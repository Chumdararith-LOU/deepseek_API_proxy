import type { Context } from "hono";

import { logStore } from "../services/logStore.ts";
import { sessionPool } from "../services/sessionPool.ts";
import { cleanTextOfXmlArtifacts, xmlToolCallToParsed } from "../tools/xmlToolParser.ts";
import type { OpenAIRequest } from "../types/openai.ts";
import { estimateTokens } from "../utils/tokenEstimator.ts";
import { extractDeepseekText } from "./chatHelpers.ts";

export interface NonStreamingCtx {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  session: {
    chatId: string;
    parentId: string | null;
    cachedHeaders?: { cookie: string; userAgent: string };
    accountEmail?: string;
  };
  nextParentId: string | null;
  sessionHeaders?: { cookie: string; userAgent: string };
  resolvedEmail: string;
  stream: ReadableStream;
  abortController: AbortController;
  cleanOutput: boolean;
}

export async function handleNonStreamingRequest(ctx: NonStreamingCtx): Promise<Response> {
  const {
    c,
    logId,
    completionId,
    body,
    session,
    nextParentId,
    sessionHeaders,
    resolvedEmail,
    stream,
    abortController,
    cleanOutput,
  } = ctx;

  let released = false;
  const release = async (success: boolean) => {
    if (released) return;
    released = true;
    await sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, success);
  };

  const timeoutMs = 300_000;
  const timer = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    let fullText = "";
    for await (const chunk of extractDeepseekText(stream)) {
      fullText += chunk;
    }
    clearTimeout(timer);

    const { toolCalls, cleanedText } = cleanTextOfXmlArtifacts(fullText);
    const content = cleanOutput ? cleanedText : fullText;
    const parsedToolCalls = toolCalls.map((tc, i) => xmlToolCallToParsed(tc, i));
    const finishReason = parsedToolCalls.length > 0 ? "tool_calls" : "stop";

    const promptText = (body.messages || [])
      .map((m: any) =>
        Array.isArray(m.content)
          ? m.content.map((c: any) => c.text || JSON.stringify(c)).join("\n")
          : String(m.content ?? ""),
      )
      .join("\n");
    const promptTokens = estimateTokens(promptText, { messageCount: (body.messages || []).length });
    const completionTokens = estimateTokens(fullText);

    logStore.updateEntry(logId, (entry) => {
      entry.output = content;
      entry.finishReason = finishReason;
      entry.tokens = { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens };
    });
    logStore.finalizeRequest(logId, finishReason);

    await release(true);

    const message: Record<string, unknown> = { role: "assistant", content };
    if (parsedToolCalls.length > 0) {
      message.tool_calls = parsedToolCalls.map((tc, i) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }

    return c.json({
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  } catch (err: any) {
    clearTimeout(timer);
    abortController.abort();
    await release(false);
    logStore.addError(logId, `Non-streaming error: ${err.message || String(err)}`);
    logStore.finalizeRequest(logId, "error");
    throw err;
  }
}
