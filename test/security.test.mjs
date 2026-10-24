// Regression tests for the three security fixes. Run: npm test (after npm run build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-test-'));
process.env.GMAIL_MCP_FILES_DIR = filesDir;
const { resolveInsideFilesDir, sanitizeAttachmentFilename } = await import('../dist/utl.js');
const { keychainRead, keychainWrite, keychainDelete } = await import('../dist/keychain.js');

test('download names from the sender cannot climb out of the folder', () => {
    assert.equal(sanitizeAttachmentFilename('../../.zshrc', 'fallback'), '_zshrc');
    assert.equal(sanitizeAttachmentFilename('..\\..\\evil.bat', 'fallback'), 'evil.bat');
    assert.equal(sanitizeAttachmentFilename('/etc/passwd', 'fallback'), 'passwd');
    assert.equal(sanitizeAttachmentFilename('..', 'fallback'), 'fallback');
    assert.equal(sanitizeAttachmentFilename('report.pdf', 'fallback'), 'report.pdf');
});

test('download directory must stay inside the files folder', () => {
    assert.throws(() => resolveInsideFilesDir(os.homedir(), 'directory'), /Refused/);
    assert.throws(() => resolveInsideFilesDir('../outside', 'directory'), /Refused/);
    assert.ok(resolveInsideFilesDir('sub', 'directory').startsWith(fs.realpathSync(filesDir)));
});

test('attachments to send must be files inside the files folder', () => {
    assert.throws(() => resolveInsideFilesDir(path.join(os.homedir(), '.ssh', 'id_rsa'), 'existing-file'), /Refused/);
    assert.throws(() => resolveInsideFilesDir('/etc/hosts', 'existing-file'), /Refused/);
    // A symlink inside the folder that points outside is refused too
    fs.symlinkSync('/etc/hosts', path.join(filesDir, 'link-to-hosts'));
    assert.throws(() => resolveInsideFilesDir('link-to-hosts', 'existing-file'), /Refused/);
    fs.writeFileSync(path.join(filesDir, 'ok.txt'), 'hi');
    assert.ok(resolveInsideFilesDir('ok.txt', 'existing-file').endsWith('ok.txt'));
});

test('keychain round trip, and odd account names are rejected', async () => {
    const account = 'selftest:roundtrip';
    const value = JSON.stringify({ refresh_token: 'x y "z"', n: 1 });
    await keychainWrite(account, value);
    assert.equal(await keychainRead(account), value);
    await keychainDelete(account);
    assert.equal(await keychainRead(account), null);
    await assert.rejects(keychainWrite('bad name\nadd-generic-password', 'v'), /invalid keychain account/);
});
