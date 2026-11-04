// ==============================================================================
// DISCORD BOT CONTROLLER FOR LUCIFER BRIDGE (Zero-Dependency Node.js v22)
// Author    : Salsa & Bos Anas
// QC Status : Hardened with Anna's QC Review (WHATWG WebSocket & Testable)
// ==============================================================================

const https = require('https');
const http = require('http');

// ------------------------------------------------------------------------------
// 1. KONFIGURASI ENVIRONMENT
// ------------------------------------------------------------------------------
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '805286573302218772')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

const API_PORT = process.env.PORT || '3000';
const API_SECRET = process.env.API_SECRET || '';
const API_BASE_URL = process.env.API_URL || `http://127.0.0.1:${API_PORT}`;

// ------------------------------------------------------------------------------
// 2. DISCORD REST API HELPER (Mengirim pesan ke Discord)
// ------------------------------------------------------------------------------
function sendDiscordMessage(channelId, content, embed, tokenOverride, callback) {
    const activeToken = tokenOverride || BOT_TOKEN;
    if (!activeToken) {
        if (callback) callback(new Error('BOT_TOKEN_NOT_CONFIGURED'));
        return;
    }

    const payload = {};
    if (content) payload.content = content;
    if (embed) payload.embeds = [embed];

    const body = JSON.stringify(payload);
    const req = https.request({
        hostname: 'discord.com',
        path: `/api/v10/channels/${channelId}/messages`,
        method: 'POST',
        headers: {
            'Authorization': `Bot ${activeToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    }, res => {
        let resData = '';
        res.on('data', chunk => { resData += chunk; });
        res.on('end', () => {
            if (callback) callback(null, res.statusCode, resData);
        });
    });

    req.on('error', err => {
        if (callback) callback(err);
        else console.error('[Discord Request Error]:', err.message);
    });

    req.write(body);
    req.end();
}

// ------------------------------------------------------------------------------
// 3. BRIDGE API CLIENT (Berkomunikasi dengan server.js)
// ------------------------------------------------------------------------------
function callBridgeApi(method, endpoint, postData, secretOverride, callback) {
    const activeSecret = secretOverride || API_SECRET;
    const url = new URL(endpoint, API_BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: method,
        headers: {
            'Authorization': `Bearer ${activeSecret}`,
            'Content-Type': 'application/json'
        }
    };

    let bodyStr = '';
    if (postData) {
        bodyStr = JSON.stringify(postData);
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = client.request(options, res => {
        let resData = '';
        res.on('data', chunk => { resData += chunk; });
        res.on('end', () => {
            let parsed = null;
            if (resData) {
                try { parsed = JSON.parse(resData); } catch (e) { parsed = resData; }
            }
            callback(null, res.statusCode, parsed);
        });
    });

    req.on('error', err => {
        callback(err);
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
}

// ------------------------------------------------------------------------------
// 4. PROTOKOL GATEWAY V10 (WHATWG EventTarget Compatible)
// ------------------------------------------------------------------------------
function setupGatewayListeners(ws, token, onMessageCreate) {
    let heartbeatInterval = null;
    let lastSequence = null;

    ws.addEventListener('open', () => {
        console.log('[Discord Gateway] Terhubung ke Discord Gateway!');
    });

    ws.addEventListener('message', (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (msg.s !== null && msg.s !== undefined) lastSequence = msg.s;

        // Opcode 10: Hello (Heartbeat & Identify)
        if (msg.op === 10) {
            const interval = msg.d.heartbeat_interval;
            heartbeatInterval = setInterval(() => {
                try {
                    ws.send(JSON.stringify({ op: 1, d: lastSequence }));
                } catch (e) {}
            }, interval);

            // Identify Packet
            ws.send(JSON.stringify({
                op: 2,
                d: {
                    token: token,
                    intents: 33280, // GUILDS (1) + GUILD_MESSAGES (512) + MESSAGE_CONTENT (32768)
                    properties: {
                        os: 'linux',
                        browser: 'lucifer-bridge',
                        device: 'lucifer-bridge'
                    }
                }
            }));
        }

        // Opcode 0: Dispatch
        if (msg.op === 0) {
            if (msg.t === 'READY') {
                console.log(`[Discord Bot Ready] Login sebagai: ${msg.d.user.username}#${msg.d.user.discriminator}`);
            }

            if (msg.t === 'MESSAGE_CREATE' && onMessageCreate) {
                onMessageCreate(msg.d);
            }
        }
    });

    ws.addEventListener('close', (event) => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        console.warn(`[Discord Gateway Closed] Code: ${event.code}, Reason: ${event.reason}`);
    });

    ws.addEventListener('error', (err) => {
        console.error('[Discord Gateway Error]:', err.message || err);
    });

    return () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
    };
}

function startDiscordBot() {
    if (!BOT_TOKEN) {
        console.log('[Discord Bot] DISCORD_BOT_TOKEN tidak ditemukan di environment. Bot Discord tidak dijalankan.');
        return;
    }

    if (typeof WebSocket === 'undefined') {
        console.error('[Discord Bot Error] Global WebSocket tidak tersedia. Memerlukan Node.js v21+');
        return;
    }

    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    setupGatewayListeners(ws, BOT_TOKEN, (msg) => {
        handleIncomingMessage(msg, sendDiscordMessage, (m, e, d, cb) => callBridgeApi(m, e, d, null, cb));
    });
}

