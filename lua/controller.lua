-- Anna: addbot-only HTTP bridge. No remote Lua evaluation or rotation startup.
local M = {}

function M.new(config)
    assert(type(config) == 'table', 'CONFIG_REQUIRED')
    local base = config.api_url
    assert(type(base) == 'string' and not base:find('[%s%?#]'), 'INVALID_API_URL')
    assert(base:match('^https://[%w%.:%-]+/?$') or
        base:match('^http://127%.0%.0%.1:%d+/?$') or
        base:match('^http://localhost:%d+/?$'), 'HTTPS_OR_LOOPBACK_REQUIRED')
    base = base:gsub('/$', '')
    assert(type(config.api_token) == 'string' and #config.api_token >= 16 and
        not config.api_token:find('[%c%s]'), 'INVALID_API_TOKEN')
    assert(type(config.journal_path) == 'string' and config.journal_path ~= '', 'JOURNAL_REQUIRED')
    local dir = config.module_dir or 'lua/'
    local json = dofile(dir .. 'json.lua')
    local addbot = config.addbot or dofile(dir .. 'addbot.lua')
    local delay = config.sleep or sleep
    local interval = config.poll_interval_ms or 2000
    assert(type(interval) == 'number' and interval >= 1000 and interval <= 60000, 'INVALID_POLL_INTERVAL')
    local path = config.journal_path
    local journal = {version = 1, jobs = {}}
    local f, _, code = io.open(path, 'rb')
    if f then
        local raw = f:read('*a'); f:close()
        local ok, decoded = pcall(json.decode, raw)
        assert(ok and type(decoded) == 'table' and decoded.version == 1 and
            type(decoded.jobs) == 'table', 'JOURNAL_CORRUPT')
        journal = decoded
    else
        assert(code == 2, 'JOURNAL_UNREADABLE')
    end
    local function validId(id)
        return type(id) == 'string' and #id >= 1 and #id <= 80 and id:match('^[%w_%-]+$')
    end
    local statuses = {success=true, failed=true, stalled=true}
    for id, record in pairs(journal.jobs) do
        assert(validId(id) and type(record) == 'table' and type(record.reported) == 'boolean' and
            (record.status == 'executing' or statuses[record.status]) and
            (record.error == nil or type(record.error) == 'string'), 'JOURNAL_CORRUPT')
    end
    -- ponytail: one controller per journal; no power-loss fsync in portable Lua.
    -- Upgrade to a transactional journal before multi-process or power-loss guarantees.
    local function save()
        local file = assert(io.open(path .. '.tmp', 'wb'), 'JOURNAL_WRITE_FAILED')
        local wrote = file:write(json.encode(journal))
        local flushed = file:flush()
        local closed = file:close()
        assert(wrote and flushed and closed, 'JOURNAL_WRITE_FAILED')
        assert(os.rename(path .. '.tmp', path), 'JOURNAL_RENAME_FAILED')
    end
    for _, record in pairs(journal.jobs) do
        if record.status == 'executing' then
            record.status = 'stalled'; record.error = 'RESTART_UNCERTAIN'; record.reported = false
        end
    end
    save()
    local function request(method, endpoint, body)
        local ok, result = pcall(function()
            if config.request then return config.request(method, endpoint, body) end
            local client = HttpClient.new()
            client.url = base .. endpoint
            client:setMethod(method == 'GET' and Method.get or Method.post)
            client.timeout = 10
            client.headers = {Authorization = 'Bearer ' .. config.api_token,
                ['Content-Type'] = 'application/json', ['Cache-Control'] = 'no-store'}
            if body then
                client.content = json.encode(body)
                if body.error == nil then
                    client.content = client.content:sub(1, -2) .. ',"error":null}'
                end
            end
            return client:request()
        end)
        if not ok or not result or result.error ~= 0 then return nil, 'NETWORK_ERROR' end
        return result
    end
    local function report(id, record)
        local body = {job_id=id, status=record.status, error=record.error}
        -- Explicit JSON null for successful reports (codec omits nil table fields).
        local response = request('POST', '/api/jobs/' .. id .. '/status', body)
        if not response or response.status < 200 or response.status >= 300 then return false end
        record.reported = true; save(); return true
    end
    local controller = {}
    function controller.step()
        -- Retry reports, never execution. Keep original final state for duplicate delivery.
        for id, record in pairs(journal.jobs) do
            if not record.reported and not report(id, record) then return false, 'REPORT_PENDING' end
        end
        local response, err = request('GET', '/api/jobs/poll')
        if not response then return false, err end
        if response.status == 204 then return true, 'IDLE' end
        if response.status ~= 200 then return false, 'POLL_REJECTED' end
        if type(response.body) ~= 'string' or #response.body > 65536 then return false, 'INVALID_JOB' end
        local ok, job = pcall(json.decode, response.body)
        if not ok or type(job) ~= 'table' or not validId(job.job_id) then return false, 'INVALID_JOB' end
        local id = job.job_id
        if journal.jobs[id] then
            return report(id, journal.jobs[id]), 'DUPLICATE_NOT_EXECUTED'
        end
        local record = {status='executing', reported=false}
        journal.jobs[id] = record; save() -- Fail closed before any side effect.
        if job.action ~= 'addbot' or type(job.account) ~= 'table' or not validId(job.bot_id) then
            record.status = 'failed'; record.error = 'INVALID_JOB'
        else
            local added, bot, reason = pcall(addbot.addAndVerifyBot, job.account, '')
            if not added then
                record.status = 'stalled'; record.error = 'EXECUTION_UNCERTAIN'
            elseif bot and reason == 'ONLINE' then
                record.status = 'success'
            else
                -- A bot may remain registered/connecting after an apparent failure.
                record.status = 'stalled'
                record.error = 'ADDBOT_REQUIRES_REVIEW'
                if reason == 'EMPTY_GROWID_NAME' or reason == 'EMPTY_GROWID_PASSWORD' or
                    reason == 'INVALID_ACCOUNT_PAYLOAD' or reason == 'UNSUPPORTED_ACCOUNT_TYPE' or
                    reason == 'INVALID_TOKEN_EMAIL' or (type(reason) == 'string' and
                    reason:match('^EMPTY_TOKEN_[A-Z]+$')) then
                    record.status = 'failed'; record.error = 'INVALID_ACCOUNT'
                end
            end
        end
        save()
        if not report(id, record) then return false, 'REPORT_PENDING' end
        return true, record.status
    end
    function controller.run()
        assert(type(delay) == 'function', 'SLEEP_API_REQUIRED')
        while true do
            -- Persistence exceptions stop the loop; do not retry uncertain execution.
            controller.step()
            delay(interval)
        end
    end
    return controller
end
return M
