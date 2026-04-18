#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CxMS Analytics Integration Test
// ─────────────────────────────────────────────────────────────────────────────
// Tests GET /cx/analytics (REST) and get_analytics (MCP tool) against a live
// server started on a random port with an isolated temp Foundation.
//
// Usage: node test/analytics.test.mjs
//
// Outputs: temp folder, port, total tests, passed, failed.
// Leaves no files on disk after completion.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
    setPlatform,
    createNodePlatform,
    setFoundationRoot,
    resetFoundationRoot,
    handleCxRoute,
    handleMcpRoute,
    resetMcpServer,
    setAuthEnabled,
    getEntityIndex,
    resetEntityIndex,
    invalidateEntityTypeCache,
    addEntityType,
} from '../dist/index.js';

// ── State ─────────────────────────────────────────────────────────────────────

let tempDir = null;
let server = null;
let port = null;
let passed = 0;
let failed = 0;
const failures = [];

// ── Assertion ────────────────────────────────────────────────────────────────

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        failures.push(label);
        console.error(`  ✗ ${label}`);
    }
}

function assertEq(actual, expected, label) {
    const ok = actual === expected;
    assert(ok, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ── Foundation ────────────────────────────────────────────────────────────────

async function createFoundation(dir) {
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'context-types'), { recursive: true });
    await fs.mkdir(path.join(dir, 'collections'), { recursive: true });
    await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(dir, '.phaibel'), { recursive: true });
    await fs.mkdir(path.join(dir, '.trash'), { recursive: true });

    const today = new Date().toISOString().split('T')[0];
    await fs.writeFile(path.join(dir, '.cxms.md'), `---\ntitle: "analytics-test"\ncreated: ${today}\ntags: [context, system, root]\n---\n\n# analytics-test\n`);
    await fs.writeFile(
        path.join(dir, '.phaibel', 'entity-types.json'),
        JSON.stringify({ version: 1, entityTypes: [] }, null, 2),
    );
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function restRequest(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        const bodyStr = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
            },
        };
        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                try {
                    resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
                } catch {
                    resolve({ status: res.statusCode, body: raw });
                }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// Send a JSON-RPC request to /mcp, handles both JSON and SSE responses.
async function mcpRequest(payload, sessionId = null) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(payload);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
            'Accept': 'application/json, text/event-stream',
        };
        if (sessionId) headers['mcp-session-id'] = sessionId;

        const opts = { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers };
        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                const ct = res.headers['content-type'] || '';
                const returnedSession = res.headers['mcp-session-id'] || null;
                let parsed = null;

                if (ct.includes('text/event-stream')) {
                    // SSE: pick the first data: line that carries result or error
                    for (const line of raw.split('\n')) {
                        if (line.startsWith('data: ')) {
                            try {
                                const obj = JSON.parse(line.slice(6));
                                if (obj.result !== undefined || obj.error !== undefined) {
                                    parsed = obj;
                                    break;
                                }
                            } catch { /* skip */ }
                        }
                    }
                } else {
                    try { parsed = JSON.parse(raw); } catch { /* skip */ }
                }

                resolve({ status: res.statusCode, body: parsed, sessionId: returnedSession });
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

// MCP initialize — each MCP request gets a fresh transport (stateless mode), so no
// session management or notifications/initialized handshake is needed.
async function mcpInitialize() {
    const res = await mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'analytics-test', version: '1.0' },
        },
    });
    return { result: res.body?.result, sessionId: res.sessionId };
}

