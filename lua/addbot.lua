-- ==============================================================================
-- LUCIFER BOT ADDBOT & DISCORD NOTIFIER (Nurons Lucifer v2.86)
-- Author    : Salsa & Bos Anas
-- QC Status : In Review by Anna (@anna)
-- ==============================================================================

local M = {}

-- ------------------------------------------------------------------------------
-- 1. KONFIGURASI DEFAULT
-- ------------------------------------------------------------------------------
M.CONFIG = {
    WEBHOOK_URL = "",      -- URL Discord Webhook (simpan lokal, jangan commit URL asli ke Git)
    LOGIN_TIMEOUT = 30,    -- Batas waktu tunggu status online (detik)
    AUTO_CONNECT = true    -- Otomatis hubungkan bot jika belum konek
}

-- ------------------------------------------------------------------------------
-- 2. HELPER SANITASI & VALIDASI KREDENSIAL
-- ------------------------------------------------------------------------------
local function isValidEmail(email)
    if not email or type(email) ~= "string" then return false end
    if email:find("%s") or email:find("%.%.") then return false end

    local user, domain = email:match("^([^@]+)@([^@]+)$")
    if not user or not domain then return false end

    if not user:match("^[%w%.%_%+%-]+$") or user:sub(1, 1) == "." or user:sub(-1, -1) == "." then
        return false
    end

    if not domain:find("%.") or domain:sub(1, 1) == "." or domain:sub(-1, -1) == "." then
        return false
    end

    for label in domain:gmatch("[^%.]+") do
        if #label == 0 then return false end
        if not (label:match("^%w[%w%-]*%w$") or label:match("^%w$")) then
            return false
        end
    end

    local tld = domain:match("%.([^%.]+)$")
    if not tld or not tld:match("^%a%a+$") then
        return false
    end

    return true
end

local function maskEmail(email)
    if not email or type(email) ~= "string" then return "<unknown>" end
    local user, domain = email:match("^([^@]+)@(.+)$")
    if not user or not domain then return "<invalid_email>" end
    if #user <= 2 then
        return user:sub(1, 1) .. "***@" .. domain
    else
        return user:sub(1, 2) .. "***" .. user:sub(-1) .. "@" .. domain
    end
end

-- ------------------------------------------------------------------------------
-- 3. HELPER DISCORD WEBHOOK
-- ------------------------------------------------------------------------------
local function sendWebhookReport(webhookUrl, isSuccess, title, description, fields)
    if not webhookUrl or type(webhookUrl) ~= "string" or webhookUrl == "" then
        return false, "WEBHOOK_URL_EMPTY"
    end
    if webhookUrl:find("URL_WEBHOOK", 1, true) or webhookUrl:find("PLACEHOLDER", 1, true) then
        return false, "WEBHOOK_URL_PLACEHOLDER"
    end

    if type(Webhook) ~= "table" or type(Webhook.new) ~= "function" then
        return false, "WEBHOOK_API_UNAVAILABLE"
    end

    local ok, _ = pcall(function()
        local wh = Webhook.new(webhookUrl)
        wh.content = ""
        wh.embed1.use = true
        wh.embed1.title = title or "Laporan Lucifer Bot"
        wh.embed1.description = description or ""
        -- Hijau jika sukses (3066993), Merah jika gagal (15158332)
        wh.embed1.color = isSuccess and 3066993 or 15158332

        if fields and type(fields) == "table" then
            for _, f in ipairs(fields) do
                if f.name and f.value then
                    wh.embed1:addField(tostring(f.name), tostring(f.value), f.inline == true)
                end
            end
        end

        wh:send()
    end)

    if not ok then
        -- Kembalikan status terisolasi tanpa string error mentah
        return false, "WEBHOOK_DISPATCH_FAILED"
    end
    -- wh:send() di Lucifer adalah void client dispatch
    return true, "WEBHOOK_DISPATCHED"
end

