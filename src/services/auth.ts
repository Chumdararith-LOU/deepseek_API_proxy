/*
 * File: auth.ts
 * Core authentication: boot init, profile cookie loading, token persistence.
 * Account management is in accountManager.ts. Token refresh is in tokenRefresh.ts.
 * Login is in loginService.ts. Login helpers are in loginHelpers.ts.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cookie } from "playwright";
import { projectPath } from "../utils/paths.ts";
import {
  type AuthState,
  accounts,
  decodeJwt,
  discoverSavedAccounts,
  enableHotReload as enableHotReloadImpl,
  getAccountByEmail,
  loadAccountsFromFile,
  migrateFromOldPaths,
  rebuildEmailIndex,
  saveAccountsToFile,
  setupAccountWatcher as setupAccountWatcherImpl,
} from "./accountManager.ts";
import { config } from "./configService.ts";
import { loginFresh } from "./loginService.ts";
import { logStore } from "./logStore.ts";
import { getActivePage } from "./playwright.ts";

export {
  addAccount,
  decodeJwt,
  decrementInFlight,
  discoverSavedAccounts,
  getAccountByEmail,
  getAccountCount,
  getAccountStats,
  getAccounts,
  getAllAccountEmails,
  getAvailableCount,
  getToken,
  getTokenWithAccount,
  hasInFlight,
  incrementInFlight,
  incrementTotalRequests,
  isAccountThrottled,
  isAvailable,
  pickAccount,
  rebuildEmailIndex,
  reloadAccounts,
  removeAccount,
  setAccountDisabled,
  throttleAccount,
} from "./accountManager.ts";
export { ensureAccountFresh, needsRefresh, tryRefreshToken } from "./tokenRefresh.ts";

export function getAuthTokenMaxAgeMs(): number {
  return config.getInt("AUTH_TOKEN_MAX_AGE_MS", 28800000);
}
export function getAuthRefreshBeforeMs(): number {
  return config.getInt("AUTH_REFRESH_BEFORE_MS", 300000);
}

const TOKEN_DIR = projectPath(".deepseek", "tokens");

export async function checkPlaywrightSession(): Promise<boolean> {
  try {
    const page = getActivePage();
    if (!page) return false;
    const cookies = await page.context().cookies();
    return cookies.some((c) => c.name.toLowerCase().includes("token") || c.name.toLowerCase().includes("session"));
  } catch {
    return false;
  }
}

let initDone = false;

export async function initAuth(onAccountReady?: (email: string) => Promise<void>): Promise<void> {
  if (initDone) return;

  migrateFromOldPaths();

  const persisted = loadAccountsFromFile();
  const discovered = discoverSavedAccounts();

  // Merge persisted accounts (throttledUntil/disabled survive restarts) with discovered accounts
  const merged: Array<{ email: string; password: string; throttledUntil?: number; disabled?: boolean }> = [
    ...discovered,
  ];
  for (const p of persisted) {
    const existing = merged.find((a) => a.email.toLowerCase().trim() === p.email.toLowerCase().trim());
    if (existing) {
      if (p.password && !existing.password) {
        existing.password = p.password;
      }
      if (p.throttledUntil) {
        existing.throttledUntil = p.throttledUntil;
      }
      if (p.disabled !== undefined) {
        existing.disabled = p.disabled;
      }
    } else if (p.password) {
      merged.push(p);
    }
  }

  if (merged.length === 0) {
    initDone = true;
    logStore.log(
      "warn",
      "auth",
      "No saved accounts found. Use the dashboard at http://localhost:26406/dashboard/accounts to add accounts.",
    );
    return;
  }

  accounts.length = 0;
  for (const a of merged) {
    const persistedUntil = a.throttledUntil ?? null;
    accounts.push({
      email: a.email,
      password: a.password,
      state: null,
      lastUsed: 0,
      throttledUntil: persistedUntil && persistedUntil > Date.now() ? persistedUntil : null,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      disabled: a.disabled ?? false,
      startupStatus: "initializing",
    });
  }
  rebuildEmailIndex();

  try {
    // Phase 1: Load tokens from browser profiles — max 3 concurrent Chromium instances
    const MAX_CONCURRENT_PROFILE_LOADS = 3;
    for (let i = 0; i < accounts.length; i += MAX_CONCURRENT_PROFILE_LOADS) {
      const batch = accounts.slice(i, i + MAX_CONCURRENT_PROFILE_LOADS);
      await Promise.allSettled(
        batch.map(async (acct) => {
          const profileState = await loadCookiesFromProfile(acct.email);
          if (profileState) {
            acct.state = profileState;
          }
        }),
      );
    }

    // Phase 2: Login accounts that don't have tokens yet — max 3 concurrent
    const needLogin = accounts.filter((a) => !a.state?.token && a.password);
    if (needLogin.length > 0) {
      logStore.log(
        "info",
        "auth",
        `Logging in ${needLogin.length} accounts (max ${MAX_CONCURRENT_PROFILE_LOADS} concurrent)...`,
      );
      for (let i = 0; i < needLogin.length; i += MAX_CONCURRENT_PROFILE_LOADS) {
        const batch = needLogin.slice(i, i + MAX_CONCURRENT_PROFILE_LOADS);
        await Promise.allSettled(
          batch.map(async (acct) => {
            const newState = await loginFresh(acct.email, acct.password!);
            if (newState) {
              acct.state = newState;
              await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
            }
          }),
        );
      }
    }

    // Phase 3: Run post-login callbacks in parallel
    if (onAccountReady) {
      const readyPromises = accounts
        .filter((a) => a.state?.token)
        .map(async (acct) => {
          try {
            await onAccountReady(acct.email);
          } catch (err: any) {
            logStore.log("warn", "auth", `Post-login config failed for ${acct.email}: ${err.message}`);
          }
        });
      await Promise.allSettled(readyPromises);
    }

    const successCount = accounts.filter((a) => a.state !== null && a.state.token).length;
    logStore.log("info", "auth", successCount + "/" + accounts.length + " accounts authenticated");

    setupAccountWatcherImpl();

    initDone = true;
  } catch (err) {
    initDone = false;
    throw err;
  }
}

export function setStartupStatus(email: string, status: "initializing" | "pending" | "connecting" | "ready"): void {
  const account = getAccountByEmail(email);
  if (account) account.startupStatus = status;
}

function getProfileDir(email: string): string {
  const safe = email
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, "_");
  return projectPath(".deepseek", "browser-profiles", safe);
}

const BROWSER_DEFAULT_ARGS = [
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-popup-blocking",
  "--mute-audio",
  "--no-first-run",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--disable-blink-features=AutomationControlled",
];

const PROFILE_LAUNCH_TIMEOUT_MS = 30_000;

async function launchPersistentProfile(profileDir: string, headless: boolean): Promise<any> {
  const { launchPersistentContext } = await import("cloakbrowser");
  return Promise.race([
    launchPersistentContext({
      userDataDir: profileDir,
      headless,
      args: [...BROWSER_DEFAULT_ARGS],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Profile launch timed out after 30s")), PROFILE_LAUNCH_TIMEOUT_MS),
    ),
  ]);
}

export async function loadCookiesFromProfile(email: string): Promise<AuthState | null> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return null;
  let context: any = null;
  try {
    const profileDir = getProfileDir(email);
    const acct = accounts.find((a) => a.email.toLowerCase().trim() === email.toLowerCase().trim());

    if (!existsSync(join(profileDir, "Default", "Cookies"))) {
      logStore.log("warn", "auth", `No profile dir for ${email} — token will come from login backfill`);
      return null;
    }

    logStore.log("info", "auth", `Loading token from profile for ${email}...`);
    context = await launchPersistentProfile(profileDir, true);

    // Headless → headed fallback when the page is captcha-challenged
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      const challenged = await page
        .evaluate(() => /captcha|verify you.?re human/i.test(document.documentElement?.innerHTML ?? ""))
        .catch(() => false);
      if (challenged) {
        logStore.log("info", "auth", `Captcha for ${email} — opening headed browser for manual login...`);
        await context.close().catch(() => {});
        context = await launchPersistentProfile(profileDir, false);
      }
    } catch (navErr: any) {
      logStore.log("debug", "auth", `Profile challenge check failed for ${email}: ${navErr.message}`);
    }

    try {
      const cookies = await context.cookies();
      const authCookie = cookies.find((c: Cookie) => {
        const n = c.name.toLowerCase();
        if (n.includes("refresh")) return false;
        return n.includes("token") || n.includes("session");
      });

      // Save ALL cookies as the session cookie string regardless of JWT health
      let cookieStr = "";
      try {
        cookieStr = cookies
          .filter((c: Cookie) => c.name && c.value)
          .map((c: Cookie) => `${c.name}=${c.value}`)
          .join("; ");
      } catch {
        /* best effort */
      }

      if (authCookie?.value) {
        const payload = decodeJwt(authCookie.value);
        const expiresAt = payload?.exp ? payload.exp * 1000 : Date.now() + getAuthTokenMaxAgeMs();
        if (expiresAt > Date.now()) {
          const refreshCookie = cookies.find((c: Cookie) => c.name.toLowerCase().includes("refresh"));
          const state: AuthState = {
            token: authCookie.value,
            expiresAt,
            refreshToken: refreshCookie?.value || null,
            cookies: cookieStr || undefined,
          };
          await saveCookies(email, state.token, state.refreshToken, state.expiresAt);
          if (acct?.state && cookieStr) acct.state.cookies = cookieStr;
          logStore.log("info", "auth", `✓ Token loaded from profile for ${email}`);
          return state;
        }
        logStore.log("warn", "auth", `Token expired for ${email}`);
      } else {
        logStore.log("warn", "auth", `No auth cookie found in profile for ${email}`);
      }
    } finally {
      if (context) {
        try {
          await context.close();
          context = null;
        } catch {
          /* non-blocking */
        }
      }
    }
  } catch (err: any) {
    if (err?.message?.toLowerCase().includes("lock")) {
      logStore.log("warn", "auth", `Profile lock error for ${email}`);
    } else {
      logStore.log("warn", "auth", `Profile cookie load failed for ${email}: ${err.message}`);
    }
    if (context) {
      try {
        await context.close();
      } catch {
        /* non-blocking */
      }
    }
  }
  return null;
}

