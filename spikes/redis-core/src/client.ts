import { createClient } from "redis";

export const DEFAULT_REDIS_URL = "redis://127.0.0.1:6390";

export function createRedisClient(url = process.env.REDIS_URL ?? DEFAULT_REDIS_URL) {
  return createClient({ url, socket: { reconnectStrategy: false } })
    .on("error", (error: Error) => console.error("Redis client error:", error.message));
}
