import { Hono } from "hono";
import { config, DEFAULT_CONFIG, isValidKey, updateClaudeCodeSettings } from "../services/configService.ts";

export const configRouter = new Hono();

configRouter.get("/", (c) => {
  const all = config.getAll();
  const safe = Object.fromEntries(Object.entries(all).filter(([k]) => !["API_KEY"].includes(k)));
  const envOverrides = (Object.keys(DEFAULT_CONFIG) as (keyof typeof DEFAULT_CONFIG)[]).filter(
    (key) => process.env[key] !== undefined,
  );
  return c.json({ config: safe, envOverrides });
});

configRouter.put("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Body must be a JSON object" }, 400);
  }

  const invalidKeys: string[] = [];
  const validKeys: string[] = [];

  for (const key of Object.keys(body)) {
    if (isValidKey(key)) {
      const val = body[key];
      if (typeof val !== "string") {
        return c.json({ error: `Value for '${key}' must be a string` }, 400);
      }
      config.set(key, val);
      validKeys.push(key);
    } else {
      invalidKeys.push(key);
    }
  }

  if (invalidKeys.length > 0) {
    return c.json(
      {
        error: `Invalid config key(s): ${invalidKeys.join(", ")}`,
        validKeys,
      },
      400,
    );
  }

  config.save();
  const all = config.getAll();
  updateClaudeCodeSettings(all);
  const safe = Object.fromEntries(Object.entries(all).filter(([k]) => !["API_KEY"].includes(k)));
  return c.json({ config: safe });
});
