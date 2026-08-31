import { randomUUID } from "node:crypto";

import { config } from "../services/configService.ts";
import type { DeepseekMessage } from "../services/deepseek.ts";
import { buildFeatureConfig, createDeepseekStream } from "../services/deepseek.ts";
import { sessionPool } from "../services/sessionPool.ts";
import type { Message, OpenAIRequest, ToolCall } from "../types/openai.ts";
import { withRetry } from "../utils/retry.ts";

export * from "./chatHelpersCore.ts";

// ── String / diff utilities ───────────────────────────────────────

export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

export function getNewContent(text: string, lastEmittedText: string): string {
  if (!text) return "";
  const commonLen = commonPrefixLen(text, lastEmittedText);
  return text.slice(commonLen);
}

// ── Model specs ───────────────────────────────────────────────────

const MODEL_SPECS: Record<string, { maxContext: number; maxOutput: number }> = {
  "deepseek-v4-flash": { maxContext: 1_000_000, maxOutput: 384_000 },
  "deepseek-v4-pro": { maxContext: 1_000_000, maxOutput: 384_000 },
};

export async function getModelSpecs(body: OpenAIRequest): Promise<{ maxContext: number; maxOutput: number }> {
  const base = String(body.model).replace("-no-thinking", "");
  return MODEL_SPECS[base] ?? { maxContext: 1_000_000, maxOutput: 384_000 };
}

// ── Content sanitization ──────────────────────────────────────────

