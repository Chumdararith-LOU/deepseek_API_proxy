import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SESSION_DIR = process.env.DEEPSEEK_SESSION_DIR ?? join(homedir(), ".deepseek-api");
export const PROFILE_DIR = process.env.DEEPSEEK_PROFILE_DIR ?? join(SESSION_DIR, "browser-profile");

// Get the directory of this file (src/utils/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root is two levels up from src/utils/
export const PROJECT_ROOT = resolve(__dirname, "..", "..");

/**
 * Resolve a path relative to the project root.
 * Use this instead of process.cwd() to ensure paths work
 * regardless of where the CLI is invoked from.
 */
export function projectPath(...segments: string[]): string {
  return resolve(PROJECT_ROOT, ...segments);
}
