// ==============================================================================
// TEST SUITE FOR SERVER.JS & DISCORD-BOT.JS (ISOLATED TEMPORARY DIRECTORY)
// Author    : Salsa & Bos Anas
// QC Status : Hardened Automated Verification
// ==============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 1. Buat direktori temporer khusus untuk isolasi total pengujian
const TMP_TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
const TMP_DATA_DIR = path.join(TMP_TEST_DIR, 'data');
fs.mkdirSync(TMP_DATA_DIR, { recursive: true, mode: 0o700 });

const TMP_JOBS_FILE = path.join(TMP_DATA_DIR, 'jobs.json');
const TMP_ACCOUNTS_FILE = path.join(TMP_TEST_DIR, 'accounts.json');

// Siapkan accounts.json di direktori temporer
fs.writeFileSync(TMP_ACCOUNTS_FILE, JSON.stringify({
    bot_alpha: {
        type: 'growid',
        name: 'AlphaTester',
        password: 'SecretPassword999'
    }
}, null, 2), { mode: 0o600 });

const TEST_PORT = 3998;
const TEST_SECRET = 'super-secret-token-min-16-chars-2026';

process.env.PORT = String(TEST_PORT);
process.env.API_SECRET = TEST_SECRET;
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.JOBS_FILE = TMP_JOBS_FILE;
process.env.ACCOUNTS_FILE = TMP_ACCOUNTS_FILE;
process.env.NODE_ENV = 'test';

const { createServerInstance, loadJobsFromDisk, inMemoryJobs, setJobs } = require('../server.js');
const { handleIncomingMessage, setupGatewayListeners } = require('../discord-bot.js');

const testServer = createServerInstance(TEST_SECRET);

