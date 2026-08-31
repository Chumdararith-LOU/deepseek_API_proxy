export interface ChatOptions {
  modelType: string;
  prompt: string;
  stream?: boolean;
}

export interface ChatChunk {
  delta: string;
  done: boolean;
}

export function chatStream(_options: ChatOptions): AsyncGenerator<ChatChunk> {
  throw new Error("not implemented");
}

export async function chat(_options: ChatOptions): Promise<string> {
  throw new Error("not implemented");
}
