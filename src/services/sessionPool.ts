/*
 * File: sessionPool.ts
 * Chat-session pooling for DeepSeek Gateway.
 * Each request acquires a fresh chat session (POST /api/v0/chat_session/create)
 * and releases it on completion. When DELETE_SESSION is enabled the session is
 * deleted server-side after release.
 */

import {
  decrementInFlight,
  getAccountByEmail,
  getAllAccountEmails,
  incrementTotalRequests,
  pickAccount,
  throttleAccount,
} from "./auth.ts";
import { config } from "./configService.ts";
import { createFetchTimeout, DEFAULT_USER_AGENT, DEEPSEEK_API_BASE } from "./deepseek.ts";
import { logStore } from "./logStore.ts";
import { type BasicHeaders, getBasicHeaders } from "./playwright.ts";

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
  /** Which account email this session is bound to */
  accountEmail?: string;
}

export function formatDeepseekEnvelopeError(json: any): string {
  const code = json?.data?.code || json?.code || "unknown";
  const details = json?.data?.details || json?.details || json?.message || "";
  return details ? `${code}: ${details}` : String(code);
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const { controller, cleanup } = createFetchTimeout(timeoutMs);
  try {
    return await globalThis.fetch(url, { ...init, signal: controller.signal });
  } finally {
    cleanup();
  }
}

