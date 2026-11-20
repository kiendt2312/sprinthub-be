#!lua name=sprinthub

local LIB_VERSION = 2
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