function makeRequest(method, reqPath, headers = {}, bodyObj = null) {
    return new Promise((resolve, reject) => {
        const postData = bodyObj ? JSON.stringify(bodyObj) : '';
        const reqHeaders = { ...headers };
        if (postData) {
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = http.request({
            hostname: '127.0.0.1',
            port: TEST_PORT,
            path: reqPath,
            method: method,
            headers: reqHeaders
        }, res => {
            let resData = '';
            res.on('data', chunk => { resData += chunk; });
            res.on('end', () => {
                let parsed = null;
                if (resData) {
                    try { parsed = JSON.parse(resData); } catch (e) { parsed = resData; }
                }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });

        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

// Mock WebSocket WHATWG compliant untuk Discord Gateway test
class MockWHATWGWebSocket {
    constructor() {
        this.listeners = {};
        this.sent = [];
    }

    addEventListener(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    dispatchEvent(event, data) {
        const handlers = this.listeners[event] || [];
        for (const h of handlers) h(data);
    }

    send(data) {
        this.sent.push(data);
    }

    close(code = 1000, reason = 'Normal') {
        this.dispatchEvent('close', { code, reason });
    }
}

async function runAllTests() {
    console.log('=== Menjalankan Test Suite Terisolasi (REST Server & Discord Bot) ===');
    console.log(`[Test Env] Direktori temporer: ${TMP_TEST_DIR}`);

    await new Promise(r => testServer.listen(TEST_PORT, '127.0.0.1', r));

    try {
        const authHeader = { 'Authorization': `Bearer ${TEST_SECRET}` };

        // ----------------------------------------------------------------------
        // Test 1: Health Check (Public)
        // ----------------------------------------------------------------------
        const resHealth = await makeRequest('GET', '/health');
        assert.strictEqual(resHealth.status, 200);
        assert.strictEqual(resHealth.body.status, 'ok');
        console.log('✓ Test 1: Health Check Endpoint (Public) - PASSED');

        // ----------------------------------------------------------------------
        // Test 2: Autentikasi Bearer Token (Missing / Bad Secret)
        // ----------------------------------------------------------------------
        const resNoAuth = await makeRequest('GET', '/api/jobs/poll');
        assert.strictEqual(resNoAuth.status, 401);
        const resBadAuth = await makeRequest('GET', '/api/jobs/poll', { 'Authorization': 'Bearer wrong-token-12345' });
        assert.strictEqual(resBadAuth.status, 401);
        console.log('✓ Test 2: Autentikasi Bearer Token (Fail-Closed) - PASSED');

        // ----------------------------------------------------------------------
        // Test 3: Poll pada Antrean Kosong (204 No Content)
        // ----------------------------------------------------------------------
        const resEmpty = await makeRequest('GET', '/api/jobs/poll', authHeader);
        assert.strictEqual(resEmpty.status, 204);
        console.log('✓ Test 3: GET /api/jobs/poll Antrean Kosong (204) - PASSED');

        // ----------------------------------------------------------------------
        // Test 4: Buat Tugas via Alias Lokal (accounts.json di direktori temp)
        // ----------------------------------------------------------------------
        const resCreate = await makeRequest('POST', '/api/jobs', authHeader, {
            alias: 'bot_alpha'
        });
        assert.strictEqual(resCreate.status, 201);
        assert.strictEqual(resCreate.body.success, true);
        const jobId1 = resCreate.body.job_id;
        console.log('✓ Test 4: POST /api/jobs Buat Tugas via Alias - PASSED');

        // ----------------------------------------------------------------------
        // Test 5: Tolak Dua Tugas Aktif untuk Bot yang Sama (409 Conflict)
        // ----------------------------------------------------------------------
        const resDupBot = await makeRequest('POST', '/api/jobs', authHeader, {
            alias: 'bot_alpha'
        });
        assert.strictEqual(resDupBot.status, 409);
        assert.strictEqual(resDupBot.body.error, 'BOT_ALREADY_HAS_ACTIVE_JOB');
        console.log('✓ Test 5: Tolak Dua Tugas Aktif untuk Bot Sama (409 Conflict) - PASSED');

        // ----------------------------------------------------------------------
        // Test 6: Tolak job_id Duplikat Permanen (409 Conflict)
        // ----------------------------------------------------------------------
        const resDupJobId = await makeRequest('POST', '/api/jobs', authHeader, {
            bot_id: 'bot_lain',
            job_id: jobId1,
            account: { type: 'growid', name: 'Bot2', password: 'P2' }
        });
        assert.strictEqual(resDupJobId.status, 409);
        assert.strictEqual(resDupJobId.body.error, 'JOB_ID_ALREADY_EXISTS');
        console.log('✓ Test 6: Tolak job_id Duplikat Permanen (409 Conflict) - PASSED');

        // ----------------------------------------------------------------------
        // Test 7: GET /api/jobs/poll Klaim Atomik (action addbot, status claimed)
        // ----------------------------------------------------------------------
        const resPoll = await makeRequest('GET', '/api/jobs/poll', authHeader);
        assert.strictEqual(resPoll.status, 200);
        assert.strictEqual(resPoll.body.job_id, jobId1);
        assert.strictEqual(resPoll.body.action, 'addbot', 'Aksi harus addbot sesuai BRIDGE.md');
        assert.strictEqual(resPoll.body.bot_id, 'bot_alpha');

        // Verifikasi tugas di disk sudah berstatus claimed sebelum polling selesai
        const savedData = JSON.parse(fs.readFileSync(TMP_JOBS_FILE, 'utf8'));
        const diskJob = savedData.find(j => j.job_id === jobId1);
        assert.strictEqual(diskJob.status, 'claimed');
        console.log('✓ Test 7: GET /api/jobs/poll Klaim Atomik ke Disk - PASSED');

        // ----------------------------------------------------------------------
        // Test 8: Tugas yang Diklaim Tidak Terbagi Ulang (204)
        // ----------------------------------------------------------------------
        const resPoll2 = await makeRequest('GET', '/api/jobs/poll', authHeader);
        assert.strictEqual(resPoll2.status, 204);
        console.log('✓ Test 8: Tugas yang Diklaim Tidak Dibagikan Ulang (204) - PASSED');

        // ----------------------------------------------------------------------
        // Test 9: Laporan Status Idempotent & Transisi Terminal
        // ----------------------------------------------------------------------
        const resStat = await makeRequest('POST', `/api/jobs/${jobId1}/status`, authHeader, {
            status: 'success',
            error: null
        });
        assert.strictEqual(resStat.status, 200);
        assert.strictEqual(resStat.body.status, 'success');

        // Laporan ulang identik -> 200 OK idempotent
        const resRepeat = await makeRequest('POST', `/api/jobs/${jobId1}/status`, authHeader, {
            status: 'success',
            error: null
        });
        assert.strictEqual(resRepeat.status, 200);
        assert.strictEqual(resRepeat.body.idempotent, true);

        // Tolak penimpaan status dari terminal state (success -> stalled ditolak)
        const resIllegal = await makeRequest('POST', `/api/jobs/${jobId1}/status`, authHeader, {
            status: 'stalled',
            error: 'Illegal'
        });
        assert.strictEqual(resIllegal.status, 409);
        assert.strictEqual(resIllegal.body.error, 'ILLEGAL_STATUS_TRANSITION_FROM_TERMINAL_STATE');
        console.log('✓ Test 9: Laporan Status Idempotent & Proteksi Terminal State - PASSED');

        // ----------------------------------------------------------------------
        // Test 10: Fail-Closed pada File State Corrupt/Kosong
        // ----------------------------------------------------------------------
        fs.writeFileSync(TMP_JOBS_FILE, ''); // Buat kosong
        assert.throws(() => {
            loadJobsFromDisk();
        }, /FILE_CORRUPT_EMPTY/, 'Membaca file state kosong harus melempar exception');

        fs.writeFileSync(TMP_JOBS_FILE, '{"invalid": true}'); // Bukan array
        assert.throws(() => {
            loadJobsFromDisk();
        }, /FILE_CORRUPT_NOT_ARRAY/, 'File bukan array harus melempar exception');
        console.log('✓ Test 10: Fail-Closed pada File State Corrupt/Kosong - PASSED');

        // ----------------------------------------------------------------------
        // Test 11: Discord Gateway WHATWG WebSocket EventTarget
        // ----------------------------------------------------------------------
        const mockWs = new MockWHATWGWebSocket();
        let messageHandled = null;
        const cleanup = setupGatewayListeners(mockWs, 'mock-bot-token', (msg) => {
            messageHandled = msg;
        });

        // Simulasi Opcode 10 (Hello)
        mockWs.dispatchEvent('message', {
            data: JSON.stringify({
                op: 10,
                d: { heartbeat_interval: 1000 }
            })
        });

        // Verifikasi paket Identify terkirim dengan intents yang benar
        assert.strictEqual(mockWs.sent.length, 1);
        const identifyPkt = JSON.parse(mockWs.sent[0]);
        assert.strictEqual(identifyPkt.op, 2);
        assert.strictEqual(identifyPkt.d.token, 'mock-bot-token');
        assert.strictEqual(identifyPkt.d.intents, 33280);

        // Simulasi Event MESSAGE_CREATE
        mockWs.dispatchEvent('message', {
            data: JSON.stringify({
                op: 0,
                t: 'MESSAGE_CREATE',
                d: { content: '!status', channel_id: 'ch_1', author: { id: '805286573302218772', bot: false } }
            })
        });
        assert.strictEqual(messageHandled.content, '!status');
        cleanup();
        console.log('✓ Test 11: Discord Gateway v10 WHATWG EventTarget & Identify - PASSED');

        // ----------------------------------------------------------------------
        // Test 12: Otorisasi Command Bot Discord (Allowlist User Check)
        // ----------------------------------------------------------------------
        let sentReply = null;
        const mockSender = (channelId, text, embed) => {
            sentReply = { channelId, text, embed };
        };

        // User tidak dikenal -> diabaikan
        handleIncomingMessage({
            content: '!addbot bot_alpha',
            channel_id: 'ch_1',
            author: { id: 'unauthorized_user_123', bot: false }
        }, mockSender);
        assert.strictEqual(sentReply, null, 'User tidak dikenal harus diabaikan');

        // User diizinkan (Bos Anas: 805286573302218772) -> diproses
        handleIncomingMessage({
            content: '!help',
            channel_id: 'ch_1',
            author: { id: '805286573302218772', bot: false }
        }, mockSender);
        assert(sentReply !== null && sentReply.embed !== undefined, 'Command !help user berwenang harus dibalas');
        console.log('✓ Test 12: Otorisasi Bot Discord (Allowlist User ID) - PASSED');

        console.log('\nSeluruh 12 skenario pengujian ketahanan lolos 100%! 🎉');
    } finally {
        testServer.close();
        // Bersihkan seluruh direktori temporer pengujian
        fs.rmSync(TMP_TEST_DIR, { recursive: true, force: true });
    }
}

runAllTests().catch(err => {
    console.error('Test Suite Gagal:', err);
    process.exit(1);
});
