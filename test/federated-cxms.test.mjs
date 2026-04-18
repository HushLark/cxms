#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Federated CxMS Integration Test
// ─────────────────────────────────────────────────────────────────────────────
// Starts 3 standalone CxMS servers, each with its own Foundation, then
// performs full CRUD operations on each to verify federated read/write.
//
// Usage: node test/federated-cxms.test.mjs
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
    setAuthEnabled,
    getEntityIndex,
    resetEntityIndex,
    addEntityType,
    loadEntityTypes,
    invalidateEntityTypeCache,
    resetPlatform,
} from '../dist/index.js';

// ── Config ──────────────────────────────────────────────────────────────────

const SERVERS = [
    { name: 'work',     port: 4001 },
    { name: 'personal', port: 4002 },
    { name: 'shared',   port: 4003 },
];

const TYPES_PER_SERVER = {
    work:     { name: 'project',  plural: 'projects',  fields: [
        { key: 'status', type: 'enum', values: ['active', 'paused', 'done'], required: true },
        { key: 'client', type: 'string', label: 'Client Name' },
    ]},
    personal: { name: 'bookmark', plural: 'bookmarks', fields: [
        { key: 'url', type: 'string', required: true },
        { key: 'category', type: 'string' },
    ]},
    shared:   { name: 'contact',  plural: 'contacts',  fields: [
        { key: 'email', type: 'string', required: true },
        { key: 'company', type: 'string' },
    ]},
};

let tempDir;
let servers = [];
let passed = 0;
let failed = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${msg}`);
    } else {
        failed++;
        console.error(`  ✗ ${msg}`);
    }
}

async function httpRequest(port, method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers });
                } catch {
                    resolve({ status: res.statusCode, body: data, headers: res.headers });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ── Foundation Setup ────────────────────────────────────────────────────────

async function createFoundation(name) {
    const dir = path.join(tempDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'context-types'), { recursive: true });
    await fs.mkdir(path.join(dir, 'collections'), { recursive: true });
    await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(dir, '.phaibel'), { recursive: true });

    const today = new Date().toISOString().split('T')[0];
    await fs.writeFile(path.join(dir, '.cxms.md'), `---
title: "${name}"
created: ${today}
tags: [context, system, root]
---

# ${name} Foundation

