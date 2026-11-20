import { parseArgs } from "node:util";
import { RedisStore } from '../src/redis/client.js';
import { readConfig } from '../src/platform/config.js';
import { startupFailed } from '../src/platform/log.js';
import { createKeys } from "../src/redis/keys.js";

import { scanByPrefix } from './index-scan.js';

type Client = RedisStore["client"];

export type WorkspaceIndexFinding = {
  type: "missing" | "orphan" | "duplicate" | "wrong-pointer" | "bad-score";
  workspaceId?: string;
  userId?: string;
  key?: string;
  index?: string;
  expected?: string;
  actual?: string;
  score?: number | string;
  detail?: string;
};

export type WorkspaceIndexReport = { ok: boolean; findings: WorkspaceIndexFinding[] };

type WorkspaceDoc = {
  id: string;
  ownerId: string;
  slug: string;
  createdAtMs: number;
  version: number;
};

const ROLES = new Set(["OWNER", "ADMIN", "MEMBER"]);

function isWorkspaceDoc(value: unknown, id: string): value is WorkspaceDoc {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ws = value as Partial<WorkspaceDoc>;
  return id !== "" && ws.id === id && typeof ws.ownerId === "string" &&
    typeof ws.slug === "string" && ws.slug.length > 0 &&
    typeof ws.createdAtMs === "number" && Number.isSafeInteger(ws.createdAtMs) &&
    typeof ws.version === "number" && Number.isSafeInteger(ws.version) && ws.version > 0;
}

