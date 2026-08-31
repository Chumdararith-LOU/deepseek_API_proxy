export interface ScreencastResult {
  error?: string;
}

export async function startScreencast(_email: string, _password: string, _ws: unknown): Promise<ScreencastResult> {
  return { error: "not implemented" };
}

export function handleInputEvent(_email: string, _event: unknown): void {}

export function closeScreencast(_email: string): void {}
