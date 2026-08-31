import { Hono } from "hono";

export const modelsRouter = new Hono();

interface ModelInfo {
  id: string;
  created: number;
  context_window: number;
  max_output_tokens: number;
  modalities: string[];
  description: string;
  capabilities: Record<string, boolean>;
}

// NOTE: DeepSeek's web API does not expose a model-listing endpoint; it only
// distinguishes `model_type: "default" | "expert"` on the chat wire protocol.
// The ids below are this gateway's public names for those two model types.
// Numeric limits are enforced in routes/chatHelpers.ts (MODEL_LIMITS) and are
// estimates, not official DeepSeek specs.
const MODELS: ModelInfo[] = [
  {
    id: "deepseek-v4-flash",
    created: 1785456000,
    context_window: 1_000_000,
    max_output_tokens: 384_000,
    modalities: ["text"],
    description:
      "DeepSeek default chat model (web `model_type: default`). General-purpose conversational model with tool use and search support.",
    capabilities: { thinking: false, document: true, search: true },
  },
  {
    id: "deepseek-v4-pro",
    created: 1786579200,
    context_window: 1_000_000,
    max_output_tokens: 384_000,
    modalities: ["text"],
    description:
      "DeepSeek expert model (web `model_type: expert`). Deeper reasoning model tuned for complex, multi-step problems.",
    capabilities: { thinking: true, document: true, search: true },
  },
];

modelsRouter.get("/models", (c) =>
  c.json({
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created,
      owned_by: "deepseek",
      permission: [],
      root: m.id,
      parent: null,
      context_window: m.context_window,
      max_output_tokens: m.max_output_tokens,
      modalities: m.modalities,
      description: m.description,
      capabilities: m.capabilities,
    })),
  }),
);
