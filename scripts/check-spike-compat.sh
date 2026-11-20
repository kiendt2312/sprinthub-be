#!/usr/bin/env bash
set -euo pipefail

# Use a disposable copy, preserving the archived source and its fixture data.
root=$(cd "$(dirname "$0")/.." && pwd)
version=${1:?Usage: scripts/check-spike-compat.sh LIB_VERSION [--bench]}
[[ "$version" =~ ^[0-9]+$ ]]
stage=$(mktemp -d)
export COMPOSE_PROJECT_NAME=sprinthub-spike-check-$$
cleanup() {
  docker compose --project-directory "$stage" down --volumes
  rm -rf -- "$stage"
}
trap cleanup EXIT
git -C "$root" archive HEAD spikes/redis-core | tar -x --strip-components=2 -C "$stage"
cp "$root/redis/functions/sprinthub.lua" "$stage/functions/sprinthub.lua"
sed -i "s/sh_lib_version\")).toBe(1)/sh_lib_version\")).toBe($version)/" "$stage/test/integration/core.test.ts"
cd "$stage"
corepack pnpm install --frozen-lockfile
docker compose up -d
for _ in {1..50}; do
  if docker compose exec -T redis redis-cli ping 2>/dev/null | grep -qx PONG; then break; fi
  sleep .2
done
corepack pnpm seed
corepack pnpm load
corepack pnpm test
corepack pnpm scenarios
if [[ "${2:-}" == "--bench" ]]; then
  corepack pnpm bench
fi