-- ------------------------------------------------------------------------------
-- 4. HELPER WAIT ONLINE & STATUS DETECTOR
-- ------------------------------------------------------------------------------
local function checkBotSanctionOrError(bot)
    if not bot or not BotStatus then return nil end
    local s = bot.status

    if s == BotStatus.wrong_password then return "WRONG_PASSWORD" end
    if s == BotStatus.account_banned then return "ACCOUNT_BANNED" end
    if s == BotStatus.location_banned then return "LOCATION_BANNED" end
    if s == BotStatus.account_suspended then return "ACCOUNT_SUSPENDED" end
    if s == BotStatus.account_restricted then return "ACCOUNT_RESTRICTED" end
    if s == BotStatus.network_restricted then return "NETWORK_RESTRICTED" end
    if s == BotStatus.two_factor then return "TWO_FACTOR_REQUIRED" end
    if s == BotStatus.captcha_requested then return "CAPTCHA_REQUESTED" end
    if s == BotStatus.http_block then return "HTTP_BLOCK" end
    if s == BotStatus.maintenance then return "SERVER_MAINTENANCE" end
    if s == BotStatus.server_overload then return "SERVER_OVERLOAD" end
    if s == BotStatus.server_busy then return "SERVER_BUSY" end
    if s == BotStatus.too_many_login then return "TOO_MANY_LOGIN" end
    if s == BotStatus.version_update then return "VERSION_UPDATE_REQUIRED" end
    if s == BotStatus.ubi_disabled then return "UBI_DISABLED" end
    if s == BotStatus.invalid_account then return "INVALID_ACCOUNT" end

    return nil
end

local function waitBotOnline(bot, timeoutSec)
    local maxTicks = timeoutSec or 30
    for tick = 1, maxTicks do
        if bot.status == BotStatus.online then
            return true, "ONLINE"
        end

        local terminalErr = checkBotSanctionOrError(bot)
        if terminalErr then
            return false, terminalErr
        end

        sleep(1000)
    end

    if bot.status == BotStatus.online then
        return true, "ONLINE"
    end
    return false, "LOGIN_TIMEOUT"
end

