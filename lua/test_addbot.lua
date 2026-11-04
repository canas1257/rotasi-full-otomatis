-- ==============================================================================
-- SELF-CHECK TEST SUITE FOR ADDBOT.LUA (MOCK RUNTIME)
-- Author    : Salsa & Bos Anas
-- QC Status : In Review by Anna (@anna)
-- ==============================================================================

local function runTests()
    print("=== Menjalankan Self-Check Mock Test Suite untuk addbot.lua ===")

    -- Deteksi direktori script secara relatif agar dapat dijalankan di lingkungan mana pun
    local script_path = debug.getinfo(1, "S").source:sub(2)
    local script_dir = script_path:match("(.*/)") or "./"
    local target_script = script_dir .. "addbot.lua"

    -- 1. Setup Mock Lucifer Environment
    BotStatus = {
        offline = 0,
        online = 1,
        wrong_password = 2,
        account_banned = 3,
        location_banned = 4,
        account_suspended = 5,
        account_restricted = 6,
        network_restricted = 7,
        two_factor = 8,
        captcha_requested = 9,
        http_block = 10,
        maintenance = 11,
        server_overload = 12,
        server_busy = 13,
        too_many_login = 14,
        version_update = 15,
        ubi_disabled = 16,
        invalid_account = 17
    }

    Platform = {
        windows = 0,
        android = 1
    }

    sleep = function(ms) end

    local mockSentPayloads = {}
    Webhook = {
        new = function(url)
            return {
                url = url,
                content = "",
                embed1 = {
                    use = false,
                    title = "",
                    description = "",
                    color = 0,
                    fields = {},
                    addField = function(self, name, val, inline)
                        table.insert(self.fields, { name = name, value = val, inline = inline })
                    end
                },
                send = function(self)
                    table.insert(mockSentPayloads, {
                        url = self.url,
                        title = self.embed1.title,
                        description = self.embed1.description,
                        color = self.embed1.color,
                        fields = self.embed1.fields
                    })
                end
            }
        end
    }

    local mockBotsManager = {}
    getBot = function(name)
        return mockBotsManager[name]
    end

    local M = dofile(target_script)

    -- --------------------------------------------------------------------------
    -- Test 1: GrowID Sukses Online
    -- --------------------------------------------------------------------------
    mockBotsManager = {}
    mockSentPayloads = {}
    addBot = function(opts)
        local bname = type(opts) == "table" and opts.name or opts
        local bot = {
            name = bname,
            status = BotStatus.online,
            connect = function() end,
            getPing = function() return 32 end,
            isInWorld = function() return true end,
            getWorld = function() return { name = "ROTASI_WORLD" } end
        }
        mockBotsManager[bname] = bot
        return bot
    end

    local b1, r1, wh1 = M.addAndVerifyBot({
        type = "growid",
        name = "BotSalsa01",
        password = "SecretPassword123"
    }, "https://discord.com/api/webhooks/mock/1")

    assert(b1 ~= nil, "Test 1 Gagal: Bot seharusnya tidak nil")
    assert(r1 == "ONLINE", "Test 1 Gagal: Status harus ONLINE")
    assert(wh1.success == true, "Test 1 Gagal: Webhook harus berhasil di-dispatch")
    assert(wh1.code == "WEBHOOK_DISPATCHED", "Test 1 Gagal: Kode webhook harus WEBHOOK_DISPATCHED")
    assert(#mockSentPayloads == 1, "Test 1 Gagal: Webhook payload harus terkirim")
    assert(mockSentPayloads[1].color == 3066993, "Test 1 Gagal: Embed harus hijau")
    print("✓ Test 1: GrowID Sukses Online - PASSED")

    -- --------------------------------------------------------------------------
    -- Test 2: Validasi Kredensial GrowID Kosong / Tidak Valid
    -- --------------------------------------------------------------------------
    local b2_1, r2_1 = M.addAndVerifyBot({ type = "growid", name = "Bot", password = "" })
    assert(b2_1 == nil and r2_1 == "EMPTY_GROWID_PASSWORD", "Test 2 Gagal: Password kosong harus ditolak")

    local b2_2, r2_2 = M.addAndVerifyBot({ type = "growid", name = "   ", password = "pass" })
    assert(b2_2 == nil and r2_2 == "EMPTY_GROWID_NAME", "Test 2 Gagal: Nama kosong harus ditolak")
    print("✓ Test 2: Validasi Kredensial GrowID (Empty/Whitespace) - PASSED")

    -- --------------------------------------------------------------------------
    -- Test 3: Password Salah (Terminal Error)
    -- --------------------------------------------------------------------------
    mockBotsManager = {}
    mockSentPayloads = {}
    addBot = function(opts)
        local bname = type(opts) == "table" and opts.name or opts
        local bot = {
            name = bname,
            status = BotStatus.wrong_password,
            connect = function() end
        }
        mockBotsManager[bname] = bot
        return bot
    end

    local b3, r3, wh3 = M.addAndVerifyBot({
        type = "growid",
        name = "BotSalahPass",
        password = "WrongPassword"
    }, "https://discord.com/api/webhooks/mock/3")

    assert(b3 == nil, "Test 3 Gagal: Return bot harus nil saat gagal")
    assert(r3 == "WRONG_PASSWORD", "Test 3 Gagal: Status harus WRONG_PASSWORD")
    assert(wh3.success == true, "Test 3 Gagal: Webhook laporan kegagalan harus terkirim")
    assert(mockSentPayloads[1].color == 15158332, "Test 3 Gagal: Embed harus merah")
    print("✓ Test 3: Terminal Error (Wrong Password) - PASSED")

    -- --------------------------------------------------------------------------
    -- Test 4: Timeout Login
    -- --------------------------------------------------------------------------
    mockBotsManager = {}
    mockSentPayloads = {}
    addBot = function(opts)
        local bname = type(opts) == "table" and opts.name or opts
        local bot = {
            name = bname,
            status = BotStatus.offline,
            connect = function() end
        }
        mockBotsManager[bname] = bot
        return bot
    end

    M.CONFIG.LOGIN_TIMEOUT = 2
    local b4, r4 = M.addAndVerifyBot({
        type = "growid",
        name = "BotTimeout",
        password = "SomePassword"
    }, "https://discord.com/api/webhooks/mock/4")

    assert(b4 == nil, "Test 4 Gagal: Return bot harus nil saat timeout")
    assert(r4 == "LOGIN_TIMEOUT", "Test 4 Gagal: Status harus LOGIN_TIMEOUT")
    print("✓ Test 4: Login Timeout - PASSED")

    -- --------------------------------------------------------------------------
    -- Test 5: Registrasi Ditolak (addBot return nil)
    -- --------------------------------------------------------------------------
    mockBotsManager = {}
    mockSentPayloads = {}
    addBot = function(opts)
        return nil
    end

    local b5, r5 = M.addAndVerifyBot({
        type = "growid",
        name = "BotDitolak",
        password = "Any"
    }, "https://discord.com/api/webhooks/mock/5")

    assert(b5 == nil, "Test 5 Gagal: Return bot harus nil")
    assert(r5 == "REGISTRATION_REJECTED", "Test 5 Gagal: Status harus REGISTRATION_REJECTED")
    print("✓ Test 5: Registrasi Ditolak Engine - PASSED")

    -- --------------------------------------------------------------------------
    -- Test 6: Pencegahan Duplikasi (Cek Existing SEBELUM addBot)
    -- --------------------------------------------------------------------------
    mockBotsManager = {}
    local existingBot = {
        name = "BotExisting",
        status = BotStatus.online,
        connect = function() end,
        getPing = function() return 20 end,
        isInWorld = function() return false end
    }
    mockBotsManager["BotExisting"] = existingBot

    local addCallCount = 0
    addBot = function(opts)
        addCallCount = addCallCount + 1
        error("addBot TIDAK BOLEH DIPANGGIL jika bot sudah ada di manager!")
    end

    local b6, r6 = M.addAndVerifyBot({
        type = "growid",
        name = "BotExisting",
        password = "Pass"
    })

    assert(addCallCount == 0, "Test 6 Gagal: addBot dipanggil padahal bot sudah ada!")
    assert(b6 == existingBot, "Test 6 Gagal: Harus me-retrieve bot dari getBot langsung")
    assert(r6 == "ONLINE", "Test 6 Gagal: Status harus ONLINE")
    print("✓ Test 6: Pencegahan Duplikasi (Existing Guard Sebelum addBot) - PASSED")

    -- --------------------------------------------------------------------------
    -- Test 7: Isolasi Kegagalan Webhook
    -- --------------------------------------------------------------------------
    mockBotsManager = {}
    addBot = function(opts)
        return {
            name = "BotWhError",
            status = BotStatus.online,
            connect = function() end,
            getPing = function() return 25 end,
            isInWorld = function() return false end
        }
    end

    Webhook.new = function()
        error("Simulasi crash socket / runtime webhook")
    end

    local b7, r7, wh7 = M.addAndVerifyBot({
        type = "growid",
        name = "BotWhError",
        password = "Pass"
    }, "https://discord.com/api/webhooks/mock/fail")

    assert(b7 ~= nil, "Test 7 Gagal: Bot harus tetap berhasil online meski webhook meledak")
    assert(r7 == "ONLINE", "Test 7 Gagal: Status bot harus ONLINE")
    assert(wh7.success == false, "Test 7 Gagal: Status webhook harus dilaporkan gagal")
    assert(wh7.code == "WEBHOOK_DISPATCH_FAILED", "Test 7 Gagal: Kode webhook harus terisolasi tanpa error mentah")
    print("✓ Test 7: Isolasi Kegagalan Webhook (Laporan Terpisah Tanpa Error Mentah) - PASSED")

    -- --------------------------------------------------------------------------
    -- Test 8: Token Format, Validasi Lengkap & Sanitasi Kredensial
    -- --------------------------------------------------------------------------
    -- A. Uji penolakan jika kredensial token tidak lengkap
    local b8_fail1, r8_fail1 = M.addAndVerifyBot({ type = "token", email = "budi@test.com", ltoken = "tok" })
    assert(b8_fail1 == nil and r8_fail1 == "EMPTY_TOKEN_MAC", "Test 8 Gagal: Token tanpa MAC harus ditolak")

    -- B. Uji sukses token & verifikasi raw token tidak bocor di embed
    mockBotsManager = {}
    mockSentPayloads = {}
    Webhook.new = function(url)
        return {
            url = url,
            embed1 = {
                fields = {},
                addField = function(self, name, val, inline)
                    table.insert(self.fields, { name = name, value = val })
                end
            },
            send = function(self)
                table.insert(mockSentPayloads, self.embed1.fields)
            end
        }
    end

    local rawToken = "SECRET_BASE64_LTOKEN_12345678"
    local rawEmail = "budi.santoso@growtopia.com"

    addBot = function(opts)
        assert(opts.name == rawToken, "Token harus diteruskan ke engine")
        assert(opts.display:find("%*%*%*"), "Display harus dimask")
        return {
            name = opts.name,
            status = BotStatus.online,
            connect = function() end,
            getPing = function() return 15 end,
            isInWorld = function() return false end
        }
    end

    local b8, r8 = M.addAndVerifyBot({
        type = "token",
        email = rawEmail,
        ltoken = rawToken,
        mac = "00:11:22:33:44:55",
        rid = "0123456789abcdef0123456789abcdef",
        wk = "fedcba9876543210fedcba9876543210"
    }, "https://discord.com/api/webhooks/mock/token")

    assert(b8 ~= nil, "Test 8 Gagal: Token bot harus sukses online")
    local payloadJson = ""
    for _, f in ipairs(mockSentPayloads[1] or {}) do
        payloadJson = payloadJson .. f.name .. "=" .. f.value .. ";"
    end
    assert(not payloadJson:find(rawEmail, 1, true), "Test 8 Gagal: Email asli bocor di embed!")
    assert(not payloadJson:find(rawToken, 1, true), "Test 8 Gagal: Raw token bocor di embed!")
    assert(payloadJson:find("bu%*%*%*o@growtopia%.com"), "Test 8 Gagal: Email tidak ter-masking dengan benar")
    print("✓ Test 8: Token Format (Validasi Lengkap + Anti-Bocor Kredensial) - PASSED")

    -- --------------------------------------------------------------------------
    -- Test 9: Telemetri Error Resilience (getPing / getWorld Throwing)
    -- --------------------------------------------------------------------------
    mockBotsManager = {}
    mockSentPayloads = {}
    addBot = function(opts)
        return {
            name = "BotTelemetryCrash",
            status = BotStatus.online,
            connect = function() end,
            getPing = function() error("Simulasi getPing melempar exception") end,
            isInWorld = function() return true end,
            getWorld = function() error("Simulasi getWorld crash") end
        }
    end

    local b9, r9 = M.addAndVerifyBot({
        type = "growid",
        name = "BotTelemetryCrash",
        password = "Pass"
    }, "https://discord.com/api/webhooks/mock/9")

    assert(b9 ~= nil, "Test 9 Gagal: Bot harus tetap sukses online walau telemetri error")
    assert(r9 == "ONLINE", "Test 9 Gagal: Status harus tetap ONLINE")
    print("✓ Test 9: Telemetri Error Resilience (getPing/getWorld Crash Terisolasi) - PASSED")

    print("\nSemua 9 skenario unit test mock lolos 100%! 🎉")
end

runTests()
