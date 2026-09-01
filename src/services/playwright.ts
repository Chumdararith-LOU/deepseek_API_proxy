import { launch as cloakLaunch } from "cloakbrowser";
import { type Browser, type BrowserContext, type Cookie, chromium, firefox, type Page, webkit } from "playwright";
import { DEFAULT_USER_AGENT } from "./deepseek.ts";
import { logStore } from "./logStore.ts";

export type BrowserType = "chromium" | "firefox" | "webkit" | "chrome" | "edge";

export interface AccountContext {
  context: BrowserContext;
  page: Page;
  lastRefresh: number;
  cookies: Record<string, string>;
  headers: Record<string, string>;
  refreshInterval?: NodeJS.Timeout;
}

const accountContexts = new Map<string, AccountContext>();
const contextCreationInFlight = new Map<string, Promise<AccountContext>>();
let defaultBrowser: Browser | null = null;
let initInFlight: Promise<void> | null = null;
let cachedUserAgent: string | null = null;

export function validateDeepseekUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Blocked URL protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "0.0.0.0") {
    throw new Error(`Blocked loopback URL: ${url}`);
  }
  if (
    /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
    /^192\.168\.\d+\.\d+$/.test(hostname)
  ) {
    throw new Error(`Blocked private IP URL: ${url}`);
  }
}

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export async function getCookies(email?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return "mock=1";
  // Directly return saved session cookies from accountManager.ts — no browser context needed.
  try {
    const { getAccountByEmail, getAccounts } = await import("./accountManager.ts");
    const acct = email ? getAccountByEmail(email) : getAccounts()[0];
    const cookies = acct?.state?.cookies;
    if (cookies) return cookies;
  } catch (importErr: any) {
    logStore.log("debug", "playwright", `getCookies fallback import error: ${importErr.message}`);
  }
  return "";
}

export interface BasicHeaders {
  cookie: string;
  userAgent: string;
  email?: string;
}

export async function getBasicHeaders(email?: string): Promise<BasicHeaders> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { cookie: "mock=1", userAgent: "mock", email: "mock@test" };
  }
  // No Playwright needed for headers — cookies from saved account state.
  if (!cachedUserAgent) {
    cachedUserAgent = DEFAULT_USER_AGENT;
  }
  const cookieStr = await getCookies(email);
  const { getAccountByEmail, getAccounts } = await import("./accountManager.ts");
  const acct = email ? getAccountByEmail(email) : getAccounts()[0];
  return {
    cookie: cookieStr,
    userAgent: cachedUserAgent,
    email: acct?.email,
  };
}

export async function initPlaywright(headless = true, browserType: BrowserType = "chromium") {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (defaultBrowser) return;
  if (initInFlight) {
    await initInFlight;
    return;
  }
  initInFlight = (async () => {
    if (defaultBrowser) return;

    let browserEngine: any;
    let channel: string | undefined;
    switch (browserType) {
      case "firefox":
        browserEngine = firefox;
        break;
      case "webkit":
        browserEngine = webkit;
        break;
      case "chrome":
        browserEngine = chromium;
        channel = "chrome";
        break;
      case "edge":
        browserEngine = chromium;
        channel = "msedge";
        break;
      case "chromium":
      default:
        defaultBrowser = await cloakLaunch({
          headless,
          humanize: true,
          geoip: true,
          args: [
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
          ],
        });
        break;
    }
    if (browserEngine) {
      defaultBrowser = await browserEngine.launch({
        headless,
        channel,
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled"],
      });
    }
    const cleanupAllContexts = async () => {
      for (const [_email, accCtx] of accountContexts.entries()) {
        if (accCtx.refreshInterval) clearInterval(accCtx.refreshInterval);
        await accCtx.context.close();
      }
      accountContexts.clear();
      if (defaultBrowser) {
        await defaultBrowser.close();
        defaultBrowser = null;
      }
    };
    process.on("SIGTERM", cleanupAllContexts);
    process.on("SIGINT", cleanupAllContexts);
  })().finally(() => {
    initInFlight = null;
  });
  return initInFlight;
}

function typedCast<T>(v: unknown): T {
  return v as T;
}