-- ------------------------------------------------------------------------------
-- 5. FUNGSI UTAMA: ADDBOT & NOTIFIKASI
-- ------------------------------------------------------------------------------
--- Menambahkan bot baru ke Lucifer dan menunggu status login
--- @param account table { type = "growid"|"token", ... }
--- @param webhookUrl string Opsional URL Discord webhook
--- @return Lucifer|nil, string Status string ("ONLINE", "LOGIN_TIMEOUT", dll), table Status webhook { success: boolean, code: string }
function M.addAndVerifyBot(account, webhookUrl)
    if not account or type(account) ~= "table" then
        return nil, "INVALID_ACCOUNT_PAYLOAD", { success = false, code = "NOT_ATTEMPTED" }
    end

    local activeWebhook = webhookUrl or M.CONFIG.WEBHOOK_URL
    local accType = account.type or "growid"
    local botInstance = nil
    local safeDisplayName = "UnknownBot"
    local botLookupKey = nil

    -- --------------------------------------------------------------------------
    -- A. Validasi Kredensial & Deteksi Bot yang Sudah Ada
    -- --------------------------------------------------------------------------
    if accType == "growid" then
        if type(account.name) ~= "string" or account.name:match("^%s*$") then
            return nil, "EMPTY_GROWID_NAME", { success = false, code = "VALIDATION_FAILED" }
        end
        if type(account.password) ~= "string" or account.password == "" then
            return nil, "EMPTY_GROWID_PASSWORD", { success = false, code = "VALIDATION_FAILED" }
        end

        safeDisplayName = account.name:match("^%s*(.-)%s*$")
        botLookupKey = safeDisplayName

        -- Pengecekan existing bot SEBELUM memanggil addBot
        if type(getBot) == "function" then
            local existing = getBot(botLookupKey)
            if existing ~= nil then
                botInstance = existing
            end
        end

        -- Jika belum ada di manager, baru lakukan penambahan
        if botInstance == nil then
            local options = {
                name = safeDisplayName,
                password = account.password,
                display = account.display or safeDisplayName,
                platform = account.platform or (Platform and Platform.windows or 0),
                connect = M.CONFIG.AUTO_CONNECT
            }
            if type(account.mac) == "string" and account.mac ~= "" then options.mac = account.mac end
            if type(account.rid) == "string" and account.rid ~= "" then options.rid = account.rid end

            local ok, res = pcall(addBot, options)
            if ok and res ~= nil then
                botInstance = res
            end
        end

    elseif accType == "token" then
        if type(account.email) ~= "string" or not isValidEmail(account.email) then
            return nil, "INVALID_TOKEN_EMAIL", { success = false, code = "VALIDATION_FAILED" }
        end
        if type(account.ltoken) ~= "string" or account.ltoken:match("^%s*$") then
            return nil, "EMPTY_TOKEN_LTOKEN", { success = false, code = "VALIDATION_FAILED" }
        end
        if type(account.mac) ~= "string" or account.mac:match("^%s*$") then
            return nil, "EMPTY_TOKEN_MAC", { success = false, code = "VALIDATION_FAILED" }
        end
        if type(account.rid) ~= "string" or account.rid:match("^%s*$") then
            return nil, "EMPTY_TOKEN_RID", { success = false, code = "VALIDATION_FAILED" }
        end
        if type(account.wk) ~= "string" or account.wk:match("^%s*$") then
            return nil, "EMPTY_TOKEN_WK", { success = false, code = "VALIDATION_FAILED" }
        end

        safeDisplayName = maskEmail(account.email)
        botLookupKey = account.ltoken

        -- Pengecekan existing bot SEBELUM memanggil addBot
        if type(getBot) == "function" then
            local existing = getBot(botLookupKey)
            if existing ~= nil then
                botInstance = existing
            end
        end

        -- Jika belum ada di manager, baru lakukan penambahan
        if botInstance == nil then
            local options = {
                name = account.ltoken,
                display = safeDisplayName,
                mail = account.email,
                secret = account.email,
                mac = account.mac,
                rid = account.rid,
                wk = account.wk,
                platform = account.platform or (Platform and Platform.windows or 0),
                connect = M.CONFIG.AUTO_CONNECT
            }

            local ok, res = pcall(addBot, options)
            if ok and res ~= nil then
                botInstance = res
            end
        end
    else
        return nil, "UNSUPPORTED_ACCOUNT_TYPE", { success = false, code = "VALIDATION_FAILED" }
    end

    -- --------------------------------------------------------------------------
    -- B. Verifikasi Pendaftaran Bot di Lucifer Manager
    -- --------------------------------------------------------------------------
    if botInstance == nil then
        local whOk, whCode = sendWebhookReport(activeWebhook, false, "Gagal Registrasi Bot", "Lucifer menolak pendaftaran bot baru.", {
            { name = "Bot Target", value = safeDisplayName, inline = true },
            { name = "Tipe Akun", value = accType, inline = true },
            { name = "Status", value = "REGISTRATION_REJECTED", inline = true }
        })
        return nil, "REGISTRATION_REJECTED", { success = whOk, code = whCode }
    end

    -- Jika AUTO_CONNECT aktif dan bot belum online, picu koneksi eksplisit jika perlu
    if M.CONFIG.AUTO_CONNECT and botInstance.status ~= BotStatus.online then
        pcall(function() botInstance:connect() end)
    end

    -- --------------------------------------------------------------------------
    -- C. Tunggu Hingga Online atau Terdeteksi Sanksi / Timeout
    -- --------------------------------------------------------------------------
    local isOnline, statusReason = waitBotOnline(botInstance, M.CONFIG.LOGIN_TIMEOUT)

    -- Siapkan field embed laporan Discord (raw token tidak pernah dimasukkan ke embed)
    local reportBotName = (accType == "token") and safeDisplayName or (botInstance.name or safeDisplayName)
    local reportFields = {
        { name = "Bot", value = reportBotName, inline = true },
        { name = "Tipe", value = accType, inline = true },
        { name = "Status", value = statusReason, inline = true }
    }

    if isOnline then
        -- Telemetri opsional: diisolasi dengan pcall agar error method tidak menggagalkan hasil login
        local pingVal = 0
        if type(botInstance.getPing) == "function" then
            local okPing, resPing = pcall(function() return botInstance:getPing() end)
            if okPing and type(resPing) == "number" then
                pingVal = resPing
            end
        end

        local worldName = "None (Menu)"
        if type(botInstance.isInWorld) == "function" then
            local okInWorld, resInWorld = pcall(function() return botInstance:isInWorld() end)
            if okInWorld and resInWorld and type(botInstance.getWorld) == "function" then
                local okWld, resWld = pcall(function() return botInstance:getWorld() end)
                if okWld and resWld and resWld.name then
                    worldName = resWld.name
                end
            end
        end

        table.insert(reportFields, { name = "Ping", value = tostring(pingVal) .. " ms", inline = true })
        table.insert(reportFields, { name = "World", value = worldName, inline = true })

        local whOk, whCode = sendWebhookReport(activeWebhook, true, "Bot Berhasil Online", "Bot telah berhasil login dan terhubung ke server.", reportFields)
        return botInstance, "ONLINE", { success = whOk, code = whCode }
    else
        local whOk, whCode = sendWebhookReport(activeWebhook, false, "Bot Gagal Login", "Bot terdaftar tetapi belum berhasil online.", reportFields)
        return nil, statusReason, { success = whOk, code = whCode }
    end
end

return M
