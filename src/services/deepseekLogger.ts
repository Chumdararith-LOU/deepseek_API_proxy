import type { ParsedToolCall } from "../types/openai.ts";
import type { DeepseekPayload } from "./deepseek.ts";

// deepseekLogger — disabled. Only gate logs (logStore) are written to disk.
// Request/response/SSE files from the upstream Deepseek API are no longer written.
// Keeping function signatures to avoid breaking callers.

export function logDeepseekRequest(_payload: DeepseekPayload, _url: string): string {
  return "";
}

export function logDeepseekResponse(
  _requestFile: string,
  _status: number,
  _statusText: string,
  _headers: Record<string, string>,
  _responsePreview: string,
): void {
  // no-op
}

export function logDeepseekSSE(
  _logFile: string | undefined,
  _sseEvents: number,
  _toolCallEvents: number,
  _toolCalls: ParsedToolCall[],
): void {
  // no-op
}