export class SessionPool {
  private activeSessions = new Set<string>();
  private activeCount = 0;
  private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      return;
    }
  }

  /**
   * Acquire a fresh session. If email is provided, use that specific account.
   * Otherwise, pick the best available account (round-robin, non-throttled).
   */
  async acquire(email?: string): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || "mock-session";
      return { chatId: mockId, parentId: null, inUse: true, accountEmail: "mock@test" };
    }

    const maxAttempts = email ? 1 : Math.max(1, getAllAccountEmails().length);
    let lastErr: unknown;
    const ACQUIRE_TIMEOUT = 30_000; // overall timeout to prevent hanging session creation

    for (let _attempt = 0; _attempt < maxAttempts; _attempt++) {
      const resolvedEmail = email || (await pickAccount())?.email;

      try {
        // Fetch headers once, pass to createSessionWithHeaders (no duplicate getBasicHeaders call)
        const result = await Promise.race([
          (async () => {
            const headers = await getBasicHeaders(resolvedEmail);
            const chatId = await this.createSessionWithHeaders(resolvedEmail, headers);
            return { headers, chatId };
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`Session acquire timed out for ${resolvedEmail || "?"} after ${ACQUIRE_TIMEOUT}ms`)),
              ACQUIRE_TIMEOUT,
            ),
          ),
        ]);
        const { headers, chatId } = result;
        const entry: PoolEntry = {
          chatId,
          parentId: null,
          inUse: true,
          cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
          accountEmail: headers.email || resolvedEmail,
        };
        this.activeSessions.add(chatId);
        this.activeCount++;
        logStore.log(
          "info",
          "pool",
          "Session acquired" + (entry.accountEmail ? ": " + entry.accountEmail.split("@")[0] : ""),
        );
        return entry;
      } catch (err: any) {
        lastErr = err;
        if (resolvedEmail) {
          decrementInFlight(resolvedEmail);
          if (
            !email &&
            /pending activation|Bad_Request|rate.?limit|captcha|chat_session\/create returned no id/i.test(
              err?.message || "",
            )
          ) {
            throttleAccount(resolvedEmail, 30 * 60 * 1000);
            logStore.log("warn", "pool", `Skipping account ${resolvedEmail}: ${err.message}`);
            continue;
          }
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("Failed to acquire session");
  }

  async release(
    chatId: string,
    _newParentId: string | null,
    cachedHeaders?: { cookie: string; userAgent: string },
    accountEmail?: string,
    isSuccess: boolean = true,
  ): Promise<void> {
    // Idempotency guard: if chatId not tracked as active, this session was already released.
    // Prevents double-release from competing cleanup paths (setTimeout + finally).
    if (!this.activeSessions.has(chatId)) {
      return;
    }

    // Track completed request — decrement in-flight, bump total count.
    // Only count successful completions toward totalRequests.
    if (accountEmail) {
      decrementInFlight(accountEmail);
      if (isSuccess) {
        incrementTotalRequests(accountEmail);
      }
    }

    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    const existingTimer = this.releaseTimers.get(chatId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.deleteSession(chatId, cachedHeaders, accountEmail);
      this.releaseTimers.delete(chatId);
    }, 0);
    if (typeof timer.unref === "function") timer.unref();
    this.releaseTimers.set(chatId, timer);

    logStore.log("info", "pool", "Session released" + (accountEmail ? ": " + accountEmail.split("@")[0] : ""));
  }

  async deleteSession(
    chatId: string,
    _cachedHeaders?: { cookie: string; userAgent: string },
    accountEmail?: string,
  ): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (config.getBool("DELETE_SESSION", true) === false) return;

    // Ensure we have an email for account lookup
    let email = accountEmail;
    if (!email) {
      try {
        const headers = await getBasicHeaders();
        email = headers.email;
      } catch {
        console.error("[SessionPool] Failed to get email for session deletion");
        return;
      }
    }

    try {
      const tokenInfo = email ? await import("./auth.ts").then((m) => m.getTokenWithAccount(email!)) : null;
      const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : "";
      const bearer = tokenInfo?.token ? `Bearer ${tokenInfo.token}` : undefined;
      const response = await fetchJson(`${DEEPSEEK_API_BASE}/api/v0/chat_session/${chatId}`, {
        method: "DELETE",
        headers: {
          accept: "application/json, text/plain, */*",
          source: "web",
          cookie: cookieStr,
          ...(bearer ? { authorization: bearer } : {}),
        },
      });
      if (!response.ok) {
        logStore.log(
          "debug",
          "pool",
          `[SessionPool] Delete returned ${response.status} for ${chatId.substring(0, 8)}...`,
        );
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        logStore.log("debug", "pool", `[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        logStore.log("debug", "pool", `[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
      }
    }
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number } {
    return {
      total: this.activeSessions.size,
      available: this.activeSessions.size - this.activeCount,
      inUse: this.activeCount,
      waiting: 0,
    };
  }

  /**
   * Create a session using pre-fetched headers (avoids duplicate getBasicHeaders call).
   */
  private async createSessionWithHeaders(email: string | undefined, _headers: BasicHeaders): Promise<string> {
    const tokenInfo = email ? await import("./auth.ts").then((m) => m.getTokenWithAccount(email!)) : null;
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : "";
    const bearer = tokenInfo?.token ? `Bearer ${tokenInfo.token}` : undefined;

    const response = await fetchJson(`${DEEPSEEK_API_BASE}/api/v0/chat_session/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        source: "web",
        cookie: cookieStr,
        origin: DEEPSEEK_API_BASE,
        referer: `${DEEPSEEK_API_BASE}/`,
        "user-agent": _headers.userAgent || DEFAULT_USER_AGENT,
        ...(bearer ? { authorization: bearer } : {}),
      },
      body: JSON.stringify({
        action: "new_chat",
        chatId: null,
      }),
    });

    if (!response.ok) {
      const bodySnippet = await response
        .text()
        .then((t) => t.substring(0, 200))
        .catch(() => "unknown");
      logStore.log(
        "warn",
        "session",
        `chat_session/create returned ${response.status}: ${bodySnippet.substring(0, 100)}`,
      );
      // Log full response for debugging 40002 errors
      if (response.status === 400) {
        logStore.log("error", "session", `Detailed error response for session creation: ${bodySnippet}`);
      }
      throw new Error(`chat_session/create returned ${response.status}`);
    }

    const responseText = await response.text();
    if (responseText.startsWith("<")) {
      logStore.log(
        "warn",
        "session",
        `chat_session/create returned HTML instead of JSON (${responseText.substring(0, 80)}...) — WAF challenge`,
      );
      throw new Error(`chat_session/create blocked by WAF — cookies may be expired`);
    }
    let json: any;
    try {
      json = JSON.parse(responseText);
    } catch {
      logStore.log("warn", "session", `chat_session/create returned non-JSON: ${responseText.substring(0, 120)}`);
      throw new Error(`chat_session/create returned non-JSON response`);
    }
    const id = json?.data?.biz_data?.id || json?.data?.id || json?.id;
    if (!id) {
      const message = formatDeepseekEnvelopeError(json);
      throw new Error(`chat_session/create returned no id: ${message}`);
    }

    return id;
  }

  /**
   * Convenience wrapper: fetches headers then delegates to createSessionWithHeaders.
   */
  private async createSession(email?: string): Promise<string> {
    const headers = await getBasicHeaders(email);
    return this.createSessionWithHeaders(email || "", headers);
  }
}

export const sessionPool = new SessionPool();
