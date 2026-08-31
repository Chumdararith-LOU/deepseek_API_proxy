import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { projectPath } from "../utils/paths.ts";
import { logStore } from "./logStore.ts";

// ── Model mapping (ported from Python server/config.py) ─────────────
export const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE ?? "30");

export const SERVER_INTERACTIVE_LOGIN =
  (process.env.SERVER_INTERACTIVE_LOGIN ?? "1").toLowerCase() !== "0" &&
  (process.env.SERVER_INTERACTIVE_LOGIN ?? "1").toLowerCase() !== "false";

export const MODEL_MAP: Record<string, string> = {
  "deepseek-v4-flash": "default",
  "deepseek-v4-pro": "expert",
};

export const DEFAULT_MODEL = "deepseek-v4-flash";

export function isKnownModel(name: string): boolean {
  return name in MODEL_MAP;
}

export function resolveModelType(name: string): string {
  const mapped = MODEL_MAP[name];
  if (!mapped) throw new Error(`Unknown model: ${name}`);
  return mapped;
}

// ── Gateway config (env var > config.json > default) ────────────────
export interface ConfigSchema {
  PORT: string;
  HOST: string;
  API_KEY: string;
  TOOL_CALLING: string;
  CLEAN_OUTPUT: string;
  STREAMING_MODE: string;
  MAX_TOOL_CALLS_PER_RESPONSE: string;
  DEEPSEEK_FETCH_TIMEOUT_MS: string;
  AUTH_TOKEN_MAX_AGE_MS: string;
  AUTH_REFRESH_BEFORE_MS: string;
  DELETE_SESSION: string;
  RATE_LIMIT_COOLDOWN_MS: string;
  CHAT_MIN_INTERVAL_MS: string;
  MAX_LOGS: string;
  SAVE_REQUEST_LOGS: string;
  RETRY_MAX_ATTEMPTS: string;
  RETRY_BASE_DELAY_MS: string;
  RETRY_MAX_DELAY_MS: string;
  RETRY_BACKOFF_MULTIPLIER: string;
  RETRY_ENABLED: string;
  STREAM_IDLE_TIMEOUT_MS: string;
  MODELS_CACHE_TTL_MS: string;
  DARK_MODE: string;
  OPEN_DASHBOARD_ON_START: string;
  CLAUDE_CODE_PROXY: string;
  USE_CUSTOM_INSTRUCTION: string;
  CUSTOM_INSTRUCTION: string;
}

export const DEFAULT_CONFIG: ConfigSchema = {
  PORT: "26406",
  HOST: "",
  API_KEY: "",
  TOOL_CALLING: "true",
  CLEAN_OUTPUT: "true",
  STREAMING_MODE: "auto",
  MAX_TOOL_CALLS_PER_RESPONSE: "3",
  DEEPSEEK_FETCH_TIMEOUT_MS: "30000",
  AUTH_TOKEN_MAX_AGE_MS: "28800000",
  AUTH_REFRESH_BEFORE_MS: "300000",
  DELETE_SESSION: "true",
  RATE_LIMIT_COOLDOWN_MS: "120000",
  CHAT_MIN_INTERVAL_MS: "10000",
  MAX_LOGS: "50",
  SAVE_REQUEST_LOGS: "false",
  RETRY_MAX_ATTEMPTS: "3",
  RETRY_BASE_DELAY_MS: "1000",
  RETRY_MAX_DELAY_MS: "30000",
  RETRY_BACKOFF_MULTIPLIER: "2",
  RETRY_ENABLED: "true",
  STREAM_IDLE_TIMEOUT_MS: "60000",
  MODELS_CACHE_TTL_MS: "3600000",
  DARK_MODE: "false",
  OPEN_DASHBOARD_ON_START: "false",
  CLAUDE_CODE_PROXY: "false",
  USE_CUSTOM_INSTRUCTION: "false",
  CUSTOM_INSTRUCTION: "",
};

const CONFIG_KEYS = new Set<string>(Object.keys(DEFAULT_CONFIG));

export function isValidKey(key: string): key is keyof ConfigSchema {
  return CONFIG_KEYS.has(key);
}

function getConfigFilePath(): string {
  return projectPath("config.json");
}

export class ConfigService {
  private _data: Partial<ConfigSchema> = {};
  private _filePath: string;

  constructor(filePath?: string) {
    this._filePath = filePath ?? getConfigFilePath();
    this.load();
  }

  load(): void {
    const filePath = this._filePath;
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);

        for (const key of Object.keys(parsed)) {
          if (!CONFIG_KEYS.has(key)) {
            logStore.log("debug", "config", `[config] Unknown key "${key}" in config.json — ignoring`);
          }
        }

