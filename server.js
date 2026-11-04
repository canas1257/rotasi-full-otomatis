// ==============================================================================
// NODE.JS REST API & JOB QUEUE BRIDGE (Zero-Dependency Node.js v22)
// Author    : Salsa & Bos Anas
// QC Status : Hardened with Anna's QC Review & BRIDGE.md Contract
// ==============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------------------------
// 1. KONFIGURASI ENVIRONMENT (Fail-Closed)
// ------------------------------------------------------------------------------
// Node v22 parses quotes/comments and preserves existing environment values.
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
    if (err.code !== 'ENOENT') throw new Error('ENV_FILE_LOAD_FAILED');
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_SECRET = process.env.API_SECRET;

// Fail-closed jika secret tidak ada atau terlalu pendek (< 16 karakter)
if (!API_SECRET || API_SECRET.length < 16) {
    if (process.env.NODE_ENV !== 'test') {
        console.error('[FATAL SECURITY] API_SECRET wajib dikonfigurasi minimal 16 karakter di environment variable! Server dihentikan (fail-closed).');
        process.exit(1);
    }
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const JOBS_FILE = process.env.JOBS_FILE || path.join(DATA_DIR, 'jobs.json');
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(__dirname, 'accounts.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
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
        // Fail-closed: jika file ada tetapi kosong atau corrupt, lemparkan error
        if (!raw.trim()) {
            throw new Error(`FILE_CORRUPT_EMPTY: File state ${JOBS_FILE} ada tetapi kosong.`);
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            throw new Error(`FILE_CORRUPT_NOT_ARRAY: File state ${JOBS_FILE} bukan array valid.`);
        }
        inMemoryJobs = parsed;
    } catch (err) {
        console.error('[Storage Fatal] Gagal membaca state jobs.json:', err.message);
        throw err;
    }
}

function saveJobsToDiskAtomic(jobs) {
    const tmpFile = path.join(DATA_DIR, `jobs.tmp.${process.pid}.${Date.now()}`);
    const content = JSON.stringify(jobs, null, 2);

    // Buka file dengan izin terbatas (0600)
    const fd = fs.openSync(tmpFile, 'w', 0o600);
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    fs.renameSync(tmpFile, JOBS_FILE);
}

// Inisialisasi awal saat start
if (process.env.NODE_ENV !== 'test' || fs.existsSync(JOBS_FILE)) {
    loadJobsFromDisk();
}

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
function parseJsonBody(req, callback) {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 64) { // Batasi 64 KiB sesuai BRIDGE.md
            req.destroy();
        }
    });
    req.on('end', () => {
        if (!body.trim()) {
            return callback(null, null);
        }
        try {
            const parsed = JSON.parse(body);
            callback(null, parsed);
        } catch (e) {
            callback(e);
        }
    });
}

function createServerInstance(customSecret) {
    const activeSecret = customSecret || API_SECRET;

    return http.createServer((req, res) => {
        const urlParts = req.url.split('?')[0].replace(/\/+$/, '');
        const method = req.method;

        // Health Check (Public)
        if (method === 'GET' && urlParts === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        }

        // Seluruh endpoint /api/* mewajibkan autentikasi Bearer token
        if (urlParts.startsWith('/api')) {
            const authHeader = req.headers['authorization'];
            if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7).trim() !== activeSecret) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
            }
        }

        // ----------------------------------------------------------------------
        // Endpoint: GET /api/jobs/poll
        // ----------------------------------------------------------------------
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
                // Rollback status memori jika gagal simpan
                pendingJob.status = 'pending';
                delete pendingJob.claimed_at;
                res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                return res.end(JSON.stringify({ error: 'PERSISTENCE_FAILURE' }));
            }

            // Payload bersih sesuai kontrak BRIDGE.md (tanpa config rotasi di tahap ini)
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

        // ----------------------------------------------------------------------
        // Endpoint: POST /api/jobs/:job_id/status
        // ----------------------------------------------------------------------
        const statusMatch = urlParts.match(/^\/api\/jobs\/([^/]+)\/status$/);
        if (method === 'POST' && statusMatch) {
            const jobId = statusMatch[1];
            return parseJsonBody(req, (err, payload) => {
                if (err || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
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

                // Cek Idempotency: Jika status dan error sama persis, kembalikan 200 OK
                if (targetJob.status === payload.status && targetJob.error === (payload.error || null)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, job_id: jobId, status: targetJob.status, idempotent: true }));
                }

                // Cegah penimpaan status terminal jika sudah success/failed dengan status yang berbeda
                if ((targetJob.status === 'success' || targetJob.status === 'failed') && targetJob.status !== payload.status) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        error: 'ILLEGAL_STATUS_TRANSITION_FROM_TERMINAL_STATE',
                        current_status: targetJob.status
                    }));
                }

                // Simpan state lama untuk rollback jika disk failure
                const prevStatus = targetJob.status;
                const prevError = targetJob.error;
                const prevUpdated = targetJob.updated_at;

                targetJob.status = payload.status;
                targetJob.error = payload.error || null;
                targetJob.updated_at = new Date().toISOString();

                try {
                    saveJobsToDiskAtomic(inMemoryJobs);
                } catch (saveErr) {
                    console.error('[Status Error] Gagal simpan status:', saveErr.message);
                    // Rollback state memori
                    targetJob.status = prevStatus;
                    targetJob.error = prevError;
                    targetJob.updated_at = prevUpdated;

                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'PERSISTENCE_FAILURE' }));
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, job_id: jobId, status: targetJob.status }));
            });
        }

        // ----------------------------------------------------------------------
        // Endpoint: POST /api/jobs
        // ----------------------------------------------------------------------
        if (method === 'POST' && urlParts === '/api/jobs') {
            return parseJsonBody(req, (err, payload) => {
                if (err || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
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

                // Resolusi akun via alias jika diberikan
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

                // Aturan BRIDGE.md: Tolak job_id duplikat permanen
                const existingJobId = inMemoryJobs.find(j => j.job_id === rawJobId);
                if (existingJobId) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'JOB_ID_ALREADY_EXISTS', job_id: rawJobId }));
                }

                const newJob = {
                    job_id: rawJobId,
                    action: 'addbot', // Sesuai kontrak BRIDGE.md
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

        // ----------------------------------------------------------------------
        // Endpoint: GET /api/jobs
        // ----------------------------------------------------------------------
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
}

const defaultServer = createServerInstance(API_SECRET);

if (require.main === module) {
    defaultServer.listen(PORT, '127.0.0.1', () => {
        console.log(`[Bridge Server] Berjalan pada http://127.0.0.1:${PORT}`);
        console.log(`[Bridge Server] API Secret: ${API_SECRET ? 'TERKONFIGURASI' : 'KOSONG'}`);
    });
}

module.exports = {
    server: defaultServer,
    createServerInstance,
    inMemoryJobs,
    saveJobsToDiskAtomic,
    loadJobsFromDisk,
    setJobs: (arr) => { inMemoryJobs = arr; }
};
