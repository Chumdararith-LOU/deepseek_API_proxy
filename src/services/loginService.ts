/*
 * File: loginService.ts
 * Login orchestration — fetch first, browser fallback for WAF challenges.
 * Kept separate from accountManager.ts to break circular dependencies.
 */

import crypto from "node:crypto";
import type { AuthState } from "./accountManager.ts";
import { loginFreshViaBrowser, loginFreshViaFetch } from "./loginHelpers.ts";
import { logStore } from "./logStore.ts";
import { Mutex } from "./playwright.ts";

const loginMutex = new Mutex();

export async function loginFresh(email: string, password: string): Promise<AuthState | null> {
  const hashedPassword = crypto.createHash("sha256").update(password).digest("hex");

  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    const fetchResult = await loginFreshViaFetch(email, hashedPassword);
    if (fetchResult) {
      logStore.log("info", "auth", "Login success (fetch): " + email);
      return fetchResult;
    }
    logStore.log("warn", "auth", `Fetch login failed for ${email} (WAF challenge or no token) — trying browser`);

    const browserResult = await loginFreshViaBrowser(email, password, loginMutex);
    if (browserResult) {
      logStore.log("info", "auth", "Login success (browser): " + email);
      return browserResult;
    }
    logStore.log("warn", "auth", `Browser login failed for ${email}`);
  }

  logStore.log("error", "auth", "Login failed: " + email);
  return null;
}
