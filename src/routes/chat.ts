import crypto from "node:crypto";
import type { Context } from "hono";

import { pickAccount, throttleAccount } from "../services/auth.ts";
import { config } from "../services/configService.ts";
import { RetryableDeepseekStreamError } from "../services/deepseek.ts";
import { logStore } from "../services/logStore.ts";
import { sessionPool } from "../services/sessionPool.ts";
import { cleanTextOfXmlArtifacts } from "../tools/xmlToolParser.ts";
import type { OpenAIRequest } from "../types/openai.ts";
import { checkContextWindow, estimateTokens } from "../utils/tokenEstimator.ts";
import { validateOpenAIRequest } from "../utils/validation.ts";
import {
  acquireSessionWithCorrections,
  buildDeepseekMessages,
  createDeepseekStreamWithRetry,
  getModelSpecs,
} from "./chatHelpers.ts";
import { handleNonStreamingRequest } from "./chatNonStreaming.ts";
import { handleStreamingRequest } from "./chatStreaming.ts";

export { commonPrefixLen, getNewContent } from "./chatHelpers.ts";

const MAX_MESSAGE_SIZE = 10_000_000;

async function parseRequestBody(c: Context) {
  const rawBody = await c.req.json();

  const validation = validateOpenAIRequest(rawBody);
  if (!validation.ok) {
    const err = new Error(validation.error!) as any;
    err.upstreamStatus = validation.status || 400;
    err.type = "invalid_request_error";
    err.code = validation.code || "invalid_request_error";
    throw err;
  }

  const body = validation.data as unknown as OpenAIRequest;

  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (content && content.length > MAX_MESSAGE_SIZE) {
        const err = new Error(`Message content exceeds maximum size of ${MAX_MESSAGE_SIZE} characters`) as any;
        err.upstreamStatus = 400;
        err.type = "invalid_request_error";
        err.code = "message_too_large";
        throw err;
      }
    }
  }

  let isStream = body.stream ?? false;
  const streamMode = config.get("STREAMING_MODE", "auto");
  if (streamMode === "stream") isStream = true;
  else if (streamMode === "non-stream") isStream = false;
  const toolCalling = config.getBool("TOOL_CALLING", true);
  const cleanOutput = config.getBool("CLEAN_OUTPUT", true);

  const messages = body.messages || [];

  const { maxContext, maxOutput } = await getModelSpecs(body);

  const formattedMessages = messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map((c: any) => c.text || JSON.stringify(c)).join("\n")
      : String(m.content ?? ""),
  }));
  const estimatedTokens = estimateTokens(formattedMessages.map((m) => m.content).join("\n"));
  const contextCheck = checkContextWindow(estimatedTokens, maxContext, maxOutput, body.model as string);

  return {
    body,
    isStream,
    toolCalling,
    cleanOutput,
    messages,
    contextCheck,
    availableTokens: contextCheck.availableTokens,
  };
}

