/**
 * MCP Authentication Test
 *
 * /mcp exposes every tool, including the ones that write and delete nodes and
 * types, so it must require the same bearer token as the /cx/* REST API.
 * Runs the server's real request handler (handleRequest), not a copy of it.
 *
 * HOME points at a temp dir so the token is generated there and the real
 * ~/.cxms/token is never read or touched.
 *
 * Usage:
 *   npm run build && node test/mcp-auth.test.mjs
 */

import http from 'http';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cxms-mcp-auth-test-'));
process.env.HOME = tempDir;

const {
    setPlatform, createNodePlatform, setFoundationRoot,
    resetFoundationRoot, resetEntityIndex, invalidateEntityTypeCache,
    resetMcpServer, setAuthEnabled, resetCachedToken, loadBearerToken,
    handleRequest,
} = await import('../dist/index.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const INITIALIZE = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'auth-test', version: '0' } },
};

// An unauthenticated request that reaches the MCP handler can hold its stream
// open rather than answer, so a regression would hang instead of failing.
// Time out and report it as status 0.
async function post(port, body, headers = {}) {
    try {
        return await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...headers,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err) {
        return { status: 0, text: async () => String(err) };
    }
}

setPlatform(createNodePlatform());
resetFoundationRoot(); resetEntityIndex(); invalidateEntityTypeCache(); resetMcpServer(); resetCachedToken();
await fs.writeFile(path.join(tempDir, '.cxms.md'), '---\ntitle: Auth Test\ncreated: 2026-10-16\n---\n');
await fs.mkdir(path.join(tempDir, '.phaibel'), { recursive: true });
await fs.writeFile(path.join(tempDir, '.phaibel', 'entity-types.json'), JSON.stringify({ version: 1, entityTypes: [] }));
setFoundationRoot(tempDir);

const token = await loadBearerToken();
const server = http.createServer(async (req, res) => {
    resetMcpServer();
    await handleRequest(req, res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

try {
    console.log('\n/mcp with auth enabled');
    setAuthEnabled(true);

    let res = await post(port, INITIALIZE);
    check('no Authorization header → 401', res.status === 401, `got ${res.status}`);

    res = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    check('tools/list without a token → 401', res.status === 401, `got ${res.status}`);

    res = await post(port, INITIALIZE, { authorization: 'Bearer not-the-token' });
    check('wrong token → 403', res.status === 403, `got ${res.status}`);

    res = await post(port, INITIALIZE, { authorization: `Bearer ${token}` });
    const text = await res.text();
    check('correct token → 200', res.status === 200, `got ${res.status}: ${text.slice(0, 200)}`);
    check('correct token → initialize result', text.includes('"result"'), text.slice(0, 200));

    res = await fetch(`http://127.0.0.1:${port}/cx/health`);
    check('/cx/health stays open', res.status === 200, `got ${res.status}`);

    console.log('\n/mcp with --no-auth');
    setAuthEnabled(false);
    res = await post(port, INITIALIZE);
    check('no token needed when auth is disabled', res.status === 200, `got ${res.status}`);
} finally {
    server.close();
    await fs.rm(tempDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
