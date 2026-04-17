// ─────────────────────────────────────────────────────────────────────────────
// Platform Abstraction — Singleton Access
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'node:module';
import type { PlatformProvider } from './types.js';

let _platform: PlatformProvider | null = null;

export function getPlatform(): PlatformProvider {
    if (!_platform) {
        const nodeRequire = createRequire(import.meta.url);
        const { createNodePlatform } = nodeRequire('./node.js') as { createNodePlatform: () => PlatformProvider };
        _platform = createNodePlatform();
    }
    return _platform;
}

export function setPlatform(provider: PlatformProvider): void {
    _platform = provider;
}

export function resetPlatform(): void {
    _platform = null;
}

export type { PlatformProvider, StorageProvider, PathProvider, FileStat } from './types.js';
