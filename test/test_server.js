// ==============================================================================
// TEST SUITE FOR SERVER.JS (NODE.JS BRIDGE REST API)
// Author    : Salsa & Bos Anas
// QC Status : Automated Verification
// ==============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TEST_PORT = 3999;
const TEST_SECRET = 'test-token-secret-12345678';
process.env.PORT = String(TEST_PORT);
process.env.API_SECRET = TEST_SECRET;

const ROOT_DIR = path.join(__dirname, '..');
const TEST_DATA_DIR = path.join(ROOT_DIR, 'data');
const TEST_JOBS_FILE = path.join(TEST_DATA_DIR, 'jobs.json');
const TEST_ACCOUNTS_FILE = path.join(ROOT_DIR, 'accounts.json');

// Siapkan accounts.json untuk pengujian alias
fs.writeFileSync(TEST_ACCOUNTS_FILE, JSON.stringify({
    bot_alpha: {
        type: 'growid',
        name: 'AlphaTester',
        password: 'SecretPassword999'
    }
}, null, 2));

// Reset jobs.json
if (fs.existsSync(TEST_JOBS_FILE)) {
    fs.unlinkSync(TEST_JOBS_FILE);
}

const { server, inMemoryJobs, loadJobsFromDisk } = require('../server.js');

function makeRequest(method, path, headers = {}, bodyObj = null) {
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
            path: path,
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

async function runServerTests() {
    console.log('=== Menjalankan Unit Test Suite untuk server.js ===');

    await new Promise(r => server.listen(TEST_PORT, '127.0.0.1', r));

    try {
        // ----------------------------------------------------------------------
        // Test 1: Health Check (Public)
        // ----------------------------------------------------------------------
        const resHealth = await makeRequest('GET', '/health');
        assert.strictEqual(resHealth.status, 200, 'Health check harus 200');
        assert.strictEqual(resHealth.body.status, 'ok', 'Status harus ok');
        console.log('✓ Test 1: Health Check Endpoint - PASSED');

        // ----------------------------------------------------------------------
        // Test 2: Autentikasi Ditolak jika Token Tidak Ada / Salah
        // ----------------------------------------------------------------------
        const resNoAuth = await makeRequest('GET', '/api/jobs/poll');
        assert.strictEqual(resNoAuth.status, 401, 'Request tanpa header auth harus 401');

        const resBadAuth = await makeRequest('GET', '/api/jobs/poll', { 'Authorization': 'Bearer wrong-secret' });
        assert.strictEqual(resBadAuth.status, 401, 'Request token salah harus 401');
        console.log('✓ Test 2: Autentikasi Bearer Token - PASSED');

        const authHeader = { 'Authorization': `Bearer ${TEST_SECRET}` };

        // ----------------------------------------------------------------------
        // Test 3: Poll saat antrean kosong mengembalikan 204
        // ----------------------------------------------------------------------
        const resEmptyPoll = await makeRequest('GET', '/api/jobs/poll', authHeader);
        assert.strictEqual(resEmptyPoll.status, 204, 'Antrean kosong harus 204 No Content');
        console.log('✓ Test 3: GET /api/jobs/poll Empty Queue (204) - PASSED');

        // ----------------------------------------------------------------------
        // Test 4: POST /api/jobs membuat tugas baru dengan alias
        // ----------------------------------------------------------------------
        const resCreate = await makeRequest('POST', '/api/jobs', authHeader, {
            alias: 'bot_alpha'
        });
        assert.strictEqual(resCreate.status, 201, 'Pembuatan tugas harus 201 Created');
        assert.strictEqual(resCreate.body.success, true);
        assert.strictEqual(resCreate.body.status, 'pending');
        const createdJobId = resCreate.body.job_id;
        console.log('✓ Test 4: POST /api/jobs Buat Tugas via Alias - PASSED');

        // ----------------------------------------------------------------------
        // Test 5: Pencegahan Duplikasi (Tolak tugas aktif kedua untuk bot yang sama)
        // ----------------------------------------------------------------------
        const resDup = await makeRequest('POST', '/api/jobs', authHeader, {
            alias: 'bot_alpha'
        });
        assert.strictEqual(resDup.status, 409, 'Tugas kedua untuk bot yang sama harus ditolak 409 Conflict');
        assert.strictEqual(resDup.body.error, 'BOT_ALREADY_HAS_ACTIVE_JOB');
        console.log('✓ Test 5: Tolak Dua Tugas Aktif untuk Bot yang Sama (409 Conflict) - PASSED');

        // ----------------------------------------------------------------------
        // Test 6: GET /api/jobs/poll mengklaim tugas secara atomik
        // ----------------------------------------------------------------------
        const resPoll = await makeRequest('GET', '/api/jobs/poll', authHeader);
        assert.strictEqual(resPoll.status, 200, 'Poll tugas pending harus 200 OK');
        assert.strictEqual(resPoll.body.job_id, createdJobId);
        assert.strictEqual(resPoll.body.action, 'addbot', 'Aksi harus addbot sesuai BRIDGE.md');
        assert.strictEqual(resPoll.body.bot_id, 'bot_alpha');
        assert.strictEqual(resPoll.body.account.name, 'AlphaTester');

        // Verifikasi bahwa tugas langsung tersimpan sebagai 'claimed' di disk
        const savedData = JSON.parse(fs.readFileSync(TEST_JOBS_FILE, 'utf8'));
        const diskJob = savedData.find(j => j.job_id === createdJobId);
        assert.strictEqual(diskJob.status, 'claimed', 'Status di disk harus sudah claimed sebelum poll response selesai');
        console.log('✓ Test 6: GET /api/jobs/poll Klaim Atomik & Payload addbot - PASSED');

        // ----------------------------------------------------------------------
        // Test 7: Poll berikutnya segera mengembalikan 204 (tidak terbagi ulang)
        // ----------------------------------------------------------------------
        const resPollAgain = await makeRequest('GET', '/api/jobs/poll', authHeader);
        assert.strictEqual(resPollAgain.status, 204, 'Tugas yang sudah claimed tidak boleh dibagikan lagi');
        console.log('✓ Test 7: Tugas yang Diklaim Tidak Terbagi Ulang (204) - PASSED');

        // ----------------------------------------------------------------------
        // Test 8: POST /api/jobs/:job_id/status memperbarui status (Idempotent)
        // ----------------------------------------------------------------------
        const resStatus = await makeRequest('POST', `/api/jobs/${createdJobId}/status`, authHeader, {
            status: 'success',
            error: null
        });
        assert.strictEqual(resStatus.status, 200, 'Laporan status harus 200 OK');
        assert.strictEqual(resStatus.body.status, 'success');

        // Laporan ulang identik harus aman dan tetap 200 OK
        const resStatusRepeat = await makeRequest('POST', `/api/jobs/${createdJobId}/status`, authHeader, {
            status: 'success',
            error: null
        });
        assert.strictEqual(resStatusRepeat.status, 200, 'Laporan status berulang harus 200 OK (idempotent)');
        console.log('✓ Test 8: POST /api/jobs/:job_id/status Idempotent Update - PASSED');

        // ----------------------------------------------------------------------
        // Test 9: GET /api/jobs memaparkan ringkasan tanpa bocor kredensial
        // ----------------------------------------------------------------------
        const resList = await makeRequest('GET', '/api/jobs', authHeader);
        assert.strictEqual(resList.status, 200);
        assert.strictEqual(resList.body.total, 1);
        const listedJob = resList.body.jobs[0];
        assert.strictEqual(listedJob.account.password, '***', 'Password harus disanitasi');
        console.log('✓ Test 9: GET /api/jobs Sanitasi Kredensial - PASSED');

        console.log('\nSemua 9 skenario unit test server.js lolos 100%! 🎉');
    } finally {
        server.close();
        if (fs.existsSync(TEST_ACCOUNTS_FILE)) {
            fs.unlinkSync(TEST_ACCOUNTS_FILE);
        }
    }
}

runServerTests().catch(err => {
    console.error('Test Suite Gagal:', err);
    process.exit(1);
});
