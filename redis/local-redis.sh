#!/bin/sh
set -euf
prefix=${REDIS_KEY_PREFIX:-sh:v1:}
case "$prefix" in *[!a-zA-Z0-9:_-]*|*[!:]) exit 1;; esac

password_hash() {
  [ -n "$1" ]
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

task_keys='workspace:* workspace-members:* project:* project-task-seq:* workspace-task-keys:* task:* project-tasks:* board:* user-assigned:* user-workspaces:* workspace-seq:* workspace-changes:* stream:domain-events idempotency:*'
task_commands='+ping +fcall +fcall_ro +type +exists +hexists +get +set +incr +hget +hsetnx +hdel +sadd +srem +sismember +scard +zadd +zrem +zcard +zrange +zrank +zscore +xadd +json.get +json.set +json.mset'
task_patterns=''
for family in $task_keys; do task_patterns="$task_patterns ~$prefix$family"; done
auth_patterns=''
for family in user:* user-email:* users-by-created user-sessions:* session:* ratelimit:*; do
  auth_patterns="$auth_patterns ~$prefix$family"
done
auth_commands='+time +smembers +hgetall +hset +pexpireat +pttl +expire +del'
settings="~${prefix}platform-settings"

acl=$(mktemp)
printf '%s\n' \
  'user default off' \
  "user sh-app on #$(password_hash "$REDIS_APP_PASSWORD") $task_patterns $auth_patterns $task_commands $auth_commands (+fcall $task_patterns $auth_patterns $settings) (+type +hget $settings)" \
  "user sh-worker on #$(password_hash "$REDIS_WORKER_PASSWORD") $task_patterns $task_commands" \
  "user sh-maint on #$(password_hash "$REDIS_MAINT_PASSWORD") ~$prefix* &* +@all" > "$acl"
chown redis:redis "$acl"
exec /usr/local/bin/docker-entrypoint.sh redis-server /etc/sprinthub/redis.conf --aclfile "$acl"
