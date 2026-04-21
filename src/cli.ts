#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// cxms / phaibel — Context Management System + Phaibel personal agent
// ─────────────────────────────────────────────────────────────────────────────
// Usage (cxms):
//   cxms                          Start with config from ~/.cxms/config.json
//   cxms --port 4000              Override port
//   cxms --foundation /path/to/f  Override foundation root
//   cxms --no-auth                Disable bearer token authentication
//   cxms init                     Initialize a new Foundation in the current directory
//   cxms onboard                  Run the first-time setup interview
//   cxms token                    Print the bearer token
//   cxms token --regenerate       Generate a new bearer token
//
// Usage (phaibel):
//   phaibel init                  First-time setup — choose vault location + interview
//   phaibel start                 Start the server in the background
//   phaibel stop                  Stop the background server
//   phaibel restart               Restart the background server
//   phaibel status                Show whether the server is running
//   phaibel token                 Print the bearer token
// ─────────────────────────────────────────────────────────────────────────────

import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { setPlatform } from './platform/index.js';
import { createNodePlatform } from './platform/node.js';
import { setFoundationRoot, findFoundationRoot } from './foundation.js';
import { runInteractiveInterview, runOnboarding, getOnboardingStatus } from './onboarding/index.js';
import {
    initFromSystemConfig,
    saveSystemConfig,
    loadBearerToken,
    regenerateToken,
    loadSystemConfig,
    setInstanceIdentity,
    getInstanceIdentity,
} from './server/system-config.js';
import { handleCxRoute } from './server/cx-router.js';
import { handleMcpRoute } from './server/mcp-server.js';
import { setAuthEnabled } from './server/auth.js';
import { getEntityIndex } from './index/entity-index.js';
import { FOUNDATION_MARKER } from './types.js';
import {
    loadKeys, setKey, removeKey, maskKey, promptKey,
    VENDORS, type Vendor,
} from './server/keys-config.js';
import {
    loadModels, saveModels, setModel,
    SUITES, MODEL_ROLES, type ModelRole,
} from './server/models-config.js';

const DEFAULT_PORT = 3800;
const IS_PHAIBEL = path.basename(process.argv[1] || '').startsWith('phaibel');

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
    command?: string;
    port?: number;
    foundation?: string;
    noAuth: boolean;
    regenerate: boolean;
    server: boolean;
    name?: string;
    description?: string;
} {
    const args = argv.slice(2);
    const result: ReturnType<typeof parseArgs> = { noAuth: false, regenerate: false, server: false };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (
            arg === 'init' || arg === 'token' || arg === 'onboard' || arg === 'phaibel-init' ||
            arg === 'start' || arg === 'stop' || arg === 'restart' || arg === 'status' ||
            arg === 'keys' || arg === 'models'
        ) {
            result.command = arg;
        } else if (arg === '--port' || arg === '-p') {
            result.port = parseInt(args[++i], 10);
        } else if (arg === '--foundation' || arg === '-f') {
            result.foundation = args[++i];
        } else if (arg === '--name' || arg === '-n') {
            result.name = args[++i];
        } else if (arg === '--description' || arg === '-d') {
            result.description = args[++i];
        } else if (arg === '--no-auth') {
            result.noAuth = true;
        } else if (arg === '--regenerate') {
            result.regenerate = true;
        } else if (arg === '--server') {
            result.server = true;
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }
    }

    return result;
}

