#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// cxms — Headless CxMS server
// ─────────────────────────────────────────────────────────────────────────────
// Usage:
//   cxms                          Start with config from ~/.cxms/config.json
//   cxms --port 4000              Override port
//   cxms --foundation /path/to/f  Override foundation root
//   cxms --no-auth                Disable bearer token authentication
//   cxms init                     Initialize a new Foundation in the current directory
//   cxms token                    Print the bearer token
//   cxms token --regenerate       Generate a new bearer token
// ─────────────────────────────────────────────────────────────────────────────

import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { setPlatform } from './platform/index.js';
import { createNodePlatform } from './platform/node.js';
import { setFoundationRoot, findFoundationRoot } from './foundation.js';
import {
    initFromSystemConfig,
    saveSystemConfig,
    loadBearerToken,
    regenerateToken,
    loadSystemConfig,
} from './server/system-config.js';
import { handleCxRoute } from './server/cx-router.js';
import { handleMcpRoute } from './server/mcp-server.js';
import { setAuthEnabled } from './server/auth.js';
import { getEntityIndex } from './index/entity-index.js';
import { FOUNDATION_MARKER } from './types.js';

const DEFAULT_PORT = 3800;

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
    command?: string;
    port?: number;
    foundation?: string;
    noAuth: boolean;
    regenerate: boolean;
} {
    const args = argv.slice(2);
    const result: ReturnType<typeof parseArgs> = { noAuth: false, regenerate: false };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === 'init' || arg === 'token') {
            result.command = arg;
        } else if (arg === '--port' || arg === '-p') {
            result.port = parseInt(args[++i], 10);
        } else if (arg === '--foundation' || arg === '-f') {
            result.foundation = args[++i];
        } else if (arg === '--no-auth') {
            result.noAuth = true;
        } else if (arg === '--regenerate') {
            result.regenerate = true;
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }
    }

    return result;
}

function printHelp(): void {
    console.log(`
cxms — Context Management System server

Usage:
  cxms                              Start the server
  cxms init                         Initialize a Foundation in the current directory
  cxms token                        Print the bearer token
  cxms token --regenerate           Generate a new bearer token

Options:
  --port, -p <port>                 Port to listen on (default: 3800)
  --foundation, -f <path>           Foundation root directory
  --no-auth                         Disable bearer token authentication
  --help, -h                        Show this help

Configuration:
  ~/.cxms/config.json               { "foundationRoot": "/path", "port": 3800 }
  ~/.cxms/token                     Bearer token (auto-generated)

Endpoints:
  GET  /cx/health                   Health check (no auth)
  *    /cx/*                        REST API (bearer token required)
  *    /mcp                         MCP tool server
`);
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdInit(): Promise<void> {
    const cwd = process.cwd();
    const markerPath = path.join(cwd, FOUNDATION_MARKER);

    try {
        await fs.access(markerPath);
        console.log(`Foundation already exists at ${cwd}`);
        return;
    } catch { /* good, doesn't exist */ }

    const name = path.basename(cwd);
    const today = new Date().toISOString().split('T')[0];

    const rootContext = `---
title: "${name}"
created: ${today}
tags: [context, system, root]
---

# ${name}

This Foundation is managed by CxMS (Context Management System).
Content is stored as Markdown files with YAML frontmatter, organised by context type.
`;

    await fs.writeFile(markerPath, rootContext);

    // Create directories
    const dirs = ['context-types', 'collections', 'logs', '.phaibel'];
    for (const dir of dirs) {
        await fs.mkdir(path.join(cwd, dir), { recursive: true });
    }

    // Save to system config
    await saveSystemConfig({ ...(await loadSystemConfig()), foundationRoot: cwd });

    console.log(`Foundation created at ${cwd}`);
    console.log(`\nCreated:`);
    console.log(`  ${FOUNDATION_MARKER}        Root context`);
    console.log(`  context-types/       Context type schemas`);
    console.log(`  collections/         Key-value collections`);
    console.log(`  logs/                Access & error logs`);
    console.log(`\nNo context types created — add them via the API or MCP.`);
    console.log(`Start the server with: cxms`);
}

async function cmdToken(regenerate: boolean): Promise<void> {
    setPlatform(createNodePlatform());
    if (regenerate) {
        const token = await regenerateToken();
        console.log(`New token generated:\n${token}`);
    } else {
        const token = await loadBearerToken();
        console.log(token);
    }
}

// ── Server ──────────────────────────────────────────────────────────────────

async function startServer(opts: {
    port?: number;
    foundation?: string;
    noAuth: boolean;
}): Promise<void> {
    setPlatform(createNodePlatform());

    // Load system config
    const config = await initFromSystemConfig();

    // CLI overrides
    if (opts.foundation) {
        setFoundationRoot(opts.foundation);
    }
    if (opts.noAuth) {
        setAuthEnabled(false);
    }

    const port = opts.port || config.port || DEFAULT_PORT;

    // Verify foundation root is set
    const root = findFoundationRoot();
    if (!root) {
        console.error('Error: No foundation root configured.');
        console.error('Either:');
        console.error('  1. Run "cxms init" in your foundation directory');
        console.error('  2. Set foundationRoot in ~/.cxms/config.json');
        console.error('  3. Use --foundation /path/to/foundation');
        process.exit(1);
    }

    // Verify foundation exists
    try {
        await fs.access(path.join(root, FOUNDATION_MARKER));
    } catch {
        console.error(`Error: ${root} is not a Foundation (missing ${FOUNDATION_MARKER})`);
        process.exit(1);
    }

    // Build search index
    console.log(`Foundation: ${root}`);
    console.log('Building index...');
    const index = getEntityIndex();
    await index.build();
    const stats = index.getStats();
    console.log(`Indexed ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);

    // Get token for display
    let token: string | null = null;
    if (!opts.noAuth) {
        token = await loadBearerToken();
    }

    // Start HTTP server
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        // REST API
        if (url.pathname.startsWith('/cx/')) {
            await handleCxRoute(req, res, url);
            return;
        }

        // MCP server
        if (url.pathname === '/mcp') {
            await handleMcpRoute(req, res);
            return;
        }

        // Root — redirect to health
        if (url.pathname === '/') {
            res.writeHead(302, { Location: '/cx/health' });
            res.end();
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, () => {
        console.log(`\nCxMS listening on http://localhost:${port}`);
        console.log(`  REST API:  http://localhost:${port}/cx/health`);
        console.log(`  MCP:       http://localhost:${port}/mcp`);
        if (token) {
            console.log(`  Token:     ${token.slice(0, 10)}...`);
        } else {
            console.log(`  Auth:      disabled`);
        }
    });

    // Graceful shutdown
    const shutdown = () => {
        console.log('\nShutting down...');
        server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// ── Main ────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv);

if (opts.command === 'init') {
    cmdInit().catch(err => { console.error(err); process.exit(1); });
} else if (opts.command === 'token') {
    cmdToken(opts.regenerate).catch(err => { console.error(err); process.exit(1); });
} else {
    startServer(opts).catch(err => { console.error(err); process.exit(1); });
}
