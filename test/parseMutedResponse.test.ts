import { expect, test } from "bun:test";
import { parseMutedResponse } from "../src/services/deepseek.ts";

test("muted envelope is detected with mute_until", () => {
  const body = JSON.stringify({
    code: 0,
    msg: "",
    data: { biz_code: 5, biz_msg: "user is muted", biz_data: { is_muted: 1, mute_until: Date.now() / 1000 + 3600 } },
  });
  const r = parseMutedResponse(body);
  expect(r).not.toBeNull();
  expect(r!.throttleMs).toBeGreaterThan(3500_000);
  expect(r!.throttleMs).toBeLessThanOrEqual(3600_000);
});

test("suspension message without mute_until defaults to 24h", () => {
  const body = JSON.stringify({ data: { biz_msg: "account suspended due to violation of user policies" } });
  const r = parseMutedResponse(body);
  expect(r).not.toBeNull();
  expect(r!.throttleMs).toBe(24 * 3_600_000);
});

test("normal SSE or non-muted JSON returns null", () => {
  expect(parseMutedResponse("data: {\"v\":\"hello\"}")).toBeNull();
  expect(parseMutedResponse(JSON.stringify({ code: 0, data: { biz_code: 0 } }))).toBeNull();
  expect(parseMutedResponse("")).toBeNull();
});

test("past mute_until floors at 60s", () => {
  const body = JSON.stringify({
    data: { biz_msg: "muted", biz_data: { is_muted: 1, mute_until: Date.now() / 1000 - 10 } },
  });
  const r = parseMutedResponse(body);
  expect(r!.throttleMs).toBe(60_000);
});
