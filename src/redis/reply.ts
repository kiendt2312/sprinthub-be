export type BoardColumn = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE';

export type FunctionReply =
  | { ok: true; data: unknown; seq: number | null; rebalancedColumn?: BoardColumn }
  | { ok: false; code: string; params: Record<string, unknown> };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeReply(raw: unknown): FunctionReply {
  if (typeof raw !== "string") {
    throw new Error("Redis Function reply must be a JSON string");
  }

  let reply: unknown;
  try {
    reply = JSON.parse(raw);
  } catch (cause) {
    throw new Error("Redis Function reply is not valid JSON", { cause });
  }

  if (isObject(reply)) {
    if (
      reply.ok === true && Object.hasOwn(reply, "data") &&
      (reply.seq === null || (typeof reply.seq === "number" && Number.isSafeInteger(reply.seq)))
    ) {
      const column = reply.rebalancedColumn;
      const result = { ok: true as const, data: reply.data, seq: reply.seq };
      if (column === undefined) return result;
      if (column === 'TODO' || column === 'IN_PROGRESS' || column === 'IN_REVIEW' || column === 'DONE') {
        return { ...result, rebalancedColumn: column };
      }
    }
    if (reply.ok === false && typeof reply.code === "string" && isObject(reply.params)) {
      return { ok: false, code: reply.code, params: reply.params };
    }
  }

  throw new Error("Redis Function reply must have {ok: true, data, seq} or {ok: false, code, params}");
}