Test foundation for federated CxMS.
`);

    // Write empty entity-types.json
    await fs.writeFile(
        path.join(dir, '.phaibel', 'entity-types.json'),
        JSON.stringify({ version: 1, entityTypes: [] }, null, 2),
    );

    return dir;
}

// ── Server Lifecycle ────────────────────────────────────────────────────────

async function startServer(name, port, foundationDir) {
    // Each server gets its own isolated context by re-initializing CxMS state
    // Since CxMS uses global singletons, we need to set up per-request routing
    // that switches the foundation root. For the test, each server is its own
    // process-like scope.

    const server = http.createServer(async (req, res) => {
        // Switch CxMS to this server's foundation for each request
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
            return;
        }

        if (url.pathname === '/mcp') {
            await handleMcpRoute(req, res);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(`  Started ${name} CxMS on port ${port} → ${foundationDir}`);
    return server;
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function testHealth(name, port) {
    const res = await httpRequest(port, 'GET', '/cx/health');
    assert(res.status === 200, `${name}: health returns 200`);
    assert(res.body.status === 'ok', `${name}: health status is ok`);
    assert(res.body.foundation !== null, `${name}: foundation path set`);
}

async function testCreateType(name, port, typeConfig) {
    const res = await httpRequest(port, 'POST', '/cx/context-types', {
        name: typeConfig.name,
        plural: typeConfig.plural,
        directory: `context-types/${typeConfig.name}`,
        description: `${typeConfig.plural} for ${name}`,
        fields: typeConfig.fields,
    });
    assert(res.status === 201 || res.status === 200, `${name}: create type ${typeConfig.name} — ${res.status}`);

    // Verify type exists
    const list = await httpRequest(port, 'GET', '/cx/context-types');
    assert(list.status === 200, `${name}: list types returns 200`);
    const types = list.body?.types || [];
    const found = Array.isArray(types) && types.some(t => t.name === typeConfig.name);
    assert(found, `${name}: type ${typeConfig.name} exists in list`);
}

const REQUIRED_FIELDS = {
    project:  { status: 'active' },
    bookmark: { url: 'https://example.com' },
    contact:  { email: 'test@example.com' },
};

async function testCRUDNodes(name, port, typeName) {
    // CREATE
    const createRes = await httpRequest(port, 'POST', `/cx/context-types/${typeName}`, {
        title: `Test ${typeName} from ${name}`,
        tags: ['test', name],
        content: `Created by federated test on ${name}`,
        ...(REQUIRED_FIELDS[typeName] || {}),
    });
    assert(createRes.status === 201 || createRes.status === 200, `${name}: create ${typeName} node — ${createRes.status}`);
    const nodeId = createRes.body?.id || createRes.body?.node?.id;
    assert(nodeId, `${name}: got node ID back: ${nodeId}`);

    // READ (list)
    const listRes = await httpRequest(port, 'GET', `/cx/context-types/${typeName}`);
    assert(listRes.status === 200, `${name}: list ${typeName} nodes — 200`);
    const nodes = listRes.body?.nodes || [];
    assert(Array.isArray(nodes) && nodes.length > 0, `${name}: has ${typeName} nodes`);

    // READ (single)
    if (nodeId) {
        const getRes = await httpRequest(port, 'GET', `/cx/context-types/${typeName}/${nodeId}`);
        assert(getRes.status === 200, `${name}: get node ${nodeId} — 200`);
        assert(getRes.body?.title?.includes('Test'), `${name}: node title correct`);
    }

    // UPDATE
    if (nodeId) {
        const updateRes = await httpRequest(port, 'PUT', `/cx/context-types/${typeName}/${nodeId}`, {
            tags: ['test', name, 'updated'],
            content: `Updated by federated test`,
        });
        assert(updateRes.status === 200, `${name}: update node — ${updateRes.status}`);

        // Verify update
        const verifyRes = await httpRequest(port, 'GET', `/cx/context-types/${typeName}/${nodeId}`);
        const tags = verifyRes.body?.tags || [];
        assert(tags.includes('updated'), `${name}: node has 'updated' tag after update`);
    }

    // SEARCH
    const searchRes = await httpRequest(port, 'POST', '/cx/search', {
        query: `Test ${typeName}`,
    });
    assert(searchRes.status === 200, `${name}: search returns 200`);
    const searchResults = searchRes.body?.results || [];
    assert(Array.isArray(searchResults) && searchResults.length > 0, `${name}: search finds results`);

    // COUNT
    const countRes = await httpRequest(port, 'GET', `/cx/context-types/${typeName}/count`);
    assert(countRes.status === 200, `${name}: count returns 200`);

    // DELETE
    if (nodeId) {
        const deleteRes = await httpRequest(port, 'DELETE', `/cx/context-types/${typeName}/${nodeId}`);
        assert(deleteRes.status === 200, `${name}: delete node — ${deleteRes.status}`);

        // Verify deleted
        const afterDelete = await httpRequest(port, 'GET', `/cx/context-types/${typeName}/${nodeId}`);
        assert(afterDelete.status === 404, `${name}: node gone after delete — ${afterDelete.status}`);
    }

    return nodeId;
}

async function testCrossServerIsolation() {
    console.log('\n── Cross-server isolation ──');

    // Create a node on server 1
    const createRes = await httpRequest(4001, 'POST', '/cx/context-types/project', {
        title: 'Isolation test project',
        tags: ['isolation'],
        status: 'active',
        content: 'Isolation test content',
    });
    assert(createRes.status === 201 || createRes.status === 200, 'work: create isolation test node');

    // Verify it does NOT appear on server 2 or 3
    const search2 = await httpRequest(4002, 'POST', '/cx/search', { query: 'Isolation test' });
    const search3 = await httpRequest(4003, 'POST', '/cx/search', { query: 'Isolation test' });
    const results2 = search2.body?.results || [];
    const results3 = search3.body?.results || [];
    assert(
        results2.length === 0,
        'personal: isolation node NOT visible',
    );
    assert(
        results3.length === 0,
        'shared: isolation node NOT visible',
    );
}

async function testMultiServerRead() {
    console.log('\n── Multi-server read (simulated federation) ──');

    // Create distinct data on each server
    await httpRequest(4001, 'POST', '/cx/context-types/project', {
        title: 'Alpha Launch', tags: ['launch'], status: 'active',
    });
    await httpRequest(4002, 'POST', '/cx/context-types/bookmark', {
        title: 'TypeScript Docs', tags: ['docs'], url: 'https://typescriptlang.org',
    });
    await httpRequest(4003, 'POST', '/cx/context-types/contact', {
        title: 'Alice Chen', tags: ['engineering'], email: 'alice@example.com',
    });

    // A "federated read" — query each server sequentially (shared-process singletons)
    const results = [];
    for (const s of SERVERS) {
        const res = await httpRequest(s.port, 'GET', '/cx/health');
        const types = await httpRequest(s.port, 'GET', '/cx/context-types');
        const typesList = types.body?.types || [];
        const typeNames = Array.isArray(typesList) ? typesList.map(t => t.name) : [];
        let totalNodes = 0;
        for (const t of typeNames) {
            const count = await httpRequest(s.port, 'GET', `/cx/context-types/${t}/count`);
            totalNodes += count.body?.count || 0;
        }
        results.push({ name: s.name, port: s.port, types: typeNames, totalNodes });
    }

    for (const r of results) {
        assert(r.types.length > 0, `${r.name}: has ${r.types.length} types (${r.types.join(', ')})`);
        assert(r.totalNodes > 0, `${r.name}: has ${r.totalNodes} total nodes`);
        console.log(`    ${r.name} → ${r.types.join(', ')} (${r.totalNodes} nodes)`);
    }

    // Verify each server has ONLY its own type
    assert(results[0].types.includes('project'), 'work has project type');
    assert(!results[0].types.includes('bookmark'), 'work does NOT have bookmark type');
    assert(results[1].types.includes('bookmark'), 'personal has bookmark type');
    assert(!results[1].types.includes('project'), 'personal does NOT have project type');
    assert(results[2].types.includes('contact'), 'shared has contact type');
    assert(!results[2].types.includes('bookmark'), 'shared does NOT have bookmark type');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  Federated CxMS Integration Test                    ║');
    console.log('║  3 CxMS servers × full CRUD + isolation + federation║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Setup temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cxms-fed-test-'));
    console.log(`Temp dir: ${tempDir}\n`);

    setPlatform(createNodePlatform());
    setAuthEnabled(false);

    try {
        // Create foundations
        console.log('── Creating foundations ──');
        const foundations = {};
        for (const s of SERVERS) {
            foundations[s.name] = await createFoundation(s.name);
        }

        // Create context types on each foundation (need to switch root for each)
        console.log('\n── Seeding context types ──');
        for (const s of SERVERS) {
            resetFoundationRoot();
            resetEntityIndex();
            invalidateEntityTypeCache();
            setFoundationRoot(foundations[s.name]);
            const typeConfig = TYPES_PER_SERVER[s.name];
            await addEntityType({
                name: typeConfig.name,
                plural: typeConfig.plural,
                directory: `context-types/${typeConfig.name}`,
                description: `${typeConfig.plural} for ${s.name}`,
                fields: typeConfig.fields,
            });
            console.log(`  ${s.name}: created type '${typeConfig.name}'`);
        }

        // Start servers
        console.log('\n── Starting servers ──');
        for (const s of SERVERS) {
            const server = await startServer(s.name, s.port, foundations[s.name]);
            servers.push(server);
        }

        // Run tests
        console.log('\n── Health checks ──');
        for (const s of SERVERS) {
            await testHealth(s.name, s.port);
        }

        console.log('\n── Verify types via API ──');
        for (const s of SERVERS) {
            const typeConfig = TYPES_PER_SERVER[s.name];
            const list = await httpRequest(s.port, 'GET', '/cx/context-types');
            const types = list.body?.types || [];
            const found = Array.isArray(types) && types.some(t => t.name === typeConfig.name);
            assert(found, `${s.name}: type '${typeConfig.name}' visible via API`);
        }

        console.log('\n── CRUD on each server ──');
        for (const s of SERVERS) {
            const typeConfig = TYPES_PER_SERVER[s.name];
            console.log(`\n  [${s.name}] — ${typeConfig.name}`);
            await testCRUDNodes(s.name, s.port, typeConfig.name);
        }

        await testCrossServerIsolation();
        await testMultiServerRead();

        // Summary
        console.log('\n══════════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed`);
        console.log('══════════════════════════════════════════════════════\n');

    } finally {
        // Cleanup
        console.log('Cleaning up...');
        for (const s of servers) {
            s.close();
        }
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    for (const s of servers) s.close();
    process.exit(1);
});
