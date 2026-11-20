#!/bin/sh
set -eu
prefix=${REDIS_KEY_PREFIX:-sh:v1:}
case "$prefix" in *[!a-zA-Z0-9:_-]*|*[!:]) exit 1;; esac

password_hash() {
  [ -n "$1" ]
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

runtime_keys='workspace:* workspace-members:* project:* project-task-seq:* workspace-task-keys:* task:* project-tasks:* board:* user-assigned:* user-workspaces:* workspace-seq:* workspace-changes:* stream:domain-events idempotency:*'
runtime_commands='+ping +fcall +fcall_ro +type +exists +hexists +get +set +incr +hget +hsetnx +hdel +sadd +srem +sismember +scard +zadd +zrem +zcard +zrange +zrank +zscore +xadd +json.get +json.set +json.mset'
keys=''
for family in $runtime_keys; do keys="$keys ~$prefix$family"; done

acl=$(mktemp)
printf '%s\n' \
  'user default off' \
  "user sh-app on #$(password_hash "$REDIS_APP_PASSWORD") $keys $runtime_commands" \
  "user sh-worker on #$(password_hash "$REDIS_WORKER_PASSWORD") $keys $runtime_commands" \
  "user sh-maint on #$(password_hash "$REDIS_MAINT_PASSWORD") ~$prefix* &* +@all" > "$acl"
chown redis:redis "$acl"
exec /usr/local/bin/docker-entrypoint.sh redis-server /etc/sprinthub/redis.conf --aclfile "$acl"
