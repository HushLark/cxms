// ─────────────────────────────────────────────────────────────────────────────
// CxMS — Boundary Guard
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from '../platform/index.js';
import { findFoundationRoot } from '../foundation.js';

export class BoundaryViolationError extends Error {
    constructor(filepath: string, foundationRoot: string) {
        super(`Path "${filepath}" is outside the Foundation boundary "${foundationRoot}"`);
        this.name = 'BoundaryViolationError';
    }
}

export async function assertWithinFoundation(filepath: string): Promise<void> {
    const root = findFoundationRoot();
    if (!root) {
        throw new Error('No Foundation found — cannot verify boundary');
    }
    await assertWithinRoot(filepath, root);
}

export async function assertWithinRoot(filepath: string, foundationRoot: string): Promise<void> {
    const { paths, storage } = getPlatform();

    let resolved = paths.resolve(filepath);
    let rootResolved = paths.resolve(foundationRoot);

    if (storage.realpath) {
        try { rootResolved = await storage.realpath(rootResolved); } catch { /* ignore */ }
        try { resolved = await storage.realpath(resolved); } catch {
            const dir = paths.dirname(resolved);
            const base = paths.basename(resolved);
            try { resolved = paths.join(await storage.realpath(dir), base); } catch { /* keep original */ }
        }
    }

    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + paths.sep)) {
        throw new BoundaryViolationError(filepath, foundationRoot);
    }
}