/** Read canonical workspace/membership documents and every reciprocal index. */
export async function verifyWorkspaceIndexes(
  client: Client,
  keys = createKeys(),
): Promise<WorkspaceIndexReport> {
  const findings: WorkspaceIndexFinding[] = [];
  const workspaces = new Map<string, WorkspaceDoc>();
  const memberships = new Map<string, Map<string, string>>();

  async function hasType(key: string, expected: string) {
    const actual = await client.type(key);
    if (actual === expected) return true;
    findings.push({ type: "wrong-pointer", key, expected, actual, detail: "Redis key type" });
    return false;
  }

  const memberPrefix = `${keys.prefix}workspace-members:`;
  for (const key of await scanByPrefix(client, `${keys.prefix}workspace:`)) {
    const id = key.slice(`${keys.prefix}workspace:`.length);
    if (!await hasType(key, "ReJSON-RL")) continue;
    const value = await client.json.get(key);
    if (!isWorkspaceDoc(value, id)) {
      findings.push({ type: "wrong-pointer", key, workspaceId: id, detail: "Invalid workspace document or ID" });
      continue;
    }
    workspaces.set(id, value);
  }

  for (const key of await scanByPrefix(client, memberPrefix)) {
    const id = key.slice(memberPrefix.length);
    if (!await hasType(key, "hash")) continue;
    const members = await client.hGetAll(key);
    const roles = new Map(Object.entries(members));
    memberships.set(id, roles);
    if (!workspaces.has(id)) findings.push({ type: "orphan", workspaceId: id, index: key });
    const owners = [...roles].filter(([, role]) => role === "OWNER").map(([userId]) => userId);
    const workspace = workspaces.get(id);
    if (owners.length !== 1 || workspace && (owners[0] !== workspace.ownerId || roles.get(workspace.ownerId) !== "OWNER")) {
      findings.push({ type: "wrong-pointer", workspaceId: id, key, expected: workspace?.ownerId,
        actual: owners.join(","), detail: "Workspace must have one OWNER matching ownerId" });
    }
    for (const [userId, role] of roles) {
      if (!ROLES.has(role)) findings.push({ type: "wrong-pointer", workspaceId: id, userId, index: key, actual: role, detail: "Invalid role" });
    }
  }

  const expectedSlugs = new Map<string, string>();
  const readableSlugIndexes = new Set<string>();
  const expectedCreated = new Map<string, number>();
  for (const [id, workspace] of workspaces) {
    const slugKey = keys.workspaceSlug(workspace.slug);
    const prior = expectedSlugs.get(slugKey);
    if (prior) findings.push({ type: "duplicate", workspaceId: id, key: slugKey, actual: prior });
    expectedSlugs.set(slugKey, id);
    expectedCreated.set(id, workspace.createdAtMs);
    const members = memberships.get(id);
    if (!members?.has(workspace.ownerId)) findings.push({ type: "missing", workspaceId: id, userId: workspace.ownerId, index: memberPrefix + id });
  }

  for (const key of await scanByPrefix(client, `${keys.prefix}workspace-slug:`)) {
    if (!await hasType(key, "string")) continue;
    readableSlugIndexes.add(key);
    const actual = await client.get(key) ?? "";
    const expected = expectedSlugs.get(key);
    if (!expected) findings.push({ type: "orphan", key, actual });
    else if (actual !== expected) findings.push({ type: "wrong-pointer", key, expected, actual });
  }
  for (const [key, workspaceId] of expectedSlugs) {
    if (!readableSlugIndexes.has(key) && await client.exists(key)) continue;
    const actual = await client.get(key);
    if (actual !== workspaceId) findings.push({ type: "missing", workspaceId, key, expected: workspaceId, actual: actual ?? undefined });
  }

  const createdKey = keys.workspacesByCreated();
  const createdExists = await client.exists(createdKey);
  if (createdExists && await hasType(createdKey, "zset")) {
    const rows = await client.zRangeWithScores(createdKey, 0, -1);
    const actual = new Map<string, number>();
    for (const { value: id, score } of rows) {
      actual.set(id, score);
      if (!Number.isSafeInteger(score)) findings.push({ type: "bad-score", workspaceId: id, index: createdKey, score });
      if (!workspaces.has(id)) findings.push({ type: "orphan", workspaceId: id, index: createdKey });
      else if (workspaces.get(id)?.createdAtMs !== score) findings.push({ type: "wrong-pointer", workspaceId: id, index: createdKey, expected: String(workspaces.get(id)?.createdAtMs), actual: String(score) });
    }
    for (const [id, score] of expectedCreated) {
      if (actual.get(id) !== score) findings.push({ type: "missing", workspaceId: id, index: createdKey, expected: String(score), actual: String(actual.get(id)) });
    }
  } else if (!createdExists) {
    for (const [id, score] of expectedCreated) {
      findings.push({ type: "missing", workspaceId: id, index: createdKey, expected: String(score) });
    }
  }

  const expectedUserWorkspaces = new Map<string, Set<string>>();
  for (const [workspaceId, members] of memberships) {
    for (const userId of members.keys()) {
      const set = expectedUserWorkspaces.get(userId) ?? new Set<string>();
      set.add(workspaceId);
      expectedUserWorkspaces.set(userId, set);
    }
  }
  const actualUserWorkspaces = new Map<string, Set<string>>();
  for (const key of await scanByPrefix(client, `${keys.prefix}user-workspaces:`)) {
    const userId = key.slice(`${keys.prefix}user-workspaces:`.length);
    if (!await hasType(key, "set")) continue;
    const values = new Set(await client.sMembers(key));
    actualUserWorkspaces.set(userId, values);
    for (const workspaceId of values) {
      if (!workspaces.has(workspaceId) || !memberships.get(workspaceId)?.has(userId)) {
        findings.push({ type: "orphan", workspaceId, userId, index: key });
      }
    }
  }
  for (const [userId, expected] of expectedUserWorkspaces) {
    const actual = actualUserWorkspaces.get(userId) ?? new Set<string>();
    for (const workspaceId of expected) if (!actual.has(workspaceId)) findings.push({ type: "missing", workspaceId, userId, index: keys.userWorkspaces(userId) });
    for (const workspaceId of actual) if (!expected.has(workspaceId)) findings.push({ type: "wrong-pointer", workspaceId, userId, index: keys.userWorkspaces(userId) });
  }

  async function checkPageIndex(key: string, expected: Set<string>, label: string) {
    if (!await hasType(key, "zset")) {
      if (await client.type(key) === "none") {
        for (const value of expected) findings.push({ type: "missing", index: key, expected: value });
      }
      return;
    }
    const rows = await client.zRangeWithScores(key, 0, -1);
    const actual = new Set<string>();
    for (const { value, score } of rows) {
      actual.add(value);
      if (score !== 0) findings.push({ type: "bad-score", index: key, score, detail: `${label} page index score must be zero` });
      if (!expected.has(value)) findings.push({ type: "orphan", index: key, actual: value });
    }
    for (const value of expected) if (!actual.has(value)) findings.push({ type: "missing", index: key, expected: value });
  }

  for (const [userId, expected] of expectedUserWorkspaces) {
    await checkPageIndex(keys.userWorkspacesPage(userId), expected, "user workspace");
  }
  for (const [workspaceId, members] of memberships) {
    await checkPageIndex(keys.workspaceMembersPage(workspaceId), new Set(members.keys()), "workspace member");
  }
  for (const pageKey of await scanByPrefix(client, `${keys.prefix}user-workspaces-page:`)) {
    const userId = pageKey.slice(`${keys.prefix}user-workspaces-page:`.length);
    if (!expectedUserWorkspaces.has(userId)) await checkPageIndex(pageKey, new Set(), "user workspace");
  }
  for (const pageKey of await scanByPrefix(client, `${keys.prefix}workspace-members-page:`)) {
    const workspaceId = pageKey.slice(`${keys.prefix}workspace-members-page:`.length);
    if (!memberships.has(workspaceId)) await checkPageIndex(pageKey, new Set(), "workspace member");
  }
  return { ok: findings.length === 0, findings };
}

async function main() {
  const { values } = parseArgs({ options: { "report-only": { type: "boolean" } } });
  const redis = new RedisStore(readConfig('maintenance'), 'maintenance');
  const { client } = redis;
  await redis.connect();
  try {
    const report = await verifyWorkspaceIndexes(client, redis.keys);
    console.log(JSON.stringify(report, null, 2));
    if (!values["report-only"] && !report.ok) process.exitCode = 1;
  } finally {
    redis.close();
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => startupFailed('maintenance', error));
}
