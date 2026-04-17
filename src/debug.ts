// ─────────────────────────────────────────────────────────────────────────────
// Debug Logger
// ─────────────────────────────────────────────────────────────────────────────

const VERBOSE = typeof process !== 'undefined' && process.env?.PHAIBEL_DEBUG === '1';

export function debug(tag: string, err: unknown): void {
    if (VERBOSE) {
        console.debug(`[cxms:${tag}]`, err);
        return;
    }
    if (err instanceof Error) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        console.debug(`[cxms:${tag}] ${err.message}`);
    } else {
        console.debug(`[cxms:${tag}] ${String(err)}`);
    }
}
