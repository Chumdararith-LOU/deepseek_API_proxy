/*
 * File: deepseekModels.ts
 * Model listing and per-account configuration for DeepSeek Gateway.
 * Note: imports from deepseek.ts are only used inside functions to keep the
 * deepseek.ts <-> deepseekModels.ts re-export cycle TDZ-safe.
 */
import { getAllAccountEmails, getTokenWithAccount } from "./auth.ts";
import { config } from "./configService.ts";
import { DEEPSEEK_MODELS_URL, DEEPSEEK_SETTINGS_URL } from "./deepseek.ts";
import { logStore } from "./logStore.ts";

export interface DeepSeekModelInfo {
  id: string;
  name?: string;
  description?: string;
}

let modelsCache: { at: number; models: DeepSeekModelInfo[] } | null = null;

export async function fetchDeepseekModels(email?: string): Promise<DeepSeekModelInfo[]> {
  const ttl = config.getInt("MODELS_CACHE_TTL_MS", 3600000);
  if (modelsCache && Date.now() - modelsCache.at < ttl) return modelsCache.models;
  const tokenInfo = await getTokenWithAccount(email);
  const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : "";
  const response = await globalThis.fetch(DEEPSEEK_MODELS_URL, {
    headers: {
      accept: "application/json, text/plain, */*",
      source: "web",
      cookie: cookieStr,
    },
  });
  if (!response.ok) {
    throw new Error(`DeepSeek models endpoint returned ${response.status}`);
  }
  const json = await response.json().catch(() => null);
  const list: DeepSeekModelInfo[] = Array.isArray(json?.data)
    ? json.data.map((m: any) => ({ id: m.id || m.model || String(m), name: m.name, description: m.description }))
    : [];
  modelsCache = { at: Date.now(), models: list };
  return list;
}

export async function configureAccount(email: string): Promise<boolean> {
  const tokenInfo = await getTokenWithAccount(email);
  if (!tokenInfo) return false;
  try {
    const response = await globalThis.fetch(DEEPSEEK_SETTINGS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        source: "web",
        cookie: `token=${tokenInfo.token}`,
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      logStore.log("debug", "deepseek", `configureAccount(${email}) returned ${response.status}`);
      return false;
    }
    return true;
  } catch (err: any) {
    logStore.log("debug", "deepseek", `configureAccount(${email}) failed: ${err.message}`);
    return false;
  }
}

export async function deleteAllChats(_email?: string): Promise<void> {
  const emails = _email ? [_email] : getAllAccountEmails();
  logStore.log(
    "debug",
    "deepseek",
    `deleteAllChats requested for ${emails.length} account(s) — not implemented upstream yet`,
  );
}
