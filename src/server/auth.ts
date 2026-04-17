// ─────────────────────────────────────────────────────────────────────────────
// CxMS — Bearer Token Authentication
// ─────────────────────────────────────────────────────────────────────────────
// Middleware that validates Authorization: Bearer <token> headers.
// Token is loaded from ~/.cxms/token on first use.
// ─────────────────────────────────────────────────────────────────────────────

import type http from 'http';
import { loadBearerToken } from './system-config.js';
import { problemResponse } from './problem-details.js';
import { debug } from '../debug.js';

let _cachedToken: string | null = null;
let _authEnabled = true;

/**
 * Enable or disable authentication.
 * When disabled, all requests are allowed through (useful for local dev).
 */
export function setAuthEnabled(enabled: boolean): void {
    _authEnabled = enabled;
    debug('auth', `Authentication ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Check if authentication is enabled.
 */
export function isAuthEnabled(): boolean {
    return _authEnabled;
}

/**
 * Validate the bearer token on an incoming request.
 * Returns true if the request is authorized, false if rejected (response already sent).
 *
 * Usage in router:
 *   if (!await authenticateRequest(req, res)) return true; // already sent 401
 */
export async function authenticateRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<boolean> {
    if (!_authEnabled) return true;

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        problemResponse(res, 401, 'Unauthorized', 'Missing Authorization header. Use: Authorization: Bearer <token>');
        return false;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        problemResponse(res, 401, 'Unauthorized', 'Invalid Authorization header format. Use: Authorization: Bearer <token>');
        return false;
    }

    const providedToken = match[1].trim();
    if (!_cachedToken) {
        _cachedToken = await loadBearerToken();
    }

    if (providedToken !== _cachedToken) {
        debug('auth', `Token mismatch from ${req.socket.remoteAddress}`);
        problemResponse(res, 403, 'Forbidden', 'Invalid bearer token');
        return false;
    }

    return true;
}

/**
 * Reset the cached token (e.g. after regeneration).
 */
export function resetCachedToken(): void {
    _cachedToken = null;
}
