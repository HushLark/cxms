// ─────────────────────────────────────────────────────────────────────────────
// CxMS — Error Log
// ─────────────────────────────────────────────────────────────────────────────
// Appends structured error entries to (Foundation)/logs/error-YYYY-MM-DD.txt.
// Non-blocking — errors in the logger itself are silently swallowed.
// ─────────────────────────────────────────────────────────────────────────────

import type http from 'http';
import { getPlatform } from '../platform/index.js';
import { findFoundationRoot } from '../foundation.js';
import { getErrorLogPath, getFoundationLogsDir } from '../paths.js';

/**
 * Resolve the error log path for the current date.
 */
function getLogPath(): string | null {
    const root = findFoundationRoot();
    if (!root) return null;
    return getErrorLogPath();
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
 * Format a Date as ISO 8601 timestamp.
 */
function formatTimestamp(date: Date): string {
    return date.toISOString();
}

/**
 * Log an error that occurred while handling an HTTP request.
 *
 * Format: [ISO-timestamp] METHOD /path — ErrorName: message\n<stack>
 */
export async function logError(
    error: unknown,
    req?: http.IncomingMessage,
): Promise<void> {
    try {
        const logPath = getLogPath();
        if (!logPath) return;

        await ensureLogsDir();

        const timestamp = formatTimestamp(new Date());
        const method = req?.method || '-';
        const url = req?.url || '-';
        const err = error instanceof Error ? error : new Error(String(error));
        const stack = err.stack ? `\n${err.stack}` : '';

        const line = `[${timestamp}] ${method} ${url} — ${err.name}: ${err.message}${stack}\n\n`;

        await getPlatform().storage.appendFile(logPath, line);
    } catch {
        // Never let logging break the server
    }
}
