import "dotenv/config";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";

import { rateLimitMiddleware, startAutoCleanup, stopAutoCleanup } from "./middleware/rateLimit.ts";
import { accountsRouter } from "./routes/accounts.ts";
import { chatCompletions } from "./routes/chat.ts";
import { configRouter } from "./routes/config.ts";
import { registerDashboardRoutes } from "./routes/dashboard/dashboardRoutes.ts";
import { modelsRouter } from "./routes/models.ts";
import { accounts, discoverSavedAccounts, parseAccountsFromEnv } from "./services/accountManager.ts";
import { getAccountCount, getAccountStats, getAvailableCount, initAuth } from "./services/auth.ts";
import { closeScreencast, handleInputEvent, startScreencast } from "./services/cdpScreencast.ts";
import { config } from "./services/configService.ts";
import { logStore } from "./services/logStore.ts";
import { initPlaywright } from "./services/playwright.ts";
import { safeCompare } from "./utils/auth.ts";
import { isBun } from "./utils/env.ts";
import { projectPath } from "./utils/paths.ts";

export const DEEPSEEK_API_BASE = "https://chat.deepseek.com";

process.title = "deepseek-gateway";

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled Promise Rejection:", reason);
});

// Forward console warn/error to dashboard system logs while preserving terminal output
const _origWarn = console.warn;
const _origError = console.error;
console.warn = (...args: any[]) => {
  _origWarn.apply(console, args);
  const msg = args.map((a: any) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logStore.log("warn", "system", msg);
};
console.error = (...args: any[]) => {
  _origError.apply(console, args);
  const msg = args.map((a: any) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logStore.log("error", "system", msg);
};

export const app = new Hono();

let inFlightRequests = 0;
let isShuttingDown = false;
let serverStop: (() => void | Promise<void>) | null = null;
const SHUTDOWN_TIMEOUT_MS = 30_000;

app.use("*", async (c, next) => {
  if (isShuttingDown) {
    return c.json({ error: { message: "Server is shutting down" } }, 503);
  }
  inFlightRequests++;
  try {
    await next();
  } finally {
    inFlightRequests--;
  }
});

async function gracefulShutdown(_signal: string): Promise<void> {
  if (isShuttingDown) {
    process.exit(1);
  }
  isShuttingDown = true;
  if (serverStop) {
    try {
      await serverStop();
    } catch {
      /* intentional */
    }
  }
  if (inFlightRequests > 0) {
    const start = Date.now();
    while (inFlightRequests > 0 && Date.now() - start < SHUTDOWN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  stopAutoCleanup();
  const pidFile = projectPath(".deepseek", "gate.pid");
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    /* best effort */
  }
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

app.use("*", cors({ origin: "*" }));

// Debug: log all incoming requests
app.use("*", async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  const ua = c.req.header("user-agent") || "unknown";
  logStore.log("debug", "http", `${method} ${path} UA=${ua.slice(0, 80)}`);
  await next();
});

// Health check — reports actual system status
app.get("/health", (c) => {
  const totalAccounts = getAccountCount();
  const availableAccounts = getAvailableCount();
  const stats = getAccountStats();
  const authenticatedCount = stats.filter((s) => s.authenticated).length;
  const throttledCount = stats.filter((s) => s.throttled).length;
  const isHealthy = totalAccounts > 0 && authenticatedCount > 0;
  return c.json({
    status: isHealthy ? "ok" : "degraded",
    version: "0.2.0",
    uptime: process.uptime(),
    inFlight: inFlightRequests,
    accounts: {
      total: totalAccounts,
      authenticated: authenticatedCount,
      available: availableAccounts,
      throttled: throttledCount,
    },
  });
});

// Ping — lightweight static response
const PING_RESPONSE = new Response("OK", {
  status: 200,
  headers: { "Content-Type": "text/plain", "Cache-Control": "no-cache" },
});
app.get("/ping", () => PING_RESPONSE);

// API Key protection for OpenAI-compatible routes (fail-open when unset)
app.use("/v1/*", async (c, next) => {
  const apiKey = config.get("API_KEY");
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

registerDashboardRoutes(app);

// Account CRUD API — protected by bearer auth
app.use("/api/accounts*", async (c, next) => {
  const apiKey = config.get("API_KEY");
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});
app.route("/api/accounts", accountsRouter);

// Also expose the accounts endpoint at the root path for dashboard
app.use("/accounts", async (c, next) => {
  const apiKey = config.get("API_KEY");
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});
app.get("/accounts", (c) => {
  return c.json({ accounts: accounts.map((a) => ({ email: a.email, expiresAt: a.state?.expiresAt ?? null })) });
});

// Config API
if (config.get("API_KEY")) {
  configRouter.use("*", async (c, next) => {
    const apiKey = config.get("API_KEY");
    const auth = c.req.header("Authorization");
    if (!apiKey || !auth || !auth.startsWith("Bearer ") || !safeCompare(auth.slice(7), apiKey)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
}
app.route("/api/config", configRouter);

// 10MB request body limit on all chat endpoints
const MAX_BODY_BYTES = 10 * 1024 * 1024;
app.use("/v1/chat/completions", async (c, next) => {
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: { message: "Request body too large" } }, 413);
  }
  await next();
});

app.route("/v1", modelsRouter);

app.post(
  "/v1/chat/completions",
  async (c, next) => {
    const result = await rateLimitMiddleware(c, "chat-completions");
    if (result) return result;
    await next();
  },
  chatCompletions,
);

// Start server
if (import.meta.main) {
  // Enable per-request file logging
  logStore.enableRequestFileLogging(projectPath(".logs"));

  const port = config.getPort();
  const hostArg = process.argv.indexOf("--host");
  const host =
    hostArg !== -1 && process.argv[hostArg + 1] ? process.argv[hostArg + 1] : config.get("HOST") || "localhost";

  // Show banner immediately on startup
  process.stdout.write(`\x1b[36m
  DeepSeek Gateway (dsg)
  \x1b[0m\x1b[32m●\x1b[0m Host: ${host}
  \x1b[32m●\x1b[0m Port: ${port}
  \x1b[32m●\x1b[0m API: ${host}:${port}/v1
  \x1b[32m●\x1b[0m Dashboard: http://${host}:${port}/dashboard (Ctrl+Click)\x1b[0m
  `);

  async function startServer() {
    // ── Phase 1: Start HTTP server FIRST so dashboard is live immediately ──
    // Token-based screencast auth: HTTP POST creates token, WS connects with token
    const screencastTokens = new Map<string, { email: string; password: string }>();

    const createServer = async (p: number, h: string) => {
      if (isBun) {
        const bunServer = Bun.serve({
          fetch: (req: any, server: any) => {
            const url = new URL(req.url);
            // Intercept WebSocket upgrade for screencast
            if (url.pathname === "/api/screencast/ws" && req.headers.get("upgrade") === "websocket") {
              const token = url.searchParams.get("token") as string;
              const session = token ? screencastTokens.get(token) : null;
              if (!session) {
                return new Response("Invalid or expired token", { status: 401 });
              }
              screencastTokens.delete(token);
              return server.upgrade(req, { data: { email: session.email, password: session.password } });
            }
            return app.fetch(req, server);
          },
          port: p,
          hostname: h,
          idleTimeout: 0,
          websocket: {
            open(ws) {
              const { email, password } = (ws.data as any) || {};
              if (!email || !password) {
                ws.close(4001, "Missing credentials");
                return;
              }
              logStore.log("info", "screencast", `WS client connected for ${email}`);
              startScreencast(email, password, ws as any).then((result) => {
                if (result.error) {
                  ws.send(JSON.stringify({ type: "error", message: result.error }));
                  ws.close();
                }
              });
            },
            message(ws, message) {
              try {
                const msg = JSON.parse(typeof message === "string" ? message : message.toString());
                if (msg.type === "input") {
                  handleInputEvent((ws.data as any)?.email || "", msg.event);
                } else if (msg.type === "close") {
                  closeScreencast((ws.data as any)?.email || "");
                }
              } catch {}
            },
            close(ws) {
              logStore.log("info", "screencast", `WS client disconnected for ${(ws.data as any)?.email || "?"}`);
            },
          },
        });
        serverStop = () => bunServer.stop(false);

        // Screencast launch endpoint — creates token, client connects WS with token
        app.post("/api/screencast/launch", async (c) => {
          try {
            const apiKey = config.get("API_KEY");
            if (apiKey) {
              const auth = c.req.header("Authorization");
              if (!auth || !auth.startsWith("Bearer ") || !safeCompare(auth.slice(7), apiKey)) {
                return c.json({ error: "Unauthorized" }, 401);
              }
            }
            const body = await c.req.json();
            const { email, password } = body;
            if (!email || !password) return c.json({ error: "email and password required" }, 400);
            const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
            screencastTokens.set(token, { email, password });
            // Auto-expire token after 30s
            setTimeout(() => screencastTokens.delete(token), 30_000);
            return c.json({ token, wsUrl: `/api/screencast/ws?token=${token}` });
          } catch {
            return c.json({ error: "Invalid request" }, 400);
          }
        });
      } else {
        const { serve } = await import("@hono/node-server");
        const nodeServer = serve({
          fetch: app.fetch,
          port: p,
          hostname: h,
          serverOptions: {
            requestTimeout: 600_000,
            keepAliveTimeout: 75_000,
            headersTimeout: 65_000,
          },
        });
        serverStop = () => new Promise<void>((resolve) => nodeServer.close(() => resolve()));
      }
    };

    try {
      await createServer(port, host);
    } catch (err: any) {
      if (err.code === "EADDRINUSE") {
        const fallbackPort = port + 1;
        logStore.log("debug", "server", `Port ${port} in use, trying ${fallbackPort}...`);
        await createServer(fallbackPort, host);
      } else {
        throw err;
      }
    }

    // Pre-warm DNS and TCP connection to DeepSeek upstream
    if (isBun) {
      try {
        Bun.dns?.prefetch?.("chat.deepseek.com", 443);
        fetch.preconnect?.(DEEPSEEK_API_BASE);
        logStore.log("info", "boot", "DNS prefetch + TCP preconnect initiated");
      } catch {
        // Not all Bun versions support these — silently skip
      }
    }

    const pidDir = projectPath(".deepseek");
    try {
      mkdirSync(pidDir, { recursive: true });
      writeFileSync(projectPath(".deepseek", "gate.pid"), String(process.pid));
    } catch {
      /* best effort */
    }

    startAutoCleanup();

    // ── Background init: accounts → configure → headers ──
    (async () => {
      logStore.log("info", "boot", "[1/5] Loading accounts...");
      await initAuth();
      const envAccounts = parseAccountsFromEnv();
      const savedAccounts = discoverSavedAccounts();
      logStore.log("info", "boot", `[1/5] Accounts discovered: ${envAccounts.length + savedAccounts.length}`);

      try {
        logStore.log("info", "boot", "[2/5] Configuring accounts...");
        logStore.log("info", "boot", "[2/5] Accounts configured (stub — no accounts ready)");
      } catch (err: any) {
        logStore.log("warn", "boot", `[2/5] Configure failed: ${err.message}`);
      }

      if (envAccounts.length + savedAccounts.length > 0) {
        const headless = process.env.HEADLESS !== "false";
        logStore.log("info", "boot", `[3/5] Starting browser (headless=${headless})...`);
        try {
          await initPlaywright(headless, "chromium");
          logStore.log("info", "boot", "[3/5] Browser ready");
        } catch (err: any) {
          logStore.log("warn", "boot", `[3/5] Browser init failed: ${err.message} — login will retry on demand`);
        }
      } else {
        logStore.log("info", "boot", "[3/5] No accounts — skipping browser init");
      }

      logStore.log("info", "boot", "Background initialization complete");
    })().catch((err) => {
      logStore.log("error", "boot", `Background init error: ${err.message}`);
    });
  }

  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
