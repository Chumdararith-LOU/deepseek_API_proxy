export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type?: "function";
  function?: { name: string; description?: string; parameters?: Record<string, unknown> };
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  tool_choice?: string | Record<string, unknown>;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
}
