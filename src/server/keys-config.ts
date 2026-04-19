import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

export type Vendor = 'anthropic' | 'openai' | 'gemini' | 'deepseek';
export const VENDORS: Vendor[] = ['anthropic', 'openai', 'gemini', 'deepseek'];

const keysFile = () => path.join(os.homedir(), '.cxms', 'keys.json');

export async function loadKeys(): Promise<Partial<Record<Vendor, string>>> {
    try {
        return JSON.parse(await fs.readFile(keysFile(), 'utf8'));
    } catch {
        return {};
    }
}

export async function saveKeys(keys: Partial<Record<Vendor, string>>): Promise<void> {
    const file = keysFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(keys, null, 2));
    await fs.chmod(file, 0o600);
}

export async function setKey(vendor: Vendor, key: string): Promise<void> {
    const keys = await loadKeys();
    keys[vendor] = key;
    await saveKeys(keys);
}

export async function removeKey(vendor: Vendor): Promise<void> {
    const keys = await loadKeys();
    delete keys[vendor];
    await saveKeys(keys);
}

export function maskKey(key: string): string {
    if (key.length <= 12) return '***';
    return key.slice(0, 10) + '...' + key.slice(-4);
}

export async function promptKey(vendor: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        // Hide input by writing prompt manually and suppressing echo
        process.stdout.write(`  ${vendor} API key: `);
        const { stdin } = process;
        const chunks: Buffer[] = [];
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.on('data', function onData(chunk: Buffer) {
            const char = chunk.toString();
            if (char === '\r' || char === '\n') {
                stdin.setRawMode?.(false);
                stdin.pause();
                stdin.off('data', onData);
                rl.close();
                process.stdout.write('\n');
                resolve(Buffer.concat(chunks).toString().trim());
            } else if (char === '\u0003') {
                process.exit(0);
            } else if (char === '\u007f') {
                chunks.pop();
            } else {
                chunks.push(chunk);
            }
        });
    });
}
