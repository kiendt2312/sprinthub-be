import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClient } from "redis";
import { DEFAULT_REDIS_URL } from "../src/client.js";

const exec = promisify(execFile);
const composeFile = fileURLToPath(new URL("../compose.yaml", import.meta.url));
const compose = ["compose", "-f", composeFile];

export async function docker(...args: string[]) {
  const { stdout } = await exec("docker", args, { timeout: 30_000 });
  return stdout.trim();
}

function createProbeClient() {
  return createClient({
    url: DEFAULT_REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: 1_000, socketTimeout: 1_000 },
  }).on("error", () => { /* The command or connect promise carries the error. */ });
}

async function probeRedis<T>(probe: (client: ReturnType<typeof createProbeClient>) => Promise<T>) {
  const client = createProbeClient();
  try {
    await client.connect();
    return await probe(client);
  } finally {
    if (client.isOpen) client.destroy();
  }
}

function redisRunId(info: string) {
  return /^run_id:([0-9a-f]{40})\r?$/m.exec(info)?.[1];
}

export async function getSpikeContainerId() {
  assert.equal(process.env.REDIS_URL ?? DEFAULT_REDIS_URL, DEFAULT_REDIS_URL,
    `Persistence drills require ${DEFAULT_REDIS_URL}`);
  const id = await docker(...compose, "ps", "--quiet", "redis");
  assert.match(id, /^[0-9a-f]{64}$/, "Start this worktree's Redis with docker compose up -d");

  const [configFile, runningImage] = (await docker("inspect", "--format",
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}\n{{.Config.Image}}', id)).split("\n");
  assert.equal(configFile, composeFile, "The running Compose service belongs to another worktree");
  const pinnedImage = await docker(...compose, "config", "--images", "redis");
  assert.match(pinnedImage, /@sha256:[0-9a-f]{64}$/);
  assert.equal(runningImage, pinnedImage, "The running service does not use the pinned image");

  const containerRunId = redisRunId(await docker("exec", id, "redis-cli", "--raw", "INFO", "server"));
  assert.ok(containerRunId, "Could not identify the Redis process in the container");
  const socketRunId = redisRunId(await probeRedis(client => client.info("server")));
  assert.equal(socketRunId, containerRunId, "The Redis endpoint does not point at the Compose container");
  return id;
}

export async function waitForRedis() {
  const deadline = performance.now() + 30_000;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      assert.equal(await probeRedis(client => client.ping()), "PONG");
      return;
    } catch (error) {
      lastError = error;
      await setTimeout(100);
    }
  }
  throw new Error("Redis did not return PONG after restart", { cause: lastError });
}