        const clean: Partial<ConfigSchema> = {};
        for (const key of Object.keys(DEFAULT_CONFIG) as (keyof ConfigSchema)[]) {
          if (typeof parsed[key] === "string") {
            clean[key] = parsed[key];
          }
        }
        this._data = clean;
        this.validate();
      } catch {
        this._data = {};
      }
    } else {
      this._data = {};
      try {
        writeFileSync(filePath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
      } catch {
        // If we can't write (e.g. readonly fs in test), just keep empty _data
      }
    }
  }

  validate(): void {
    const port = parseInt(this.get("PORT"), 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      logStore.log(
        "debug",
        "config",
        `[config] PORT "${this.get("PORT")}" is invalid, using default ${DEFAULT_CONFIG.PORT}`,
      );
    }

    const checkPositive = (key: keyof ConfigSchema, name: string): void => {
      const val = parseInt(this.get(key), 10);
      if (!isNaN(val) && val < 0) {
        logStore.log(
          "debug",
          "config",
          `[config] ${name} (${key}) is negative (${val}), using default ${DEFAULT_CONFIG[key]}`,
        );
      }
    };

    checkPositive("AUTH_TOKEN_MAX_AGE_MS", "AUTH_TOKEN_MAX_AGE_MS");
    checkPositive("MAX_LOGS", "MAX_LOGS");
    checkPositive("DEEPSEEK_FETCH_TIMEOUT_MS", "DEEPSEEK_FETCH_TIMEOUT_MS");
    checkPositive("RATE_LIMIT_COOLDOWN_MS", "RATE_LIMIT_COOLDOWN_MS");
    checkPositive("RETRY_MAX_ATTEMPTS", "RETRY_MAX_ATTEMPTS");
    checkPositive("RETRY_BASE_DELAY_MS", "RETRY_BASE_DELAY_MS");
    checkPositive("RETRY_MAX_DELAY_MS", "RETRY_MAX_DELAY_MS");
    checkPositive("AUTH_REFRESH_BEFORE_MS", "AUTH_REFRESH_BEFORE_MS");
    checkPositive("MAX_TOOL_CALLS_PER_RESPONSE", "MAX_TOOL_CALLS_PER_RESPONSE");
  }

  get<K extends keyof ConfigSchema>(key: K, defaultValue?: string): string {
    const envVal = process.env[key];
    if (envVal !== undefined) return envVal;

    if (this._data[key] !== undefined) return this._data[key]!;

    if (defaultValue !== undefined) return defaultValue;

    return DEFAULT_CONFIG[key];
  }

  /** Get a config value as an integer. Returns `defaultValue` when unset or NaN. */
  getInt<K extends keyof ConfigSchema>(key: K, defaultValue: number = 0): number {
    const val = parseInt(this.get(key), 10);
    return isNaN(val) ? defaultValue : val;
  }

  /** Get a config value as a float. Returns `defaultValue` when unset or NaN. */
  getFloat<K extends keyof ConfigSchema>(key: K, defaultValue: number = 0): number {
    const val = parseFloat(this.get(key));
    return isNaN(val) ? defaultValue : val;
  }

  /** Get a config value as a boolean. Accepts 'true'/'false', '1'/'0', case-insensitive. */
  getBool<K extends keyof ConfigSchema>(key: K, defaultValue: boolean = false): boolean {
    const val = this.get(key).toLowerCase();
    if (val === "true" || val === "1") return true;
    if (val === "false" || val === "0") return false;
    return defaultValue;
  }

  /** Get the validated server port (1-65535). */
  getPort(defaultValue: number = 26406): number {
    const port = parseInt(this.get("PORT"), 10);
    if (isNaN(port) || port < 1 || port > 65535) return defaultValue;
    return port;
  }

  set<K extends keyof ConfigSchema>(key: K, value: string): void {
    this._data[key] = value;
  }

  getAll(): ConfigSchema {
    const result = {} as ConfigSchema;
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof ConfigSchema)[]) {
      result[key] = process.env[key] ?? this._data[key] ?? DEFAULT_CONFIG[key];
    }
    return result;
  }

  save(): void {
    writeFileSync(this._filePath, `${JSON.stringify(this._data, null, 2)}\n`, "utf-8");
  }

  reset(): void {
    this.load();
  }
}

export function updateClaudeCodeSettings(cfg: ConfigSchema): void {
  const enabled = cfg.CLAUDE_CODE_PROXY === "true";
  const settingsDir = projectPath(".claude");
  const settingsFile = join(settingsDir, "settings.json");

  if (enabled) {
    const host = cfg.HOST || "localhost";
    const port = cfg.PORT || "26406";
    const baseUrl = `http://${host}:${port}`;
    const settings = {
      _comment: "Managed by deepseek-gateway — CLAUDE_CODE_PROXY toggle in dashboard",
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: "unused",
      },
    };
    try {
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    } catch (err) {
      console.error("[Claude Code] Failed to write .claude/settings.json:", err);
    }
  } else {
    try {
      if (existsSync(settingsFile)) {
        const raw = readFileSync(settingsFile, "utf-8");
        const content = JSON.parse(raw);
        if (content._comment?.includes("deepseek-gateway") || content.env?.ANTHROPIC_BASE_URL) {
          delete content._comment;
          delete content.env?.ANTHROPIC_BASE_URL;
          delete content.env?.ANTHROPIC_AUTH_TOKEN;
          if (content.env && Object.keys(content.env).length === 0) delete content.env;
          if (Object.keys(content).length === 0) {
            unlinkSync(settingsFile);
            try {
              const rest = readdirSync(settingsDir);
              if (rest.length === 0) rmdirSync(settingsDir);
            } catch {
              // best effort
            }
          } else {
            writeFileSync(settingsFile, `${JSON.stringify(content, null, 2)}\n`);
          }
          console.log("[Claude Code] Proxy disabled — .claude/settings.json cleaned");
        }
      }
    } catch {
      // best effort cleanup
    }
  }
}

export const config = new ConfigService();
