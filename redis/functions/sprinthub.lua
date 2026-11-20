#!lua name=sprinthub

local LIB_VERSION = 3
local IDEMPOTENCY_TTL = 86400
local COLUMN_LIMIT = 500
local STEP = 1024
local MAX_SCORE = 2 ^ 50
local MAX_SAFE_INTEGER = 2 ^ 53 - 1

local transitions = {
    TODO = { IN_PROGRESS = true },
    IN_PROGRESS = { TODO = true, IN_REVIEW = true },
    IN_REVIEW = { IN_PROGRESS = true, DONE = true },
    DONE = { IN_PROGRESS = true },
}

local function integer(value)
    return string.format('%.0f', value)
end

-- Lua CJSON formats numbers with at most 14 significant digits.
local function json_with_integers(data, fields)
    local parts = { cjson.encode(data):sub(1, -2) }
    for name, value in pairs(fields) do
        parts[#parts + 1] = ',' .. cjson.encode(name) .. ':' .. integer(value)
    end
    parts[#parts + 1] = '}'
    return table.concat(parts)
end

local function reject(code, params_json)
    return '{"ok":false,"code":' .. cjson.encode(code) .. ',"params":' .. (params_json or '{}') .. '}'
end

local function decode_document(raw)
    local previous = cjson.decode_array_with_array_mt()
    cjson.decode_array_with_array_mt(true)
    local ok, document = pcall(cjson.decode, raw)
    cjson.decode_array_with_array_mt(previous)
    assert(ok and type(document) == 'table', 'Expected a JSON document')
    return document
end

local function read_document(key)
    local raw = redis.call('JSON.GET', key)
    if raw then
        return decode_document(raw)
    end
end

local function has_value(value)
    return value ~= nil and value ~= cjson.null
end

local function is_id(value)
    return value ~= '' and not value:find(':', 1, true)
end

local function get_prefix(keys, ws)
    local suffix = 'workspace-members:' .. ws
    local key = keys[1]
    if #key > #suffix and key:sub(-#suffix) == suffix then
        return key:sub(1, #key - #suffix)
    end
end

local function keys_match(keys, prefix, suffixes)
    for index, suffix in ipairs(suffixes) do
        if keys[index] ~= prefix .. suffix then
            return false
        end
    end
    return true
end

local function mutation_suffixes(suffixes, ws, actor, idempotency_key)
    suffixes[#suffixes + 1] = 'workspace-seq:' .. ws
    suffixes[#suffixes + 1] = 'workspace-changes:' .. ws
    suffixes[#suffixes + 1] = 'stream:domain-events'
    suffixes[#suffixes + 1] = 'idempotency:' .. actor .. ':' .. idempotency_key
    return suffixes
end

local function replay(key, request_hash)
    local raw = redis.call('GET', key)
    if raw then
        local stored = cjson.decode(raw)
        if stored.requestHash ~= request_hash then
            return reject('IDEMPOTENCY_KEY_REUSED')
        end
        assert(type(stored.response) == 'string', 'Invalid stored idempotency response')
        return stored.response
    end
end

local function assert_type(key, expected)
    local actual = redis.call('TYPE', key).ok
    assert(actual == 'none' or actual == expected, 'WRONGTYPE ' .. key .. ' requires ' .. expected)
end

local function next_counter(key)
    local raw = redis.call('GET', key)
    if not raw then
        return 1
    end
    assert(raw == '0' or raw:match('^[1-9]%d*$'), 'Invalid counter: ' .. key)
    local current = tonumber(raw)
    assert(current < MAX_SAFE_INTEGER, 'Counter exceeds safe integer range: ' .. key)
    return current + 1
end

local function iso_timestamp(ms)
    assert(ms and ms == math.floor(ms) and ms >= -62167219200000 and ms <= 253402300799999,
        'Invalid nowMs')
    local days = math.floor(ms / 86400000)
    local time = ms - days * 86400000

    -- Convert Unix days to a Gregorian date using 400-year cycles starting in March.
    local shifted = days + 719468
    local era = math.floor(shifted / 146097)
    local day_of_era = shifted - era * 146097
    local year_of_era = math.floor((day_of_era - math.floor(day_of_era / 1460)
        + math.floor(day_of_era / 36524) - math.floor(day_of_era / 146096)) / 365)
    local day_of_year = day_of_era - (365 * year_of_era + math.floor(year_of_era / 4)
        - math.floor(year_of_era / 100))
    local march_month = math.floor((5 * day_of_year + 2) / 153)
    local day = day_of_year - math.floor((153 * march_month + 2) / 5) + 1
    local month = (march_month + 2) % 12 + 1
    local year = year_of_era + era * 400 + (month <= 2 and 1 or 0)
    return string.format('%04d-%02d-%02dT%02d:%02d:%02d.%03dZ', year, month, day,
        math.floor(time / 3600000), math.floor(time / 60000) % 60, math.floor(time / 1000) % 60, time % 1000)
end

local function prepare_outbox(keys, seq, event, change, data_json, request_hash, rebalanced)
    local changes, stream = keys[#keys - 2], keys[#keys - 1]
    assert_type(changes, 'zset')
    assert_type(stream, 'stream')

    local seq_arg = integer(seq)
    local fields = {
        'eventId', event.workspaceId .. ':' .. seq_arg,
        'eventVersion', '1',
        'type', event.type,
        'seq', seq_arg,
        'workspaceId', event.workspaceId,
        'actorId', event.actorId,
        'occurredAt', event.occurredAt,
        'payload', cjson.encode(event.payload),
    }
    if event.requestId and event.requestId ~= '' then
        fields[#fields + 1] = 'requestId'
        fields[#fields + 1] = event.requestId
    end
    if event.taskId then
        fields[#fields + 1] = 'projectId'
        fields[#fields + 1] = event.projectId
        fields[#fields + 1] = 'taskId'
        fields[#fields + 1] = event.taskId
        fields[#fields + 1] = 'entityVersion'
        fields[#fields + 1] = integer(event.entityVersion)
        fields[#fields + 1] = 'clientMutationId'
        fields[#fields + 1] = event.clientMutationId
    end
    local entries = { seq_arg, change }
    if rebalanced then
        fields[#fields + 1] = 'rebalancedColumn'
        fields[#fields + 1] = rebalanced
        entries[#entries + 1] = seq_arg
        entries[#entries + 1] = 'board:' .. event.projectId .. ':' .. rebalanced
    end
    local response = '{"ok":true,"data":' .. data_json .. ',"seq":' .. seq_arg .. '}'
    local saved = cjson.encode({ requestHash = request_hash, response = response })
    return function()
        redis.call('ZADD', changes, unpack(entries))
        redis.call('XADD', stream, '*', unpack(fields))
        redis.call('SET', keys[#keys], saved, 'EX', IDEMPOTENCY_TTL)
        return response
    end
end

local function destination_rank(board, id, moving_rank)
    local rank = redis.call('ZRANK', board, id)
    if rank == false or rank == moving_rank then
        return nil
    end
    if moving_rank and rank > moving_rank then
        return rank - 1
    end
    return rank
end

local function score_at(board, rank, moving_rank)
    if moving_rank and rank >= moving_rank then
        rank = rank + 1
    end
    local result = redis.call('ZRANGE', board, rank, rank, 'WITHSCORES')
    local score = tonumber(result[2])
    assert(score and score == math.floor(score) and math.abs(score) <= MAX_SCORE, 'Invalid board score')
    return score
end

local function between(lower, upper)
    if lower and upper then
        if upper - lower >= 2 then
            return math.floor((lower + upper) / 2)
        end
    elseif lower then
        return lower + STEP
    elseif upper then
        return upper - STEP
    else
        return STEP
    end
end

local function plan_placement(board, task_id, same_column, after_id, before_id)
    local moving_rank = same_column and redis.call('ZRANK', board, task_id)
    assert(not same_column or moving_rank ~= false, 'Task is missing from its board column')
    assert(same_column or redis.call('ZSCORE', board, task_id) == false, 'Task already in destination column')
    local size = redis.call('ZCARD', board) - (same_column and 1 or 0)

    -- The insertion slot counts the members before the new position after excluding the mover.
    local slot = size
    local after_rank = after_id ~= '' and destination_rank(board, after_id, moving_rank) or nil
    local before_rank = before_id ~= '' and destination_rank(board, before_id, moving_rank) or nil
    if (after_id ~= '' and not after_rank) or (before_id ~= '' and not before_rank) then
        return nil, reject('INVALID_POSITION_ANCHOR')
    end
    if before_rank then
        if before_rank ~= (after_rank and after_rank + 1 or 0) then
            return nil, reject('INVALID_POSITION_ANCHOR')
        end
        slot = before_rank
    elseif after_rank and after_rank ~= size - 1 then
        return nil, reject('INVALID_POSITION_ANCHOR')
    end
    if size + 1 > COLUMN_LIMIT then
        return nil, reject('COLUMN_FULL', cjson.encode({ limit = COLUMN_LIMIT }))
    end

    local lower = slot > 0 and score_at(board, slot - 1, moving_rank) or nil
    local upper = slot < size and score_at(board, slot, moving_rank) or nil
    local score = between(lower, upper)
    if score and math.abs(score) <= MAX_SCORE then
        return { entries = { integer(score), task_id }, rebalanced = false }
    end

    local entries = {}
    local rank = 0
    for _, id in ipairs(redis.call('ZRANGE', board, 0, -1)) do
        if id ~= task_id then
            rank = rank + 1
            entries[#entries + 1] = integer(rank * STEP)
            entries[#entries + 1] = id
        end
    end
    score = between(slot > 0 and slot * STEP or nil, slot < size and (slot + 1) * STEP or nil)
    entries[#entries + 1] = integer(score)
    entries[#entries + 1] = task_id
    return { entries = entries, rebalanced = true }
end

local function create_task(keys, args)
    if #keys ~= 12 or (#args ~= 10 and #args ~= 11) then
        return reject('KEYS_MISMATCH')
    end
    local ws, project_id, actor, task_id, assignee, raw_payload, idem, request_hash, mutation_id, time = unpack(args)
    local prefix = get_prefix(keys, ws)
    if not prefix or not is_id(ws) or not is_id(project_id) or not is_id(actor) or not is_id(task_id)
        or (assignee ~= '' and (not is_id(assignee) or assignee == 'none')) or idem == ''
        or not keys_match(keys, prefix, mutation_suffixes({
            'workspace-members:' .. ws, 'project:' .. project_id, 'project-task-seq:' .. project_id,
            'workspace-task-keys:' .. ws, 'task:' .. task_id, 'project-tasks:' .. project_id,
            'board:' .. project_id .. ':TODO', 'user-assigned:' .. (assignee == '' and 'none' or assignee),
        }, ws, actor, idem)) then
        return reject('KEYS_MISMATCH')
    end

    local project = read_document(keys[2])
    if not project or project.workspaceId ~= ws or not redis.call('HGET', keys[1], actor) then
        return reject('NOT_FOUND')
    end
    local previous = replay(keys[12], request_hash)
    if previous then
        return previous
    end
    if has_value(project.archivedAt) then
        return reject('PROJECT_ARCHIVED')
    end
    assert(redis.call('EXISTS', keys[5]) == 0, 'Caller-generated task ID already exists')
    if assignee ~= '' and not redis.call('HGET', keys[1], assignee) then
        return reject('ASSIGNEE_NOT_MEMBER')
    end

    local placement, failure = plan_placement(keys[7], task_id, false, '', '')
    if not placement then
        return failure
    end
    local number = next_counter(keys[3])
    local issue_key = project.key .. '-' .. integer(number)
    assert(redis.call('HEXISTS', keys[4], issue_key) == 0, 'Next issue key already exists')
    assert_type(keys[6], 'set')
    if assignee ~= '' then
        assert_type(keys[8], 'set')
    end

    local payload = decode_document(raw_payload)
    assert(type(payload.title) == 'string', 'Expected a task title')
    assert(payload.description == nil or type(payload.description) == 'string', 'Invalid description')
    assert(payload.priority == nil or type(payload.priority) == 'string', 'Invalid priority')
    local numbers = { number = number, createdAtMs = tonumber(time), lastSeq = next_counter(keys[9]) }
    local occurred_at = iso_timestamp(numbers.createdAtMs)
    if has_value(payload.dueAtMs) then
        local due = payload.dueAtMs
        assert(type(due) == 'number' and due == math.floor(due) and math.abs(due) <= MAX_SAFE_INTEGER,
            'Invalid dueAtMs')
        numbers.dueAtMs = due
    end
    local data = {
        id = task_id, workspaceId = ws, projectId = project_id, key = issue_key,
        title = payload.title, description = payload.description or '', descriptionFormat = 'markdown',
        status = 'TODO', priority = payload.priority or 'MEDIUM',
        assigneeId = assignee ~= '' and assignee or cjson.null,
        assigneeIndexValue = assignee ~= '' and assignee or 'UNASSIGNED',
        reporterId = actor, sprintId = cjson.null, labelIds = decode_document('[]'),
        dueAtMs = numbers.dueAtMs == nil and cjson.null or nil,
        createdAt = occurred_at, deletedAt = cjson.null, isDeleted = 'false',
        lastClientMutationId = mutation_id, schemaVersion = 1, version = 1,
    }
    local document = json_with_integers(data, numbers)
    local finish = prepare_outbox(keys, numbers.lastSeq, {
        requestId = args[11], type = 'TASK_CREATED', workspaceId = ws, projectId = project_id, taskId = task_id,
        actorId = actor, entityVersion = 1, clientMutationId = mutation_id, occurredAt = occurred_at,
        payload = { key = issue_key },
    }, 'task:' .. task_id, document, request_hash, placement.rebalanced and 'TODO')

    redis.call('INCR', keys[3])
    redis.call('HSETNX', keys[4], issue_key, task_id)
    redis.call('INCR', keys[9])
    redis.call('JSON.SET', keys[5], '$', document)
    redis.call('SADD', keys[6], task_id)
    redis.call('ZADD', keys[7], unpack(placement.entries))
    if assignee ~= '' then
        redis.call('SADD', keys[8], task_id)
    end
    return finish()
end

local function move_task(keys, args)
    if #keys ~= 9 or (#args ~= 13 and #args ~= 14) then
        return reject('KEYS_MISMATCH')
    end
    local ws, project_id, task_id, actor, from, to, after_id, before_id, expected, idem, request_hash, mutation_id, time =
        unpack(args)
    local prefix = get_prefix(keys, ws)
    if not prefix or not is_id(ws) or not is_id(project_id) or not is_id(task_id) or not is_id(actor)
        or idem == '' or not keys_match(keys, prefix, mutation_suffixes({
            'workspace-members:' .. ws, 'project:' .. project_id, 'task:' .. task_id,
            'board:' .. project_id .. ':' .. from, 'board:' .. project_id .. ':' .. to,
        }, ws, actor, idem)) then
        return reject('KEYS_MISMATCH')
    end

    local task = read_document(keys[3])
    if not task or has_value(task.deletedAt) or task.isDeleted == 'true' or task.isDeleted == true then
        return reject('NOT_FOUND')
    end
    if task.workspaceId ~= ws or task.projectId ~= project_id or task.status ~= from then
        return reject('KEYS_MISMATCH')
    end
    local project = read_document(keys[2])
    if not project then
        return reject('NOT_FOUND')
    end
    if project.workspaceId ~= ws then
        return reject('KEYS_MISMATCH')
    end
    if not redis.call('HGET', keys[1], actor) then
        return reject('NOT_FOUND')
    end
    local previous = replay(keys[9], request_hash)
    if previous then
        return previous
    end
    if has_value(project.archivedAt) then
        return reject('PROJECT_ARCHIVED')
    end
    local version = task.version
    assert(type(version) == 'number' and version == math.floor(version) and version >= 1
        and version <= MAX_SAFE_INTEGER, 'Invalid task version')
    if version ~= tonumber(expected) then
        return reject('TASK_VERSION_CONFLICT', '{"currentVersion":' .. integer(version) .. '}')
    end
    if not transitions[from] or (from ~= to and not transitions[from][to]) then
        return reject('INVALID_STATUS_TRANSITION')
    end
    local placement, failure = plan_placement(keys[5], task_id, from == to, after_id, before_id)
    if not placement then
        return failure
    end
    if from ~= to then
        assert(redis.call('ZSCORE', keys[4], task_id), 'Task is missing from its source column')
    end

    assert(version < MAX_SAFE_INTEGER, 'Task version exceeds safe integer range')
    local seq = next_counter(keys[6])
    local numbers = { version = version + 1, lastSeq = seq }
    for _, field in ipairs({ 'number', 'createdAtMs', 'dueAtMs' }) do
        if type(task[field]) == 'number' then
            numbers[field] = task[field]
            task[field] = nil
        end
    end
    task.version, task.lastSeq = nil, nil
    task.status, task.lastClientMutationId = to, mutation_id
    local status_json, mutation_json = cjson.encode(to), cjson.encode(mutation_id)
    local finish = prepare_outbox(keys, seq, {
        requestId = args[14], type = 'TASK_MOVED', workspaceId = ws, projectId = project_id, taskId = task_id,
        actorId = actor, entityVersion = numbers.version, clientMutationId = mutation_id,
        occurredAt = iso_timestamp(tonumber(time)), payload = { from = from, to = to },
    }, 'task:' .. task_id, json_with_integers(task, numbers), request_hash, placement.rebalanced and to)

    redis.call('INCR', keys[6])
    redis.call('JSON.MSET',
        keys[3], '$.status', status_json,
        keys[3], '$.version', integer(numbers.version),
        keys[3], '$.lastSeq', integer(seq),
        keys[3], '$.lastClientMutationId', mutation_json)
    if from ~= to then
        redis.call('ZREM', keys[4], task_id)
    end
    redis.call('ZADD', keys[5], unpack(placement.entries))
    return finish()
end

local function remove_member(keys, args)
    if #keys ~= 6 or (#args ~= 6 and #args ~= 7) then
        return reject('KEYS_MISMATCH')
    end
    local ws, actor, user, idem, request_hash, time = unpack(args)
    local prefix = get_prefix(keys, ws)
    if not prefix or not is_id(ws) or not is_id(actor) or not is_id(user) or idem == ''
        or not keys_match(keys, prefix, mutation_suffixes({
            'workspace-members:' .. ws, 'user-workspaces:' .. user,
        }, ws, actor, idem)) then
        return reject('KEYS_MISMATCH')
    end

    local role = redis.call('HGET', keys[1], actor)
    if role ~= 'OWNER' and role ~= 'ADMIN' then
        return reject('NOT_FOUND')
    end
    local previous = replay(keys[6], request_hash)
    if previous then
        return previous
    end
    local target = redis.call('HGET', keys[1], user)
    if target ~= 'MEMBER' and not (target == 'ADMIN' and role == 'OWNER') then
        return reject('NOT_FOUND')
    end
    assert_type(keys[2], 'set')
    local seq = next_counter(keys[3])
    local data = { userId = user }
    local finish = prepare_outbox(keys, seq, {
        requestId = args[7], type = 'MEMBER_REMOVED', workspaceId = ws, actorId = actor,
        occurredAt = iso_timestamp(tonumber(time)), payload = data,
    }, 'member:' .. user, cjson.encode(data), request_hash, false)

    redis.call('HDEL', keys[1], user)
    redis.call('SREM', keys[2], ws)
    redis.call('INCR', keys[3])
    return finish()
end

redis.register_function('sh_create_task', create_task)
redis.register_function('sh_move_task', move_task)
redis.register_function('sh_remove_member', remove_member)
redis.register_function({
    function_name = 'sh_lib_version',
    callback = function() return LIB_VERSION end,
    flags = { 'no-writes' },
})

-- Authentication and sessions

local AUTH_SESSION_LIMIT = 32
local AUTH_SESSION_SLIDING_MS = 7 * 24 * 60 * 60 * 1000
local AUTH_SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000
local AUTH_IDEMPOTENCY_TTL = 86400

local function auth_prefix(key, suffix)
    if not key or #key <= #suffix or key:sub(-#suffix) ~= suffix then return nil end
    return key:sub(1, #key - #suffix)
end

local function auth_id(value)
    return type(value) == 'string' and #value == 30 and value:match('^usr_[0-7][0-9A-HJKMNP-TV-Z]+$') ~= nil
end

local function auth_code_points(value)
    local _, count = value:gsub('[^\128-\191]', '')
    return count
end

local function auth_integer(value, min, max)
    return type(value) == 'number' and value == math.floor(value) and value >= min and value <= max
end

local function auth_time_ms()
    local now = redis.call('TIME')
    return tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
end

local function auth_session_snapshot(raw, max)
    local list = decode_document(raw)
    assert(type(list) == 'table' and raw:match('^%s*%['), 'Invalid session snapshot')
    assert(#list <= max, 'Session snapshot exceeds bound')
    local previous = nil
    for _, digest in ipairs(list) do
        assert(type(digest) == 'string' and digest:match('^[0-9a-f]+$') and #digest == 64,
            'Invalid session digest')
        assert(previous == nil or previous < digest, 'Session snapshot must be sorted and unique')
        previous = digest
    end
    return list
end

local function auth_same_snapshot(actual, expected)
    if #actual ~= #expected then return false end
    local found = {}
    for _, value in ipairs(actual) do found[value] = true end
    for _, value in ipairs(expected) do if not found[value] then return false end end
    return true
end

local function auth_check_session_keys(index_key, digest_keys, digests, uid)
    assert_type(index_key, 'set')
    assert(redis.call('SCARD', index_key) <= AUTH_SESSION_LIMIT, 'Session index exceeds bound')
    local actual = redis.call('SMEMBERS', index_key)
    if not auth_same_snapshot(actual, digests) then return false end
    for i, digest in ipairs(digests) do
        local key = digest_keys[i]
        assert_type(key, 'hash')
        if redis.call('EXISTS', key) == 1 then
            local owner = redis.call('HGET', key, 'userId')
            assert(owner == uid, 'Session index contains a session owned by another user')
        end
    end
    return true
end

local function auth_profile(user)
    return {
        id = user.id,
        email = user.email,
        displayName = user.displayName,
        avatarUrl = user.avatarUrl,
        locale = user.locale,
        version = user.version,
    }
end

local function auth_assert_profile_source(user)
    assert(user and auth_id(user.id) and type(user.email) == 'string'
        and type(user.displayName) == 'string'
        and (user.avatarUrl == cjson.null or type(user.avatarUrl) == 'string')
        and (user.locale == 'en' or user.locale == 'vi')
        and auth_integer(user.version, 1, MAX_SAFE_INTEGER), 'Invalid user profile data')
end

local function auth_profile_json(user)
    local profile = auth_profile(user)
    local version = profile.version
    profile.version = nil
    return json_with_integers(profile, { version = version })
end

local function auth_session_live(key, uid, now)
    if redis.call('HGET', key, 'userId') ~= uid then return false end
    local expires = tonumber(redis.call('HGET', key, 'expiresAtMs'))
    local absolute = tonumber(redis.call('HGET', key, 'absoluteExpiresAtMs'))
    assert(auth_integer(expires, 1, MAX_SAFE_INTEGER)
        and auth_integer(absolute, 1, MAX_SAFE_INTEGER)
        and expires <= absolute, 'Invalid session expiry')
    return expires > now and absolute > now
end

local AUTH_NO_CHANGE = '{"ok":true,"data":{"changed":false},"seq":null}'
local AUTH_CHANGED = '{"ok":true,"data":{"changed":true},"seq":null}'

local function auth_remove_sessions(index_key, session_keys, digests)
    for i, digest in ipairs(digests) do
        redis.call('DEL', session_keys[i])
        redis.call('SREM', index_key, digest)
    end
end

local function take_auth_rate_limit(keys, args)
    if #args ~= 3 then return reject('KEYS_MISMATCH') end
    local scope, subject, email_digest = unpack(args)
    local suffixes
    local windows
    if scope == 'login' then
        if #keys ~= 2 or not subject:match('^[0-9a-f]+$') or #subject ~= 64
            or not email_digest:match('^[0-9a-f]+$') or #email_digest ~= 64 then
            return reject('KEYS_MISMATCH')
        end
        local prefix = auth_prefix(keys[1], 'ratelimit:login-ip:' .. subject)
        suffixes = { 'ratelimit:login-ip:' .. subject, 'ratelimit:login-acct:' .. email_digest }
        windows = { { 'login-ip', 20, 900 }, { 'login-acct', 5, 900 } }
        if not prefix or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    elseif scope == 'register' then
        if #keys ~= 1 or not subject:match('^[0-9a-f]+$') or #subject ~= 64 or email_digest ~= '' then
            return reject('KEYS_MISMATCH')
        end
        local prefix = auth_prefix(keys[1], 'ratelimit:register:' .. subject)
        suffixes = { 'ratelimit:register:' .. subject }
        windows = { { 'register', 3, 3600 } }
        if not prefix or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    elseif scope == 'write' then
        if #keys ~= 1 or not auth_id(subject) or email_digest ~= '' then return reject('KEYS_MISMATCH') end
        local prefix = auth_prefix(keys[1], 'ratelimit:write:' .. subject)
        suffixes = { 'ratelimit:write:' .. subject }
        windows = { { 'write', 120, 60 } }
        if not prefix or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    else
        return reject('KEYS_MISMATCH')
    end

    for _, key in ipairs(keys) do assert_type(key, 'string') end
    local blocked = decode_document('[]')
    for i, window in ipairs(windows) do
        local count = next_counter(keys[i])
        if count > window[2] then
            local ttl_ms = redis.call('PTTL', keys[i])
            local ttl = ttl_ms >= 0 and math.max(1, math.ceil(ttl_ms / 1000)) or window[3]
            blocked[#blocked + 1] = { policy = window[1], retryAfter = ttl }
        end
    end
    for i, window in ipairs(windows) do
        redis.call('INCR', keys[i])
        redis.call('EXPIRE', keys[i], window[3], 'NX')
    end
    return '{"ok":true,"data":{"blocked":' .. cjson.encode(blocked) .. '},"seq":null}'
end

local function register_user(keys, args)
    if #keys ~= 4 or #args ~= 6 then return reject('KEYS_MISMATCH') end
    local uid, email_digest, normalized_email, display_email, password_hash, display_name = unpack(args)
    local prefix = auth_prefix(keys[1], 'platform-settings')
    if not prefix or not auth_id(uid) or type(email_digest) ~= 'string'
        or not email_digest:match('^[0-9a-f]+$') or #email_digest ~= 64
        or not keys_match(keys, prefix, { 'platform-settings', 'user-email:' .. email_digest,
            'user:' .. uid, 'users-by-created' }) then
        return reject('KEYS_MISMATCH')
    end
    assert(type(normalized_email) == 'string' and normalized_email ~= ''
        and normalized_email == string.lower(normalized_email), 'Invalid normalized email')
    assert(type(display_email) == 'string' and #display_email <= 254
        and string.lower(display_email) == normalized_email, 'Invalid display email')
    assert(type(password_hash) == 'string' and password_hash ~= '', 'Invalid password hash')
    assert(type(display_name) == 'string' and #display_name >= 1 and auth_code_points(display_name) <= 80, 'Invalid display name')
    assert_type(keys[1], 'hash')
    assert_type(keys[2], 'string')
    assert_type(keys[3], 'ReJSON-RL')
    assert_type(keys[4], 'zset')
    local enabled = redis.call('HGET', keys[1], 'registrationEnabled')
    if enabled == '0' then return reject('REGISTRATION_DISABLED') end
    assert(enabled == false or enabled == '1', 'Invalid registrationEnabled setting')
    local existing = redis.call('GET', keys[2])
    if existing then
        assert(auth_id(existing), 'Invalid email mapping')
        return '{"ok":true,"data":{"status":"accepted"},"seq":null}'
    end
    assert(redis.call('EXISTS', keys[3]) == 0 and not redis.call('ZSCORE', keys[4], uid),
        'Caller-generated user ID already exists')
    local now = auth_time_ms()
    local user = {
        id = uid, email = display_email, emailNormalized = normalized_email, emailDigest = email_digest,
        passwordHash = password_hash, displayName = display_name, avatarUrl = cjson.null, locale = 'en',
        disabledAt = cjson.null, suspendedBy = cjson.null, lastLoginAt = cjson.null,
        createdAt = iso_timestamp(now), schemaVersion = 1, version = 1,
    }
    local user_json = json_with_integers(user, { createdAtMs = now })
    redis.call('JSON.SET', keys[3], '$', user_json)
    redis.call('SET', keys[2], uid)
    redis.call('ZADD', keys[4], integer(now), uid)
    return '{"ok":true,"data":{"status":"accepted"},"seq":null}'
end

local function create_session(keys, args)
    if #args ~= 6 then return reject('KEYS_MISMATCH') end
    local uid, email_digest, new_digest, public_id, prior_digest, snapshot_json = unpack(args)
    local prefix = auth_prefix(keys[1], 'user-email:' .. email_digest)
    local digests = auth_session_snapshot(snapshot_json, AUTH_SESSION_LIMIT)
    if #keys ~= 4 + #digests or not prefix or not auth_id(uid) or #email_digest ~= 64
        or not email_digest:match('^[0-9a-f]+$') or #new_digest ~= 64 or not new_digest:match('^[0-9a-f]+$')
        or #public_id ~= 30 or not public_id:match('^ses_[0-7][0-9A-HJKMNP-TV-Z]+$')
        or (prior_digest ~= '' and (#prior_digest ~= 64 or not prior_digest:match('^[0-9a-f]+$')))
        or not keys_match(keys, prefix, { 'user-email:' .. email_digest, 'user:' .. uid,
            'user-sessions:' .. uid, 'session:' .. new_digest }) then
        return reject('KEYS_MISMATCH')
    end
    if not keys_match(keys, prefix, (function()
        local values = { 'user-email:' .. email_digest, 'user:' .. uid, 'user-sessions:' .. uid,
            'session:' .. new_digest }
        for _, digest in ipairs(digests) do values[#values + 1] = 'session:' .. digest end
        return values
    end)()) then return reject('KEYS_MISMATCH') end
    if redis.call('GET', keys[1]) ~= uid then return reject('INVALID_CREDENTIALS') end
    local user = read_document(keys[2])
    assert(user and user.id == uid and user.emailDigest == email_digest, 'Invalid registered user or email mapping')
    auth_assert_profile_source(user)
    assert_type(keys[3], 'set')
    assert_type(keys[4], 'hash')
    local digest_keys = {}
    for i in ipairs(digests) do digest_keys[i] = keys[4 + i] end
    if not auth_check_session_keys(keys[3], digest_keys, digests, uid) then return reject('KEYS_MISMATCH') end
    if user.disabledAt ~= nil and user.disabledAt ~= cjson.null then return reject('USER_SUSPENDED') end
    assert(auth_integer(user.version, 1, MAX_SAFE_INTEGER), 'Invalid user version')
    assert(user.version < MAX_SAFE_INTEGER, 'User version exceeds safe integer range')
    if redis.call('EXISTS', keys[4]) == 1 then return reject('KEYS_MISMATCH') end
    local now = auth_time_ms()
    local live = 0
    local remove_keys, remove_digests = {}, {}
    for i, digest in ipairs(digests) do
        if digest ~= prior_digest and auth_session_live(digest_keys[i], uid, now) then
            live = live + 1
        else
            remove_keys[#remove_keys + 1] = digest_keys[i]
            remove_digests[#remove_digests + 1] = digest
        end
    end
    if live >= AUTH_SESSION_LIMIT then return reject('SESSION_LIMIT_REACHED', '{"limit":32}') end
    local expires = now + AUTH_SESSION_SLIDING_MS
    local absolute = now + AUTH_SESSION_ABSOLUTE_MS
    user.version = user.version + 1
    local version = integer(user.version)
    local last_login = cjson.encode(iso_timestamp(now))
    local response = '{"ok":true,"data":' .. auth_profile_json(user) .. ',"seq":null}'

    auth_remove_sessions(keys[3], remove_keys, remove_digests)
    redis.call('SADD', keys[3], new_digest)
    redis.call('HSET', keys[4], 'userId', uid, 'id', public_id, 'createdAtMs', integer(now),
        'lastSeenAtMs', integer(now), 'expiresAtMs', integer(expires), 'absoluteExpiresAtMs', integer(absolute))
    redis.call('PEXPIREAT', keys[4], integer(expires))
    redis.call('JSON.MSET', keys[2], '$.lastLoginAt', last_login, keys[2], '$.version', version)
    return response
end

local function touch_session(keys, args)
    if #keys ~= 2 or #args ~= 3 then return reject('KEYS_MISMATCH') end
    local uid, digest, interval = unpack(args)
    local prefix = auth_prefix(keys[1], 'session:' .. digest)
    if not prefix or not auth_id(uid) or #digest ~= 64 or not digest:match('^[0-9a-f]+$')
        or not interval:match('^%d+$') or not keys_match(keys, prefix, { 'session:' .. digest, 'user-sessions:' .. uid }) then
        return reject('KEYS_MISMATCH')
    end
    local touch_ms = tonumber(interval)
    assert(auth_integer(touch_ms, 0, MAX_SAFE_INTEGER), 'Invalid touch interval')
    assert_type(keys[1], 'hash'); assert_type(keys[2], 'set')
    if redis.call('EXISTS', keys[1]) == 0 then
        return '{"ok":true,"data":{"changed":false},"seq":null}'
    end
    if redis.call('SISMEMBER', keys[2], digest) == 0 then return reject('KEYS_MISMATCH') end
    local session = redis.call('HGETALL', keys[1])
    local values = {}; for i = 1, #session, 2 do values[session[i]] = session[i + 1] end
    if values.userId ~= uid then return reject('KEYS_MISMATCH') end
    local now = auth_time_ms()
    local last = tonumber(values.lastSeenAtMs); local expires = tonumber(values.expiresAtMs)
    local absolute = tonumber(values.absoluteExpiresAtMs)
    assert(last and expires and absolute, 'Invalid session timestamps')
    if expires <= now or absolute <= now or now - last <= touch_ms then
        return '{"ok":true,"data":{"changed":false},"seq":null}'
    end
    local next_expires = math.min(now + AUTH_SESSION_SLIDING_MS, absolute)
    redis.call('HSET', keys[1], 'lastSeenAtMs', integer(now), 'expiresAtMs', integer(next_expires))
    redis.call('PEXPIREAT', keys[1], integer(next_expires))
    return '{"ok":true,"data":{"changed":true},"seq":null}'
end

local function logout_session(keys, args)
    if #keys ~= 3 or #args ~= 2 then return reject('KEYS_MISMATCH') end
    local uid, digest = unpack(args)
    local prefix = auth_prefix(keys[1], 'session:' .. digest)
    if not prefix or not auth_id(uid) or #digest ~= 64 or not digest:match('^[0-9a-f]+$')
        or not keys_match(keys, prefix, { 'session:' .. digest, 'user:' .. uid, 'user-sessions:' .. uid }) then
        return reject('KEYS_MISMATCH')
    end
    assert_type(keys[1], 'hash'); assert_type(keys[2], 'ReJSON-RL'); assert_type(keys[3], 'set')
    if not auth_session_live(keys[1], uid, auth_time_ms()) then return AUTH_NO_CHANGE end
    local user = read_document(keys[2])
    assert(user and user.id == uid, 'Invalid user document')
    if redis.call('SISMEMBER', keys[3], digest) == 0 then return reject('KEYS_MISMATCH') end
    redis.call('DEL', keys[1])
    redis.call('SREM', keys[3], digest)
    return AUTH_CHANGED
end

local function logout_all_sessions(keys, args)
    if #args ~= 3 then return reject('KEYS_MISMATCH') end
    local uid, digest, snapshot_json = unpack(args)
    local prefix = auth_prefix(keys[1], 'session:' .. digest)
    local digests = auth_session_snapshot(snapshot_json, AUTH_SESSION_LIMIT)
    if #keys ~= 3 + #digests or not prefix or not auth_id(uid) or #digest ~= 64
        or not digest:match('^[0-9a-f]+$')
        or not keys_match(keys, prefix, { 'session:' .. digest, 'user:' .. uid, 'user-sessions:' .. uid }) then
        return reject('KEYS_MISMATCH')
    end
    local expected = { 'session:' .. digest, 'user:' .. uid, 'user-sessions:' .. uid }
    for _, item in ipairs(digests) do expected[#expected + 1] = 'session:' .. item end
    if not keys_match(keys, prefix, expected) then return reject('KEYS_MISMATCH') end
    assert_type(keys[1], 'hash'); assert_type(keys[2], 'ReJSON-RL'); assert_type(keys[3], 'set')
    if not auth_session_live(keys[1], uid, auth_time_ms()) then return AUTH_NO_CHANGE end
    local user = read_document(keys[2])
    assert(user and user.id == uid, 'Invalid user document')
    if redis.call('SISMEMBER', keys[3], digest) == 0 then return reject('KEYS_MISMATCH') end
    local digest_keys = {}
    for i in ipairs(digests) do digest_keys[i] = keys[3 + i] end
    if not auth_check_session_keys(keys[3], digest_keys, digests, uid) then return reject('KEYS_MISMATCH') end
    auth_remove_sessions(keys[3], digest_keys, digests)
    return AUTH_CHANGED
end

local function update_my_profile(keys, args)
    if #keys ~= 4 or #args ~= 6 then return reject('KEYS_MISMATCH') end
    local uid, digest, expected_version, patch_json, idem_key, request_hash = unpack(args)
    local prefix = auth_prefix(keys[1], 'session:' .. digest)
    if not prefix or not auth_id(uid) or #digest ~= 64 or not digest:match('^[0-9a-f]+$')
        or not idem_key:match('^[A-Za-z0-9._%-]+$') or #idem_key < 1 or #idem_key > 128
        or #request_hash ~= 64 or not request_hash:match('^[0-9a-f]+$')
        or not keys_match(keys, prefix, { 'session:' .. digest, 'user:' .. uid,
            'user-sessions:' .. uid, 'idempotency:' .. uid .. ':' .. idem_key }) then
        return reject('KEYS_MISMATCH')
    end
    assert_type(keys[1], 'hash'); assert_type(keys[2], 'ReJSON-RL'); assert_type(keys[3], 'set'); assert_type(keys[4], 'string')
    if not auth_session_live(keys[1], uid, auth_time_ms())
        or redis.call('SISMEMBER', keys[3], digest) == 0 then return reject('SESSION_INVALID') end
    local user = read_document(keys[2])
    assert(user and user.id == uid and not has_value(user.disabledAt), 'Invalid session owner')
    auth_assert_profile_source(user)
    local previous = redis.call('GET', keys[4])
    if previous then
        local stored = cjson.decode(previous)
        assert(type(stored.requestHash) == 'string' and type(stored.response) == 'string', 'Invalid idempotency record')
        if stored.requestHash ~= request_hash then return reject('IDEMPOTENCY_KEY_REUSED') end
        return stored.response
    end
    local expected = tonumber(expected_version)
    assert(expected and auth_integer(expected, 1, MAX_SAFE_INTEGER), 'Invalid expected version')
    assert(auth_integer(user.version, 1, MAX_SAFE_INTEGER), 'Invalid user version')
    if user.version ~= expected then
        return reject('USER_VERSION_CONFLICT', '{"currentVersion":' .. integer(user.version) .. '}')
    end
    local patch = decode_document(patch_json)
    assert(type(patch) == 'table', 'Invalid profile patch')
    local count = 0
    for name, value in pairs(patch) do
        count = count + 1
        if name == 'displayName' then
            assert(type(value) == 'string' and #value >= 1 and auth_code_points(value) <= 80, 'Invalid displayName')
        elseif name == 'avatarUrl' then
            assert(value == cjson.null or (type(value) == 'string' and auth_code_points(value) <= 2048 and value:sub(1, 8):lower() == 'https://'),
                'Invalid avatarUrl')
        elseif name == 'locale' then
            assert(value == 'en' or value == 'vi', 'Invalid locale')
        else
            error('Invalid profile field: ' .. tostring(name))
        end
    end
    assert(count > 0, 'Empty profile patch')
    local changed = false
    for name, value in pairs(patch) do
        local current = user[name]
        if current == nil then current = cjson.null end
        if current ~= value then changed = true end
        user[name] = value
    end
    if changed then
        assert(user.version < MAX_SAFE_INTEGER, 'User version exceeds safe integer range')
        user.version = user.version + 1
    end
    local response = '{"ok":true,"data":' .. auth_profile_json(user) .. ',"seq":null}'
    local idempotency = cjson.encode({ requestHash = request_hash, response = response })
    if changed then
        local fields = { keys[2], '$.version', integer(user.version) }
        for name, value in pairs(patch) do
            fields[#fields + 1] = keys[2]
            fields[#fields + 1] = '$.' .. name
            fields[#fields + 1] = cjson.encode(value)
        end
        redis.call('JSON.MSET', unpack(fields))
    end
    redis.call('SET', keys[4], idempotency, 'EX', AUTH_IDEMPOTENCY_TTL)
    return response
end

redis.register_function('sh_take_auth_rate_limit', take_auth_rate_limit)
redis.register_function('sh_register_user', register_user)
redis.register_function('sh_create_session', create_session)
redis.register_function('sh_touch_session', touch_session)
redis.register_function('sh_logout_session', logout_session)
redis.register_function('sh_logout_all_sessions', logout_all_sessions)
redis.register_function('sh_update_my_profile', update_my_profile)

-- Platform administration

local ADMIN_LIMIT = 16
local MAX_SAFE_INTEGER = 9007199254740991

local function admin_prefix(keys)
    local suffix = 'platform-admins'
    local key = keys[1]
    if not key or #key <= #suffix or key:sub(-#suffix) ~= suffix then return nil end
    return key:sub(1, #key - #suffix)
end

local function admin_json_array(raw, label)
    local value = decode_document(raw)
    assert(raw:match('^%s*%['), 'Invalid ' .. label .. ' JSON')
    local previous
    for _, item in ipairs(value) do
        assert(auth_id(item), 'Invalid ' .. label .. ' value')
        assert(not previous or previous < item, 'Unsorted or duplicate ' .. label .. ' values')
        previous = item
    end
    return value
end

local function admin_same_array(first, second)
    if #first ~= #second then return false end
    for i = 1, #first do if first[i] ~= second[i] then return false end end
    return true
end

local function admin_members(key)
    assert_type(key, 'set')
    assert(redis.call('SCARD', key) <= ADMIN_LIMIT, 'Platform Admin set exceeds configured limit')
    local members = redis.call('SMEMBERS', key)
    table.sort(members)
    return members
end

local function admin_read_user(key)
    local key_type = redis.call('TYPE', key).ok
    assert(key_type == 'none' or key_type == 'ReJSON-RL', 'Invalid user key type')
    local user = read_document(key)
    if user then
        assert(type(user.id) == 'string' and user.id ~= '', 'Invalid user document id')
        assert(type(user.version) == 'number' and user.version >= 1 and user.version == math.floor(user.version), 'Invalid user version')
        assert(user.disabledAt == nil or user.disabledAt == cjson.null or type(user.disabledAt) == 'string', 'Invalid disabledAt')
    end
    return user
end

local function admin_preflight_audit(key)
    assert_type(key, 'stream')
end

local function admin_make_audit(action, actor_id, os_user, target_id, request_id, setting_name, setting_value)
    local seconds, micros = unpack(redis.call('TIME'))
    local occurred_at = iso_timestamp(tonumber(seconds) * 1000 + math.floor(tonumber(micros) / 1000))
    local fields = { 'type', action, 'actor', 'cli:' .. actor_id, 'osUser', os_user, 'requestId', request_id, 'occurredAt', occurred_at }
    if target_id then
        fields[#fields + 1] = 'targetId'
        fields[#fields + 1] = target_id
    end
    if setting_name then
        fields[#fields + 1] = 'setting'
        fields[#fields + 1] = setting_name
        fields[#fields + 1] = 'value'
        fields[#fields + 1] = setting_value
    end
    return fields
end

local function admin_validate_sessions(prefix, user_id, index_key, snapshot_json, session_keys)
    local supplied = auth_session_snapshot(snapshot_json, AUTH_SESSION_LIMIT)
    if #supplied > AUTH_SESSION_LIMIT then return nil, reject('KEYS_MISMATCH') end
    assert_type(index_key, 'set')
    assert(redis.call('SCARD', index_key) <= AUTH_SESSION_LIMIT, 'Session index exceeds configured limit')
    local actual = redis.call('SMEMBERS', index_key)
    table.sort(actual)
    if not admin_same_array(actual, supplied) then return nil, reject('KEYS_MISMATCH') end
    -- Session keys begin after the fixed portion, so compare them separately.
    for i, digest in ipairs(supplied) do
        local key = session_keys[i]
        if key ~= prefix .. 'session:' .. digest then return nil, reject('KEYS_MISMATCH') end
        assert_type(key, 'hash')
        if redis.call('EXISTS', key) == 1 then
            assert(redis.call('HGET', key, 'userId') == user_id, 'Session owner mismatch')
        end
    end
    return supplied
end

local function admin_compare_key_suffixes(keys, prefix, suffixes)
    if #keys ~= #suffixes then return false end
    return keys_match(keys, prefix, suffixes)
end

local function admin_active_count(admin_ids, users_by_id)
    local count = 0
    for _, id in ipairs(admin_ids) do
        local user = users_by_id[id]
        if user and (user.disabledAt == nil or user.disabledAt == cjson.null) then count = count + 1 end
    end
    return count
end

local function admin_snapshot(keys, prefix, raw_ids, actor_id, target_id, session_ids)
    local ids = admin_json_array(raw_ids, 'admin snapshot')
    if #ids > ADMIN_LIMIT then return nil, nil, reject('KEYS_MISMATCH') end
    local suffixes = { 'platform-admins', 'user:' .. actor_id, 'user:' .. target_id, 'stream:audit', 'user-sessions:' .. target_id }
    for _, id in ipairs(ids) do suffixes[#suffixes + 1] = 'user:' .. id end
    for _, digest in ipairs(session_ids) do suffixes[#suffixes + 1] = 'session:' .. digest end
    if not admin_compare_key_suffixes(keys, prefix, suffixes) then return nil, nil, reject('KEYS_MISMATCH') end
    local actual = admin_members(keys[1])
    if not admin_same_array(actual, ids) then return nil, nil, reject('KEYS_MISMATCH') end
    local users_by_id = {}
    for i, id in ipairs(ids) do
        if not users_by_id[id] then
            local user = admin_read_user(keys[5 + i])
            assert(user, 'Platform Admin user is missing')
            assert(user.id == id, 'Platform Admin user id mismatch')
            users_by_id[id] = user
        end
    end
    return ids, users_by_id
end

local function admin_delete_sessions(sessions_key, digests, session_keys)
    for i, digest in ipairs(digests) do
        local key = session_keys[i]
        if redis.call('EXISTS', key) == 1 then redis.call('DEL', key) end
        redis.call('SREM', sessions_key, digest)
    end
    if #digests == 0 then redis.call('DEL', sessions_key) end
end

local function admin_result(changed)
    return '{"ok":true,"data":{"changed":' .. (changed and 'true' or 'false') .. '},"seq":null}'
end

redis.register_function('sh_grant_admin', function(keys, args)
    local prefix = admin_prefix(keys)
    if not prefix or #keys < 5 or #args ~= 5 then return reject('KEYS_MISMATCH') end
    local actor_id, target_id, os_user, request_id = args[1], args[2], args[3], args[4]
    if not auth_id(actor_id) or not auth_id(target_id) or os_user == '' or request_id == '' then
        return reject('INVALID_ARGUMENT')
    end
    local session_ids = auth_session_snapshot(args[5], AUTH_SESSION_LIMIT)
    local suffixes = { 'platform-admins', 'user:' .. actor_id, 'user:' .. target_id, 'stream:audit', 'user-sessions:' .. target_id }
    for _, digest in ipairs(session_ids) do suffixes[#suffixes + 1] = 'session:' .. digest end
    if not admin_compare_key_suffixes(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    local session_ids_checked, mismatch = admin_validate_sessions(prefix, target_id, keys[5], args[5], { unpack(keys, 6) })
    if mismatch then return mismatch end
    session_ids = session_ids_checked
    local user = admin_read_user(keys[3])
    if not user or user.id ~= target_id then return reject('NOT_FOUND') end
    if user.disabledAt ~= nil and user.disabledAt ~= cjson.null then return reject('USER_SUSPENDED') end
    local admins = admin_members(keys[1])
    local bootstrap = #admins == 0 and actor_id == target_id
    if not bootstrap then
        local actor = admin_read_user(keys[2])
        if not actor or actor.id ~= actor_id or actor.disabledAt ~= nil and actor.disabledAt ~= cjson.null or redis.call('SISMEMBER', keys[1], actor_id) == 0 then
            return reject('OPERATOR_FORBIDDEN')
        end
    end
    admin_preflight_audit(keys[4])
    if redis.call('SISMEMBER', keys[1], target_id) == 1 then return admin_result(false) end
    if #admins >= ADMIN_LIMIT then return reject('PLATFORM_ADMIN_LIMIT_REACHED') end
    local audit = admin_make_audit('admin.grant', actor_id, os_user, target_id, request_id)
    admin_delete_sessions(keys[5], session_ids, { unpack(keys, 6) })
    redis.call('SADD', keys[1], target_id)
    redis.call('XADD', keys[4], '*', unpack(audit))
    return admin_result(true)
end)

redis.register_function('sh_revoke_admin', function(keys, args)
    local prefix = admin_prefix(keys)
    if not prefix or #args ~= 6 then return reject('INVALID_ARGUMENT') end
    local actor_id, target_id, os_user, request_id = args[1], args[2], args[3], args[4]
    if not auth_id(actor_id) or not auth_id(target_id) or os_user == '' or request_id == '' then
        return reject('INVALID_ARGUMENT')
    end
    local admin_ids = admin_json_array(args[5], 'admin snapshot')
    local session_ids = auth_session_snapshot(args[6], AUTH_SESSION_LIMIT)
    local ids, users, error_reply = admin_snapshot(keys, prefix, args[5], actor_id, target_id, session_ids)
    if error_reply then return error_reply end
    local actual_sessions, session_error = admin_validate_sessions(prefix, target_id, keys[5], args[6], { unpack(keys, 6 + #admin_ids) })
    if session_error then return session_error end
    local session_keys = { unpack(keys, 6 + #admin_ids) }
    local actor = users[actor_id]
    local target = users[target_id] or admin_read_user(keys[3])
    if not target or target.id ~= target_id then return reject('NOT_FOUND') end
    if not actor or actor.disabledAt ~= nil and actor.disabledAt ~= cjson.null then return reject('OPERATOR_FORBIDDEN') end
    if redis.call('SISMEMBER', keys[1], actor_id) == 0 then return reject('OPERATOR_FORBIDDEN') end
    admin_preflight_audit(keys[4])
    if redis.call('SISMEMBER', keys[1], target_id) == 0 then return admin_result(false) end
    local active_count = admin_active_count(ids, users)
    if target.disabledAt == nil or target.disabledAt == cjson.null then
        if active_count <= 1 then return reject('LAST_PLATFORM_ADMIN') end
    end
    local audit = admin_make_audit('admin.revoke', actor_id, os_user, target_id, request_id)
    admin_delete_sessions(keys[5], actual_sessions, session_keys)
    redis.call('SREM', keys[1], target_id)
    redis.call('XADD', keys[4], '*', unpack(audit))
    return admin_result(true)
end)

redis.register_function('sh_suspend_user', function(keys, args)
    local prefix = admin_prefix(keys)
    if not prefix or #args ~= 6 then return reject('INVALID_ARGUMENT') end
    local actor_id, target_id, os_user, request_id = args[1], args[2], args[3], args[4]
    if not auth_id(actor_id) or not auth_id(target_id) or os_user == '' or request_id == '' then
        return reject('INVALID_ARGUMENT')
    end
    local admin_ids = admin_json_array(args[5], 'admin snapshot')
    local session_ids = auth_session_snapshot(args[6], AUTH_SESSION_LIMIT)
    local ids, users, error_reply = admin_snapshot(keys, prefix, args[5], actor_id, target_id, session_ids)
    if error_reply then return error_reply end
    local actual_sessions, session_error = admin_validate_sessions(prefix, target_id, keys[5], args[6], { unpack(keys, 6 + #admin_ids) })
    if session_error then return session_error end
    local session_keys = { unpack(keys, 6 + #admin_ids) }
    local actor = users[actor_id]
    local target = users[target_id] or admin_read_user(keys[3])
    if not target or target.id ~= target_id then return reject('NOT_FOUND') end
    if not actor or actor.disabledAt ~= nil and actor.disabledAt ~= cjson.null then return reject('OPERATOR_FORBIDDEN') end
    if redis.call('SISMEMBER', keys[1], actor_id) == 0 then return reject('OPERATOR_FORBIDDEN') end
    admin_preflight_audit(keys[4])
    if target.disabledAt ~= nil and target.disabledAt ~= cjson.null then return admin_result(false) end
    if redis.call('SISMEMBER', keys[1], target_id) == 1 and admin_active_count(ids, users) <= 1 then
        return reject('LAST_PLATFORM_ADMIN')
    end
    assert(target.version < MAX_SAFE_INTEGER, 'User version exceeds safe integer range')
    local disabled_at = cjson.encode(iso_timestamp(auth_time_ms()))
    local suspended_by = cjson.encode(actor_id)
    local version = integer(target.version + 1)
    local audit = admin_make_audit('user.suspend', actor_id, os_user, target_id, request_id)
    admin_delete_sessions(keys[5], actual_sessions, session_keys)
    redis.call('JSON.MSET', keys[3], '$.disabledAt', disabled_at,
        keys[3], '$.suspendedBy', suspended_by, keys[3], '$.version', version)
    redis.call('XADD', keys[4], '*', unpack(audit))
    return admin_result(true)
end)

redis.register_function('sh_reactivate_user', function(keys, args)
    local prefix = admin_prefix(keys)
    if not prefix or #keys ~= 5 or #args ~= 4 then return reject('INVALID_ARGUMENT') end
    local actor_id, target_id, os_user, request_id = args[1], args[2], args[3], args[4]
    if not auth_id(actor_id) or not auth_id(target_id) or os_user == '' or request_id == '' then
        return reject('INVALID_ARGUMENT')
    end
    if not admin_compare_key_suffixes(keys, prefix, { 'platform-admins', 'user:' .. actor_id, 'user:' .. target_id, 'stream:audit', 'user-sessions:' .. target_id }) then return reject('KEYS_MISMATCH') end
    local actor = admin_read_user(keys[2])
    local target = admin_read_user(keys[3])
    if not target or target.id ~= target_id then return reject('NOT_FOUND') end
    if not actor or actor.id ~= actor_id or actor.disabledAt ~= nil and actor.disabledAt ~= cjson.null or redis.call('SISMEMBER', keys[1], actor_id) == 0 then return reject('OPERATOR_FORBIDDEN') end
    assert_type(keys[5], 'set')
    admin_preflight_audit(keys[4])
    if target.disabledAt == nil or target.disabledAt == cjson.null then return admin_result(false) end
    assert(redis.call('SCARD', keys[5]) == 0, 'Cannot reactivate user with session index entries')
    assert(target.version < MAX_SAFE_INTEGER, 'User version exceeds safe integer range')
    local version = integer(target.version + 1)
    local audit = admin_make_audit('user.reactivate', actor_id, os_user, target_id, request_id)
    redis.call('JSON.MSET', keys[3], '$.disabledAt', 'null',
        keys[3], '$.suspendedBy', 'null', keys[3], '$.version', version)
    redis.call('XADD', keys[4], '*', unpack(audit))
    return admin_result(true)
end)

redis.register_function('sh_revoke_sessions', function(keys, args)
    local prefix = admin_prefix(keys)
    if not prefix or #args ~= 5 then return reject('INVALID_ARGUMENT') end
    local actor_id, target_id, os_user, request_id = args[1], args[2], args[3], args[4]
    if not auth_id(actor_id) or not auth_id(target_id) or os_user == '' or request_id == '' then
        return reject('INVALID_ARGUMENT')
    end
    local session_ids = auth_session_snapshot(args[5], AUTH_SESSION_LIMIT)
    local suffixes = { 'platform-admins', 'user:' .. actor_id, 'user:' .. target_id, 'stream:audit', 'user-sessions:' .. target_id }
    for _, digest in ipairs(session_ids) do suffixes[#suffixes + 1] = 'session:' .. digest end
    if not admin_compare_key_suffixes(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    admin_members(keys[1])
    local actor = admin_read_user(keys[2])
    local target = admin_read_user(keys[3])
    if not target or target.id ~= target_id then return reject('NOT_FOUND') end
    if not actor or actor.id ~= actor_id or actor.disabledAt ~= nil and actor.disabledAt ~= cjson.null or redis.call('SISMEMBER', keys[1], actor_id) == 0 then return reject('OPERATOR_FORBIDDEN') end
    local actual, session_error = admin_validate_sessions(prefix, target_id, keys[5], args[5], { unpack(keys, 6) })
    if session_error then return session_error end
    admin_preflight_audit(keys[4])
    if #actual == 0 then return admin_result(false) end
    local audit = admin_make_audit('user.revoke-sessions', actor_id, os_user, target_id, request_id)
    admin_delete_sessions(keys[5], actual, { unpack(keys, 6) })
    redis.call('XADD', keys[4], '*', unpack(audit))
    return admin_result(true)
end)

redis.register_function('sh_set_platform_setting', function(keys, args)
    local prefix = admin_prefix(keys)
    local actor_id, setting_name, value, os_user, request_id = args[1], args[2], args[3], args[4], args[5]
    if not prefix or #keys ~= 4 or #args ~= 5 or not admin_compare_key_suffixes(keys, prefix, { 'platform-admins', 'user:' .. actor_id, 'platform-settings', 'stream:audit' }) then return reject('KEYS_MISMATCH') end
    if not auth_id(actor_id) or os_user == '' or request_id == '' then return reject('INVALID_ARGUMENT') end
    if setting_name ~= 'registrationEnabled' or value ~= '0' and value ~= '1' then return reject('INVALID_ARGUMENT') end
    admin_members(keys[1])
    local actor = admin_read_user(keys[2])
    if not actor or actor.id ~= actor_id or actor.disabledAt ~= nil and actor.disabledAt ~= cjson.null or redis.call('SISMEMBER', keys[1], actor_id) == 0 then return reject('OPERATOR_FORBIDDEN') end
    assert_type(keys[3], 'hash')
    admin_preflight_audit(keys[4])
    local previous = redis.call('HGET', keys[3], setting_name) or '1'
    assert(previous == '0' or previous == '1', 'Invalid registration setting')
    if previous == value then return admin_result(false) end
    local audit = admin_make_audit('platform.setting', actor_id, os_user, nil, request_id, setting_name, value)
    redis.call('HSET', keys[3], setting_name, value)
    redis.call('XADD', keys[4], '*', unpack(audit))
    return admin_result(true)
end)
