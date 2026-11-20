#!lua name=sprinthub

local LIB_VERSION = 5
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

local function prepare_outbox(keys, seq, event, change, data_json, request_hash, rebalanced, include_rebalanced)
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
    if event.projectId then
        fields[#fields + 1] = 'projectId'
        fields[#fields + 1] = event.projectId
    end
    if event.taskId then
        fields[#fields + 1] = 'taskId'
        fields[#fields + 1] = event.taskId
    end
    if event.entityVersion then
        fields[#fields + 1] = 'entityVersion'
        fields[#fields + 1] = integer(event.entityVersion)
    end
    if event.clientMutationId then
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
    local rebalanced_json = include_rebalanced and rebalanced and
        ',"rebalancedColumn":' .. cjson.encode(rebalanced) or ''
    local response = '{"ok":true,"data":' .. data_json .. ',"seq":' .. seq_arg .. rebalanced_json .. '}'
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
            -- Rank scores are at most 512,000 and safe to pass as Lua numbers.
            entries[#entries + 1] = rank * STEP
            entries[#entries + 1] = id
        end
    end
    score = between(slot > 0 and slot * STEP or nil, slot < size and (slot + 1) * STEP or nil)
    entries[#entries + 1] = integer(score)
    entries[#entries + 1] = task_id
    return { entries = entries, rebalanced = true }
end

local function deleted_task(task)
    return has_value(task.deletedAt) or task.isDeleted == 'true' or task.isDeleted == true
end

local function task_workspace(workspace_key, workspace_id)
    local workspace = read_document(workspace_key)
    if workspace and workspace.id == workspace_id and not has_value(workspace.archivedAt) then
        return workspace
    end
end

local function task_workspace_member(members_key, actor)
    local role = redis.call('HGET', members_key, actor)
    return role == 'OWNER' or role == 'ADMIN' or role == 'MEMBER'
end

local task_priorities = { LOW = true, MEDIUM = true, HIGH = true, URGENT = true }

local function read_task_project(key)
    local raw = redis.pcall('JSON.GET', key, '.id', '.workspaceId', '.archivedAt', '.key')
    if not raw then return nil end
    if type(raw) ~= 'table' then
        local project = decode_document(raw)
        return { id = project['.id'], workspaceId = project['.workspaceId'],
            archivedAt = project['.archivedAt'], key = project['.key'] }
    end
    if raw.err ~= 'ERR Path does not exist' then error(raw.err) end
    -- Older project fixtures may omit the archive marker.
    raw = redis.call('JSON.GET', key, '$.id', '$.workspaceId', '$.archivedAt', '$.key')
    local paths = decode_document(raw)
    return { id = paths['$.id'][1], workspaceId = paths['$.workspaceId'][1],
        archivedAt = paths['$.archivedAt'][1], key = paths['$.key'][1] }
end

local function auth_code_points(value)
    if type(value) ~= 'string' then return math.huge end
    -- Strip runs of UTF-8 continuation bytes. Each remaining byte starts one code point.
    local leading = value:gsub('[\128-\191]+', '')
    return #leading
end

local function within_text_limit(value, maximum)
    return type(value) == 'string' and (#value <= maximum or auth_code_points(value) <= maximum)
end

local function valid_task_payload(payload)
    return within_text_limit(payload.title, 200) and payload.title:find('%S') ~= nil
        and (payload.description == nil or within_text_limit(payload.description, 20000))
        and (payload.priority == nil or task_priorities[payload.priority] == true)
        and (not has_value(payload.dueAtMs) or (type(payload.dueAtMs) == 'number' and payload.dueAtMs >= 0
            and payload.dueAtMs <= MAX_SAFE_INTEGER and payload.dueAtMs == math.floor(payload.dueAtMs)))
end

local function create_task(keys, args)
    local p0 = #keys == 14 and #args == 11
    if not p0 and (#keys ~= 12 or (#args ~= 10 and #args ~= 11)) then
        return reject('KEYS_MISMATCH')
    end
    local ws, project_id, actor, task_id, assignee, raw_payload, idem, request_hash, mutation_id, time = unpack(args)
    local prefix = get_prefix(keys, ws)
    local suffixes = {
        'workspace-members:' .. ws, 'project:' .. project_id, 'project-task-seq:' .. project_id,
        'workspace-task-keys:' .. ws, 'task:' .. task_id, 'project-tasks:' .. project_id,
        'board:' .. project_id .. ':TODO', 'user-assigned:' .. (assignee == '' and 'none' or assignee),
    }
    if p0 then
        suffixes[9] = 'workspace:' .. ws
        suffixes[10] = 'backlog:' .. project_id
    end
    if not prefix or not is_id(ws) or not is_id(project_id) or not is_id(actor) or not is_id(task_id)
        or (assignee ~= '' and (not is_id(assignee) or assignee == 'none')) or idem == ''
        or not keys_match(keys, prefix, mutation_suffixes(suffixes, ws, actor, idem)) then
        return reject('KEYS_MISMATCH')
    end

    local project
    if p0 then project = read_task_project(keys[2]) else project = read_document(keys[2]) end
    if not project or project.workspaceId ~= ws or (p0 and project.id ~= project_id) then
        return reject('NOT_FOUND')
    end
    local workspace
    if p0 then
        workspace = task_workspace(keys[9], ws)
        if not workspace or not task_workspace_member(keys[1], actor) then
            return reject('NOT_FOUND')
        end
    elseif not redis.call('HGET', keys[1], actor) then
        return reject('NOT_FOUND')
    end
    local previous = replay(keys[#keys], request_hash)
    if previous then
        return previous
    end
    if has_value(project.archivedAt) then
        return reject('PROJECT_ARCHIVED')
    end
    if p0 and has_value(workspace.suspendedAt) then
        return reject('WORKSPACE_SUSPENDED')
    end
    assert(redis.call('EXISTS', keys[5]) == 0, 'Caller-generated task ID already exists')
    if assignee ~= '' then
        if p0 and not task_workspace_member(keys[1], assignee) then
            return reject('ASSIGNEE_NOT_MEMBER')
        elseif not p0 and not redis.call('HGET', keys[1], assignee) then
            return reject('ASSIGNEE_NOT_MEMBER')
        end
    end

    local placement, failure = plan_placement(keys[7], task_id, false, '', '')
    if not placement then
        return failure
    end
    local number = next_counter(keys[3])
    if p0 then
        assert(number <= MAX_SCORE, 'Backlog issue number exceeds score bound')
        assert_type(keys[10], 'zset')
        assert(type(project.key) == 'string' and #project.key >= 2 and #project.key <= 10
            and project.key:match('^[A-Z0-9]+$'), 'Invalid project key')
    end
    local issue_key = project.key .. '-' .. integer(number)
    assert(redis.call('HEXISTS', keys[4], issue_key) == 0, 'Next issue key already exists')
    assert_type(keys[6], 'set')
    if assignee ~= '' then
        assert_type(keys[8], 'set')
    end

    local payload = decode_document(raw_payload)
    if p0 and not valid_task_payload(payload) then return reject('VALIDATION_FAILED') end
    assert(type(payload.title) == 'string', 'Expected a task title')
    assert(payload.description == nil or type(payload.description) == 'string', 'Invalid description')
    assert(payload.priority == nil or type(payload.priority) == 'string', 'Invalid priority')
    local seq_key = keys[#keys - 3]
    local numbers = { number = number, createdAtMs = tonumber(time), lastSeq = next_counter(seq_key) }
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
    }, 'task:' .. task_id, document, request_hash, placement.rebalanced and 'TODO', p0)

    redis.call('INCR', keys[3])
    redis.call('HSETNX', keys[4], issue_key, task_id)
    redis.call('INCR', seq_key)
    if p0 then
        redis.call('JSON.SET', keys[5], '.', document)
    else
        redis.call('JSON.SET', keys[5], '$', document)
    end
    redis.call('SADD', keys[6], task_id)
    redis.call('ZADD', keys[7], unpack(placement.entries))
    if p0 then redis.call('ZADD', keys[10], integer(number), task_id) end
    if assignee ~= '' then
        redis.call('SADD', keys[8], task_id)
    end
    return finish()
end

local function move_task(keys, args)
    local p0 = #keys == 10 and #args == 14
    if not p0 and (#keys ~= 9 or (#args ~= 13 and #args ~= 14)) then
        return reject('KEYS_MISMATCH')
    end
    local ws, project_id, task_id, actor, from, to, after_id, before_id, expected, idem, request_hash, mutation_id, time =
        unpack(args)
    local prefix = get_prefix(keys, ws)
    local suffixes = {
        'workspace-members:' .. ws, 'project:' .. project_id, 'task:' .. task_id,
        'board:' .. project_id .. ':' .. from, 'board:' .. project_id .. ':' .. to,
    }
    if p0 then suffixes[6] = 'workspace:' .. ws end
    if not prefix or not is_id(ws) or not is_id(project_id) or not is_id(task_id) or not is_id(actor)
        or idem == '' or not keys_match(keys, prefix, mutation_suffixes(suffixes, ws, actor, idem)) then
        return reject('KEYS_MISMATCH')
    end

    local task = read_document(keys[3])
    if not task or (not p0 and deleted_task(task)) then
        return reject('NOT_FOUND')
    end
    if task.workspaceId ~= ws or task.projectId ~= project_id or task.status ~= from or (p0 and task.id ~= task_id) then
        return reject('KEYS_MISMATCH')
    end
    local project
    if p0 then project = read_task_project(keys[2]) else project = read_document(keys[2]) end
    if not project or (p0 and project.id ~= project_id) then
        return reject('NOT_FOUND')
    end
    if project.workspaceId ~= ws then
        return reject('KEYS_MISMATCH')
    end
    local workspace
    if p0 then
        workspace = task_workspace(keys[6], ws)
        if not workspace or not task_workspace_member(keys[1], actor) then
            return reject('NOT_FOUND')
        end
    elseif not redis.call('HGET', keys[1], actor) then
        return reject('NOT_FOUND')
    end
    local previous = replay(keys[#keys], request_hash)
    if previous then
        return previous
    end
    if p0 and deleted_task(task) then return reject('NOT_FOUND') end
    if has_value(project.archivedAt) then
        return reject('PROJECT_ARCHIVED')
    end
    if p0 and has_value(workspace.suspendedAt) then
        return reject('WORKSPACE_SUSPENDED')
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
    local seq_key = keys[#keys - 3]
    local seq = next_counter(seq_key)
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
    }, 'task:' .. task_id, json_with_integers(task, numbers), request_hash, placement.rebalanced and to, p0)

    redis.call('INCR', seq_key)
    local path_root = p0 and '.' or '$.'
    redis.call('JSON.MSET',
        keys[3], path_root .. 'status', status_json,
        keys[3], path_root .. 'version', integer(numbers.version),
        keys[3], path_root .. 'lastSeq', integer(seq),
        keys[3], path_root .. 'lastClientMutationId', mutation_json)
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

-- Workspace and membership mutations (library v4).
local function ws_id(value)
    return type(value) == 'string' and #value == 29
        and value:match('^ws_[0-7][0-9A-HJKMNP-TV-Z]+$') ~= nil
end

local function ws_slug(value)
    return type(value) == 'string' and #value >= 1 and #value <= 64
        and value:match('^[a-z0-9][a-z0-9%-]*$') ~= nil
        and not value:find('--', 1, true) and value:sub(1, 1) ~= '-' and value:sub(-1) ~= '-'
end

local function ws_name(value)
    return type(value) == 'string' and #value > 0 and auth_code_points(value) <= 100
end

local function ws_mutation_args(args, first)
    local idem, hash, now_ms, request_id, mutation_id = unpack(args, first, first + 4)
    if type(idem) ~= 'string' or #idem < 1 or #idem > 128 or not idem:match('^[A-Za-z0-9._%-]+$')
        or type(hash) ~= 'string' or #hash ~= 64 or not hash:match('^[0-9a-f]+$')
        or type(request_id) ~= 'string' or request_id == ''
        or type(mutation_id) ~= 'string' or mutation_id == '' then return nil end
    local now = tonumber(now_ms)
    if not auth_integer(now, 0, 253402300799999) then return nil end
    return { idem = idem, hash = hash, now = now, request = request_id, mutation = mutation_id }
end

local function ws_public(workspace, actor_role)
    local data = {
        id = workspace.id, name = workspace.name, slug = workspace.slug,
        ownerId = workspace.ownerId, role = actor_role, createdAt = workspace.createdAt,
    }
    return json_with_integers(data, { version = workspace.version, createdAtMs = workspace.createdAtMs })
end

local function ws_outbox(keys, workspace, actor, meta, event_type, payload, change, data_json)
    -- Workspace mutations declare the same four trailing keys as task mutations.
    local seq_key = keys[#keys - 3]
    local seq = next_counter(seq_key)
    local finish = prepare_outbox(keys, seq, {
        workspaceId = workspace.id,
        actorId = actor,
        type = event_type,
        occurredAt = iso_timestamp(meta.now),
        requestId = meta.request,
        entityVersion = workspace.version,
        clientMutationId = meta.mutation,
        payload = payload,
    }, change, data_json, meta.hash, false)

    return function()
        redis.call('INCR', seq_key)
        return finish()
    end
end

local function ws_validate_document(workspace, ws)
    assert(workspace and workspace.id == ws and ws_id(workspace.id)
        and auth_id(workspace.ownerId) and ws_name(workspace.name) and ws_slug(workspace.slug)
        and type(workspace.createdAt) == 'string' and auth_integer(workspace.createdAtMs, 0, MAX_SAFE_INTEGER)
        and auth_integer(workspace.version, 1, MAX_SAFE_INTEGER), 'Invalid workspace document')
end

local function ws_preflight(keys, first, expected)
    for offset, kind in ipairs(expected) do assert_type(keys[first + offset - 1], kind) end
end

local function ws_membership(keys, index, actor)
    local role = redis.call('HGET', keys[index], actor)
    if role ~= 'OWNER' and role ~= 'ADMIN' and role ~= 'MEMBER' then return nil end
    return role
end

local function ws_load(keys, ws, actor)
    local workspace = read_document(keys[2])
    if not workspace or workspace.id ~= ws then return nil, reject('NOT_FOUND') end
    local role = ws_membership(keys, 1, actor)
    if not role then return nil, reject('NOT_FOUND') end
    ws_validate_document(workspace, ws)
    assert((role ~= 'OWNER' or actor == workspace.ownerId)
        and redis.call('HGET', keys[1], workspace.ownerId) == 'OWNER',
        'Workspace ownerId does not match the owner membership')
    return { doc = workspace, role = role }
end

local function create_workspace(keys, args)
    if #keys ~= 12 or #args ~= 9 then return reject('KEYS_MISMATCH') end
    local ws, actor, name, slug = unpack(args, 1, 4)
    local meta = ws_mutation_args(args, 5)
    if not ws_id(ws) or not auth_id(actor) or not meta then return reject('KEYS_MISMATCH') end
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. ws)
    local suffixes = { 'workspace-members:' .. ws, 'workspace:' .. ws,
        'user-workspaces:' .. actor, 'user-workspaces-page:' .. actor,
        'workspace-members-page:' .. ws, 'workspace-slug:' .. slug,
        'workspaces-by-created', 'user:' .. actor, 'workspace-seq:' .. ws,
        'workspace-changes:' .. ws, 'stream:domain-events', 'idempotency:' .. actor .. ':' .. meta.idem }
    if not prefix or not ws_slug(slug) or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    local user = read_document(keys[8])
    if not user or user.id ~= actor or has_value(user.disabledAt) then return reject('NOT_FOUND') end
    if not ws_name(name) or not ws_slug(slug) then return reject('VALIDATION_FAILED') end
    local previous = replay(keys[12], meta.hash)
    if previous then return previous end
    if redis.call('EXISTS', keys[1]) == 1 or redis.call('EXISTS', keys[2]) == 1 then return reject('KEYS_MISMATCH') end
    if redis.call('EXISTS', keys[6]) == 1 then return reject('WORKSPACE_SLUG_TAKEN') end
    ws_preflight(keys, 1, { 'hash', 'ReJSON-RL', 'set', 'zset', 'zset', 'string', 'zset', 'ReJSON-RL', 'string', 'zset', 'stream' })
    assert_type(keys[12], 'string')
    local workspace = {
        id = ws, name = name, slug = slug, ownerId = actor, schemaVersion = 1,
        createdAt = iso_timestamp(meta.now), archivedAt = cjson.null,
        suspendedAt = cjson.null, suspendedBy = cjson.null,
    }
    local raw = json_with_integers(workspace, { createdAtMs = meta.now, version = 1 })
    workspace.createdAtMs, workspace.version = meta.now, 1
    local finish = ws_outbox(keys, workspace, actor, meta, 'WORKSPACE_CREATED',
        {}, 'workspace:' .. ws, ws_public(workspace, 'OWNER'))
    redis.call('HSET', keys[1], actor, 'OWNER')
    redis.call('JSON.SET', keys[2], '$', raw)
    redis.call('SADD', keys[3], ws)
    redis.call('ZADD', keys[4], 0, ws)
    redis.call('ZADD', keys[5], 0, actor)
    redis.call('SET', keys[6], ws)
    redis.call('ZADD', keys[7], integer(meta.now), ws)
    return finish()
end

local function update_workspace(keys, args)
    if #keys ~= 8 or #args ~= 12 then return reject('KEYS_MISMATCH') end
    local ws, actor, old_slug, new_slug, expected, name, slug = unpack(args, 1, 7)
    local meta = ws_mutation_args(args, 8)
    if not ws_id(ws) or not auth_id(actor) or not meta then return reject('KEYS_MISMATCH') end
    if (slug ~= '' and new_slug ~= slug) or (slug == '' and new_slug ~= old_slug) then return reject('KEYS_MISMATCH') end
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. ws)
    local suffixes = { 'workspace-members:' .. ws, 'workspace:' .. ws, 'workspace-slug:' .. old_slug,
        'workspace-slug:' .. new_slug, 'workspace-seq:' .. ws, 'workspace-changes:' .. ws,
        'stream:domain-events', 'idempotency:' .. actor .. ':' .. meta.idem }
    if not prefix or not ws_slug(old_slug) or (new_slug ~= '' and not ws_slug(new_slug))
        or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    local loaded, failure = ws_load(keys, ws, actor)
    if not loaded then return failure end
    local workspace, role = loaded.doc, loaded.role
    if workspace.slug ~= old_slug then return reject('KEYS_MISMATCH') end
    if role ~= 'OWNER' and role ~= 'ADMIN' then return reject('FORBIDDEN') end
    local previous = replay(keys[8], meta.hash)
    if previous then return previous end
    if has_value(workspace.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end
    if not expected:match('^[1-9]%d*$') or tonumber(expected) ~= workspace.version then
        return reject('WORKSPACE_VERSION_CONFLICT', '{"currentVersion":' .. integer(workspace.version) .. '}')
    end
    local next_name = name ~= '' and name or workspace.name
    local next_slug = slug ~= '' and slug or workspace.slug
    if name ~= '' and not ws_name(name) or slug ~= '' and not ws_slug(slug) then return reject('VALIDATION_FAILED') end
    if name == '' and slug == '' then return reject('VALIDATION_FAILED') end
    if next_slug ~= workspace.slug and redis.call('EXISTS', keys[4]) == 1 then return reject('WORKSPACE_SLUG_TAKEN') end
    assert(workspace.version < MAX_SAFE_INTEGER, 'Workspace version exceeds safe integer range')
    ws_preflight(keys, 3, { 'string', 'string', 'string', 'zset', 'stream', 'string' })
    if redis.call('GET', keys[3]) ~= ws then return reject('KEYS_MISMATCH') end
    workspace.name, workspace.slug, workspace.version = next_name, next_slug, workspace.version + 1
    local finish = ws_outbox(keys, workspace, actor, meta, 'WORKSPACE_UPDATED',
        { name = next_name, slug = next_slug }, 'workspace:' .. ws, ws_public(workspace, role))
    local name_json, slug_json = cjson.encode(next_name), cjson.encode(next_slug)
    if next_slug ~= old_slug then
        redis.call('DEL', keys[3])
        redis.call('SET', keys[4], ws)
    end
    redis.call('JSON.MSET', keys[2], '$.name', name_json,
        keys[2], '$.slug', slug_json, keys[2], '$.version', integer(workspace.version))
    return finish()
end

local function add_workspace_member(keys, args)
    if #keys ~= 11 or #args ~= 9 then return reject('KEYS_MISMATCH') end
    local ws, actor, target, digest = unpack(args, 1, 4)
    local meta = ws_mutation_args(args, 5)
    if not ws_id(ws) or not auth_id(actor) or (target ~= '' and not auth_id(target)) or not meta then return reject('KEYS_MISMATCH') end
    local index_user = target ~= '' and target or 'none'
    local email_key = digest ~= '' and ('user-email:' .. digest) or 'user-email:none'
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. ws)
    local suffixes = { 'workspace-members:' .. ws, 'workspace:' .. ws, 'user-workspaces:' .. index_user,
        'user-workspaces-page:' .. index_user, 'workspace-members-page:' .. ws, 'user:' .. index_user,
        email_key, 'workspace-seq:' .. ws, 'workspace-changes:' .. ws, 'stream:domain-events',
        'idempotency:' .. actor .. ':' .. meta.idem }
    if not prefix or (digest ~= '' and (#digest ~= 64 or not digest:match('^[0-9a-f]+$')))
        or (target == '' and digest == '') or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    local loaded, failure = ws_load(keys, ws, actor)
    if not loaded then return failure end
    local role = loaded.role
    if role ~= 'OWNER' and role ~= 'ADMIN' then return reject('FORBIDDEN') end
    local previous = replay(keys[11], meta.hash)
    if previous then return previous end
    if has_value(loaded.doc.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end
    if digest ~= '' then
        local mapped = redis.call('GET', keys[7])
        if not mapped then return reject('NOT_FOUND') end
        if target == '' or mapped ~= target then return reject('KEYS_MISMATCH') end
    end
    if target == '' or target == actor then return reject('INVALID_MEMBER_TARGET') end
    local user = read_document(keys[6])
    if not user or user.id ~= target then return reject('NOT_FOUND') end
    if redis.call('HGET', keys[1], target) then return reject('MEMBER_ALREADY_EXISTS') end
    ws_preflight(keys, 3, { 'set', 'zset', 'zset', 'ReJSON-RL', 'string', 'string', 'zset', 'stream', 'string' })
    local workspace = loaded.doc
    assert(workspace.version < MAX_SAFE_INTEGER, 'Workspace version exceeds safe integer range')
    workspace.version = workspace.version + 1
    local data = { userId = target, role = 'MEMBER' }
    local finish = ws_outbox(keys, workspace, actor, meta, 'MEMBER_ADDED',
        data, 'member:' .. target, cjson.encode(data))
    redis.call('HSET', keys[1], target, 'MEMBER')
    redis.call('SADD', keys[3], ws)
    redis.call('ZADD', keys[4], 0, ws)
    redis.call('ZADD', keys[5], 0, target)
    redis.call('JSON.SET', keys[2], '$.version', integer(workspace.version))
    return finish()
end

local function update_workspace_role(keys, args)
    if #keys ~= 6 or #args ~= 10 then return reject('KEYS_MISMATCH') end
    local ws, actor, target, new_role, expected = unpack(args, 1, 5)
    local meta = ws_mutation_args(args, 6)
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. ws)
    local suffixes = { 'workspace-members:' .. ws, 'workspace:' .. ws, 'workspace-seq:' .. ws,
        'workspace-changes:' .. ws, 'stream:domain-events', 'idempotency:' .. actor .. ':' .. (meta and meta.idem or '') }
    if not prefix or not ws_id(ws) or not auth_id(actor) or not auth_id(target) or not meta
        or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    local loaded, failure = ws_load(keys, ws, actor)
    if not loaded then return failure end
    if loaded.role ~= 'OWNER' or loaded.doc.ownerId ~= actor then return reject('FORBIDDEN') end
    local previous = replay(keys[6], meta.hash)
    if previous then return previous end
    if has_value(loaded.doc.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end
    if target == actor then return reject('WORKSPACE_OWNER_REQUIRED') end
    local current = redis.call('HGET', keys[1], target)
    if not current then return reject('NOT_FOUND') end
    if current == 'OWNER' then return reject('WORKSPACE_OWNER_REQUIRED') end
    if new_role ~= 'ADMIN' and new_role ~= 'MEMBER' then return reject('VALIDATION_FAILED') end
    if not expected:match('^[1-9]%d*$') or tonumber(expected) ~= loaded.doc.version then
        return reject('WORKSPACE_VERSION_CONFLICT', '{"currentVersion":' .. integer(loaded.doc.version) .. '}')
    end
    ws_preflight(keys, 1, { 'hash', 'ReJSON-RL', 'string', 'zset', 'stream', 'string' })
    if current ~= 'ADMIN' and current ~= 'MEMBER' then return reject('NOT_FOUND') end
    if current == new_role then
        local raw_seq = redis.call('GET', keys[3]) or '0'
        assert(raw_seq:match('^%d+$'), 'Invalid workspace sequence')
        local current_seq = tonumber(raw_seq)
        assert(current_seq <= MAX_SAFE_INTEGER, 'Workspace sequence exceeds safe integer range')
        local response = '{"ok":true,"data":' .. cjson.encode({ userId = target, role = current })
            .. ',"seq":' .. integer(current_seq) .. '}'
        redis.call('SET', keys[6], cjson.encode({ requestHash = meta.hash, response = response }), 'EX', IDEMPOTENCY_TTL)
        return response
    end
    assert(loaded.doc.version < MAX_SAFE_INTEGER, 'Workspace version exceeds safe integer range')
    loaded.doc.version = loaded.doc.version + 1
    local data = { userId = target, role = new_role }
    local finish = ws_outbox(keys, loaded.doc, actor, meta, 'MEMBER_ROLE_UPDATED',
        data, 'member:' .. target, cjson.encode(data))
    redis.call('HSET', keys[1], target, new_role)
    redis.call('JSON.SET', keys[2], '$.version', integer(loaded.doc.version))
    return finish()
end

local function transfer_workspace_owner(keys, args)
    if #keys ~= 6 or #args ~= 8 then return reject('KEYS_MISMATCH') end
    local ws, actor, target = unpack(args, 1, 3)
    local meta = ws_mutation_args(args, 4)
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. ws)
    local suffixes = { 'workspace-members:' .. ws, 'workspace:' .. ws, 'workspace-seq:' .. ws,
        'workspace-changes:' .. ws, 'stream:domain-events', 'idempotency:' .. actor .. ':' .. (meta and meta.idem or '') }
    if not prefix or not ws_id(ws) or not auth_id(actor) or not auth_id(target) or not meta
        or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    local loaded, failure = ws_load(keys, ws, actor)
    if not loaded then return failure end
    local previous = replay(keys[6], meta.hash)
    if previous then return previous end
    if loaded.role ~= 'OWNER' or loaded.doc.ownerId ~= actor then return reject('FORBIDDEN') end
    if has_value(loaded.doc.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end
    if target == actor then return reject('INVALID_MEMBER_TARGET') end
    local target_role = redis.call('HGET', keys[1], target)
    if not target_role then return reject('NOT_FOUND') end
    if target_role ~= 'ADMIN' and target_role ~= 'MEMBER' then return reject('NOT_FOUND') end
    ws_preflight(keys, 1, { 'hash', 'ReJSON-RL', 'string', 'zset', 'stream', 'string' })
    assert(loaded.doc.version < MAX_SAFE_INTEGER, 'Workspace version exceeds safe integer range')
    loaded.doc.ownerId = target
    loaded.doc.version = loaded.doc.version + 1
    local finish = ws_outbox(keys, loaded.doc, actor, meta, 'WORKSPACE_OWNER_TRANSFERRED',
        { oldOwnerId = actor, ownerId = target }, 'workspace:' .. ws, ws_public(loaded.doc, 'ADMIN'))
    local target_json = cjson.encode(target)
    redis.call('HSET', keys[1], actor, 'ADMIN', target, 'OWNER')
    redis.call('JSON.MSET', keys[2], '$.ownerId', target_json,
        keys[2], '$.version', integer(loaded.doc.version))
    return finish()
end

local function remove_workspace_member(keys, args)
    if #keys ~= 10 or #args ~= 9 then return reject('KEYS_MISMATCH') end
    local ws, actor, target, mode = unpack(args, 1, 4)
    local meta = ws_mutation_args(args, 5)
    local index_user = target ~= '' and target or 'none'
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. ws)
    local suffixes = { 'workspace-members:' .. ws, 'workspace:' .. ws, 'user-workspaces:' .. index_user,
        'user-workspaces-page:' .. index_user, 'workspace-members-page:' .. ws, 'stream:audit',
        'workspace-seq:' .. ws, 'workspace-changes:' .. ws, 'stream:domain-events',
        'idempotency:' .. actor .. ':' .. (meta and meta.idem or '') }
    if not prefix or not ws_id(ws) or not auth_id(actor) or not auth_id(target) or not meta
        or (mode ~= 'remove' and mode ~= 'leave') or not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end
    local loaded, failure = ws_load(keys, ws, actor)
    if not loaded then return failure end
    if mode == 'leave' and target ~= actor then return reject('INVALID_MEMBER_TARGET') end
    if mode == 'remove' and target == actor then return reject('INVALID_MEMBER_TARGET') end
    if mode == 'remove' and loaded.role ~= 'OWNER' and loaded.role ~= 'ADMIN' then return reject('FORBIDDEN') end
    local previous = replay(keys[10], meta.hash)
    if previous then return previous end
    if has_value(loaded.doc.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end
    local target_role = redis.call('HGET', keys[1], target)
    if not target_role then return reject('NOT_FOUND') end
    if target_role ~= 'OWNER' and target_role ~= 'ADMIN' and target_role ~= 'MEMBER' then return reject('NOT_FOUND') end
    if mode == 'remove' and loaded.role == 'ADMIN' and target_role ~= 'MEMBER' then return reject('FORBIDDEN') end
    if target_role == 'OWNER' then return reject('WORKSPACE_OWNER_REQUIRED') end
    ws_preflight(keys, 1, { 'hash', 'ReJSON-RL', 'set', 'zset', 'zset', 'stream', 'string', 'zset', 'stream', 'string' })
    assert(loaded.doc.version < MAX_SAFE_INTEGER, 'Workspace version exceeds safe integer range')
    loaded.doc.version = loaded.doc.version + 1
    local data = { userId = target }
    local finish = ws_outbox(keys, loaded.doc, actor, meta, 'MEMBER_REMOVED',
        data, 'member:' .. target, cjson.encode(data))
    local audit_type = mode == 'leave' and 'workspace.member.leave' or 'workspace.member.remove'
    local occurred_at = iso_timestamp(meta.now)
    redis.call('HDEL', keys[1], target)
    redis.call('SREM', keys[3], ws)
    redis.call('ZREM', keys[4], ws)
    redis.call('ZREM', keys[5], target)
    redis.call('JSON.SET', keys[2], '$.version', integer(loaded.doc.version))
    redis.call('XADD', keys[6], '*', 'type', audit_type, 'workspaceId', ws,
        'actorId', actor, 'targetId', target, 'requestId', meta.request,
        'occurredAt', occurred_at)
    return finish()
end

redis.register_function('sh_create_workspace', create_workspace)
redis.register_function('sh_update_workspace', update_workspace)
redis.register_function('sh_add_workspace_member', add_workspace_member)
redis.register_function('sh_update_workspace_role', update_workspace_role)
redis.register_function('sh_transfer_workspace_owner', transfer_workspace_owner)
redis.register_function('sh_remove_workspace_member', remove_workspace_member)

-- Durable member removal jobs
do
    local lease_ms = 30000
    local batch_limit = 100
    local queue_suffix = 'unassign-jobs-by-due'
    local stream_suffix = 'stream:domain-events'
    local function ok(data)
        return '{"ok":true,"data":' .. data .. ',"seq":null}'
    end

    local function valid_component(value)
        return #value <= 128 and value:match('^[A-Za-z0-9_-]+$') ~= nil
    end

    local function valid_cursor(value)
        return #value <= 20 and value:match('^%d+$') ~= nil
    end

    local function job_prefix(keys, id, ws, user)
        if not valid_component(id) or not valid_component(ws) or not valid_component(user) then
            return nil
        end
        return auth_prefix(keys[1], 'job:' .. id)
    end

    local function job_scope(id, ws, user)
        return { 'job:' .. id, queue_suffix, 'lock:unassign:' .. ws .. ':' .. user,
            'fence:unassign:' .. ws .. ':' .. user }
    end

    local function validate_job(job, id, ws, user)
        assert(job.id == id and job.workspaceId == ws and job.userId == user, 'Invalid unassign job identity')
        assert(type(job.cursor) == 'string' and valid_cursor(job.cursor), 'Invalid unassign cursor')
        assert(job.status == 'PENDING' or job.status == 'RUNNING' or job.status == 'DONE',
            'Invalid unassign job status')
    end

    redis.register_function('sh_persist_unassign_job', function(keys, args)
        if #keys ~= 2 or #args ~= 4 then return reject('KEYS_MISMATCH') end
        local id, ws, user, event_id = unpack(args)
        local prefix = job_prefix(keys, id, ws, user)
        local event_workspace, seq = event_id:match('^([^:]+):([1-9]%d*)$')
        if not prefix or ws ~= event_workspace or #seq > 16 or id ~= 'unassign-' .. ws .. '-' .. seq
            or not keys_match(keys, prefix, { 'job:' .. id, queue_suffix }) then
            return reject('KEYS_MISMATCH')
        end

        local existing = read_document(keys[1])
        if existing then
            validate_job(existing, id, ws, user)
            assert(existing.eventId == event_id, 'Invalid unassign source ID')
            return ok('false')
        end
        assert_type(keys[2], 'zset')
        local now = auth_time_ms()
        local document = cjson.encode({ id = id, workspaceId = ws, userId = user, eventId = event_id,
            createdAtMs = now, cursor = '0', status = 'PENDING' })
        if redis.call('JSON.SET', keys[1], '$', document, 'NX') then
            redis.call('ZADD', keys[2], integer(now), id)
            return ok('true')
        end
        return ok('false')
    end)

    redis.register_function('sh_claim_unassign_job', function(keys, args)
        if #keys ~= 4 or #args ~= 4 then return reject('KEYS_MISMATCH') end
        local id, ws, user, token = unpack(args)
        local prefix = job_prefix(keys, id, ws, user)
        if not prefix or not valid_component(token) or not keys_match(keys, prefix, job_scope(id, ws, user)) then
            return reject('KEYS_MISMATCH')
        end

        local job = read_document(keys[1])
        if not job then return ok('null') end
        validate_job(job, id, ws, user)
        if job.status == 'DONE' then return ok('null') end
        assert_type(keys[2], 'zset')
        assert_type(keys[3], 'string')
        local now = auth_time_ms()
        local ttl = redis.call('PTTL', keys[3])
        assert(ttl ~= -1, 'Unassign lock must expire')
        if ttl >= 0 then
            redis.call('ZADD', keys[2], integer(now + math.max(ttl, 1)), id)
            return ok('null')
        end

        local epoch = next_counter(keys[4])
        local response = ok(json_with_integers({ cursor = job.cursor }, { epoch = epoch }))
        redis.call('INCR', keys[4])
        redis.call('SET', keys[3], id .. ':' .. token, 'PX', lease_ms)
        redis.call('JSON.SET', keys[1], '$.status', '"RUNNING"')
        redis.call('ZADD', keys[2], integer(now + lease_ms), id)
        return response
    end)

    local task_paths = { '.id', '.workspaceId', '.projectId', '.assigneeId', '.deletedAt',
        '.isDeleted', '.version' }
    local optional_task_paths = { '$.id', '$.workspaceId', '$.projectId', '$.assigneeId', '$.deletedAt',
        '$.isDeleted', '$.version' }

    local function read_unassign_task(key)
        -- Single-location paths return scalars without allocating one array per field.
        local raw = redis.pcall('JSON.GET', key, unpack(task_paths))
        if type(raw) ~= 'table' then return raw and cjson.decode(raw) end
        if raw.err ~= 'ERR Path does not exist' then error(raw.err) end

        -- Multi-path legacy reads reject an absent field, which older records may omit.
        local values = cjson.decode(redis.call('JSON.GET', key, unpack(optional_task_paths)))
        local task = {}
        for i, path in ipairs(task_paths) do task[path] = values[optional_task_paths[i]][1] end
        return task
    end

    local function plan_unassign(key, id, ws, user, seq, occurred_at, event_payload)
        local task = read_unassign_task(key)
        if not task or task['.id'] ~= id or task['.workspaceId'] ~= ws or task['.assigneeId'] ~= user
            or has_value(task['.deletedAt']) or task['.isDeleted'] == 'true' then
            return nil
        end
        local version = task['.version']
        local project = task['.projectId']
        assert(auth_integer(version, 1, MAX_SAFE_INTEGER - 1), 'Invalid task version')
        assert(seq <= MAX_SAFE_INTEGER, 'Workspace seq exceeds safe integer range')
        assert(type(project) == 'string' and is_id(project), 'Invalid task project')
        local seq_arg = integer(seq)
        local version_arg = integer(version + 1)
        return {
            id = id, seq = seq_arg, version = version_arg, key = key,
            event = {
                'eventId', ws .. ':' .. seq_arg, 'eventVersion', '1', 'type', 'TASK_UNASSIGNED',
                'workspaceId', ws, 'projectId', project, 'taskId', id, 'actorId', 'worker:unassign',
                'entityVersion', version_arg, 'seq', seq_arg, 'occurredAt', occurred_at,
                'payload', event_payload,
            },
        }
    end

    redis.register_function('sh_run_unassign_batch', function(keys, args)
        if #args < 7 or #args > 7 + batch_limit or #keys ~= #args + 2 then
            return reject('KEYS_MISMATCH')
        end
        local id, ws, user, token, epoch, cursor, next_cursor = unpack(args, 1, 7)
        local prefix = job_prefix(keys, id, ws, user)
        if not prefix or not valid_component(token) or not epoch:match('^[1-9]%d*$')
            or not valid_cursor(cursor) or (next_cursor ~= '' and not valid_cursor(next_cursor))
            or (next_cursor == '' and #args == 7) then
            return reject('KEYS_MISMATCH')
        end
        local suffixes = job_scope(id, ws, user)
        suffixes[5], suffixes[6] = 'workspace-members:' .. ws, 'user-assigned:' .. user
        suffixes[7], suffixes[8], suffixes[9] = 'workspace-seq:' .. ws, 'workspace-changes:' .. ws, stream_suffix
        for i = 8, #args do
            if not valid_component(args[i]) then return reject('KEYS_MISMATCH') end
            suffixes[i + 2] = 'task:' .. args[i]
        end
        if not keys_match(keys, prefix, suffixes) then return reject('KEYS_MISMATCH') end

        local job = read_document(keys[1])
        if not job then return reject('STALE_JOB_EPOCH') end
        validate_job(job, id, ws, user)
        if job.status ~= 'RUNNING' or redis.call('GET', keys[3]) ~= id .. ':' .. token
            or redis.call('GET', keys[4]) ~= epoch then
            return reject('STALE_JOB_EPOCH')
        end
        if job.cursor ~= cursor then return reject('STALE_JOB_CURSOR') end

        assert_type(keys[2], 'zset')
        local now = auth_time_ms()
        local rejoined = redis.call('HEXISTS', keys[5], user) == 1
        local done = rejoined or next_cursor == '0'
        local saved_cursor = rejoined and '0' or (next_cursor ~= '' and next_cursor or cursor)
        local plans = {}
        local first_seq
        if not rejoined and #args > 7 then
            assert_type(keys[6], 'set')
            assert_type(keys[8], 'zset')
            assert_type(keys[9], 'stream')
            first_seq = next_counter(keys[7])
            local occurred_at = iso_timestamp(now)
            local event_payload = cjson.encode({ userId = user })
            local seen = {}
            for i = 8, #args do
                local task_id = args[i]
                if not seen[task_id] then
                    seen[task_id] = true
                    local plan = plan_unassign(keys[i + 2], task_id, ws, user, first_seq + #plans, occurred_at, event_payload)
                    if plan then plans[#plans + 1] = plan end
                end
            end
        end

        local cursor_json = cjson.encode(saved_cursor)
        local response = ok(cjson.encode({ cursor = saved_cursor, done = done }))
        if #plans > 0 then
            local updates, assigned, changes = {}, {}, {}
            for _, plan in ipairs(plans) do
                for _, arg in ipairs({
                    plan.key, '.assigneeId', 'null',
                    plan.key, '.assigneeIndexValue', '"UNASSIGNED"',
                    plan.key, '.version', plan.version,
                    plan.key, '.lastSeq', plan.seq,
                }) do
                    updates[#updates + 1] = arg
                end
                assigned[#assigned + 1] = plan.id
                changes[#changes + 1] = plan.seq
                changes[#changes + 1] = 'task:' .. plan.id
            end

            redis.call('JSON.MSET', unpack(updates))
            redis.call('SET', keys[7], integer(first_seq + #plans - 1))
            redis.call('SREM', keys[6], unpack(assigned))
            redis.call('ZADD', keys[8], unpack(changes))
            for _, plan in ipairs(plans) do
                redis.call('XADD', keys[9], '*', unpack(plan.event))
            end
        end
        redis.call('JSON.SET', keys[1], '$.cursor', cursor_json)
        if done then
            redis.call('JSON.SET', keys[1], '$.status', '"DONE"')
            redis.call('ZREM', keys[2], id)
            redis.call('DEL', keys[3])
        else
            redis.call('PEXPIRE', keys[3], lease_ms)
            redis.call('ZADD', keys[2], integer(now + lease_ms), id)
        end
        return response
    end)

    redis.register_function('sh_dead_letter_unassign', function(keys, args)
        if #keys ~= 3 or #args ~= 1 or not args[1]:match('^%d+%-%d+$') then
            return reject('KEYS_MISMATCH')
        end
        local id = args[1]
        local prefix = auth_prefix(keys[1], stream_suffix)
        if not prefix or not keys_match(keys, prefix, { stream_suffix, 'stream:dead-letter', 'processed:dlq:' .. id }) then
            return reject('KEYS_MISMATCH')
        end
        if redis.call('GET', keys[3]) then return ok('false') end
        assert_type(keys[2], 'stream')
        local entries = redis.call('XRANGE', keys[1], id, id, 'COUNT', 1)
        if #entries == 0 then return ok('false') end
        local event = cjson.encode(entries[1][2])
        redis.call('XADD', keys[2], '*', 'sourceId', id, 'group', 'unassign', 'event', event)
        redis.call('SET', keys[3], '1')
        return ok('true')
    end)
end

-- P0 project mutations (library v5).
local function project_id(value)
    return type(value) == 'string' and #value == 30
        and value:match('^prj_[0-7][0-9A-HJKMNP-TV-Z]+$') ~= nil
end

local function project_key(value)
    return type(value) == 'string' and #value >= 2 and #value <= 10
        and value:match('^[A-Z0-9]+$') ~= nil
end

local function project_name(value)
    if type(value) ~= 'string' or value == '' or auth_code_points(value) > 100 then return false end
    return value == value:gsub('^%s+', ''):gsub('%s+$', '')
end

local function project_description(value)
    return within_text_limit(value, 8000)
end

local function project_validate_document(project, pid, ws)
    assert(project and project.id == pid and project.workspaceId == ws and project_id(project.id)
        and ws_id(project.workspaceId) and auth_id(project.createdBy)
        and project_name(project.name) and project_key(project.key)
        and type(project.description) == 'string'
        and type(project.createdAt) == 'string'
        and auth_integer(project.createdAtMs, 0, MAX_SAFE_INTEGER)
        and auth_integer(project.version, 1, MAX_SAFE_INTEGER)
        and (project.archivedAt == cjson.null or project.archivedAt == nil or type(project.archivedAt) == 'string'),
        'Invalid project document')
end

local function project_public_json(project)
    local data = {
        id = project.id, workspaceId = project.workspaceId, name = project.name, key = project.key,
        description = project.description, createdBy = project.createdBy, createdAt = project.createdAt,
        archivedAt = project.archivedAt == nil and cjson.null or project.archivedAt,
    }
    return json_with_integers(data, { createdAtMs = project.createdAtMs, version = project.version })
end

local function project_document_json(data)
    return data:sub(1, -2) .. ',"schemaVersion":1}'
end

local function project_outbox(keys, workspace, project, actor, meta, event_type, payload, data)
    local seq_key = keys[#keys - 3]
    local seq = next_counter(seq_key)
    local finish = prepare_outbox(keys, seq, {
        workspaceId = workspace.id, projectId = project.id, actorId = actor,
        type = event_type, occurredAt = iso_timestamp(meta.now), requestId = meta.request,
        entityVersion = project.version, clientMutationId = meta.mutation, payload = payload,
    }, 'project:' .. project.id, data, meta.hash, false)

    return function()
        redis.call('INCR', seq_key)
        return finish()
    end
end

local function project_response(project, seq)
    return '{"ok":true,"data":' .. project_public_json(project) .. ',"seq":' .. integer(seq) .. '}'
end

local function project_current_seq(key)
    local raw = redis.call('GET', key) or '0'
    assert(raw == '0' or raw:match('^[1-9]%d*$'), 'Invalid workspace sequence')
    local seq = tonumber(raw)
    assert(seq and seq <= MAX_SAFE_INTEGER, 'Workspace sequence exceeds safe integer range')
    return seq
end

local function project_keys(keys, ws, pid, actor, idem, suffixes)
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. ws)
    suffixes[#suffixes + 1] = 'workspace-seq:' .. ws
    suffixes[#suffixes + 1] = 'workspace-changes:' .. ws
    suffixes[#suffixes + 1] = 'stream:domain-events'
    suffixes[#suffixes + 1] = 'idempotency:' .. actor .. ':' .. idem
    if not prefix or not keys_match(keys, prefix, suffixes) then return nil end
    return prefix
end

local function create_project(keys, args)
    if #keys ~= 10 or #args ~= 11 then return reject('KEYS_MISMATCH') end
    local ws, pid, actor, new_key, name, description = unpack(args, 1, 6)
    local meta = ws_mutation_args(args, 7)
    if not ws_id(ws) or not project_id(pid) or not auth_id(actor) or not meta then return reject('KEYS_MISMATCH') end
    if not project_key(new_key) or not project_name(name) or not project_description(description) then
        return reject('VALIDATION_FAILED')
    end
    if not project_keys(keys, ws, pid, actor, meta.idem, {
        'workspace-members:' .. ws, 'workspace:' .. ws, 'project:' .. pid,
        'workspace-projects:' .. ws, 'workspace-projects-page:' .. ws,
        'project-key:' .. ws .. ':' .. new_key,
    }) then return reject('KEYS_MISMATCH') end

    ws_preflight(keys, 1, { 'hash', 'ReJSON-RL', 'ReJSON-RL', 'set', 'zset', 'string',
        'string', 'zset', 'stream', 'string' })
    local loaded, failure = ws_load(keys, ws, actor)
    if not loaded then return failure end
    if has_value(loaded.doc.archivedAt) then return reject('NOT_FOUND') end
    local role = loaded.role
    if role ~= 'OWNER' and role ~= 'ADMIN' then return reject('FORBIDDEN') end
    local previous = replay(keys[10], meta.hash)
    if previous then return previous end
    if has_value(loaded.doc.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end
    if redis.call('EXISTS', keys[3]) == 1 then return reject('KEYS_MISMATCH') end
    if redis.call('EXISTS', keys[6]) == 1 then return reject('PROJECT_KEY_TAKEN') end

    local project = {
        id = pid, workspaceId = ws, name = name, key = new_key, description = description,
        createdBy = actor, createdAt = iso_timestamp(meta.now), createdAtMs = meta.now,
        archivedAt = cjson.null, version = 1, schemaVersion = 1,
    }
    local data = project_public_json(project)
    local document = project_document_json(data)
    local finish = project_outbox(keys, loaded.doc, project, actor, meta, 'PROJECT_CREATED',
        { projectId = pid, key = new_key }, data)

    redis.call('JSON.SET', keys[3], '$', document)
    redis.call('SADD', keys[4], pid)
    redis.call('ZADD', keys[5], 0, pid)
    redis.call('SET', keys[6], pid)
    return finish()
end

local function update_project(keys, args)
    if #keys ~= 10 or #args ~= 13 then return reject('KEYS_MISMATCH') end
    local ws, pid, actor, old_key, new_key, mode, expected, raw_patch = unpack(args, 1, 8)
    local meta = ws_mutation_args(args, 9)
    if not ws_id(ws) or not project_id(pid) or not auth_id(actor) or not project_key(old_key) or not meta then
        return reject('KEYS_MISMATCH')
    end
    if not project_key(new_key) or (mode ~= 'update' and mode ~= 'archive' and mode ~= 'unarchive') then
        return reject('VALIDATION_FAILED')
    end
    if type(expected) ~= 'string' or not expected:match('^[1-9]%d*$') then return reject('VALIDATION_FAILED') end
    if not project_keys(keys, ws, pid, actor, meta.idem, {
        'workspace-members:' .. ws, 'workspace:' .. ws, 'project:' .. pid,
        'project-key:' .. ws .. ':' .. old_key, 'project-key:' .. ws .. ':' .. new_key,
        'project-task-seq:' .. pid,
    }) then return reject('KEYS_MISMATCH') end

    ws_preflight(keys, 1, { 'hash', 'ReJSON-RL', 'ReJSON-RL', 'string', 'string', 'string',
        'string', 'zset', 'stream', 'string' })
    local loaded, failure = ws_load(keys, ws, actor)
    if not loaded then return failure end
    if has_value(loaded.doc.archivedAt) then return reject('NOT_FOUND') end
    local project = read_document(keys[3])
    if not project or project.id ~= pid or project.workspaceId ~= ws then return reject('NOT_FOUND') end
    project_validate_document(project, pid, ws)
    if project.key ~= old_key then return reject('KEYS_MISMATCH') end
    local role = loaded.role
    if role ~= 'OWNER' and role ~= 'ADMIN' then return reject('FORBIDDEN') end
    local previous = replay(keys[10], meta.hash)
    if previous then return previous end
    if mode ~= 'unarchive' and has_value(project.archivedAt) then return reject('PROJECT_ARCHIVED') end
    if has_value(loaded.doc.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end

    local version = tonumber(expected)
    if not auth_integer(version, 1, MAX_SAFE_INTEGER) or version ~= project.version then
        return reject('PROJECT_VERSION_CONFLICT', '{"currentVersion":' .. integer(project.version) .. '}')
    end
    if redis.call('GET', keys[4]) ~= pid then
        assert(false, 'Project key index does not point to project')
    end

    local patch = nil
    if mode == 'update' then
        if type(raw_patch) ~= 'string' or not raw_patch:match('^%s*{') then return reject('VALIDATION_FAILED') end
        local ok, decoded = pcall(decode_document, raw_patch)
        if not ok or type(decoded) ~= 'table' then return reject('VALIDATION_FAILED') end
        patch = decoded
        for field in pairs(patch) do
            if field ~= 'name' and field ~= 'description' then return reject('VALIDATION_FAILED') end
        end
        if next(patch) == nil and new_key == old_key then return reject('VALIDATION_FAILED') end
        if patch.name ~= nil and (type(patch.name) ~= 'string' or not project_name(patch.name)) then
            return reject('VALIDATION_FAILED')
        end
        if patch.description ~= nil and not project_description(patch.description) then
            return reject('VALIDATION_FAILED')
        end
    elseif raw_patch ~= '{}' or new_key ~= old_key then
        return reject('VALIDATION_FAILED')
    end

    if mode == 'unarchive' and not has_value(project.archivedAt) then
        local seq = project_current_seq(keys[7])
        local response = project_response(project, seq)
        redis.call('SET', keys[10], cjson.encode({ requestHash = meta.hash, response = response }),
            'EX', IDEMPOTENCY_TTL)
        return response
    end

    local changing_key = new_key ~= old_key
    local raw_counter = redis.call('GET', keys[6]) or '0'
    assert(raw_counter == '0' or raw_counter:match('^[1-9]%d*$'), 'Invalid project task counter')
    local counter = tonumber(raw_counter)
    assert(counter and counter <= MAX_SAFE_INTEGER, 'Project task counter exceeds safe integer range')
    if changing_key then
        if counter > 0 then return reject('PROJECT_KEY_IMMUTABLE') end
        if redis.call('EXISTS', keys[5]) == 1 then return reject('PROJECT_KEY_TAKEN') end
    end
    assert(project.version < MAX_SAFE_INTEGER, 'Project version exceeds safe integer range')

    if patch then
        if patch.name ~= nil then project.name = patch.name end
        if patch.description ~= nil then project.description = patch.description end
    end
    if changing_key then project.key = new_key end
    if mode == 'archive' then project.archivedAt = iso_timestamp(meta.now) end
    if mode == 'unarchive' then project.archivedAt = cjson.null end
    project.version = project.version + 1

    local event_type = 'PROJECT_UPDATED'
    if mode == 'archive' then event_type = 'PROJECT_ARCHIVED' end
    if mode == 'unarchive' then event_type = 'PROJECT_UNARCHIVED' end
    local payload = { projectId = pid, key = project.key }
    if patch and patch.name ~= nil then payload.name = project.name end
    if mode == 'archive' or mode == 'unarchive' then payload.archivedAt = project.archivedAt end

    local data = project_public_json(project)
    local document = project_document_json(data)
    local finish = project_outbox(keys, loaded.doc, project, actor, meta, event_type, payload, data)
    if changing_key then
        redis.call('DEL', keys[4])
        redis.call('SET', keys[5], pid)
    end
    redis.call('JSON.SET', keys[3], '$', document)
    return finish()
end

redis.register_function('sh_create_project', create_project)
redis.register_function('sh_update_project', update_project)

-- P0 task update, assignment, and delete functions (library v5).
local function task_id(value)
    return type(value) == 'string' and #value == 30 and value:match('^tsk_[0-7][0-9A-HJKMNP-TV-Z]+$') ~= nil
end

local function task_mutation_base(keys, args, count, suffixes)
    if #keys ~= count then return nil, reject('KEYS_MISMATCH') end
    local ws, pid, tid, actor = unpack(args, 1, 4)
    local meta = ws_mutation_args(args, 9)
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. tostring(ws))
    if not prefix or not ws_id(ws) or not project_id(pid) or not task_id(tid) or not auth_id(actor) or not meta
        or not keys_match(keys, prefix, suffixes(meta)) then return nil, reject('KEYS_MISMATCH') end

    local task = read_document(keys[4])
    local workspace = task_workspace(keys[2], ws)
    local project = read_task_project(keys[3])
    if not workspace or not project or project.id ~= pid or project.workspaceId ~= ws
        or not task or task.id ~= tid or task.workspaceId ~= ws or task.projectId ~= pid then
        return nil, reject('NOT_FOUND')
    end
    local role = ws_membership(keys, 1, actor)
    if not role then return nil, reject('NOT_FOUND') end
    return { ws = ws, pid = pid, tid = tid, actor = actor, meta = meta,
        task = task, workspace = workspace, project = project }
end

local function task_current_version(task)
    assert(auth_integer(task.version, 1, MAX_SAFE_INTEGER), 'Invalid task version')
    return task.version
end

local function task_expected_version(raw)
    if type(raw) ~= 'string' or not raw:match('^[1-9]%d*$') then return nil end
    local value = tonumber(raw)
    if not auth_integer(value, 1, MAX_SAFE_INTEGER) then return nil end
    return value
end

local function task_write(keys, args, is_assign)
    if #args ~= 13 then return reject('KEYS_MISMATCH') end
    local patch_ok, patch = pcall(decode_document, args[8])
    if not patch_ok or type(patch) ~= 'table' then return reject('VALIDATION_FAILED') end
    local old_assignee, new_assignee, expected = args[5], args[6], task_expected_version(args[7])
    local base, failure = task_mutation_base(keys, args, 10, function(meta)
        return mutation_suffixes({ 'workspace-members:' .. args[1], 'workspace:' .. args[1],
            'project:' .. args[2], 'task:' .. args[3],
            'user-assigned:' .. (args[5] == '' and 'none' or args[5]),
            'user-assigned:' .. (args[6] == '' and 'none' or args[6]) },
            args[1], args[4], meta.idem)
    end)
    if not base then return failure end
    local task, meta = base.task, base.meta
    local previous = replay(keys[10], meta.hash)
    if previous then return previous end
    if deleted_task(task) then return reject('NOT_FOUND') end
    if has_value(base.project.archivedAt) then return reject('PROJECT_ARCHIVED') end
    if has_value(base.workspace.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end

    local version = task_current_version(task)
    if not expected then return reject('VALIDATION_FAILED') end
    if version ~= expected then return reject('TASK_VERSION_CONFLICT', '{"currentVersion":' .. integer(version) .. '}') end
    local actual_old = has_value(task.assigneeId) and task.assigneeId or ''
    if old_assignee ~= actual_old or (new_assignee ~= '' and not auth_id(new_assignee)) then return reject('KEYS_MISMATCH') end
    local assignment_supplied = patch.assigneeId ~= nil
    local desired = patch.assigneeId
    if desired == cjson.null then desired = '' end
    if desired == nil then desired = old_assignee end
    if desired ~= new_assignee then return reject('KEYS_MISMATCH') end
    if is_assign then
        local field_count = 0
        for field in pairs(patch) do
            if field ~= 'assigneeId' then return reject('VALIDATION_FAILED') end
            field_count = field_count + 1
        end
        if field_count ~= 1 then return reject('VALIDATION_FAILED') end
    end
    if assignment_supplied and new_assignee ~= '' and not task_workspace_member(keys[1], new_assignee) then
        return reject('ASSIGNEE_NOT_MEMBER')
    end

    if not is_assign then
        for field, value in pairs(patch) do
            if field == 'title' then
                if type(value) ~= 'string' or value ~= value:match('^%s*(.-)%s*$') or #value == 0
                    or auth_code_points(value) > 200 then return reject('VALIDATION_FAILED') end
            elseif field == 'description' then
                if not within_text_limit(value, 20000) then return reject('VALIDATION_FAILED') end
            elseif field == 'priority' then
                if value ~= 'LOW' and value ~= 'MEDIUM' and value ~= 'HIGH' and value ~= 'URGENT' then
                    return reject('VALIDATION_FAILED')
                end
            elseif field == 'dueAtMs' then
                if value ~= cjson.null and not auth_integer(value, 0, MAX_SAFE_INTEGER) then return reject('VALIDATION_FAILED') end
            elseif field ~= 'assigneeId' then
                return reject('VALIDATION_FAILED')
            end
        end
        if next(patch) == nil then return reject('VALIDATION_FAILED') end
    end

    if old_assignee ~= '' then assert_type(keys[5], 'set') end
    if new_assignee ~= '' then assert_type(keys[6], 'set') end
    assert_type(keys[7], 'string')
    assert_type(keys[8], 'zset')
    assert_type(keys[9], 'stream')
    assert(version < MAX_SAFE_INTEGER, 'Task version exceeds safe integer range')
    local seq = next_counter(keys[7])

    for field, value in pairs(patch) do
        if field == 'assigneeId' then
            task.assigneeId = value
            task.assigneeIndexValue = new_assignee ~= '' and new_assignee or 'UNASSIGNED'
        else
            task[field] = value
        end
    end
    task.version, task.lastSeq = version + 1, seq
    task.lastClientMutationId = meta.mutation
    local nums = { version = task.version, lastSeq = seq }
    task.version, task.lastSeq = nil, nil
    if type(task.number) == 'number' then nums.number, task.number = task.number, nil end
    if type(task.createdAtMs) == 'number' then nums.createdAtMs, task.createdAtMs = task.createdAtMs, nil end
    if type(task.dueAtMs) == 'number' then nums.dueAtMs, task.dueAtMs = task.dueAtMs, nil end
    local document = json_with_integers(task, nums)
    local event_type = is_assign and 'TASK_ASSIGNED' or 'TASK_UPDATED'
    local changed_fields = {}
    for field in pairs(patch) do changed_fields[#changed_fields + 1] = field end
    table.sort(changed_fields)
    local finish = prepare_outbox(keys, seq, {
        requestId = meta.request, type = event_type, workspaceId = base.ws, projectId = base.pid,
        taskId = base.tid, actorId = base.actor, entityVersion = version + 1,
        clientMutationId = meta.mutation, occurredAt = iso_timestamp(meta.now),
        payload = is_assign and { assigneeId = new_assignee ~= '' and new_assignee or cjson.null }
            or { fields = changed_fields },
    }, 'task:' .. base.tid, document, meta.hash, false)

    redis.call('INCR', keys[7])
    redis.call('JSON.SET', keys[4], '$', document)
    if old_assignee ~= new_assignee then
        if old_assignee ~= '' then redis.call('SREM', keys[5], base.tid) end
        if new_assignee ~= '' then redis.call('SADD', keys[6], base.tid) end
    end
    return finish()
end

local function update_task(keys, args)
    return task_write(keys, args, false)
end

local function assign_task(keys, args)
    return task_write(keys, args, true)
end

local function delete_task(keys, args)
    if #keys ~= 12 or #args ~= 12 then return reject('KEYS_MISMATCH') end
    local ws, pid, tid, actor, status, old_assignee, expected = unpack(args, 1, 7)
    local meta = ws_mutation_args(args, 8)
    local prefix = auth_prefix(keys[1], 'workspace-members:' .. tostring(ws))
    local suffixes = meta and mutation_suffixes({ 'workspace-members:' .. ws, 'workspace:' .. ws,
        'project:' .. pid, 'task:' .. tid, 'project-tasks:' .. pid, 'board:' .. pid .. ':' .. status,
        'backlog:' .. pid, 'user-assigned:' .. (old_assignee == '' and 'none' or old_assignee) }, ws, actor, meta.idem)
    if not prefix or not ws_id(ws) or not project_id(pid) or not task_id(tid) or not auth_id(actor) or not meta
        or (status ~= 'TODO' and status ~= 'IN_PROGRESS' and status ~= 'IN_REVIEW' and status ~= 'DONE')
        or (old_assignee ~= '' and not auth_id(old_assignee)) or not keys_match(keys, prefix, suffixes) then
        return reject('KEYS_MISMATCH')
    end
    local task, workspace, project = read_document(keys[4]), task_workspace(keys[2], ws), read_task_project(keys[3])
    if not workspace or not project or project.id ~= pid or project.workspaceId ~= ws
        or not task or task.id ~= tid or task.workspaceId ~= ws or task.projectId ~= pid then return reject('NOT_FOUND') end
    local role = ws_membership(keys, 1, actor)
    if not role then return reject('NOT_FOUND') end
    if role ~= 'OWNER' and role ~= 'ADMIN' and task.reporterId ~= actor then return reject('FORBIDDEN') end
    local previous = replay(keys[12], meta.hash)
    if previous then return previous end
    if deleted_task(task) then return reject('NOT_FOUND') end
    if has_value(project.archivedAt) then return reject('PROJECT_ARCHIVED') end
    if has_value(workspace.suspendedAt) then return reject('WORKSPACE_SUSPENDED') end
    if task.status ~= status or (has_value(task.assigneeId) and task.assigneeId or '') ~= old_assignee then
        return reject('KEYS_MISMATCH')
    end
    if has_value(task.sprintId) or (type(task.labelIds) == 'table' and #task.labelIds > 0) then
        return reject('VALIDATION_FAILED')
    end
    local version = task_current_version(task)
    local expected_version = task_expected_version(expected)
    if not expected_version then return reject('VALIDATION_FAILED') end
    if version ~= expected_version then return reject('TASK_VERSION_CONFLICT', '{"currentVersion":' .. integer(version) .. '}') end

    assert_type(keys[5], 'set')
    assert_type(keys[6], 'zset')
    assert_type(keys[7], 'zset')
    if old_assignee ~= '' then assert_type(keys[8], 'set') end
    assert_type(keys[9], 'string')
    assert_type(keys[10], 'zset')
    assert_type(keys[11], 'stream')
    assert(version < MAX_SAFE_INTEGER, 'Task version exceeds safe integer range')
    local seq = next_counter(keys[9])
    local deleted_at = iso_timestamp(meta.now)
    task.deletedAt, task.isDeleted = deleted_at, 'true'
    task.version, task.lastSeq = version + 1, seq
    task.lastClientMutationId = meta.mutation
    local nums = { version = version + 1, lastSeq = seq }
    task.version, task.lastSeq = nil, nil
    if type(task.number) == 'number' then nums.number, task.number = task.number, nil end
    if type(task.createdAtMs) == 'number' then nums.createdAtMs, task.createdAtMs = task.createdAtMs, nil end
    if type(task.dueAtMs) == 'number' then nums.dueAtMs, task.dueAtMs = task.dueAtMs, nil end
    local document = json_with_integers(task, nums)
    local finish = prepare_outbox(keys, seq, {
        requestId = meta.request, type = 'TASK_DELETED', workspaceId = ws, projectId = pid,
        taskId = tid, actorId = actor, entityVersion = version + 1,
        clientMutationId = meta.mutation, occurredAt = deleted_at, payload = {},
    }, 'task:' .. tid, document, meta.hash, false)

    redis.call('INCR', keys[9])
    redis.call('JSON.SET', keys[4], '$', document)
    redis.call('SREM', keys[5], tid)
    redis.call('ZREM', keys[6], tid)
    -- ZREM is safe when a spike-era task has no backlog entry.
    redis.call('ZREM', keys[7], tid)
    if old_assignee ~= '' then redis.call('SREM', keys[8], tid) end
    return finish()
end

redis.register_function('sh_update_task', update_task)
redis.register_function('sh_assign_task', assign_task)
redis.register_function('sh_delete_task', delete_task)
