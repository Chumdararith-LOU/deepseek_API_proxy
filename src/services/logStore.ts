/*
 * File: logStore.ts
 * In-memory request log store — captures client requests and DeepSeek responses
 * for viewing at the dashboard log endpoints (SSE + JSON).
 * System-level logging is provided by the SystemLogger base class below.
 */
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monitorStore } from "./monitorStore.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_SYSTEM_ENTRIES = 200;
const MAX_RAW_CHUNKS = 100;
const MAX_FIELD_LENGTH = 10240;
const DEFAULT_MAX_LOGS = 50;

function getMaxLogs(): number {
  const val = parseInt(process.env.MAX_LOGS ?? "", 10);
  return Number.isNaN(val) || val < 1 ? DEFAULT_MAX_LOGS : val;
}

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SystemLogFilter {
  minLevel?: LogLevel;
  category?: string;
  since?: string;
  limit?: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  model: string;
  stream: boolean;
  accountEmail: string;
  latency_ms: number | null;
  tokens: { prompt: number; completion: number; total: number } | null;
  input?: string;
  output?: string;
  reasoning_content?: string;
  rawRequestBody?: Record<string, unknown> | string;
  rawResponse?: string;
  processedResponse?: string;
  finishReason?: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    success: boolean;
    blocked?: boolean;
    blockReason?: string;
    error?: string;
    executionTimeMs?: number;
  }>;
  networkTiming?: {
    dnsLookup: number;
    tcpConnect: number;
    tlsHandshake: number;
    firstByte: number;
    total: number;
  };
  errors: string[];
  chunks: string[];
  parsedToolCalls: Array<{ name: string; args: string }>;
  remainingText?: string;
  reasoningContent?: string;
  amplificationRatio?: number;
  amplificationTriggeredInput?: string;
  startedAt: number;
  finalResponse?: {
    finishReason: string;
    toolCallCount: number;
    contentPreview: string;
  };
  apiType?: "openai" | "anthropic";
}

export class SystemLogger {
  protected systemEntries: SystemLogEntry[] = [];
  protected systemListeners: Set<(entry: SystemLogEntry) => void> = new Set();
  protected systemIdCounter = 0;

  log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    const entry: SystemLogEntry = {
      id: `sys-${++this.systemIdCounter}`,
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata: data,
    };
    this.systemEntries.unshift(entry);
    if (this.systemEntries.length > MAX_SYSTEM_ENTRIES) this.systemEntries.pop();

    for (const listener of this.systemListeners) {
      try {
        listener(entry);
      } catch (err) {
        try {
          process.stderr.write(`[SystemLogger] system log listener error: ${err}\n`);
        } catch {
          /* ignore */
        }
      }
    }

    if (!process.stdout.isTTY) {
      try {
        process.stdout.write(`${JSON.stringify({ ...entry, logger: "deepseek-gateway" })}\n`);
      } catch {
        /* ignore */
      }
    }
  }

  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("debug", category, message, data);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("info", category, message, data);
  }

  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("warn", category, message, data);
  }

  error(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("error", category, message, data);
  }

  getLogs(limit = 50, category?: string, level?: LogLevel): SystemLogEntry[] {
    let result = this.systemEntries;
    if (category) result = result.filter((e) => e.category === category);
    if (level) result = result.filter((e) => LOG_LEVEL_RANK[e.level] >= LOG_LEVEL_RANK[level]);
    return result.slice(0, limit);
  }

  subscribeSystem(listener: (entry: SystemLogEntry) => void): () => void {
    this.systemListeners.add(listener);
    return () => this.systemListeners.delete(listener);
  }
}

export class RequestLogStore extends SystemLogger {
  private entries: LogEntry[] = [];
  private entryMap: Map<string, LogEntry> = new Map();
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private requestLogDir: string | null = null;
  private startTime = Date.now();