// ------------------------------------------------------------------------------
// 5. COMMAND HANDLERS
// ------------------------------------------------------------------------------
function handleIncomingMessage(msg, messageSender = sendDiscordMessage, apiCaller = callBridgeApi) {
    if (!msg || !msg.content || (msg.author && msg.author.bot)) return;

    const content = msg.content.trim();
    if (!content.startsWith('!')) return;

    const parts = content.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Otorisasi Pengguna (Hanya ALLOWED_USERS yang berhak menjalankan perintah)
    const authorId = msg.author && msg.author.id;
    if (!ALLOWED_USERS.includes(authorId)) {
        return; // Fail-closed: abaikan user yang tidak diizinkan
    }

    // --------------------------------------------------------------------------
    // Command: !help
    // --------------------------------------------------------------------------
    if (command === '!help') {
        const helpEmbed = {
            title: '🎮 Lucifer Bot Controller - Bantuan',
            description: 'Perintah yang tersedia untuk mengontrol bot Lucifer via Discord:',
            color: 3447003,
            fields: [
                { name: '!status', value: 'Melihat status antrean tugas dan ringkasan bot.', inline: false },
                { name: '!addbot <alias>', value: 'Menambahkan bot ke antrean berdasarkan alias lokal di `accounts.json` (Contoh: `!addbot bot1`).', inline: false }
            ],
            footer: { text: 'Keamanan: Password tidak pernah diketik di chat Discord.' }
        };
        messageSender(msg.channel_id, null, helpEmbed);
        return;
    }

    // --------------------------------------------------------------------------
    // Command: !status
    // --------------------------------------------------------------------------
    if (command === '!status') {
        apiCaller('GET', '/api/jobs', null, null, (err, statusCode, data) => {
            if (err || statusCode !== 200) {
                return messageSender(msg.channel_id, `❌ Gagal menghubungi server bridge: ${err ? err.message : `HTTP ${statusCode}`}`);
            }

            const jobs = (data && data.jobs) || [];
            const counts = {
                pending: jobs.filter(j => j.status === 'pending').length,
                claimed: jobs.filter(j => j.status === 'claimed').length,
                success: jobs.filter(j => j.status === 'success').length,
                failed: jobs.filter(j => j.status === 'failed').length,
                stalled: jobs.filter(j => j.status === 'stalled').length
            };

            const statusEmbed = {
                title: '📊 Status Antrean Bot Lucifer',
                color: counts.failed > 0 ? 15158332 : 3066993,
                fields: [
                    { name: 'Total Tugas', value: tostring(data ? data.total : 0), inline: true },
                    { name: 'Pending', value: tostring(counts.pending), inline: true },
                    { name: 'Claimed', value: tostring(counts.claimed), inline: true },
                    { name: 'Online / Berhasil', value: tostring(counts.success), inline: true },
                    { name: 'Gagal', value: tostring(counts.failed), inline: true },
                    { name: 'Stalled', value: tostring(counts.stalled), inline: true }
                ],
                timestamp: new Date().toISOString()
            };

            if (jobs.length > 0) {
                const recent = jobs.slice(-5).reverse();
                const listText = recent.map(j => `• **${j.bot_id}** [${j.job_id}]: \`${j.status}\``).join('\n');
                statusEmbed.fields.push({ name: '5 Tugas Terakhir', value: listText, inline: false });
            }

            messageSender(msg.channel_id, null, statusEmbed);
        });
        return;
    }

    // --------------------------------------------------------------------------
    // Command: !addbot <alias>
    // --------------------------------------------------------------------------
    if (command === '!addbot') {
        const alias = args[0];
        if (!alias) {
            return messageSender(msg.channel_id, '⚠️ Format salah! Gunakan: `!addbot <alias>`\nContoh: `!addbot bot1`\n*(Daftar alias akun dikonfigurasi di file lokal `accounts.json`)*');
        }

        // Aksi 'addbot' sesuai kontrak BRIDGE.md
        apiCaller('POST', '/api/jobs', { alias: alias, action: 'addbot' }, null, (err, statusCode, data) => {
            if (err) {
                return messageSender(msg.channel_id, `❌ Gagal menghubungi server bridge: ${err.message}`);
            }

            if (statusCode === 201) {
                const addEmbed = {
                    title: '✅ Tugas Berhasil Didaftarkan',
                    description: `Bot alias **${alias}** telah dimasukkan ke antrean!`,
                    color: 3066993,
                    fields: [
                        { name: 'Job ID', value: `\`${data.job_id}\``, inline: true },
                        { name: 'Status', value: `\`${data.status}\``, inline: true }
                    ],
                    footer: { text: 'Tugas akan otomatis dieksekusi oleh Lua saat polling berikutnya.' }
                };
                messageSender(msg.channel_id, null, addEmbed);
            } else {
                const errMsg = (data && data.error) ? data.error : `HTTP ${statusCode}`;
                messageSender(msg.channel_id, `❌ Gagal menambahkan tugas: \`${errMsg}\``);
            }
        });
        return;
    }
}

function tostring(val) {
    return val !== undefined && val !== null ? String(val) : '0';
}

if (require.main === module) {
    startDiscordBot();
}

module.exports = {
    startDiscordBot,
    setupGatewayListeners,
    handleIncomingMessage,
    sendDiscordMessage,
    callBridgeApi
};
