// Anna: native .env loading, isolated files and child processes; no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-env-'));
try {
    fs.writeFileSync(path.join(dir, '.env'), [
        'API_SECRET="test-secret-long-enough" # comment',
        'ENV_CHECK="quoted value" # comment',
        'ENV_KEEP=file-value',
        'ENV_EMPTY=file-value',
    ].join('\n'), {mode: 0o600});
    for (const filename of ['server.js', 'discord-bot.js']) {
        fs.copyFileSync(path.join(__dirname, '..', filename), path.join(dir, filename));
        const env = {...process.env, DATA_DIR:path.join(dir, 'data'), ENV_KEEP:'existing', ENV_EMPTY:''};
        delete env.API_SECRET; delete env.ENV_CHECK;
        execFileSync(process.execPath, ['-e', `
            require(${JSON.stringify(path.join(dir, filename))});
            const assert=require('node:assert/strict');
            assert.equal(process.env.API_SECRET,'test-secret-long-enough');
            assert.equal(process.env.ENV_CHECK,'quoted value');
            assert.equal(process.env.ENV_KEEP,'existing');
            assert.equal(process.env.ENV_EMPTY,'');
        `], {env, stdio:'pipe'});
    }
    console.log('env: both modules, quotes/comments, existing/empty environment precedence: PASS');
} finally {
    fs.rmSync(dir, {recursive:true, force:true});
}