export async function saveCookies(
  email: string,
  token: string,
  refreshToken?: string | null,
  expiresAt?: number,
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  try {
    let jwtExpiresAt = expiresAt;
    if (!jwtExpiresAt) {
      const payload = decodeJwt(token);
      if (payload?.exp && typeof payload.exp === "number") {
        jwtExpiresAt = payload.exp * 1000;
      } else {
        jwtExpiresAt = Date.now() + getAuthTokenMaxAgeMs();
      }
    }

    const acct = accounts.find((a) => a.email.toLowerCase().trim() === normalizedEmail);
    if (acct && token) {
      acct.state = {
        token,
        expiresAt: jwtExpiresAt,
        refreshToken: refreshToken || acct.state?.refreshToken || null,
        cookies: acct.state?.cookies,
      };
      if (acct.throttledUntil && acct.throttledUntil > Date.now()) {
        acct.throttledUntil = null;
      }
    }

    // Persist a token snapshot under .deepseek/tokens/
    try {
      mkdirSync(TOKEN_DIR, { recursive: true });
      const safe = normalizedEmail.replace(/[^a-z0-9]/g, "_");
      writeFileSync(
        join(TOKEN_DIR, `${safe}.json`),
        JSON.stringify(
          {
            email: normalizedEmail,
            token,
            refreshToken: refreshToken || null,
            expiresAt: jwtExpiresAt,
            savedAt: Date.now(),
          },
          null,
          2,
        ),
        "utf-8",
      );
    } catch (fileErr: any) {
      logStore.log("debug", "auth", `Token file save failed for ${normalizedEmail}: ${fileErr.message}`);
    }
  } catch (err: any) {
    logStore.log("error", "auth", `Failed to save cookies for ${normalizedEmail}: ${err.message}`);
  }
}

export function setupAccountWatcher(): void {
  setupAccountWatcherImpl();
}

export function enableHotReload(): void {
  enableHotReloadImpl();
}