  createEntry(id: string, model: string, stream: boolean): LogEntry {
    const entry: LogEntry = {
      id,
      timestamp: new Date().toISOString(),
      model,
      stream,
      accountEmail: "",
      latency_ms: null,
      tokens: null,
      errors: [],
      chunks: [],
      parsedToolCalls: [],
      startedAt: Date.now(),
    };
    this.entries.unshift(entry);
    this.entryMap.set(id, entry);

    const cap = getMaxLogs();
    while (this.entries.length > cap) {
      const removed = this.entries.pop();
      if (removed) this.entryMap.delete(removed.id);
    }
    return entry;
  }

  updateEntry(id: string, updater: (entry: LogEntry) => void): void {
    const entry = this.entryMap.get(id);
    if (!entry) return;
    updater(entry);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        try {
          process.stderr.write(`[RequestLogStore] listener error: ${err}\n`);
        } catch {
          /* ignore */
        }
      }
    }
  }

  getEntry(id: string): LogEntry | undefined {
    return this.entryMap.get(id);
  }

  addRawChunk(id: string, chunk: string): void {
    this.updateEntry(id, (entry) => {
      entry.chunks.push(chunk);
      if (entry.chunks.length > MAX_RAW_CHUNKS) entry.chunks.shift();
    });
  }

  addProcessedOutput(id: string, content: string): void {
    this.updateEntry(id, (entry) => {
      entry.output = (entry.output ?? "") + content;
      if (entry.output.length > MAX_FIELD_LENGTH) {
        entry.output = `${entry.output.substring(0, MAX_FIELD_LENGTH)}... [truncated]`;
      }
    });
  }

  addError(id: string, error: string): void {
    this.updateEntry(id, (entry) => {
      entry.errors.push(error);
    });
  }

  recordAmplificationEvent(logId: string, ratio: number, triggeringInput: string): void {
    this.updateEntry(logId, (entry) => {
      entry.amplificationRatio = ratio;
      entry.amplificationTriggeredInput =
        triggeringInput.length > 2000
          ? `${triggeringInput.substring(0, 2000)}... [truncated ${triggeringInput.length - 2000} more chars]`
          : triggeringInput;
    });
  }

  setNetworkTiming(id: string, timing: LogEntry["networkTiming"]): void {
    this.updateEntry(id, (entry) => {
      entry.networkTiming = timing;
    });
  }

  getEntries(count = 20): LogEntry[] {
    return this.entries.slice(0, count);
  }

  getAll(): LogEntry[] {
    return this.entries;
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enableRequestFileLogging(dirPath: string): void {
    this.requestLogDir = dirPath;
    try {
      mkdirSync(dirPath, { recursive: true });
    } catch {
      /* best effort */
    }
  }

  getRequestLogDir(): string | null {
    return this.requestLogDir;
  }

  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  finalizeRequest(logId: string, finishReason?: string): void {
    this.updateEntry(logId, (entry) => {
      entry.latency_ms = Date.now() - entry.startedAt;
      if (finishReason) entry.finishReason = finishReason;
    });
    this.persistToDisk(logId);

    const entry = this.entryMap.get(logId);
    if (entry?.accountEmail) {
      const hasErrors = (entry.errors && entry.errors.length > 0) || finishReason === "error";
      monitorStore.record({
        accountEmail: entry.accountEmail,
        model: entry.model || "unknown",
        stream: entry.stream,
        success: !hasErrors,
        latencyMs: entry.latency_ms,
        error: entry.errors?.length ? entry.errors[0] : null,
      });
    }
  }

  private persistToDisk(logId: string): void {
    if (!this.requestLogDir) return;
    const entry = this.entryMap.get(logId);
    if (!entry) return;
    try {
      const filePath = join(this.requestLogDir, `${logId}.json`);
      writeFile(filePath, `${JSON.stringify(entry, null, 2)}\n`, "utf-8").catch(() => {
        /* disk write best-effort */
      });
      this.cleanupOldLogFiles();
    } catch {
      /* best effort */
    }
  }

  private cleanupOldLogFiles(): void {
    if (!this.requestLogDir) return;
    try {
      const files = readdirSync(this.requestLogDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
      const maxFiles = getMaxLogs();
      while (files.length > maxFiles) {
        const oldest = files.shift();
        if (!oldest) break;
        try {
          unlinkSync(join(this.requestLogDir, oldest));
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* best effort */
    }
  }
}

export const logStore = new RequestLogStore();
