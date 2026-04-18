// ─────────────────────────────────────────────────────────────────────────────
// CxMS — System Configuration (~/.cxms/)
// ─────────────────────────────────────────────────────────────────────────────
// Manages the CxMS system directory at ~/.cxms/ which holds:
//   config.json  — foundation root, port, settings
//   token        — bearer token for API authentication
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from '../platform/index.js';
import { setFoundationRoot } from '../foundation.js';
import { debug } from '../debug.js';
import crypto from 'crypto';

const CXMS_DIR = '.cxms';
const CONFIG_FILE = 'config.json';
const TOKEN_FILE = 'token';

export interface CxmsConfig {
    /** Absolute path to the Foundation root directory */
    foundationRoot?: string;
    /** Port for the CxMS HTTP server */
    port?: number;
    /** Display name for this CxMS instance */
    name?: string;
    /** Description of this CxMS instance's purpose */
    description?: string;
}

// ── Instance identity ─────────────────────────────────────────────────────────

const DEFAULT_INSTANCE_NAME = 'Main';
const DEFAULT_INSTANCE_DESCRIPTION = 'The main Context Management System';

let _instanceName: string = DEFAULT_INSTANCE_NAME;
let _instanceDescription: string = DEFAULT_INSTANCE_DESCRIPTION;

export function setInstanceIdentity(name: string, description: string): void {
    _instanceName = name;
    _instanceDescription = description;
}

export function getInstanceIdentity(): { name: string; description: string } {
    return { name: _instanceName, description: _instanceDescription };
}

export function resetInstanceIdentity(): void {
    _instanceName = DEFAULT_INSTANCE_NAME;
    _instanceDescription = DEFAULT_INSTANCE_DESCRIPTION;
}

/**
 * Get the ~/.cxms/ directory path.
 */
export function getSystemDir(): string {
    return getPlatform().paths.join(getPlatform().homedir(), CXMS_DIR);
}

/**
 * Ensure the ~/.cxms/ directory exists.
 */
export async function ensureSystemDir(): Promise<string> {
    const dir = getSystemDir();
    await getPlatform().storage.mkdir(dir, { recursive: true });
    return dir;
}

/**
 * Load the CxMS config from ~/.cxms/config.json.
 * Returns defaults if the file doesn't exist.
 */
export async function loadSystemConfig(): Promise<CxmsConfig> {
    const { storage, paths } = getPlatform();
    const configPath = paths.join(getSystemDir(), CONFIG_FILE);
    try {
        const raw = await storage.readFile(configPath);
        return JSON.parse(raw) as CxmsConfig;
    } catch {
        return {};
    }
}

/**
 * Save the CxMS config to ~/.cxms/config.json.
 */
export async function saveSystemConfig(config: CxmsConfig): Promise<void> {
    const dir = await ensureSystemDir();
    const { storage, paths } = getPlatform();
    await storage.writeFile(paths.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2));
    debug('system-config', `Saved config to ${dir}/${CONFIG_FILE}`);
}

/**
 * Load the bearer token from ~/.cxms/token.
 * Auto-generates one if it doesn't exist.
 */
export async function loadBearerToken(): Promise<string> {
    const { storage, paths } = getPlatform();
    const tokenPath = paths.join(getSystemDir(), TOKEN_FILE);
    try {
        const token = (await storage.readFile(tokenPath)).trim();
        if (token.length > 0) return token;
    } catch {
        // Token file doesn't exist — generate one
    }

    const token = generateToken();
    await ensureSystemDir();
    await storage.writeFile(tokenPath, token + '\n');
    debug('system-config', 'Generated new bearer token');
    return token;
}

/**
 * Regenerate the bearer token. Returns the new token.
 */
export async function regenerateToken(): Promise<string> {
    const { storage, paths } = getPlatform();
    const token = generateToken();
    await ensureSystemDir();
    await storage.writeFile(paths.join(getSystemDir(), TOKEN_FILE), token + '\n');
    debug('system-config', 'Regenerated bearer token');
    return token;
}

/**
 * Initialize CxMS from system config.
 * Reads ~/.cxms/config.json and sets the foundation root if configured.
 * Returns the loaded config.
 */
export async function initFromSystemConfig(): Promise<CxmsConfig> {
    const config = await loadSystemConfig();
    if (config.foundationRoot) {
        setFoundationRoot(config.foundationRoot);
        debug('system-config', `Foundation root set to ${config.foundationRoot}`);
    }
    if (config.name || config.description) {
        setInstanceIdentity(
            config.name ?? DEFAULT_INSTANCE_NAME,
            config.description ?? DEFAULT_INSTANCE_DESCRIPTION,
        );
    }
    return config;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateToken(): string {
    return `cxms_${crypto.randomBytes(32).toString('hex')}`;
}