async function setupSession(
  messages: any[],
  body: OpenAIRequest,
  availableTokens: number,
  toolCalling: boolean,
  logId: string,
) {
  const { deepseekMessages: processedMessages } = buildDeepseekMessages(messages, body, availableTokens, toolCalling);

  let lastFailedEmail: string | undefined;
  const isThinkingModel = !body.model.includes("no-thinking");
  const MAX_ACCOUNT_RETRIES = 5;
  let lastError: any;

  for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
    const selectedAccount = await pickAccount(lastFailedEmail);
    const accountEmail = selectedAccount?.email;
    if (!selectedAccount && attempt > 0) {
      throw lastError || new Error("All accounts are rate-limited. Please wait and try again later.");
    }

    let sessionResult: Awaited<ReturnType<typeof acquireSessionWithCorrections>>;
    try {
      sessionResult = await acquireSessionWithCorrections(accountEmail, processedMessages);
    } catch (err) {
      lastFailedEmail = accountEmail;
      lastError = err;
      logStore.log(
        "warn",
        "chat",
        `[Chat] Session acquire failed for ${accountEmail || "?"}: ${err instanceof Error ? err.message : String(err)}`,
      );
      logStore.addError(
        logId,
        `Session acquire failed for ${accountEmail || "?"}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const { session, deepseekMessages: sessionMessages, nextParentId, sessionHeaders, resolvedEmail } = sessionResult;

    logStore.updateEntry(logId, (entry) => {
      entry.accountEmail = resolvedEmail;
    });

    let streamResult: Awaited<ReturnType<typeof createDeepseekStreamWithRetry>>;
    try {
      streamResult = await createDeepseekStreamWithRetry(
        sessionMessages,
        isThinkingModel,
        body.model,
        session.chatId,
        nextParentId,
        resolvedEmail,
      );
    } catch (err: any) {
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);

      logStore.log(
        "debug",
        "chat",
        `[Chat] Request failed on ${resolvedEmail}: ${err.message || err} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `Stream creation failed for ${resolvedEmail}: ${err.message || String(err)}`);

      if (
        err.upstreamStatus === 429 ||
        /RateLimited|QuotaExhausted|TooManyRequests|daily usage limit/i.test(err.message || "")
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      if (
        (err.message || "").includes("FAIL_SYS_USER_VALIDATE") ||
        (err.message || "").includes("CAPTCHA") ||
        err instanceof RetryableDeepseekStreamError
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        if (resolvedEmail) throttleAccount(resolvedEmail, 5 * 60 * 1000);
        continue;
      }
      if (
        err.name === "AbortError" ||
        (err.message || "").includes("timed out") ||
        (err.message || "").includes("timeout") ||
        (err.message || "").includes("ETIMEDOUT") ||
        err.upstreamStatus === 408 ||
        err.upstreamStatus === 504
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      throw err;
    }
    const { stream, abortController } = streamResult;

    const FIRST_CHUNK_MS = 60_000;
    const streamReader = stream.getReader();
    let firstChunk: any;
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      firstChunk = await Promise.race([
        streamReader.read(),
        new Promise<never>((_, reject) => {
          firstChunkTimer = setTimeout(
            () => reject(new Error(`No first chunk from ${resolvedEmail} within ${FIRST_CHUNK_MS / 1000}s`)),
            FIRST_CHUNK_MS,
          );
        }),
      ]);
    } catch (timeoutErr) {
      clearTimeout(firstChunkTimer);
      logStore.log(
        "warn",
        "chat",
        `[Chat] First-chunk timeout for ${resolvedEmail} after stream started (${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `First-chunk timeout for ${resolvedEmail}`);
      streamReader.cancel().catch(() => {});
      abortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      lastFailedEmail = resolvedEmail;
      lastError = timeoutErr as Error;
      continue;
    }
    clearTimeout(firstChunkTimer);

    const reconstructedStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (!firstChunk.done && firstChunk.value) controller.enqueue(firstChunk.value);
        try {
          while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              await new Promise((r) => setTimeout(r, 1));
            }
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    logStore.log("debug", "chat", `[Chat] Request routed to ${resolvedEmail} — stream ready (attempt ${attempt + 1})`);

    return {
      session,
      nextParentId,
      sessionHeaders,
      resolvedEmail,
      stream: reconstructedStream,
      abortController,
    };
  }

  throw lastError || new Error("All accounts are rate-limited. Please wait and try again later.");
}

function populateLogEntry(logEntry: any, body: OpenAIRequest, messages: any[]): void {
  const rawContent = messages.length > 0 ? messages[messages.length - 1].content : "";
  const lastMsg =
    typeof rawContent === "string" ? rawContent : rawContent !== undefined ? JSON.stringify(rawContent) : "";
  logEntry.clientRequest = {
    messageCount: messages.length,
    roles: messages.map((m) => m.role),
    hasTools: !!body.tools?.length,
    toolNames: body.tools?.map((t: any) => t.function?.name || t.name) || [],
    tool_choice: body.tool_choice
      ? typeof body.tool_choice === "string"
        ? body.tool_choice
        : JSON.stringify(body.tool_choice)
      : null,
    lastMessage: lastMsg.substring(0, 300),
    messages: messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
  };
}

export async function chatCompletions(c: Context) {
  const logId = crypto.randomUUID();
  try {
    const parsed = await parseRequestBody(c);
    const { body, isStream, toolCalling, cleanOutput, messages, contextCheck } = parsed;
    logStore.log(
      "debug",
      "chat",
      `[Chat] Request: model=${body.model} stream=${isStream} msgs=${messages.length} tools=${body.tools?.length || 0} msgSizes=[${messages.map((m: any) => `${m.role}:${typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length}`).join(",")}]`,
    );
    logStore.createEntry(logId, body.model, isStream);
    logStore.updateEntry(logId, (entry) => {
      entry.apiType = "openai";
    });
    const logEntry = logStore.getEntry(logId);
    if (logEntry) populateLogEntry(logEntry, body, messages);

    if (!contextCheck.ok) {
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: "", toolCallCount: 0, contentPreview: "" };
        entry.finalResponse.finishReason = "context_window_exceeded";
      });
      logStore.finalizeRequest(logId);
      return c.json(
        {
          error: {
            message: contextCheck.message,
            type: "invalid_request_error",
            param: "messages",
            code: "context_window_exceeded",
          },
        },
        400,
      );
    }

    const { session, nextParentId, sessionHeaders, resolvedEmail, stream, abortController } = await setupSession(
      messages,
      body,
      contextCheck.availableTokens!,
      toolCalling,
      logId,
    );

    const completionId = "chatcmpl-" + crypto.randomUUID();

    if (!isStream) {
      return handleNonStreamingRequest({
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
      });
    }

    return handleStreamingRequest({
      c,
      logId,
      completionId,
      body,
      session,
      initialParentId: nextParentId,
      sessionHeaders,
      resolvedEmail,
      stream,
      deepseekAbortController: abortController,
      toolCalling,
      cleanOutput,
    });
  } catch (err: any) {
    logStore.log("error", "chat", `[Chat] Error: ${err.message || String(err)}`);
    logStore.addError(logId, err.message || String(err));
    logStore.finalizeRequest(logId, "error");
    const status = err.upstreamStatus || 500;
    const cleanMessage =
      cleanTextOfXmlArtifacts(err.message || String(err)).cleanedText || err.message || "Internal error";
    return c.json(
      {
        error: {
          message: cleanMessage,
          type: err.type || "server_error",
          code: err.code || undefined,
        },
      },
      status,
    );
  }
}
