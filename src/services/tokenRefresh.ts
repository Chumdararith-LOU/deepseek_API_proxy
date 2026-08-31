/*
 * File: tokenRefresh.ts
 * Token refresh logic — refresh token exchange and keeping accounts fresh.
 */

import type { AccountEntry } from "./accountManager.ts";
import { accounts, saveAccountsToFile } from "./accountManager.ts";
import { config } from "./configService.ts";
import { createFetchTimeout, DEEPSEEK_API_BASE } from "./deepseek.ts";
import { loginFresh } from "./loginService.ts";
import { logStore } from "./logStore.ts";

function getAuthRefreshBeforeMs(): number {
  return config.getInt("AUTH_REFRESH_BEFORE_MS", 300000);
}

function getAuthTokenMaxAgeMs(): number {
  return config.getInt("AUTH_TOKEN_MAX_AGE_MS", 28800000);
}

export function needsRefresh(acct: AccountEntry): boolean {
  if (!acct.state) return true;
  return acct.state.expiresAt - getAuthRefreshBeforeMs() < Date.now();
}

export async function tryRefreshToken(acct: AccountEntry): Promise<boolean> {
  if (!acct.state?.refreshToken) return false;

  const { controller, cleanup } = createFetchTimeout(15_000);
  try {
    const resp = await globalThis.fetch(`${DEEPSEEK_API_BASE}/api/v2/auths/refresh`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        source: "web",
      },
      body: JSON.stringify({ refresh_token: acct.state.refreshToken }),
      signal: controller.signal,
    });

    if (!resp.ok) return false;

    const body = await resp.text();
    const data = JSON.parse(body);
    if (!data.data?.token) return false;

    acct.state = {
      token: data.data.token,
      expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
      refreshToken: data.data.refresh_token || acct.state.refreshToken,
    };
    saveAccountsToFile(accounts);
    if (acct.throttledUntil && acct.throttledUntil > Date.now()) {
      acct.throttledUntil = null;
    }
    return true;
  } catch (err: any) {
    logStore.log("error", "auth", `HTTP refresh fetch failed for ${acct.email}: ${err.message}`);
    return false;
  } finally {
    cleanup();
  }
}

export async function ensureAccountFresh(acct: AccountEntry): Promise<boolean> {
  if (acct.state && !needsRefresh(acct)) return true;

  // Avoid concurrent refresh for same account (single-flight)
  if (acct.refreshInFlight) {
    return acct.refreshInFlight;
  }

  acct.refreshInFlight = (async () => {
    try {
      if (acct.state?.refreshToken) {
        if (await tryRefreshToken(acct)) return true;
        logStore.log("warn", "auth", `Refresh token failed for ${acct.email}`);
      }

      if (acct.throttledUntil && acct.throttledUntil > Date.now()) {
        const waitSec = Math.ceil((acct.throttledUntil - Date.now()) / 1000);
        logStore.log("warn", "auth", `Skipping re-login for ${acct.email} — throttled for ${waitSec}s more`);
        return false;
      }

      if (!acct.password) {
        logStore.log("warn", "auth", `Cannot re-login ${acct.email} — no stored password`);
        return false;
      }

      const newState = await loginFresh(acct.email, acct.password);
      if (newState) {
        acct.state = newState;
        saveAccountsToFile(accounts);
        return true;
      }
      return false;
    } finally {
      acct.refreshInFlight = null;
    }
  })();

  return acct.refreshInFlight;
}
