// ─────────────────────────────────────────────────────────────────────────────
// CxMS — HTTP Request Handler
// ─────────────────────────────────────────────────────────────────────────────
// Top-level routing for the CxMS server: the /cx/* REST API and the /mcp
// endpoint. Lives here rather than inline in the CLI so the exact routing the
// server runs — including which paths require a bearer token — is testable.
// ─────────────────────────────────────────────────────────────────────────────

import type http from 'http';
import { handleCxRoute } from './cx-router.js';
import { handleMcpRoute } from './mcp-server.js';
import { authenticateRequest } from './auth.js';

export async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // REST API — authenticates per route (/cx/health is open as a liveness probe)
    if (url.pathname.startsWith('/cx/')) {
        await handleCxRoute(req, res, url);
        return;
    }

    // MCP server — the tools read and write the whole Foundation, so it needs
    // the same bearer token as the REST API
    if (url.pathname === '/mcp') {
        if (!await authenticateRequest(req, res)) return;
        await handleMcpRoute(req, res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
}
