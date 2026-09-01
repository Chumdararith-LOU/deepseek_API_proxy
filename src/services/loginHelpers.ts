/*
 * File: loginHelpers.ts
 * Login implementation helpers.
 * Contains the three login strategies: browser context, fetch, and temp context.
 */

import crypto from "node:crypto";
import type { AuthState } from "./accountManager.ts";
import { config } from "./configService.ts";
import { createFetchTimeout, DEFAULT_USER_AGENT, DEEPSEEK_API_BASE } from "./deepseek.ts";
import { logStore } from "./logStore.ts";
import {
  type AccountContext,
  createAccountContext,
  type getBrowser,
  type Mutex,
  removeAccountContext,
} from "./playwright.ts";

export function getAuthTokenMaxAgeMs(): number {
  return config.getInt("AUTH_TOKEN_MAX_AGE_MS", 28800000);
}

function buildAuthState(token: string, refreshToken: string | null): AuthState {
  return {
    token,
    expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
    refreshToken,
  };
}

/**
 * Login via plain fetch — fastest path, no browser overhead.
 */
export async function loginFreshViaFetch(email: string, hashedPassword: string): Promise<AuthState | null> {
  const { controller, cleanup } = createFetchTimeout(15_000);
  let response: Response;
  try {
    response = await globalThis.fetch(`${DEEPSEEK_API_BASE}/api/v0/users/login`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        "user-agent": DEFAULT_USER_AGENT,
        "x-client-platform": "web",
        "x-client-locale": "en_US",
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        email,
        password: hashedPassword,
        device_id: "deepseek_to_api",
        os: "android",
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    logStore.log("debug", "auth", `fetch login error for ${email}: ${err.message}`);
    return null;
  } finally {
    cleanup();
  }

  if (response.status === 202 || (response.headers.get("x-amzn-waf-action") || "").includes("challenge")) {
    logStore.log("warn", "auth", `WAF challenge received for ${email} — browser login required`);
    return null;
  }

  if (response.ok) {
    let data: any;
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    // Extract token from the nested structure based on Python auth pattern
    let token =
      data?.data?.biz_data?.user?.token || data?.data?.token || data?.token || data?.data?.session_token || null;
    let refreshToken = data?.data?.refresh_token || data?.refresh_token || null;

    if (!token) {
      const hdrs = response.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies: string[] =
        typeof hdrs.getSetCookie === "function"
          ? hdrs.getSetCookie()
          : (response.headers.get("set-cookie") || "").split(",");

      for (const cookie of setCookies) {
        const tokenMatch = cookie.match(/\btoken=([^;]+)/);
        if (tokenMatch && !token) token = tokenMatch[1];
        const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
        if (refreshMatch) refreshToken = refreshMatch[1];
      }
    }

    if (token) {
      return buildAuthState(token, refreshToken);
    }

    logStore.log(
      "warn",
      "auth",
      `API login returned 200 but no token for ${email}: ${JSON.stringify(data).substring(0, 200)}`,
    );
  } else {
    const errText = await response.text().catch(() => "");
    logStore.log("error", "auth", `Login failed for ${email} (${response.status}): ${errText.substring(0, 200)}`);
  }

  return null;
}

/**
 * Login via browser context — executes signin API inside the browser via evaluate().
 */
export async function loginFreshViaBrowser(
  email: string,
  password: string,
  loginMutex: Mutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const accCtx = await createAccountContext(email);
    const page = accCtx.page;

    try {
      const currentUrl = page.url();
      if (!currentUrl.includes("sign_in") && !currentUrl.includes("login")) {
        logStore.log("info", "auth", `Navigating to DeepSeek login page for ${email}`);
        await page.goto(`${DEEPSEEK_API_BASE}/auth/login`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      }
    } catch (err: any) {
      logStore.log("warn", "auth", `Navigation check failed for ${email}: ${err.message}`);
      // Continue to try login anyway - perhaps it's already navigated or page was already loaded
    }

    // Wait for and fill login form fields - more resilient selectors for DeepSeek's UI
    try {
      // Try different selectors for email field (DeepSeek's current HTML)
      const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="email"]',
        'input[aria-label*="email" i]',
        '[data-testid="email"]',
      ];

      let emailFieldFound = false;
      for (const selector of emailSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.fill(selector, email);
          emailFieldFound = true;
          logStore.log("info", "auth", `Found email field with selector: ${selector}`);
          break;
        } catch (err) {
          // Try next selector
        }
      }

      if (!emailFieldFound) {
        logStore.log("warn", "auth", `Could not find email field for ${email}`);
        return null;
      }

      // Try different selectors for password field
      const passwordSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        'input[placeholder*="password"]',
        'input[aria-label*="password"]',
        '[data-testid="password"]',
      ];

      let passwordFieldFound = false;
      for (const selector of passwordSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.fill(selector, password);
          passwordFieldFound = true;
          logStore.log("info", "auth", `Found password field with selector: ${selector}`);
          break;
        } catch (err) {
          // Try next selector
        }
      }

      if (!passwordFieldFound) {
        logStore.log("warn", "auth", `Could not find password field for ${email}`);
        return null;
      }

      // Try different selectors for submit button
      const submitSelectors = [
        "div.ds-button--primary",
        'div[class*="ds-button--primary"]',
        'div[class*="ds-button--filled"]',
        'button[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Continue")',
        '[data-testid="submit"]',
      ];

      let submitButtonFound = false;
      for (const selector of submitSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          logStore.log("info", "auth", `Found submit button with selector: ${selector}`);

          // Click to submit
          await page.click(selector);
          submitButtonFound = true;
          break;
        } catch (err) {
          // Try next selector
        }
      }

      if (!submitButtonFound) {
        logStore.log("warn", "auth", `Could not find submit button for ${email}`);
        return null;
      }

      // Wait for successful navigation to the main page
      try {
        await page.waitForURL((url) => !url.toString().includes("sign_in"), { timeout: 15_000 });
        logStore.log("info", "auth", `Successfully navigated to main page for ${email}`);
      } catch (err: any) {
        logStore.log("warn", "auth", `Navigation timeout for ${email} (could be expected): ${(err as Error).message}`);
      }

      // Wait a bit to let cookies populate
      await page.waitForTimeout(2000);
    } catch (err: any) {
      logStore.log("error", "auth", `Form fill failed for ${email}: ${err.message}`);
      throw err; // Re-throw to ensure we don't continue with partial login
    }

    // Try to extract token from cookies - more resilient approach
    try {
      const cookies = await page.context().cookies();
      const authCookies = cookies.filter((c) => c.domain?.includes("deepseek"));
      let token = null;
      let refreshToken = null;

      for (const c of authCookies) {
        if (c.name === "token") token = c.value;
        if (c.name === "refresh_token") refreshToken = c.value;
      }

      if (token) {
        logStore.log("info", "auth", `Successfully extracted token from cookies for ${email}`);
        return buildAuthState(token, refreshToken);
      }
    } catch (err: any) {
      logStore.log("warn", "auth", `Cookie extraction failed for ${email}: ${err.message}`);
    }

    try {
      const stored = await page.evaluate(() => {
        const readUserToken = () => {
          try {
            const raw = window.localStorage.getItem("userToken");
            if (!raw) return null;
            const o = JSON.parse(raw);
            return o && o.value ? o.value : null;
          } catch {
            return null;
          }
        };
        return {
          token: readUserToken() || localStorage.getItem("token") || localStorage.getItem("__token__"),
          refreshToken: localStorage.getItem("refresh_token"),
        };
      });
      if (stored.token) {
        logStore.log("info", "auth", `Extracted token from localStorage for ${email}`);
        return buildAuthState(stored.token, stored.refreshToken);
      }
    } catch (err: any) {
      logStore.log("warn", "auth", `localStorage extraction failed for ${email}: ${err.message}`);
    }

    // If we're here, we tried the browser approach but didn't find tokens
    logStore.log("info", "auth", `Browser-based login approach complete for ${email}, no tokens found`);
    // Return null to fall through to temp context if needed
    return null;
  } catch (err: any) {
    logStore.log("error", "auth", `Unexpected browser login error for ${email}: ${err.message}`);
    return null;
  } finally {
    release();
  }
}

