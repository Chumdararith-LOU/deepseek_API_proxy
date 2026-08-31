/*
 * File: deepseek.ts
 * Core Deepseek upstream transport — token lookup, request construction,
 * SSE streaming, retry with circuit breaker, rate-limit/CAPTCHA handling.
 */

import crypto from "node:crypto";
import { CircuitBreaker, CircuitOpenError, withRetry } from "../utils/retry.ts";
import { decrementInFlight, getTokenWithAccount, pickAccount, throttleAccount } from "./auth.ts";
import { config, MODEL_MAP } from "./configService.ts";
import { logStore } from "./logStore.ts";
import { powSolver } from "./powSolver.ts";

export { configureAccount, deleteAllChats, fetchDeepseekModels } from "./deepseekModels.ts";

// Shared URL constants for Deepseek API
export const DEEPSEEK_API_BASE = "https://chat.deepseek.com";
export const DEEPSEEK_CHAT_COMPLETIONS_URL = `${DEEPSEEK_API_BASE}/api/v0/chat/completion`;
export const DEEPSEEK_SETTINGS_URL = `${DEEPSEEK_API_BASE}/api/v2/users/user/settings/update`;
export const DEEPSEEK_CHATS_URL = `${DEEPSEEK_API_BASE}/api/v2/chats/`;
export const DEEPSEEK_MODELS_URL = `${DEEPSEEK_API_BASE}/api/models`;

/** Build shared feature_config for Deepseek message payloads. */
export function buildFeatureConfig(_enableThinking: boolean): Record<string, any> {
  return {
    thinking_enabled: true,
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: false,
    thinking_mode: "Thinking",
    thinking_format: "summary",
    auto_search: true,
  };
}

export class RetryableDeepseekStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RetryableDeepseekStreamError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class DeepseekUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = "DeepseekUpstreamError";
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

class UpstreamStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamStatusError";
    this.status = status;
  }
}

export interface DeepseekMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: "user" | "assistant" | "function";
  content: string | Record<string, unknown>;
  user_action: string;
  files: unknown[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: Record<string, unknown>;
  extra: Record<string, unknown>;
  sub_chat_type: string;
  parent_id: string | null;
  model?: string;
  modelName?: string;
  modelIdx?: number;
  userContext?: unknown;
  info?: Record<string, unknown>;
}

export interface DeepseekPayload {
  chat_session_id: string | null;
  parent_message_id: string | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  model_type: string;
  preempt: boolean;
  action: string | null;
}

export interface DeepseekStreamResult {
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  accountEmail?: string;
  abortController: AbortController;
  logFile?: string;
}

const cachedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function createFetchTimeout(ms?: number): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = ms ?? config.getInt("DEEPSEEK_FETCH_TIMEOUT_MS", 30000);
  if (timeout > 0) {
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeout);
    return { controller, cleanup: () => clearTimeout(timer) };
  }
  return { controller, cleanup: () => {} };
}

function buildRequestHeaders(reqHeaders: Record<string, string>, cId?: string): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    source: "web",
    cookie: reqHeaders.cookie,
    ...(reqHeaders["authorization"] ? { authorization: reqHeaders["authorization"] } : {}),
    origin: DEEPSEEK_API_BASE,
    referer: cId ? `https://chat.deepseek.com/c/${cId}` : "https://chat.deepseek.com/",
    "sec-ch-ua": '"Chromium";v="142", "Not(A:Brand";v="24", "Google Chrome";v="142"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    timezone: cachedTimezone,
    "user-agent":
      reqHeaders["user-agent"] ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "x-accel-buffering": "no",
    "x-app-version": "2.0.0",
    "x-client-version": "2.0.0",
    "x-client-platform": "web",
    "x-client-locale": "en_US",
    "x-request-id": crypto.randomUUID(),
  };
}