export async function createAccountContext(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return {
      context: typedCast<BrowserContext>(null),
      page: typedCast<Page>(null),
      lastRefresh: Date.now(),
      cookies: cookies || {},
      headers: {},
    };
  }
  const existing = accountContexts.get(email);
  if (existing) return existing;
  const inFlight = contextCreationInFlight.get(email);
  if (inFlight) return inFlight;
  const creationPromise = createContextInternal(email, cookies);
  contextCreationInFlight.set(email, creationPromise);
  try {
    return await creationPromise;
  } finally {
    contextCreationInFlight.delete(email);
  }
}

async function createContextInternal(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  await initPlaywright();
  if (!defaultBrowser) throw new Error("Playwright browser not initialized");
  if (accountContexts.has(email)) return accountContexts.get(email)!;

  // Merge provided cookies with any saved session cookies from the account state.
  const allCookies = { ...cookies };
  try {
    const { getAccountByEmail } = await import("./accountManager.ts");
    const acct = getAccountByEmail(email);
    const saved = acct?.state?.cookies;
    if (saved) {
      saved.split(";").forEach((pair) => {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          const name = pair.slice(0, eq).trim();
          const val = pair.slice(eq + 1).trim();
          if (name && val) allCookies[name] = val;
        }
      });
    }
  } catch (mergeErr: any) {
    logStore.log("debug", "playwright", `session cookies merge error: ${mergeErr.message}`);
  }

  const context = await defaultBrowser.newContext({
    storageState:
      allCookies && Object.keys(allCookies).length > 0
        ? {
            cookies: Object.entries(allCookies).map(
              ([name, value]) =>
                ({
                  name,
                  value,
                  domain: ".deepseek.com",
                  path: "/",
                  expires: Math.floor(Date.now() / 1000) + 3600,
                  httpOnly: true,
                  secure: true,
                  sameSite: "Lax",
                }) as Cookie,
            ),
            origins: [],
          }
        : undefined,
  });
  const page = await context.newPage();
  const extractedHeaders: Record<string, string> = {};
  await page.route("**/api/**", async (route: any, request: any) => {
    const headers = request.headers();
    if (headers["user-agent"]) extractedHeaders["user-agent"] = headers["user-agent"];
    await route.continue();
  });
  await page.route("**/*", (route: any) => {
    const resourceType = route.request().resourceType();
    const url = route.request().url();
    if (
      resourceType === "image" ||
      resourceType === "font" ||
      resourceType === "stylesheet" ||
      resourceType === "media"
    ) {
      route.abort();
    } else if (
      url.includes("google-analytics.com") ||
      url.includes("googletagmanager.com") ||
      url.includes("facebook.com") ||
      url.includes("hotjar.com") ||
      url.includes("sentry.io")
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
  try {
    validateDeepseekUrl("https://chat.deepseek.com/");
    await page.goto("https://chat.deepseek.com/", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (navErr: any) {
    logStore.log("debug", "playwright", `Initial navigation to chat.deepseek.com failed: ${navErr.message}`);
  }

  const accCtx: AccountContext = {
    context,
    page,
    lastRefresh: Date.now(),
    cookies: cookies || {},
    headers: extractedHeaders,
  };
  accountContexts.set(email, accCtx);
  return accCtx;
}

export function removeAccountContext(email: string): void {
  const accCtx = accountContexts.get(email);
  if (!accCtx) return;
  if (accCtx.refreshInterval) {
    clearInterval(accCtx.refreshInterval);
  }
  accCtx.context.close().catch(() => {});
  accountContexts.delete(email);
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  for (const [_email, accCtx] of accountContexts.entries()) {
    if (accCtx.refreshInterval) clearInterval(accCtx.refreshInterval);
    await accCtx.context.close();
  }
  accountContexts.clear();
  if (defaultBrowser) {
    await defaultBrowser.close();
    defaultBrowser = null;
  }
  cachedUserAgent = null;
}

export function getActivePage(email?: string): Page | null {
  if (email) return accountContexts.get(email)?.page || null;
  for (const accCtx of accountContexts.values()) {
    return accCtx.page;
  }
  return null;
}

export function getBrowser(): Browser | null {
  return defaultBrowser;
}
