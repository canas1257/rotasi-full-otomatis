// ==============================================================================
// NODE.JS REST API & JOB QUEUE BRIDGE (Zero-Dependency Node.js)
// Author    : Salsa & Bos Anas
// QC Status : Verified with Anna's BRIDGE.md Contract
// ==============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------------------------
// 1. KONFIGURASI ENVIRONMENT
// ------------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const API_SECRET = process.env.API_SECRET || 'secret-token-lucifer-2026';
const DATA_DIR = path.join(__dirname, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ------------------------------------------------------------------------------
// 2. STATE PERSISTENCE ATOMIK (write-to-temp + fsync + rename)
// ------------------------------------------------------------------------------
let inMemoryJobs = [];

function loadJobsFromDisk() {
    if (!fs.existsSync(JOBS_FILE)) {
        inMemoryJobs = [];
        return;
    }
    try {
        const raw = fs.readFileSync(JOBS_FILE, 'utf8');
        if (!raw.trim()) {
            inMemoryJobs = [];
            return;
        }
        inMemoryJobs = JSON.parse(raw);
        if (!Array.isArray(inMemoryJobs)) {
            console.error('[Storage Error] File data/jobs.json bukan array valid!');
            inMemoryJobs = [];
        }
    } catch (err) {
        console.error('[Storage Fatal] Gagal membaca data/jobs.json:', err.message);
        throw err;
    }
}

function saveJobsToDiskAtomic(jobs) {
    const tmpFile = path.join(DATA_DIR, `jobs.tmp.${process.pid}.${Date.now()}`);
    const content = JSON.stringify(jobs, null, 2);

    const fd = fs.openSync(tmpFile, 'w');
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    fs.renameSync(tmpFile, JOBS_FILE);
}

loadJobsFromDisk();

// ------------------------------------------------------------------------------
// 3. HELPER VALIDASI & SANITASI
// ------------------------------------------------------------------------------
function isValidId(id) {
    return typeof id === 'string' && id.length >= 1 && id.length <= 80 && /^[\w-]+$/.test(id);
}

function maskAccount(acc) {
    if (!acc || typeof acc !== 'object') return null;
    if (acc.type === 'token') {
        const email = acc.email || '';
        const user = email.split('@')[0] || '';
        const domain = email.split('@')[1] || '';
        const maskedEmail = user.length <= 2 ? `${user[0]}***@${domain}` : `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
        return {
            type: 'token',
            email: maskedEmail,
            mac: acc.mac ? `${acc.mac.slice(0, 8)}:***` : undefined
        };
    }
    return {
        type: 'growid',
        name: acc.name || 'Unknown',
        password: '***'
    };
}

// ------------------------------------------------------------------------------
// 4. ROUTER & HANDLERS
// ------------------------------------------------------------------------------
function checkAuth(req, res) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED_MISSING_OR_INVALID_BEARER_TOKEN' }));
        return false;
    }
    const token = authHeader.slice(7).trim();
    if (token !== API_SECRET) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED_INVALID_SECRET' }));
        return false;
    }
    return true;
}

function parseJsonBody(req, callback) {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 64) { // Limit 64 KiB
            req.destroy();
        }
    });
    req.on('end', () => {
        if (!body.trim()) {
            return callback(null, {});
        }
        try {
            const parsed = JSON.parse(body);
            callback(null, parsed);
        } catch (e) {
            callback(e);
        }
    });
}

const server = http.createServer((req, res) => {
    const urlParts = req.url.split('?')[0].replace(/\/+$/, '');
    const method = req.method;

    // Health Check (Public)
    if (method === 'GET' && urlParts === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    }

    // Seluruh endpoint /api/* mewajibkan autentikasi Bearer token
    if (urlParts.startsWith('/api')) {
        if (!checkAuth(req, res)) return;
    }

    // --------------------------------------------------------------------------
    // Endpoint: GET /api/jobs/poll
    // Sesuai BRIDGE.md: action 'addbot', 204 jika kosong, klaim atomik sebelum 200
    // --------------------------------------------------------------------------
    if (method === 'GET' && urlParts === '/api/jobs/poll') {
        const pendingJob = inMemoryJobs.find(j => j.status === 'pending');
        if (!pendingJob) {
            res.writeHead(204, { 'Cache-Control': 'no-store' });
            return res.end();
        }

        // Tandai status 'claimed' secara atomik di disk SEBELUM respon dikirim
        pendingJob.status = 'claimed';
        pendingJob.claimed_at = new Date().toISOString();

        try {
            saveJobsToDiskAtomic(inMemoryJobs);
        } catch (err) {
            console.error('[Poll Error] Gagal simpan klaim atomik:', err.message);
            pendingJob.status = 'pending';
            delete pendingJob.claimed_at;
            res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ error: 'PERSISTENCE_FAILURE' }));
        }

        // Sesuai BRIDGE.md: kirim hanya job_id, action, bot_id, account (tanpa config rotasi di tahap ini)
        const jobPayload = {
            job_id: pendingJob.job_id,
            action: pendingJob.action || 'addbot',
            bot_id: pendingJob.bot_id,
            account: pendingJob.account
        };

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        });
        return res.end(JSON.stringify(jobPayload));
    }

    // --------------------------------------------------------------------------
    // Endpoint: POST /api/jobs/:job_id/status
    // Sesuai BRIDGE.md: menerima success, failed, stalled (idempotent untuk laporan berulang)
    // --------------------------------------------------------------------------
    const statusMatch = urlParts.match(/^\/api\/jobs\/([^/]+)\/status$/);
    if (method === 'POST' && statusMatch) {
        const jobId = statusMatch[1];
        return parseJsonBody(req, (err, payload) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'INVALID_JSON_BODY' }));
            }

            const targetJob = inMemoryJobs.find(j => j.job_id === jobId);
            if (!targetJob) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'JOB_NOT_FOUND' }));
            }

            const validStatuses = ['success', 'failed', 'stalled', 'in_progress'];
            if (!payload.status || !validStatuses.includes(payload.status)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'INVALID_STATUS_VALUE', allowed: validStatuses }));
            }

            // Jika status dan error sama persis dengan laporan sebelumnya (idempotent report)
            if (targetJob.status === payload.status && targetJob.error === (payload.error || null)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, job_id: jobId, status: targetJob.status, idempotent: true }));
            }

            targetJob.status = payload.status;
            targetJob.error = payload.error || null;
            targetJob.updated_at = new Date().toISOString();

            try {
                saveJobsToDiskAtomic(inMemoryJobs);
            } catch (saveErr) {
                console.error('[Status Error] Gagal simpan status:', saveErr.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'PERSISTENCE_FAILURE' }));
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, job_id: jobId, status: targetJob.status }));
        });
    }

    // --------------------------------------------------------------------------
    // Endpoint: POST /api/jobs
    // Menambahkan tugas baru (menolak dua tugas aktif untuk bot yang sama)
    // --------------------------------------------------------------------------
    if (method === 'POST' && urlParts === '/api/jobs') {
        return parseJsonBody(req, (err, payload) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'INVALID_JSON_BODY' }));
            }

            let accountData = payload.account;
            const alias = payload.alias;
            const botId = alias || payload.bot_id;

            if (!botId || !isValidId(botId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'INVALID_OR_MISSING_BOT_ID', hint: 'bot_id harus 1-80 karakter ASCII [a-zA-Z0-9_-]' }));
            }

            // Aturan BRIDGE.md: Server harus menolak dua tugas aktif untuk bot yang sama
            const activeJob = inMemoryJobs.find(j => j.bot_id === botId && (j.status === 'pending' || j.status === 'claimed' || j.status === 'executing'));
            if (activeJob) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    error: 'BOT_ALREADY_HAS_ACTIVE_JOB',
                    active_job_id: activeJob.job_id,
                    current_status: activeJob.status
                }));
            }

            // Jika menggunakan alias, baca dari accounts.json lokal
            if (alias) {
                if (!fs.existsSync(ACCOUNTS_FILE)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'ACCOUNTS_FILE_NOT_FOUND', hint: 'Buat accounts.json dari template accounts.example.json' }));
                }
                try {
                    const accountsMap = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
                    if (!accountsMap[alias]) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: `ALIAS_NOT_FOUND: ${alias}` }));
                    }
                    accountData = accountsMap[alias];
                } catch (readAccErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'FAILED_READING_ACCOUNTS_FILE' }));
                }
            }

            if (!accountData || typeof accountData !== 'object') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'MISSING_ACCOUNT_DATA_OR_VALID_ALIAS' }));
            }

            const rawJobId = payload.job_id || `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            if (!isValidId(rawJobId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'INVALID_JOB_ID_FORMAT' }));
            }

            const newJob = {
                job_id: rawJobId,
                action: 'addbot', // Sesuai kontrak BRIDGE.md tahap ini
                bot_id: botId,
                account: accountData,
                status: 'pending',
                created_at: new Date().toISOString()
            };

            inMemoryJobs.push(newJob);

            try {
                saveJobsToDiskAtomic(inMemoryJobs);
            } catch (saveErr) {
                inMemoryJobs.pop();
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'PERSISTENCE_FAILURE' }));
            }

            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                success: true,
                job_id: newJob.job_id,
                bot_id: newJob.bot_id,
                status: newJob.status
            }));
        });
    }

    // --------------------------------------------------------------------------
    // Endpoint: GET /api/jobs
    // Monitoring antrean (kredensial otomatis disanitasi)
    // --------------------------------------------------------------------------
    if (method === 'GET' && urlParts === '/api/jobs') {
        const sanitizedList = inMemoryJobs.map(j => ({
            job_id: j.job_id,
            action: j.action,
            bot_id: j.bot_id,
            status: j.status,
            account: maskAccount(j.account),
            created_at: j.created_at,
            claimed_at: j.claimed_at,
            updated_at: j.updated_at,
            error: j.error
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ total: sanitizedList.length, jobs: sanitizedList }));
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ENDPOINT_NOT_FOUND' }));
});

if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[Bridge Server] Berjalan pada http://127.0.0.1:${PORT}`);
        console.log(`[Bridge Server] API Secret: ${API_SECRET ? 'TERKONFIGURASI' : 'KOSONG'}`);
    });
}

module.exports = { server, inMemoryJobs, saveJobsToDiskAtomic, loadJobsFromDisk };