// Call a single MCP tool and return the parsed result content.
async function mcpToolCall(toolName, args, sessionId = null) {
    const res = await mcpRequest({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
    }, sessionId);

    const content = res.body?.result?.content;
    if (!content || !content[0]) return { raw: res.body, data: null };
    try {
        return { raw: res.body, data: JSON.parse(content[0].text) };
    } catch {
        return { raw: res.body, data: content[0].text };
    }
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

async function startServer(foundationDir) {
    const srv = http.createServer(async (req, res) => {
        // Reset singletons so every request sees the correct isolated state.
        resetFoundationRoot();
        resetEntityIndex();
        invalidateEntityTypeCache();
        setPlatform(createNodePlatform());
        setFoundationRoot(foundationDir);
        setAuthEnabled(false);

        const index = getEntityIndex();
        if (!index.isBuilt) await index.build();

        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname.startsWith('/cx/')) {
            await handleCxRoute(req, res, url);
        } else if (url.pathname === '/mcp') {
            // StreamableHTTPServerTransport is designed for single long-lived connections.
            // Reset it before each request so every MCP call gets a fresh transport
            // that handles the full JSON-RPC exchange independently (stateless mode).
            resetMcpServer();
            await handleMcpRoute(req, res);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });

    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    return srv;
}

// ── Seed data ─────────────────────────────────────────────────────────────────

async function seedData() {
    // Create two types
    await restRequest('POST', '/cx/context-types', {
        name: 'task',
        plural: 'tasks',
        directory: 'context-types/task',
        description: 'A task to complete',
        fields: [
            { key: 'status', type: 'enum', values: ['open', 'done'], required: true },
            { key: 'priority', type: 'enum', values: ['low', 'medium', 'high'] },
        ],
    });
    await restRequest('POST', '/cx/context-types', {
        name: 'note',
        plural: 'notes',
        directory: 'context-types/note',
        description: 'A freeform note',
        fields: [{ key: 'category', type: 'string' }],
    });

    // Create 3 tasks
    const tasks = [
        { title: 'Write tests', status: 'open', priority: 'high', content: 'Cover all analytics endpoints.' },
        { title: 'Review PR', status: 'open', priority: 'medium', content: 'Review the analytics PR.' },
        { title: 'Deploy server', status: 'done', priority: 'low', content: 'Deploy to production.' },
    ];
    const taskIds = [];
    for (const t of tasks) {
        const res = await restRequest('POST', '/cx/context-types/task', t);
        if (res.body?.id) taskIds.push(res.body.id);
    }

    // Create 2 notes
    const notes = [
        { title: 'Architecture notes', category: 'design', content: 'BM25 + inverted index.' },
        { title: 'Meeting notes', category: 'meetings', content: 'Discussed analytics feature.' },
    ];
    const noteIds = [];
    for (const n of notes) {
        const res = await restRequest('POST', '/cx/context-types/note', n);
        if (res.body?.id) noteIds.push(res.body.id);
    }

    return { taskIds, noteIds };
}

// ── Test suites ───────────────────────────────────────────────────────────────

async function testRestAnalytics(taskIds, noteIds) {
    console.log('\n── REST: GET /cx/analytics ──');

    const res = await restRequest('GET', '/cx/analytics');
    const a = res.body;

    assert(res.status === 200, 'returns HTTP 200');
    assert(typeof a === 'object' && a !== null, 'response body is an object');
    assert(typeof a.foundation === 'string' && a.foundation.length > 0, 'foundation path is a non-empty string');
    assert(a.foundation === tempDir, `foundation matches temp dir`);

    // Files and bytes
    assert(Number.isInteger(a.totalFiles) && a.totalFiles > 0, `totalFiles is positive integer (${a.totalFiles})`);
    assert(Number.isInteger(a.totalBytes) && a.totalBytes > 0, `totalBytes is positive integer (${a.totalBytes})`);
    assert(typeof a.totalBytesFormatted === 'string' && /\d+(\.\d+)? (B|KB|MB|GB)/.test(a.totalBytesFormatted),
        `totalBytesFormatted is human-readable (${a.totalBytesFormatted})`);

    // Trash starts empty
    assertEq(a.trashFiles, 0, 'trashFiles is 0 before any deletes');
    assert(Number.isInteger(a.trashBytes) && a.trashBytes === 0, 'trashBytes is 0 before any deletes');

    // Context types
    assertEq(a.contextTypes.count, 2, 'contextTypes.count is 2');
    assert(Array.isArray(a.contextTypes.types), 'contextTypes.types is an array');
    assertEq(a.contextTypes.types.length, 2, 'contextTypes.types has 2 entries');

    const taskType = a.contextTypes.types.find(t => t.name === 'task');
    const noteType = a.contextTypes.types.find(t => t.name === 'note');

    assert(taskType !== undefined, 'task type present in analytics');
    assert(noteType !== undefined, 'note type present in analytics');
    assertEq(taskType?.nodes, 3, 'task type has 3 nodes');
    assertEq(noteType?.nodes, 2, 'note type has 2 nodes');
    assert(Number.isInteger(taskType?.bytes) && taskType?.bytes > 0, `task type bytes > 0 (${taskType?.bytes})`);
    assert(Number.isInteger(noteType?.bytes) && noteType?.bytes > 0, `note type bytes > 0 (${noteType?.bytes})`);

    // totalBytes must exceed the sum of type bytes (there are also .cxms.md, entity-types.json, etc.)
    const typeBytesSum = (taskType?.bytes ?? 0) + (noteType?.bytes ?? 0);
    assert(a.totalBytes >= typeBytesSum, `totalBytes (${a.totalBytes}) ≥ sum of type bytes (${typeBytesSum})`);

    return a;
}

async function testRestAnalyticsAfterDelete(taskIds, beforeAnalytics) {
    console.log('\n── REST: analytics after soft-delete ──');

    assert(taskIds.length > 0, 'have a task ID to delete');
    const idToDelete = taskIds[0];

    const del = await restRequest('DELETE', `/cx/context-types/task/${idToDelete}`);
    assert(del.status === 200, `DELETE /cx/context-types/task/${idToDelete} returns 200`);

    const res = await restRequest('GET', '/cx/analytics');
    const a = res.body;

    assert(res.status === 200, 'analytics still returns 200 after delete');
    assertEq(a.trashFiles, 1, 'trashFiles is 1 after soft-delete');
    assert(a.trashBytes > 0, `trashBytes > 0 after soft-delete (${a.trashBytes})`);

    const taskType = a.contextTypes.types.find(t => t.name === 'task');
    assertEq(taskType?.nodes, 2, 'task type drops to 2 nodes after delete');

    // totalFiles should decrease by 1 (moved to trash, not counted in main)
    assert(a.totalFiles < beforeAnalytics.totalFiles, `totalFiles decreased (${a.totalFiles} < ${beforeAnalytics.totalFiles})`);
}

async function testRestAnalyticsConsistency() {
    console.log('\n── REST: analytics consistency ──');

    // Two rapid calls should return identical counts
    const [r1, r2] = await Promise.all([
        restRequest('GET', '/cx/analytics'),
        restRequest('GET', '/cx/analytics'),
    ]);
    assertEq(r1.body?.totalFiles, r2.body?.totalFiles, 'concurrent calls: totalFiles matches');
    assertEq(r1.body?.contextTypes?.count, r2.body?.contextTypes?.count, 'concurrent calls: type count matches');

    // Verify against node count endpoint for each type
    const countTask = await restRequest('GET', '/cx/context-types/task/count');
    const countNote = await restRequest('GET', '/cx/context-types/note/count');
    const a = r1.body;

    const taskType = a?.contextTypes?.types?.find(t => t.name === 'task');
    const noteType = a?.contextTypes?.types?.find(t => t.name === 'note');

    assertEq(taskType?.nodes, countTask.body?.count, `analytics task nodes matches /count endpoint (${taskType?.nodes})`);
    assertEq(noteType?.nodes, countNote.body?.count, `analytics note nodes matches /count endpoint (${noteType?.nodes})`);
}

async function testMcpAnalytics(restAnalytics) {
    console.log('\n── MCP: get_analytics ──');

    // Initialize
    const { result: initResult, sessionId } = await mcpInitialize();
    assert(initResult !== undefined, 'MCP initialize returns a result');
    assert(typeof initResult?.serverInfo?.name === 'string', `MCP server name present (${initResult?.serverInfo?.name})`);

    // List tools — verify get_analytics is listed
    const toolsRes = await mcpRequest({
        jsonrpc: '2.0', id: 10, method: 'tools/list', params: {},
    }, sessionId);
    const tools = toolsRes.body?.result?.tools ?? [];
    assert(Array.isArray(tools), 'tools/list returns an array');
    const analyticsTool = tools.find(t => t.name === 'get_analytics');
    assert(analyticsTool !== undefined, 'get_analytics tool is registered');
    assert(typeof analyticsTool?.description === 'string', 'get_analytics tool has a description');

    // Call get_analytics
    const { raw, data } = await mcpToolCall('get_analytics', {}, sessionId);
    assert(raw?.result !== undefined && raw?.error === undefined, 'get_analytics MCP call succeeds (no error)');
    assert(typeof data === 'object' && data !== null, 'get_analytics returns an object');

    // Structural checks
    assert(typeof data?.foundation === 'string', `MCP: foundation is a string (${data?.foundation})`);
    assert(data?.foundation === tempDir, 'MCP: foundation matches temp dir');
    assert(Number.isInteger(data?.totalFiles) && data?.totalFiles > 0, `MCP: totalFiles positive (${data?.totalFiles})`);
    assert(Number.isInteger(data?.totalBytes) && data?.totalBytes > 0, `MCP: totalBytes positive (${data?.totalBytes})`);
    assert(typeof data?.totalBytesFormatted === 'string', 'MCP: totalBytesFormatted is a string');
    assert(Number.isInteger(data?.contextTypes?.count), 'MCP: contextTypes.count is an integer');
    assert(Array.isArray(data?.contextTypes?.types), 'MCP: contextTypes.types is an array');

    // Both REST and MCP report the same type count
    assertEq(data?.contextTypes?.count, 2, 'MCP: contextTypes.count is 2');

    const mcpTask = data?.contextTypes?.types?.find(t => t.name === 'task');
    const mcpNote = data?.contextTypes?.types?.find(t => t.name === 'note');
    assert(mcpTask !== undefined, 'MCP: task type present');
    assert(mcpNote !== undefined, 'MCP: note type present');
    assertEq(mcpNote?.nodes, 2, 'MCP: note type has 2 nodes (unchanged)');
    assert(Number.isInteger(mcpTask?.nodes) && mcpTask?.nodes >= 1, `MCP: task type has ≥1 nodes (${mcpTask?.nodes})`);

    // Verify MCP and REST agree on note count (notes were not deleted)
    const restNow = await restRequest('GET', '/cx/analytics');
    assertEq(data?.contextTypes?.types?.find(t => t.name === 'note')?.nodes,
        restNow.body?.contextTypes?.types?.find(t => t.name === 'note')?.nodes,
        'MCP and REST agree on note node count');
    assertEq(data?.totalFiles, restNow.body?.totalFiles,
        'MCP and REST totalFiles are identical');
}

async function testRestEdgeCases() {
    console.log('\n── REST: edge cases ──');

    // Analytics is unauthenticated? No — it requires auth, and auth is disabled.
    // Verify it doesn't appear in health (health is unauthenticated, analytics is not).
    const health = await restRequest('GET', '/cx/health');
    assert(health.status === 200, 'health still returns 200');
    assert(health.body?.contextTypes === 2, `health shows contextTypes count = 2 (${health.body?.contextTypes})`);

    // Non-existent type returns 404 via the router (not a missing route)
    const notFound = await restRequest('GET', '/cx/context-types/does-not-exist/count');
    assert(notFound.status === 404, '/count for unknown type returns 404');

    // totalFiles includes the .cxms.md root marker and config files
    const a = (await restRequest('GET', '/cx/analytics')).body;
    assert(a.totalFiles >= 5, `totalFiles ≥ 5 (foundation files + nodes; got ${a.totalFiles})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const startTime = Date.now();

    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  CxMS Analytics Integration Test                    ║');
    console.log('║  REST /cx/analytics + MCP get_analytics             ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Create temp foundation
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cxms-analytics-test-'));
    await createFoundation(tempDir);
    console.log(`Temp dir : ${tempDir}`);

    // Seed entity types via direct API (before server starts — avoids index-not-built race)
    resetFoundationRoot();
    resetEntityIndex();
    invalidateEntityTypeCache();
    setPlatform(createNodePlatform());
    setFoundationRoot(tempDir);

    try {
        // Start server on a random available port
        server = await startServer(tempDir);
        port = server.address().port;
        console.log(`Port     : ${port}`);
        console.log(`Protocol : HTTP + MCP/StreamableHTTP\n`);

        // Seed nodes via REST
        console.log('── Seeding foundation with types and nodes ──');
        const { taskIds, noteIds } = await seedData();
        console.log(`  Created 3 tasks (ids: ${taskIds.join(', ')})`);
        console.log(`  Created 2 notes (ids: ${noteIds.join(', ')})`);

        // Run test suites
        const restAnalytics = await testRestAnalytics(taskIds, noteIds);
        await testRestAnalyticsAfterDelete(taskIds, restAnalytics);
        await testRestAnalyticsConsistency();
        await testMcpAnalytics(restAnalytics);
        await testRestEdgeCases();

    } finally {
        // Tear down server
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        // Reset all singletons
        resetMcpServer();
        resetEntityIndex();
        resetFoundationRoot();
        invalidateEntityTypeCache();

        // Remove temp dir — verify no trace
        await fs.rm(tempDir, { recursive: true, force: true });
        const stillExists = await fs.access(tempDir).then(() => true).catch(() => false);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        const total = passed + failed;

        console.log('\n══════════════════════════════════════════════════════');
        console.log('  Test Summary');
        console.log('══════════════════════════════════════════════════════');
        console.log(`  Temp dir  : ${tempDir}  ${stillExists ? '(WARNING: not removed)' : '(removed ✓)'}`);
        console.log(`  Port      : ${port}`);
        console.log(`  Total     : ${total}`);
        console.log(`  Passed    : ${passed}`);
        console.log(`  Failed    : ${failed}`);
        console.log(`  Duration  : ${elapsed}s`);
        if (failures.length > 0) {
            console.log('\n  Failed assertions:');
            for (const f of failures) console.error(`    ✗ ${f}`);
        }
        console.log('══════════════════════════════════════════════════════\n');
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('\nFatal error:', err);
    if (server) server.close();
    if (tempDir) fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
});