function printHelp(): void {
    if (IS_PHAIBEL) {
        console.log(`
phaibel — Personal AI agent powered by CxMS

Usage:
  phaibel init                      First-time setup — choose vault location + interview
  phaibel start                     Start the server in the background
  phaibel stop                      Stop the background server
  phaibel restart                   Restart the background server
  phaibel status                    Show whether the server is running
  phaibel token                     Print the bearer token
  phaibel token --regenerate        Generate a new bearer token

API keys:
  phaibel keys                      List configured API keys (masked)
  phaibel keys add <vendor> [key]   Add or update a key (prompts if key omitted)
  phaibel keys remove <vendor>      Remove a key
  Vendors: anthropic, openai, gemini, deepseek

Models:
  phaibel models                    Show current model configuration
  phaibel models use <vendor>       Switch to a vendor's default model suite
  phaibel models set <role> <model> Override a single model role
  Roles: chat, fast, embed

Options:
  --port, -p <port>                 Port to listen on (default: 3800)
  --foundation, -f <path>           Vault directory override
  --no-auth                         Disable bearer token authentication
  --help, -h                        Show this help

Files:
  ~/.cxms/phaibel.pid               PID of the background server process
  ~/.cxms/phaibel.log               Server log output
`);
    } else {
        console.log(`
cxms — Context Management System server

Usage:
  cxms                              Start the server
  cxms init                         Initialize a Foundation in the current directory
  cxms onboard                      Run the first-time setup interview
  cxms token                        Print the bearer token
  cxms token --regenerate           Generate a new bearer token

Options:
  --port, -p <port>                 Port to listen on (default: 3800)
  --foundation, -f <path>           Foundation root directory
  --name, -n <name>                 Instance name (default: Main)
  --description, -d <text>          Instance description
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
}

// ── Daemon helpers ───────────────────────────────────────────────────────────

async function getCxmsDir(): Promise<string> {
    const { default: os } = await import('os');
    const dir = path.join(os.homedir(), '.cxms');
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

async function getRunningPid(): Promise<number | null> {
    try {
        const dir = await getCxmsDir();
        const pidFile = path.join(dir, 'phaibel.pid');
        const pid = parseInt(await fs.readFile(pidFile, 'utf8'), 10);
        process.kill(pid, 0); // throws if not running
        return pid;
    } catch {
        return null;
    }
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

async function cmdPhaibelInit(): Promise<void> {
    setPlatform(createNodePlatform());

    const readline = await import('readline');
    const os = await import('os');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const ask = (q: string) => new Promise<string>(r => rl.question(q, a => r(a.trim())));

    console.log('\n  \x1b[1m\x1b[36mPhaibel\x1b[0m — Personal AI agent\n');
    console.log('  This will set up your vault and personal profile.\n');

    // Pick vault location
    const defaultVault = path.join(os.homedir(), 'Phaibel');
    const vaultInput = await ask(`  Vault location (default: ${defaultVault}): `);
    const vaultDir = path.resolve(vaultInput || defaultVault);
    rl.close();

    // Check if already initialised
    setPlatform(createNodePlatform());
    setFoundationRoot(vaultDir);

    const existing = await getOnboardingStatus();
    if (existing.complete) {
        console.log(`\n  Already set up for \x1b[1m${existing.userName}\x1b[0m (${existing.role}) at ${vaultDir}`);
        console.log(`  Agent: ${existing.agentName}`);
        console.log(`\n  Start with: phaibel start\n`);
        return;
    }

    // Create vault directory if needed
    await fs.mkdir(vaultDir, { recursive: true });
    console.log(`\n  Vault: \x1b[2m${vaultDir}\x1b[0m\n`);

    // Run interview
    const answers = await runInteractiveInterview();

    // Run onboarding
    const result = await runOnboarding(answers, vaultDir);

    // Save foundation root + instance identity to system config
    await saveSystemConfig({
        foundationRoot: vaultDir,
        port: DEFAULT_PORT,
        name: answers.agentName || 'Phaibel',
        description: `${answers.name}'s personal Phaibel agent`,
    });

    const token = await loadBearerToken();

    console.log(`\n  \x1b[32m✓\x1b[0m Vault ready at ${vaultDir}`);
    console.log(`  \x1b[32m✓\x1b[0m Context types: ${result.typesCreated.length > 0 ? result.typesCreated.join(', ') : 'installed'}`);
    console.log(`  \x1b[32m✓\x1b[0m Profiles written\n`);
    console.log(`  Start your agent:\n`);
    console.log(`    \x1b[1mphaibel start\x1b[0m\n`);
    console.log(`  Bearer token (for API / MCP clients):\n`);
    console.log(`    \x1b[2m${token.slice(0, 18)}...\x1b[0m\n`);
}

async function cmdOnboard(): Promise<void> {
    setPlatform(createNodePlatform());

    const cwd = process.cwd();

    // Check existing status
    const existing = await getOnboardingStatus();
    if (existing.complete) {
        console.log(`\nFoundation already set up for ${existing.userName} (${existing.role}).`);
        console.log(`Agent: ${existing.agentName}`);
        console.log(`\nRe-run with a fresh Foundation directory to start over.`);
        return;
    }

    // Run interview
    const answers = await runInteractiveInterview();

    // Determine Foundation directory (use current or configured)
    const foundationDir = findFoundationRoot() || cwd;

    // Run onboarding
    const result = await runOnboarding(answers, foundationDir);

    console.log(`\n  Context types created: ${result.typesCreated.join(', ') || 'none (already existed)'}`);
    console.log(`  Profiles written:      ${result.profilesWritten.join(', ')}`);
    console.log(`\n  Foundation: ${result.foundationPath}`);
    console.log(`\n  Start the server: cxms --foundation ${result.foundationPath}\n`);
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

// ── Keys & models commands (phaibel only) ───────────────────────────────────

async function cmdKeys(args: string[]): Promise<void> {
    const [sub, vendor, keyArg] = args;

    if (!sub || sub === 'list') {
        const keys = await loadKeys();
        const configured = VENDORS.filter(v => keys[v]);
        if (configured.length === 0) {
            console.log('No API keys configured.');
            console.log(`  Add one: phaibel keys add <vendor> [key]`);
            console.log(`  Vendors: ${VENDORS.join(', ')}`);
            return;
        }
        console.log('API keys:');
        for (const v of VENDORS) {
            const k = keys[v];
            console.log(`  ${v.padEnd(12)} ${k ? maskKey(k) : '(not set)'}`);
        }
        return;
    }

    if (sub === 'add') {
        if (!vendor || !VENDORS.includes(vendor as Vendor)) {
            console.error(`Vendor must be one of: ${VENDORS.join(', ')}`);
            process.exit(1);
        }
        const key = keyArg || await promptKey(vendor);
        if (!key) { console.error('No key provided.'); process.exit(1); }
        await setKey(vendor as Vendor, key);
        console.log(`${vendor} key saved.`);
        return;
    }

    if (sub === 'remove') {
        if (!vendor || !VENDORS.includes(vendor as Vendor)) {
            console.error(`Vendor must be one of: ${VENDORS.join(', ')}`);
            process.exit(1);
        }
        await removeKey(vendor as Vendor);
        console.log(`${vendor} key removed.`);
        return;
    }

    console.error(`Unknown subcommand: phaibel keys ${sub}`);
    console.error('Usage: phaibel keys [list | add <vendor> [key] | remove <vendor>]');
    process.exit(1);
}

async function cmdModels(args: string[]): Promise<void> {
    const [sub, ...rest] = args;

    if (!sub || sub === 'list') {
        const m = await loadModels();
        const isEmpty = !m.chat && !m.fast && !m.embed;
        if (isEmpty) {
            console.log('No model configuration set.');
            console.log('  Switch to a suite: phaibel models use <vendor>');
            console.log(`  Vendors: ${Object.keys(SUITES).join(', ')}`);
            return;
        }
        console.log('Model configuration:');
        if (m.vendor) console.log(`  Suite:  ${m.vendor}`);
        console.log(`  chat:   ${m.chat  || '(not set)'}`);
        console.log(`  fast:   ${m.fast  || '(not set)'}`);
        console.log(`  embed:  ${m.embed || '(not set)'}`);
        console.log('');
        console.log('  Change suite:  phaibel models use <vendor>');
        console.log('  Change model:  phaibel models set <role> <model>');
        return;
    }

    if (sub === 'use') {
        const vendor = rest[0];
        if (!vendor || !(vendor in SUITES)) {
            console.error(`Vendor must be one of: ${Object.keys(SUITES).join(', ')}`);
            process.exit(1);
        }
        const suite = SUITES[vendor as Vendor];
        await saveModels(suite);
        console.log(`Switched to ${vendor} suite:`);
        console.log(`  chat:   ${suite.chat  || '(none)'}`);
        console.log(`  fast:   ${suite.fast  || '(none)'}`);
        console.log(`  embed:  ${suite.embed || '(none)'}`);
        return;
    }

    if (sub === 'set') {
        const [role, model] = rest;
        if (!role || !MODEL_ROLES.includes(role as ModelRole)) {
            console.error(`Role must be one of: ${MODEL_ROLES.join(', ')}`);
            process.exit(1);
        }
        if (!model) {
            console.error('Usage: phaibel models set <role> <model>');
            process.exit(1);
        }
        await setModel(role as ModelRole, model);
        console.log(`${role} → ${model}`);
        return;
    }

    console.error(`Unknown subcommand: phaibel models ${sub}`);
    console.error('Usage: phaibel models [list | use <vendor> | set <role> <model>]');
    process.exit(1);
}

// ── Daemon commands (phaibel only) ──────────────────────────────────────────

async function cmdStart(opts: {
    port?: number;
    foundation?: string;
    noAuth: boolean;
}): Promise<void> {
    const existing = await getRunningPid();
    const port = opts.port || DEFAULT_PORT;
    if (existing) {
        console.log(`Phaibel is already running (pid ${existing})`);
        console.log(`  Client: http://localhost:${port}/`);
        return;
    }

    const dir = await getCxmsDir();
    const pidFile = path.join(dir, 'phaibel.pid');
    const logFile = path.join(dir, 'phaibel.log');

    const args = ['--server'];
    if (opts.port) args.push('--port', String(opts.port));
    if (opts.foundation) args.push('--foundation', opts.foundation);
    if (opts.noAuth) args.push('--no-auth');

    const log = await fs.open(logFile, 'a');
    const child = spawn(process.argv[0], [process.argv[1], ...args], {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
    });
    child.unref();
    await log.close();

    await fs.writeFile(pidFile, String(child.pid));

    console.log(`Phaibel started (pid ${child.pid})`);
    console.log(`  Client:  http://localhost:${port}/`);
    console.log(`  Log:     ${logFile}`);
    console.log(`\n  Stop with: phaibel stop`);
}

async function cmdStop(): Promise<void> {
    const pid = await getRunningPid();
    if (!pid) {
        console.log('Phaibel is not running.');
        return;
    }

    process.kill(pid, 'SIGTERM');

    const dir = await getCxmsDir();
    await fs.unlink(path.join(dir, 'phaibel.pid')).catch(() => {});

    console.log(`Phaibel stopped (pid ${pid})`);
}

async function cmdRestart(opts: { port?: number; foundation?: string; noAuth: boolean }): Promise<void> {
    await cmdStop();
    await new Promise(r => setTimeout(r, 600));
    await cmdStart(opts);
}

async function cmdStatus(port?: number): Promise<void> {
    const pid = await getRunningPid();
    const p = port || DEFAULT_PORT;
    if (pid) {
        console.log(`Phaibel is running (pid ${pid})`);
        console.log(`  Client: http://localhost:${p}/`);
    } else {
        console.log('Phaibel is not running.');
        console.log('  Start with: phaibel start');
    }
}

// ── Server ──────────────────────────────────────────────────────────────────

async function startServer(opts: {
    port?: number;
    foundation?: string;
    noAuth: boolean;
    name?: string;
    description?: string;
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
    if (opts.name || opts.description) {
        setInstanceIdentity(
            opts.name ?? config.name ?? 'Main',
            opts.description ?? config.description ?? 'The main Context Management System',
        );
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

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    const { name: instanceName, description: instanceDescription } = getInstanceIdentity();
    server.listen(port, () => {
        console.log(`\nCxMS — ${instanceName}`);
        console.log(`  ${instanceDescription}`);
        console.log(`\nListening on http://localhost:${port}`);
        console.log(`  Client:    http://localhost:${port}/`);
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

// When invoked as `phaibel init`, map to the rich setup flow
if (IS_PHAIBEL && opts.command === 'init') opts.command = 'phaibel-init';

if (opts.command === 'phaibel-init') {
    cmdPhaibelInit().catch(err => { console.error(err); process.exit(1); });
} else if (opts.command === 'init') {
    cmdInit().catch(err => { console.error(err); process.exit(1); });
} else if (opts.command === 'onboard') {
    cmdOnboard().catch(err => { console.error(err); process.exit(1); });
} else if (opts.command === 'token') {
    cmdToken(opts.regenerate).catch(err => { console.error(err); process.exit(1); });
} else if (IS_PHAIBEL && opts.command === 'start') {
    cmdStart(opts).catch(err => { console.error(err); process.exit(1); });
} else if (IS_PHAIBEL && opts.command === 'stop') {
    cmdStop().catch(err => { console.error(err); process.exit(1); });
} else if (IS_PHAIBEL && opts.command === 'restart') {
    cmdRestart(opts).catch(err => { console.error(err); process.exit(1); });
} else if (IS_PHAIBEL && opts.command === 'status') {
    cmdStatus(opts.port).catch(err => { console.error(err); process.exit(1); });
} else if (IS_PHAIBEL && opts.command === 'keys') {
    cmdKeys(process.argv.slice(3)).catch(err => { console.error(err); process.exit(1); });
} else if (IS_PHAIBEL && opts.command === 'models') {
    cmdModels(process.argv.slice(3)).catch(err => { console.error(err); process.exit(1); });
} else if (IS_PHAIBEL && !opts.command && !opts.server) {
    // `phaibel` alone — show help instead of starting server
    printHelp();
} else {
    // cxms (foreground) or phaibel --server (daemon child)
    startServer(opts).catch(err => { console.error(err); process.exit(1); });
}