const lastRequestTime = new Map<string, number>();
async function applyRequestJitter(accountEmail?: string): Promise<void> {
  if (!accountEmail) return;
  const now = Date.now();
  const last = lastRequestTime.get(accountEmail) || 0;
  const gap = config.getInt("CHAT_MIN_INTERVAL_MS", 10000) + Math.random() * 2000;
  // Reserve the slot before sleeping so concurrent requests serialize per account
  const slot = Math.max(now, last + gap);
  lastRequestTime.set(accountEmail, slot);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

export function parseMutedResponse(bodyText: string): { throttleMs: number; msg: string } | null {
  try {
    const payload = JSON.parse(bodyText);
    const bizData = payload?.data?.biz_data;
    const bizMsg = String(payload?.data?.biz_msg || "");
    if (!bizData?.is_muted && !/muted|suspended|violation/i.test(bizMsg)) return null;
    const muteUntil = typeof bizData?.mute_until === "number" ? bizData.mute_until : undefined;
    const throttleMs = muteUntil ? Math.max(60_000, muteUntil * 1000 - Date.now()) : 24 * 3_600_000;
    return { throttleMs, msg: bizMsg || "user is muted" };
  } catch {
    return null;
  }
}

const deepseekCircuitBreaker = new CircuitBreaker("deepseek-api", {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
});

export async function createDeepseekStream(
  messages: DeepseekMessage[],
  enableThinking: boolean,
  modelId: string,
  chatId?: string,
  parentId?: string | null,
  accountEmail?: string,
): Promise<DeepseekStreamResult> {
  const actualParentId: string | null = parentId !== undefined ? parentId : null;
  const timestamp = Math.floor(Date.now() / 1000);
  const model = modelId.replace("-no-thinking", "");

  // Ensure each message has required fields
  const deepseekMessages: DeepseekMessage[] = messages.map((msg, i) => ({
    fid: msg.fid || crypto.randomUUID(),
    parentId: msg.parentId || (i === 0 ? actualParentId : null),
    childrenIds: msg.childrenIds || [],
    role: msg.role,
    content: msg.content,
    user_action: msg.user_action || "chat",
    files: msg.files || [],
    timestamp: msg.timestamp || timestamp,
    models: msg.models || [model],
    chat_type: msg.chat_type || "t2t",
    feature_config: msg.feature_config || buildFeatureConfig(enableThinking),
    extra: msg.extra || { meta: { subChatType: "t2t" } },
    sub_chat_type: msg.sub_chat_type || "t2t",
    parent_id: msg.parent_id ?? (i === 0 ? actualParentId : null),
    ...(msg.role === "function"
      ? {
          model: msg.model || model,
          modelName: msg.modelName || model,
          modelIdx: msg.modelIdx ?? 0,
          userContext: msg.userContext,
          info: msg.info || {},
        }
      : {}),
  }));

  const lastUserMsg = [...deepseekMessages].reverse().find((m) => m.role === "user");
  const fullPrompt = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";

  const payload: DeepseekPayload = {
    chat_session_id: chatId || null,
    parent_message_id: actualParentId,
    prompt: fullPrompt,
    ref_file_ids: [],
    thinking_enabled: false,
    search_enabled: false,
    model_type: MODEL_MAP[model] || "default",
    preempt: false,
    action: null,
  };

  const urlObj = new URL(DEEPSEEK_CHAT_COMPLETIONS_URL);
  if (chatId) urlObj.searchParams.set("chat_id", chatId);
  const url = urlObj.href;

  const retryConfig = {
    maxRetries: Math.max(0, config.getInt("RETRY_MAX_ATTEMPTS", 3)),
    baseDelayMs: Math.max(0, config.getInt("RETRY_BASE_DELAY_MS", 1000)),
    maxDelayMs: Math.max(0, config.getInt("RETRY_MAX_DELAY_MS", 30000)),
    backoffMultiplier: Math.max(0.1, config.getFloat("RETRY_BACKOFF_MULTIPLIER", 2)),
    attemptTimeoutMs: 30_000,
  };

  const retriesEnabled = config.getBool("RETRY_ENABLED", true);
  let currentAccountEmail = accountEmail;
  const streamAbortController = new AbortController();

  async function handleErrorResponse(response: Response): Promise<never> {
    const errText = await response.text().catch(() => "");
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const errorJson = JSON.parse(errText);
        if (
          errorJson?.data?.details?.includes("chat is in progress") ||
          errorJson?.data?.details?.includes("The chat is in progress")
        ) {
          const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
          throw new RetryableDeepseekStreamError(`Deepseek: ${errorJson.data.details}`, retryAfterMs);
        }
        if (errorJson?.success === false) {
          const code = errorJson.data?.code || errorJson.code || "Unknown";
          const details = errorJson.data?.details || errorJson.details || errorJson.message || "";
          const wait = errorJson.data?.wait || "";

          // Rate-limit: throttle account and try next
          if (code === "RateLimited" || code === "QuotaExhausted" || code === "TooManyRequests") {
            if (currentAccountEmail) {
              const waitHours = errorJson.data?.num || 1;
              const throttleMs = waitHours * 3600_000;
              throttleAccount(currentAccountEmail, throttleMs);
              const nextAccount = await pickAccount(currentAccountEmail);
              if (nextAccount) {
                currentAccountEmail = nextAccount.email;
                decrementInFlight(nextAccount.email);
              } else {
                throw new DeepseekUpstreamError(`All accounts rate-limited. ${details}.${wait}`, code, 429);
              }
            }
          }

          let status: number;
          if (code === "RateLimited") status = 429;
          else if (code === "QuotaExhausted") status = 429;
          else if (code === "InvalidParameter" || code === "BadRequest") status = 400;
          else if (code === "Unauthorized" || code === "Forbidden") status = 403;
          else status = 500;

          throw new DeepseekUpstreamError(`Deepseek upstream error: ${code}: ${details}.${wait}`, code, status);
        }

        // Deepseek anti-bot CAPTCHA — throttle account and switch
        if (errorJson?.ret?.[0] === "FAIL_SYS_USER_VALIDATE") {
          const details = errorJson.ret[1] || "CAPTCHA required";
          logStore.log("warn", "deepseek", `CAPTCHA detected for ${currentAccountEmail || "unknown"}: ${details}`);
          if (currentAccountEmail) {
            throttleAccount(currentAccountEmail, 5 * 60 * 1000);
            logStore.log(
              "debug",
              "deepseek",
              `[Deepseek] BOT DETECTION: ${currentAccountEmail} hit FAIL_SYS_USER_VALIDATE — throttled 5min, switching account`,
            );
            const nextAccount = await pickAccount(currentAccountEmail);
            if (nextAccount) {
              currentAccountEmail = nextAccount.email;
              decrementInFlight(nextAccount.email);
            }
          }
          throw new RetryableDeepseekStreamError(`Deepseek CAPTCHA — switched accounts. ${details}`, 3000);
        }

        if (
          errorJson?.data?.details?.includes("is not exist") ||
          errorJson?.data?.details?.includes("not exist") ||
          errorJson?.data?.details?.includes("does not exist")
        ) {
          throw new RetryableDeepseekStreamError(`Deepseek: ${errorJson.data.details}`, 0);
        }
      } catch (parseOrRetryError) {
        if (
          parseOrRetryError instanceof RetryableDeepseekStreamError ||
          parseOrRetryError instanceof DeepseekUpstreamError
        ) {
          throw parseOrRetryError;
        }
      }
    }
    const sanitizedErrText = errText
      .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[JWT_REDACTED]")
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[JWT_REDACTED]")
      .slice(0, 500);
    throw new UpstreamStatusError(
      `Failed to fetch from Deepseek: ${response.status} ${response.statusText} - ${sanitizedErrText}`,
      response.status,
    );
  }

  async function doFetch(): Promise<{ response: Response; headers: Record<string, string> }> {
    // Resolve account + token
    if (!currentAccountEmail) {
      const acct = await pickAccount();
      if (acct) {
        currentAccountEmail = acct.email;
      }
    }
    await applyRequestJitter(currentAccountEmail);

    const tokenInfo = currentAccountEmail ? await getTokenWithAccount(currentAccountEmail) : null;
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : "";
    const reqHeaders: Record<string, string> = { cookie: cookieStr };
    if (tokenInfo?.token) reqHeaders["authorization"] = `Bearer ${tokenInfo.token}`;
    if (currentAccountEmail) {
      try {
        const { getBasicHeaders } = await import("./playwright.ts");
        const basicHeaders = await getBasicHeaders(currentAccountEmail);
        reqHeaders["cookie"] = basicHeaders.cookie || cookieStr;
        reqHeaders["user-agent"] = basicHeaders.userAgent || "";
      } catch {
        // playwright not available — use minimal headers
      }
    }

    // Fetch and solve PoW challenge
    let powResponseHeader = "";
    try {
      const challengeUrl = `${DEEPSEEK_API_BASE}/api/v0/chat/create_pow_challenge`;
      const challengeResponse = await globalThis.fetch(challengeUrl, {
        method: "POST",
        headers: buildRequestHeaders(reqHeaders, chatId),
        body: JSON.stringify({ target_path: urlObj.pathname }),
      });

      if (challengeResponse.ok) {
        const envelope = await challengeResponse.json();
        const cd = envelope?.data?.biz_data?.challenge || envelope?.data?.challenge || envelope;
        const challenge = {
          salt: cd.salt,
          expire_at: cd.expire_at,
          difficulty: cd.difficulty,
          challenge: cd.challenge,
          algorithm: cd.algorithm,
          signature: cd.signature,
          target_path: cd.target_path,
        };
        powResponseHeader = await powSolver.makeHeader(challenge);
      }
    } catch (err) {
      logStore.log("warn", "deepseek", `PoW challenge failed: ${err}`);
    }

    const headers = buildRequestHeaders(reqHeaders, chatId);
    if (powResponseHeader) {
      headers["x-ds-pow-response"] = powResponseHeader;
    }
    const { controller, cleanup } = createFetchTimeout();

    // Link abort to the stream controller
    const onAbort = () => controller.abort();
    streamAbortController.signal.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      cleanup();
      streamAbortController.signal.removeEventListener("abort", onAbort);
    }

    if (!response.ok) {
      await handleErrorResponse(response);
    }

    // Muted/suspended accounts get HTTP 200 with a JSON envelope instead of SSE
    const respContentType = response.headers.get("content-type") || "";
    if (respContentType.includes("application/json")) {
      const bodyText = await response.text().catch(() => "");
      const muted = parseMutedResponse(bodyText);
      if (muted) {
        if (currentAccountEmail) {
          throttleAccount(currentAccountEmail, muted.throttleMs);
          const nextAccount = await pickAccount(currentAccountEmail);
          if (nextAccount) {
            currentAccountEmail = nextAccount.email;
            decrementInFlight(nextAccount.email);
          } else {
            throw new DeepseekUpstreamError(`All accounts muted or suspended. ${muted.msg}`, "AccountMuted", 429);
          }
        }
        throw new RetryableDeepseekStreamError(`Deepseek account muted — rotated. ${muted.msg}`, 0);
      }
      throw new UpstreamStatusError(`Deepseek returned JSON instead of a stream: ${bodyText.slice(0, 300)}`, 502);
    }

    return { response, headers };
  }

  // Execute with retry + circuit breaker
  const maxRetries = retriesEnabled ? retryConfig.maxRetries : 0;
  let result: { response: Response; headers: Record<string, string> } | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      result = await deepseekCircuitBreaker.execute(doFetch);
      break;
    } catch (err: any) {
      lastError = err;

      if (err instanceof RetryableDeepseekStreamError) {
        if (attempt < maxRetries && err.retryAfterMs > 0) {
          await new Promise((r) => setTimeout(r, err.retryAfterMs));
          continue;
        }
        if (attempt < maxRetries) continue;
      }

      if (err instanceof CircuitOpenError) {
        throw new DeepseekUpstreamError("Deepseek API circuit breaker is open", "CircuitOpen", 503);
      }

      if (err instanceof UpstreamStatusError && err.status >= 500 && attempt < maxRetries) {
        const delay = Math.min(retryConfig.baseDelayMs * 2 ** attempt, retryConfig.maxDelayMs);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (err instanceof DeepseekUpstreamError) throw err;
      if (err instanceof UpstreamStatusError) throw err;
      if (attempt >= maxRetries) throw err;
    }
  }

  if (!result) {
    throw lastError instanceof Error ? lastError : new Error("Deepseek stream failed");
  }

  const upstreamResponse = result.response;

  const bodyStream = upstreamResponse.body;
  if (!bodyStream) {
    throw new DeepseekUpstreamError("Deepseek returned empty response body", "EmptyBody", 502);
  }

  return {
    stream: bodyStream,
    headers: result.headers,
    uiSessionId: chatId || "",
    accountEmail: currentAccountEmail,
    abortController: streamAbortController,
  };
}

export function validateDeepseekUrl(url: string): void {
  if (!url.startsWith(DEEPSEEK_API_BASE)) {
    throw new Error(`URL must be under ${DEEPSEEK_API_BASE}`);
  }
}
