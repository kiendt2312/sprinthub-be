import { expect, it } from "vitest";
import { decodeReply } from "../src/reply.js";

it("decodes a successful reply with data and seq", () => {
  expect(decodeReply('{"ok":true,"data":{"id":"tsk_1"},"seq":2}')).toEqual({
    ok: true,
    data: { id: "tsk_1" },
    seq: 2,
  });
});

it("preserves a business error's code and params", () => {
  expect(decodeReply('{"ok":false,"code":"TASK_VERSION_CONFLICT","params":{"currentVersion":7}}'))
    .toEqual({ ok: false, code: "TASK_VERSION_CONFLICT", params: { currentVersion: 7 } });
});

it("reports malformed JSON and non-string replies", () => {
  expect(() => decodeReply("{oops")).toThrow("Redis Function reply is not valid JSON");
  expect(() => decodeReply(null)).toThrow("Redis Function reply must be a JSON string");
});

it.each([
  "null",
  '{"ok":"true","data":{},"seq":1}',
  '{"ok":true,"seq":1}',
  '{"ok":true,"data":null,"seq":"1"}',
  '{"ok":true,"data":{},"seq":1.5}',
  '{"ok":false,"code":"NOT_FOUND"}',
  '{"ok":false,"code":"NOT_FOUND","params":[]}',
])("rejects JSON outside the Function reply contract (%s)", (reply) => {
  expect(() => decodeReply(reply)).toThrow("Redis Function reply must have");
});
