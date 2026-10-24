import { execFile, spawn } from 'child_process';

// Everything this server stores (OAuth client keys, one token per GMAIL_ACCOUNT)
// lives in the macOS login keychain under this service name. Nothing is written to disk.
const KEYCHAIN_SERVICE = 'gmail-mcp';

/**
 * Stores a value in the keychain. The value is base64-encoded and fed to
 * `security -i` over stdin, so it never appears in a process argument list.
 */
export function keychainWrite(keychainAccount: string, value: string): Promise<void> {
    // The command line below is split on whitespace by `security -i`; refuse anything that could inject.
    if (!/^[A-Za-z0-9._%+@:-]+$/.test(keychainAccount)) {
        return Promise.reject(new Error(`invalid keychain account name: ${keychainAccount}`));
    }
    const encodedValue = Buffer.from(value, 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
        const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0 && !stderr.trim()) resolve();
            else reject(new Error(`keychain write failed for ${keychainAccount}: ${stderr.trim() || `exit ${code}`}`));
        });
        child.stdin.end(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${keychainAccount} -w ${encodedValue}\n`);
    });
}

/** Returns the stored value, or null if the item does not exist. */
export function keychainRead(keychainAccount: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        execFile('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount, '-w'],
            (error, stdout) => {
                if (error) {
                    // exit code 44 = item not found
                    if ((error as NodeJS.ErrnoException & { code?: number }).code === 44) resolve(null);
                    else reject(new Error(`keychain read failed for ${keychainAccount}: ${error.message}`));
                    return;
                }
                resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
            });
    });
}

export function keychainDelete(keychainAccount: string): Promise<void> {
    return new Promise(resolve => {
        execFile('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount], () => resolve());
    });
}
