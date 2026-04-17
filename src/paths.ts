// ─────────────────────────────────────────────────────────────────────────────
// PATHS — Central path resolution for CxMS
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from './platform/index.js';
import { getFoundationRoot } from './foundation.js';

function join(...parts: string[]): string {
    return getPlatform().paths.join(...parts);
}

export function getFoundationDir(): string {
    return getFoundationRoot();
}

/** Legacy .phaibel config directory: {foundation}/.phaibel/ */
export function getVaultConfigDir(): string {
    return join(getFoundationRoot(), '.phaibel');
}

export function getContextTypesDir(): string {
    return join(getFoundationRoot(), 'context-types');
}

export function getProfilesDir(): string {
    return join(getFoundationRoot(), 'profiles');
}

export function getCollectionsDir(): string {
    return join(getFoundationRoot(), 'collections');
}

export function getFoundationLogsDir(): string {
    return join(getFoundationRoot(), 'logs');
}

export function getAccessLogPath(date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return join(getFoundationRoot(), 'logs', `access-${y}-${m}-${d}.txt`);
}

export function getErrorLogPath(date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return join(getFoundationRoot(), 'logs', `error-${y}-${m}-${d}.txt`);
}

export function getContextTypeMappingPath(): string {
    return join(getFoundationRoot(), 'context-types', 'mapping.json');
}

export function getEntityTypesPath(): string {
    return join(getVaultConfigDir(), 'entity-types.json');
}

export function getEmbeddingsPath(): string {
    return join(getVaultConfigDir(), 'embeddings.json');
}
