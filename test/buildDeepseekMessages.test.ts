import { expect, test } from "bun:test";

import { buildDeepseekMessages } from "../src/routes/chatHelpers.ts";
import type { Message, OpenAIRequest } from "../src/types/openai.ts";

const body: OpenAIRequest = { model: "deepseek-v4-flash", messages: [] };

test("tool-call round-trip: assistant tool_calls echo + tool result reach the model", () => {
  const messages: Message[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "What is the weather in Paris?" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris", units: "metric" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "Sunny, 21C" },
    { role: "user", content: "Summarize it." },
  ];

  const { deepseekMessages } = buildDeepseekMessages(messages, body, 100_000, true);
  expect(deepseekMessages).toHaveLength(1);
  const content = String(deepseekMessages[0].content);

  expect(content).toContain("<system>\nYou are helpful.\n</system>");
  expect(content).toContain("<assist>");
  expect(content).toContain('<｜｜DSML｜｜invoke name="get_weather">');
  expect(content).toContain('<｜｜DSML｜｜parameter name="city" string="true">Paris</｜｜DSML｜｜parameter>');
  expect(content).toContain('<｜｜DSML｜｜parameter name="units" string="true">metric</｜｜DSML｜｜parameter>');
  expect(content).toContain("</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>");
  expect(content).toContain("<tool_result>\nSunny, 21C\n</tool_result>");
  expect(content.match(/<user>/g)).toHaveLength(2);
});

test("assistant tool_calls with non-string args are JSON-encoded", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_2",
          type: "function",
          function: { name: "search", arguments: JSON.stringify({ limit: 5, tags: ["a", "b"] }) },
        },
      ],
    },
  ];

  const { deepseekMessages } = buildDeepseekMessages(messages, body, 100_000, true);
  const content = String(deepseekMessages[0].content);

  expect(content).toContain('<｜｜DSML｜｜parameter name="limit" string="true">5</｜｜DSML｜｜parameter>');
  expect(content).toContain('<｜｜DSML｜｜parameter name="tags" string="true">[&quot;a&quot;,&quot;b&quot;]</｜｜DSML｜｜parameter>');
});
