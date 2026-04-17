// ─────────────────────────────────────────────────────────────────────────────
// Platform Abstraction — Node.js Implementation
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs, realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import type { PlatformProvider, StorageProvider, PathProvider, FileStat } from './types.js';

class NodeStorageProvider implements StorageProvider {
    async readFile(filePath: string, encoding = 'utf-8'): Promise<string> {
        return fs.readFile(filePath, encoding as BufferEncoding);
    }
    async writeFile(filePath: string, content: string): Promise<void> {
        await fs.writeFile(filePath, content);
    }
    async readdir(dirPath: string): Promise<string[]> {
        return fs.readdir(dirPath);
    }
    async mkdir(dirPath: string, opts?: { recursive?: boolean }): Promise<void> {
        await fs.mkdir(dirPath, opts);
    }
    async rename(oldPath: string, newPath: string): Promise<void> {
        await fs.rename(oldPath, newPath);
    }
    async access(filePath: string): Promise<void> {
        await fs.access(filePath);
    }
    async unlink(filePath: string): Promise<void> {
        await fs.unlink(filePath);
    }
    async appendFile(filePath: string, content: string): Promise<void> {
        await fs.appendFile(filePath, content);
    }
    async stat(filePath: string): Promise<FileStat> {
        const stats = await fs.stat(filePath);
        return {
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            mtime: stats.mtime,
            size: stats.size,
        };
    }
    async realpath(filePath: string): Promise<string> {
        return realpathSync(filePath);
    }
}

const nodePathProvider: PathProvider = {
    join: (...parts: string[]) => path.join(...parts),
    basename: (p: string, ext?: string) => path.basename(p, ext),
    dirname: (p: string) => path.dirname(p),
    resolve: (...parts: string[]) => path.resolve(...parts),
    extname: (p: string) => path.extname(p),
    sep: path.sep,
};

class NodePlatformProvider implements PlatformProvider {
    readonly storage: StorageProvider;
    readonly paths: PathProvider;

    constructor() {
        this.storage = new NodeStorageProvider();
        this.paths = nodePathProvider;
    }

    homedir(): string {
        return os.homedir();
    }

    generateId(length: number): string {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        const alpha = 'abcdefghijklmnopqrstuvwxyz';
        let id = alpha[Math.floor(Math.random() * 26)];
        for (let i = 1; i < length; i++) {
            id += chars[Math.floor(Math.random() * 36)];
        }
        return id;
    }
}

export function createNodePlatform(): PlatformProvider {
    return new NodePlatformProvider();
}
