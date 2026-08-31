import { expect, test } from "bun:test";
import { extractDeltaContent } from "../src/routes/chatHelpersCore.ts";

test("bare snapshot frame (object v, no p/o) is extracted — first token not dropped", () => {
  const snapshot = { v: { response: { fragments: [{ type: "RESPONSE", content: "I" }] } } };
  const r1 = extractDeltaContent(snapshot, null, 0, "", null);
  expect(r1.foundStr).toBe(true);
  expect(r1.vStr).toBe("I");
  expect(r1.activePath).toBe("response/fragments/-1/content");

  const append = { o: "APPEND", p: "response/fragments/-1/content", v: "'ll" };
  const r2 = extractDeltaContent(append, null, 0, "", r1.activePath);
  expect(r2.foundStr).toBe(true);
  expect(r2.vStr).toBe("'ll");
});

test("snapshot frame without response wrapper is extracted", () => {
  const snapshot = { v: { fragments: [{ type: "RESPONSE", content: "Done" }] } };
  const r = extractDeltaContent(snapshot, null, 0, "", null);
  expect(r.foundStr).toBe(true);
  expect(r.vStr).toBe("Done");
});

test("snapshot frame without RESPONSE content yields nothing", () => {
  const snapshot = { v: { response: { fragments: [{ type: "THINKING", content: "hmm" }] } } };
  const r = extractDeltaContent(snapshot, null, 0, "", null);
  expect(r.foundStr).toBe(false);
  expect(r.vStr).toBe("");
});