const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
const ROLE_PREFIX_RE = /^(?:System|Assistant|User|Human):\s*/gim;
// C0 control chars except \t \n \r — built via constructor to avoid literal control chars in source
const CONTROL_CHAR_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}]`,
  "g",
);

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function messageToText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text" && typeof c.text === "string") return c.text;
        if (c.type === "image_url") return "[Image]";
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return String(msg.content ?? "");
}

export interface BuildDeepseekMessagesResult {
  deepseekMessages: DeepseekMessage[];
}

function toolCallsToDsml(toolCalls: ToolCall[]): string {
  const invokes = toolCalls
    .map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      const params = Object.entries(args)
        .map(([key, value]) => {
          const val = typeof value === "string" ? value : JSON.stringify(value);
          return `<｜｜DSML｜｜parameter name="${escXml(key)}" string="true">${escXml(val)}</｜｜DSML｜｜parameter>`;
        })
        .join("");
      return `<｜｜DSML｜｜invoke name="${escXml(tc.function.name)}">${params}</｜｜DSML｜｜invoke>`;
    })
    .join("");
  return `<｜｜DSML｜｜tool_calls>${invokes}</｜｜DSML｜｜tool_calls>`;
}

export function buildDeepseekMessages(
  messages: Message[],
  body: OpenAIRequest,
  availableTokens: number,
  toolCalling: boolean,
): BuildDeepseekMessagesResult {
  const turns: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const raw = messageToText(msg)
        .replace(SYSTEM_REMINDER_RE, "")
        .replace(ROLE_PREFIX_RE, "")
        .replace(CONTROL_CHAR_RE, "")
        .trim();
      if (raw) turns.push(`<system>\n${raw}\n</system>`);
      continue;
    }

    if (msg.role === "tool") {
      const content = messageToText(msg).trim();
      if (content) turns.push(`<tool_result>\n${content}\n</tool_result>`);
      continue;
    }

    let content = messageToText(msg)
      .replace(SYSTEM_REMINDER_RE, "")
      .replace(ROLE_PREFIX_RE, "")
      .replace(CONTROL_CHAR_RE, "")
      .trim();

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      turns.push(`<assist>\n${[content, toolCallsToDsml(msg.tool_calls)].filter(Boolean).join("\n")}\n</assist>`);
      continue;
    }

    if (!content) continue;

    // Per-message truncation guard based on available token budget
    const charLimit = Math.floor(availableTokens * 3.0);
    if (content.length > charLimit) {
      content = content.slice(0, charLimit);
    }

    if (msg.role === "assistant") {
      turns.push(`<assist>\n${content}\n</assist>`);
    } else {
      turns.push(`<user>\n${content}\n</user>`);
    }
  }

  // Append tool definitions so the model knows what tools are available
  if (toolCalling && body.tools && body.tools.length > 0) {
    turns.push(
      "<tool_instructions>\n" +
        "You have access to tools. When you want to use a tool, you MUST output the call in this exact DSML format and nothing else:\n" +
        '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="tool_name"><｜｜DSML｜｜parameter name="param_name" string="true">param_value</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>\n' +
        "Do not simulate or describe tool results. Only output the DSML tool-call block.\n" +
        "</tool_instructions>",
    );
    const defs = body.tools
      .map((t) => {
        const fn = t.function ?? t;
        const name = fn.name ?? t.name ?? "unknown";
        const desc = fn.description ?? t.description ?? "";
        const params = fn.parameters ?? t.parameters;
        return `<tool name="${escXml(String(name))}">\n${escXml(String(desc))}\n${params ? escXml(JSON.stringify(params)) : ""}\n</tool>`;
      })
      .join("\n");
    turns.push(`<tools>\n${defs}\n</tools>`);
  }

  const inlineContent = turns.join("\n");

  const baseMessage: DeepseekMessage = {
    fid: randomUUID(),
    parentId: null,
    childrenIds: [],
    role: "user",
    content: inlineContent,
    user_action: "chat",
    files: [],
    timestamp: Math.floor(Date.now() / 1000),
    models: [],
    chat_type: "t2t",
    feature_config: {},
    extra: { meta: { subChatType: "t2t" } },
    sub_chat_type: "t2t",
    parent_id: null,
  };

  return {
    deepseekMessages: [baseMessage],
  };
}

// ── Session acquisition ───────────────────────────────────────────

export interface AcquiredSession {
  session: {
    chatId: string;
    parentId: string | null;
    cachedHeaders?: { cookie: string; userAgent: string };
    accountEmail?: string;
  };
  deepseekMessages: DeepseekMessage[];
  nextParentId: string | null;
  sessionHeaders?: { cookie: string; userAgent: string };
  resolvedEmail: string;
}

export async function acquireSessionWithCorrections(
  accountEmail: string | undefined,
  messages: DeepseekMessage[],
): Promise<AcquiredSession> {
  const session = await sessionPool.acquire(accountEmail);
  const resolvedEmail = session.accountEmail || accountEmail || "";

  // Bind the first message's parent to the session root so DeepSeek links the turn correctly
  const bound = messages.map((m, i) =>
    i === 0 ? { ...m, parentId: session.parentId, parent_id: session.parentId } : m,
  );

  return {
    session,
    deepseekMessages: bound,
    nextParentId: session.parentId,
    sessionHeaders: session.cachedHeaders,
    resolvedEmail,
  };
}

// ── Stream creation with retry ────────────────────────────────────

export async function createDeepseekStreamWithRetry(
  messages: DeepseekMessage[],
  enableThinking: boolean,
  modelId: string,
  chatId: string,
  parentId: string | null,
  accountEmail: string,
): Promise<{ stream: ReadableStream; abortController: AbortController }> {
  const maxRetries = Math.max(0, config.getInt("RETRY_MAX_ATTEMPTS", 3));

  return withRetry(
    async () => {
      const result = await createDeepseekStream(messages, enableThinking, modelId, chatId, parentId, accountEmail);
      return { stream: result.stream, abortController: result.abortController };
    },
    {
      maxRetries,
      baseDelayMs: Math.max(0, config.getInt("RETRY_BASE_DELAY_MS", 1000)),
      maxDelayMs: Math.max(0, config.getInt("RETRY_MAX_DELAY_MS", 30000)),
    },
  );
}

// ── DeepSeek SSE text extraction ──────────────────────────────────
// DeepSeek streams an initial snapshot frame (full response object with
// fragments[].content) followed by APPEND frames that grow the content.
// We track the active append path and emit only RESPONSE-fragment text.

export async function* extractDeepseekText(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let activePath: string | null = null;

  function* processLine(line: string): Generator<string> {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    let obj: any;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }

    if (obj.type === "error" && typeof obj.content === "string" && obj.content) {
      throw new Error(`DeepSeek upstream error: ${obj.content}`);
    }

    const v = obj.v;

    // Snapshot frame: full response object (may be nested under v.response or direct)
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const respObj = v.response && typeof v.response === "object" ? v.response : v;
      const frags = respObj.fragments;
      if (Array.isArray(frags)) {
        for (const frag of frags) {
          if (frag && frag.type === "RESPONSE" && typeof frag.content === "string") {
            activePath = "response/fragments/-1/content";
            if (frag.content) yield frag.content;
          }
        }
        return;
      }
    }

    // Append frame: may set a new path via "p", then append "v"
    if (obj.o === "APPEND") {
      if (typeof obj.p === "string" && obj.p) activePath = obj.p;
      if (typeof v === "string" && activePath && /content$/.test(activePath)) {
        yield v;
      }
      return;
    }

    // Non-append frame with an explicit path (e.g. status, token_usage): track path, don't yield
    if (typeof obj.p === "string" && obj.p) {
      activePath = obj.p;
      return;
    }

    // Bare value frame appending to the active content path
    if (typeof v === "string" && activePath && /content$/.test(activePath)) {
      yield v;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        yield* processLine(line);
      }
    }
    // Flush any trailing bytes
    buffer += decoder.decode();
    if (buffer) {
      for (const line of buffer.split("\n")) {
        yield* processLine(line);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader already released */
    }
  }
}
