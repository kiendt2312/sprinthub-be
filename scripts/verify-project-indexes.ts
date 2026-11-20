import { parseArgs } from 'node:util';
import { readConfig } from '../src/platform/config.js';
import { startupFailed } from '../src/platform/log.js';
import { RedisStore } from '../src/redis/client.js';
import { createKeys } from '../src/redis/keys.js';
import { scanByPrefix } from './index-scan.js';

type Client = RedisStore['client'];
type ProjectPointer = { id: string; workspaceId: string; key: string };
type Finding = {
  type: 'missing' | 'orphan' | 'wrong-pointer' | 'duplicate' | 'bad-score';
  index: string;
  projectId?: string;
  actual?: string | number;
};

function projectPointer(doc: unknown, id: string): ProjectPointer | undefined {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return;
  const { id: docId, workspaceId, key } = doc as Partial<ProjectPointer>;
  if (docId === id && typeof workspaceId === 'string' && /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(workspaceId)
    && typeof key === 'string' && /^[A-Z0-9]{2,10}$/.test(key)) return { id, workspaceId, key };
}

export async function verifyProjectIndexes(client: Client, keys = createKeys()) {
  const projectPrefix = keys.project('');
  const projects = new Map<string, ProjectPointer>();
  const uniqueKeys = new Map<string, string>();
  const activeWorkspaces = new Map<string, boolean>();
  const findings: Finding[] = [];

  for (const index of await scanByPrefix(client, projectPrefix)) {
    const projectId = index.slice(projectPrefix.length);
    const kind = await client.type(index);
    const project = kind === 'ReJSON-RL' ? projectPointer(await client.json.get(index), projectId) : undefined;
    if (!project) {
      findings.push({ type: 'wrong-pointer', index, projectId });
      continue;
    }
    projects.set(projectId, project);
    const workspaceKey = keys.workspace(project.workspaceId);
    if (!activeWorkspaces.has(workspaceKey)) {
      const workspace = await client.type(workspaceKey) === 'ReJSON-RL'
        ? await client.json.get(workspaceKey) as { id?: string; archivedAt?: unknown } | null : null;
      activeWorkspaces.set(workspaceKey, workspace?.id === project.workspaceId && workspace.archivedAt == null);
    }
    if (!activeWorkspaces.get(workspaceKey)) findings.push({ type: 'wrong-pointer', index: workspaceKey, projectId });

    const unique = keys.projectKey(project.workspaceId, project.key);
    const claim = uniqueKeys.get(unique);
    if (claim) findings.push({ type: 'duplicate', index: unique, projectId, actual: claim });
    else uniqueKeys.set(unique, projectId);
  }

  async function checkMembershipIndexes(
    prefix: string,
    kind: 'set' | 'zset',
    expectedIndex: (workspaceId: string) => string,
  ) {
    const seen = new Map<string, Set<string>>();
    for (const index of await scanByPrefix(client, prefix)) {
      const actualKind = await client.type(index);
      if (actualKind !== kind) {
        findings.push({ type: 'wrong-pointer', index, actual: actualKind });
        continue;
      }
      const entries = kind === 'set'
        ? (await client.sMembers(index)).map(value => ({ value, score: 0 }))
        : await client.zRangeWithScores(index, 0, -1);
      seen.set(index, new Set(entries.map(entry => entry.value)));
      for (const { value: projectId, score } of entries) {
        const project = projects.get(projectId);
        if (score !== 0) findings.push({ type: 'bad-score', index, projectId, actual: Number.isFinite(score) ? score : String(score) });
        if (!project) findings.push({ type: 'orphan', index, projectId });
        else if (index !== expectedIndex(project.workspaceId)) findings.push({ type: 'wrong-pointer', index, projectId });
      }
    }
    for (const project of projects.values()) {
      const index = expectedIndex(project.workspaceId);
      if (!seen.get(index)?.has(project.id)) findings.push({ type: 'missing', index, projectId: project.id });
    }
  }
  await checkMembershipIndexes(keys.workspaceProjects(''), 'set', keys.workspaceProjects);
  await checkMembershipIndexes(keys.workspaceProjectsPage(''), 'zset', keys.workspaceProjectsPage);

  const seenUniqueKeys = new Set<string>();
  for (const index of await scanByPrefix(client, keys.projectKey('', '').slice(0, -1))) {
    seenUniqueKeys.add(index);
    const projectId = uniqueKeys.get(index);
    const kind = await client.type(index);
    const actual = kind === 'string' ? await client.get(index) : null;
    if (!projectId) findings.push({ type: 'orphan', index, actual: actual ?? kind });
    else if (actual !== projectId) findings.push({ type: 'wrong-pointer', index, projectId, actual: actual ?? kind });
  }
  for (const [index, projectId] of uniqueKeys) {
    if (!seenUniqueKeys.has(index)) findings.push({ type: 'missing', index, projectId });
  }
  return { ok: findings.length === 0, findings };
}

async function main() {
  const { values } = parseArgs({ options: { 'report-only': { type: 'boolean' } } });
  const redis = new RedisStore(readConfig('maintenance'), 'maintenance');
  await redis.connect();
  try {
    const report = await verifyProjectIndexes(redis.client, redis.keys);
    console.log(JSON.stringify(report, null, 2));
    if (!values['report-only'] && !report.ok) process.exitCode = 1;
  } finally {
    redis.close();
  }
}

if (import.meta.main) await main().catch((error: unknown) => startupFailed('maintenance', error));
