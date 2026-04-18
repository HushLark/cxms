// ─────────────────────────────────────────────────────────────────────────────
// CxMS — Vault Analytics
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from './platform/index.js';
import { findFoundationRoot } from './foundation.js';
import { loadEntityTypes } from './schema/entity-type-config.js';

export interface TypeAnalytics {
    name: string;
    nodes: number;
    bytes: number;
}

export interface VaultAnalytics {
    foundation: string;
    totalFiles: number;
    totalBytes: number;
    totalBytesFormatted: string;
    trashFiles: number;
    trashBytes: number;
    contextTypes: {
        count: number;
        types: TypeAnalytics[];
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function walkDir(dirPath: string): Promise<{ files: number; bytes: number }> {
    const { storage, paths } = getPlatform();
    let files = 0;
    let bytes = 0;

    let entries: string[];
    try {
        entries = await storage.readdir(dirPath);
    } catch {
        return { files, bytes };
    }

    await Promise.all(entries.map(async (entry) => {
        const fullPath = paths.join(dirPath, entry);
        let s;
        try {
            s = await storage.stat(fullPath);
        } catch {
            return;
        }
        if (s.isDirectory) {
            const sub = await walkDir(fullPath);
            files += sub.files;
            bytes += sub.bytes;
        } else if (s.isFile) {
            files += 1;
            bytes += s.size;
        }
    }));

    return { files, bytes };
}

export async function getVaultAnalytics(): Promise<VaultAnalytics> {
    const root = findFoundationRoot();
    if (!root) throw new Error('No foundation root found');
    const { storage, paths } = getPlatform();

    const types = await loadEntityTypes();

    // Per-type node counts and bytes (only .md files that are nodes)
    const typeAnalytics: TypeAnalytics[] = await Promise.all(
        types.map(async (t) => {
            const typeDir = paths.join(root, t.directory);
            let entries: string[] = [];
            try {
                entries = await storage.readdir(typeDir);
            } catch {
                return { name: t.name, nodes: 0, bytes: 0 };
            }

            let nodes = 0;
            let bytes = 0;
            await Promise.all(entries.map(async (entry) => {
                // Skip context/examples meta-files
                if (entry === '.cxms.md' || entry === '.cxms-examples.md') return;
                if (!entry.endsWith('.md')) return;
                const fp = paths.join(typeDir, entry);
                try {
                    const s = await storage.stat(fp);
                    if (s.isFile) {
                        nodes += 1;
                        bytes += s.size;
                    }
                } catch { /* skip */ }
            }));

            return { name: t.name, nodes, bytes };
        }),
    );

    // Trash stats
    const trashDir = paths.join(root, '.trash');
    const trash = await walkDir(trashDir);

    // Total vault walk (excludes trash from main count)
    const topEntries = await storage.readdir(root).catch(() => [] as string[]);
    let totalFiles = 0;
    let totalBytes = 0;
    await Promise.all(topEntries.map(async (entry) => {
        if (entry === '.trash') return; // counted separately
        const fullPath = paths.join(root, entry);
        let s;
        try {
            s = await storage.stat(fullPath);
        } catch { return; }
        if (s.isDirectory) {
            const sub = await walkDir(fullPath);
            totalFiles += sub.files;
            totalBytes += sub.bytes;
        } else if (s.isFile) {
            totalFiles += 1;
            totalBytes += s.size;
        }
    }));

    return {
        foundation: root,
        totalFiles,
        totalBytes,
        totalBytesFormatted: formatBytes(totalBytes),
        trashFiles: trash.files,
        trashBytes: trash.bytes,
        contextTypes: {
            count: types.length,
            types: typeAnalytics,
        },
    };
}
