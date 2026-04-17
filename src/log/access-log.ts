// ─────────────────────────────────────────────────────────────────────────────
// CxMS — Access Log
// ─────────────────────────────────────────────────────────────────────────────
// Appends Apache Combined Log Format entries to (Foundation)/logs/access-YYYY-MM-DD.txt.
// Non-blocking — errors are silently swallowed so logging never breaks requests.
// ─────────────────────────────────────────────────────────────────────────────

import type http from 'http';
import { getPlatform } from '../platform/index.js';
import { findFoundationRoot } from '../foundation.js';
import { getAccessLogPath, getFoundationLogsDir } from '../paths.js';

/**
 * Resolve the access log path for the current date.
 * Computed per-request since the date changes daily.
 */
function getLogPath(): string | null {
    const root = findFoundationRoot();
    if (!root) return null;
    return getAccessLogPath();
}

/**
 * Ensure the logs directory exists.
 */
async function ensureLogsDir(): Promise<void> {
    const root = findFoundationRoot();
    if (!root) return;
    await getPlatform().storage.mkdir(getFoundationLogsDir(), { recursive: true });
}

/**
 * Format a Date as Apache Combined Log Format timestamp.
 * e.g. [06/Apr/2026:14:30:00 +0000]
 */
function formatTimestamp(date: Date): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = String(date.getUTCDate()).padStart(2, '0');
    const mon = months[date.getUTCMonth()];
    const y = date.getUTCFullYear();
    const h = String(date.getUTCHours()).padStart(2, '0');
    const m = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    return `[${d}/${mon}/${y}:${h}:${m}:${s} +0000]`;
}

/**
 * Log an HTTP request in Apache Combined Log Format.
 * Call this after the response has been sent.
 */
export async function logAccess(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    startTime: number,
): Promise<void> {
    try {
        const logPath = getLogPath();
        if (!logPath) return;

        await ensureLogsDir();

        const remoteAddr = req.socket.remoteAddress || '-';
        const method = req.method || '-';
        const url = req.url || '-';
        const httpVersion = `HTTP/${req.httpVersion}`;
        const status = res.statusCode;
        const contentLength = res.getHeader('content-length') || '-';
        const referer = req.headers.referer || '-';
        const userAgent = req.headers['user-agent'] || '-';
        const timestamp = formatTimestamp(new Date(startTime));

        const line = `${remoteAddr} - - ${timestamp} "${method} ${url} ${httpVersion}" ${status} ${contentLength} "${referer}" "${userAgent}"\n`;

        await getPlatform().storage.appendFile(logPath, line);
    } catch {
        // Never let logging break the server
    }
}