/**
 * Login via a disposable browser context — last resort.
 */
export async function loginViaTempContext(
  _browser: ReturnType<typeof getBrowser>,
  email: string,
  hashedPassword: string,
  loginMutex: Mutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  let accCtx: AccountContext | null = null;
  try {
    accCtx = await createAccountContext(email);
    const page = accCtx.page;
    const context = accCtx.context;

    let capturedToken: string | null = null;
    let capturedRefresh: string | null = null;

    // Intercept signin API to capture token from BOTH JSON body AND set-cookie headers
    await page.route("**/api/v2/auths/signin", async (route) => {
      try {
        const response = await route.fetch();

        // Try to extract token from JSON response body first (fastest path)
        try {
          const body = await response.json();
          const jsonToken = body?.data?.token || body?.token || body?.data?.session_token || null;
          const jsonRefresh = body?.data?.refresh_token || body?.refresh_token || null;
          if (jsonToken && !capturedToken) capturedToken = jsonToken;
          if (jsonRefresh && !capturedRefresh) capturedRefresh = jsonRefresh;
        } catch {
          logStore.log("warn", "auth", "signin route fetch returned non-JSON response");
        }

        // Also check set-cookie headers as fallback
        const setCookies = response
          .headersArray()
          .filter((h) => h.name.toLowerCase() === "set-cookie")
          .map((h) => h.value);
        for (const cookie of setCookies) {
          const tokenMatch = cookie.match(/\btoken=([^;]+)/);
          if (tokenMatch && !capturedToken) capturedToken = tokenMatch[1];
          const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
          if (refreshMatch && !capturedRefresh) capturedRefresh = refreshMatch[1];
        }

        await route.fulfill({ response });
      } catch {
        // If route.fetch fails, let the request pass through normally
        await route.continue();
      }
    });

    try {
      await page.goto(`${DEEPSEEK_API_BASE}/auth`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      logStore.log("warn", "auth", `goto auth page failed for ${email}`);
    }

    try {
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10_000 });
      await page.fill('input[type="email"], input[name="email"]', email);
      await page.fill('input[type="password"], input[name="password"]', hashedPassword);
      await Promise.all([
        page.click(
          'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")',
        ),
        page.waitForURL((url) => !url.toString().includes("/auth"), { timeout: 15_000 }).catch(() => {}),
      ]);
    } catch {
      logStore.log("warn", "auth", `form fill/submit failed for ${email}`);
    }

    // Poll for token with shorter intervals instead of blind sleep
    for (let attempt = 0; attempt < 10; attempt++) {
      if (capturedToken) break;
      await new Promise((r) => setTimeout(r, 500));

      // Check cookies as fallback
      try {
        const cookies = await context.cookies();
        const tokenCookie = cookies.find(
          (c) =>
            c.name === "token" ||
            (c.name.toLowerCase().includes("token") &&
              c.domain.includes("deepseek") &&
              !c.name.toLowerCase().includes("refresh")),
        );
        const refreshCookie = cookies.find(
          (c) =>
            c.name === "refresh_token" || (c.name.toLowerCase().includes("refresh") && c.domain.includes("deepseek")),
        );
        if (tokenCookie?.value) capturedToken = tokenCookie.value;
        if (refreshCookie?.value) capturedRefresh = refreshCookie.value;
      } catch {
        // context may be closing — keep polling
      }
    }

    if (capturedToken) {
      return buildAuthState(capturedToken, capturedRefresh);
    }

    logStore.log("warn", "auth", `Temp context login captured no token for ${email}`);
    return null;
  } catch (err: any) {
    logStore.log("error", "auth", `Temp context login error for ${email}: ${err.message}`);
    return null;
  } finally {
    if (accCtx) {
      try {
        removeAccountContext(email);
      } catch {
        /* removeAccountContext handles interval clear, context close, and map cleanup */
      }
      try {
        await accCtx.page.close();
      } catch {
        /* page may already be closed */
      }
      try {
        await accCtx.context.close();
      } catch {
        /* context may already be closed or already closed by removeAccountContext */
      }
    }
    release();
  }
}
