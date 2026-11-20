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
workspace_patterns=''
for family in workspace-slug:* workspaces-by-created user-workspaces-page:* workspace-members-page:*; do
  workspace_patterns="$workspace_patterns ~$prefix$family"
done
project_patterns=''
for family in workspace-projects:* workspace-projects-page:* project-key:* backlog:*; do
  project_patterns="$project_patterns ~$prefix$family"
done
worker_patterns=''
for family in job:unassign-* unassign-jobs-by-due lock:unassign:* fence:unassign:* stream:dead-letter processed:dlq:*; do
  worker_patterns="$worker_patterns ~$prefix$family"
done
settings="~${prefix}platform-settings"
audit="~${prefix}stream:audit"
domain="~${prefix}stream:domain-events"

acl=$(mktemp)
printf '%s\n' \
  'user default off' \
  "user sh-app on #$(password_hash "$REDIS_APP_PASSWORD") $task_patterns $workspace_patterns $project_patterns $auth_patterns $task_commands $auth_commands +multi +exec (+fcall $task_patterns $auth_patterns $settings) (+type +hget $settings) (+fcall $task_patterns $workspace_patterns $audit) (+type +xadd $audit)" \
  "user sh-worker on #$(password_hash "$REDIS_WORKER_PASSWORD") $task_patterns $worker_patterns $task_commands +time (+pexpire +pttl +del ~${prefix}lock:unassign:*) (+sscan ~${prefix}user-assigned:*) (+xgroup|create +xreadgroup +xack +xautoclaim +xpending +xtrim +xrange $domain)" \
  "user sh-maint on #$(password_hash "$REDIS_MAINT_PASSWORD") ~$prefix* &* +@all" > "$acl"
chown redis:redis "$acl"
exec /usr/local/bin/docker-entrypoint.sh redis-server /etc/sprinthub/redis.conf --aclfile "$acl"
