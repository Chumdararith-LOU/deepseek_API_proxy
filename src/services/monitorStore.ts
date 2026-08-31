import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_DIR } from "../utils/paths.ts";

export interface MonitorEntry {
  id: string;
  timestamp: string;
  accountEmail: string;
  model: string;
  stream: boolean;
  success: boolean;
  latencyMs: number | null;
  error: string | null;
  mode: "streaming" | "non-streaming";
}

export interface ModeStats {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
}

export interface AccountMetrics {
  email: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  byMode: {
    streaming: ModeStats | null;
    nonStreaming: ModeStats | null;
  };
  recentErrors: string[];
  lastActivity: string | null;
}

export interface MonitorSummary {
  accounts: AccountMetrics[];
  totals: {
    totalRequests: number;
    totalSuccess: number;
    totalErrors: number;
    overallErrorRate: number;
    overallAvgLatencyMs: number | null;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
  };
  modeComparison: {
    streaming: ModeStats;
    nonStreaming: ModeStats;
  };
  topErrors: Array<{ message: string; count: number }>;
  timeRange: { from: string; to: string } | null;
  totalEntries: number;
}

const DEFAULT_MAX_ENTRIES = 50000;
const SAVE_DEBOUNCE_MS = 5000;

function computeLatencyStats(latencies: number[]): {
  avg: number | null;
  min: number | null;
  max: number | null;
  median: number | null;
  p95: number | null;
} {
  if (!latencies.length) {
    return { avg: null, min: null, max: null, median: null, p95: null };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

function computeModeStats(entries: MonitorEntry[]): ModeStats | null {
  if (!entries.length) return null;
  const errors = entries.filter((e) => !e.success);
  const lats = entries.filter((e) => e.latencyMs != null).map((e) => e.latencyMs as number);
  return {
    totalRequests: entries.length,
    successCount: entries.length - errors.length,
    errorCount: errors.length,
    avgLatencyMs: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
  };
}

function emptyModeStats(): ModeStats {
  return { totalRequests: 0, successCount: 0, errorCount: 0, avgLatencyMs: null };
}

class MonitorStore {
  private entries: MonitorEntry[] = [];
  private storePath: string;
  private maxEntries: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private idCounter = 0;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.storePath = join(SESSION_DIR, "monitor.json");
    this.maxEntries = maxEntries;
    this.load();
  }

  record(entry: {
    accountEmail: string;
    model: string;
    stream: boolean;
    success: boolean;
    latencyMs: number | null;
    error?: string | null;
  }): void {
    this.entries.push({
      id: `mon-${++this.idCounter}`,
      timestamp: new Date().toISOString(),
      accountEmail: entry.accountEmail,
      model: entry.model,
      stream: entry.stream,
      success: entry.success,
      latencyMs: entry.latencyMs,
      error: entry.error ?? null,
      mode: entry.stream ? "streaming" : "non-streaming",
    });

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }

    this.dirty = true;
    this.scheduleSave();
  }

  getSummary(): MonitorSummary {
    const all = this.entries;

    const byAccount = new Map<string, MonitorEntry[]>();
    for (const entry of all) {
      const email = entry.accountEmail || "unknown";
      let group = byAccount.get(email);
      if (!group) {
        group = [];
        byAccount.set(email, group);
      }
      group.push(entry);
    }

    const accounts: AccountMetrics[] = [];
    for (const [email, entries] of byAccount) {
      const errors = entries.filter((e) => !e.success);
      const lats = entries.filter((e) => e.latencyMs != null).map((e) => e.latencyMs as number);
      const latStats = computeLatencyStats(lats);

      const errSet = new Set<string>();
      for (const e of errors) {
        if (e.error) {
          const truncated = e.error.length > 120 ? e.error.substring(0, 120) + "..." : e.error;
          errSet.add(truncated);
        }
      }

      let lastActivity: string | null = null;
      for (const e of entries) {
        if (!lastActivity || new Date(e.timestamp).getTime() > new Date(lastActivity).getTime()) {
          lastActivity = e.timestamp;
        }
      }

      accounts.push({
        email,
        totalRequests: entries.length,
        successCount: entries.length - errors.length,
        errorCount: errors.length,
        errorRate: entries.length ? Math.round((errors.length / entries.length) * 100) : 0,
        avgLatencyMs: latStats.avg,
        minLatencyMs: latStats.min,
        maxLatencyMs: latStats.max,
        medianLatencyMs: latStats.median,
        p95LatencyMs: latStats.p95,
        byMode: {
          streaming: computeModeStats(entries.filter((e) => e.stream)),
          nonStreaming: computeModeStats(entries.filter((e) => !e.stream)),
        },
        recentErrors: [...errSet].slice(0, 10),
        lastActivity,
      });
    }

    const allErrors = all.filter((e) => !e.success);
    const allLats = all.filter((e) => e.latencyMs != null).map((e) => e.latencyMs as number);
    const totalStats = computeLatencyStats(allLats);

    const errorCounts = new Map<string, number>();
    for (const e of allErrors) {
      if (e.error) {
        const key = e.error.length > 120 ? e.error.substring(0, 120) + "..." : e.error;
        errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
      }
    }
    const topErrors = [...errorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([message, count]) => ({ message, count }));

    let timeRange: { from: string; to: string } | null = null;
    if (all.length) {
      let min = all[0].timestamp;
      let max = all[0].timestamp;
      for (const e of all) {
        if (e.timestamp < min) min = e.timestamp;
        if (e.timestamp > max) max = e.timestamp;
      }
      timeRange = { from: min, to: max };
    }

    return {
      accounts,
      totals: {
        totalRequests: all.length,
        totalSuccess: all.length - allErrors.length,
        totalErrors: allErrors.length,
        overallErrorRate: all.length ? Math.round((allErrors.length / all.length) * 100) : 0,
        overallAvgLatencyMs: totalStats.avg,
        medianLatencyMs: totalStats.median,
        p95LatencyMs: totalStats.p95,
      },
      modeComparison: {
        streaming: computeModeStats(all.filter((e) => e.stream)) || emptyModeStats(),
        nonStreaming: computeModeStats(all.filter((e) => !e.stream)) || emptyModeStats(),
      },
      topErrors,
      timeRange,
      totalEntries: all.length,
    };
  }

  clear(): void {
    this.entries = [];
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private load(): void {
    try {
      if (existsSync(this.storePath)) {
        const parsed = JSON.parse(readFileSync(this.storePath, "utf-8"));
        if (Array.isArray(parsed)) {
          this.entries = parsed.slice(-this.maxEntries);
        }
      }
    } catch (err: any) {
      console.error("[MonitorStore] Failed to load:", err.message);
      this.entries = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(SESSION_DIR, { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(this.entries), "utf-8");
      this.dirty = false;
    } catch (err: any) {
      console.error("[MonitorStore] Failed to save:", err.message);
    }
  }
}

export const monitorStore = new MonitorStore();
