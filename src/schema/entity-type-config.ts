// ─────────────────────────────────────────────────────────────────────────────
// ENTITY TYPE CONFIG
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from '../platform/index.js';
import { BUILT_IN_TYPE_NAMES } from './entity-types-defaults.js';
import { debug } from '../debug.js';
import { getEntityTypesPath, getVaultConfigDir, getFoundationDir } from '../paths.js';
import { getFoundationRoot } from '../foundation.js';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'duration' | 'enum' | 'array' | 'object';

export interface FieldDef {
    key: string;
    type: FieldType;
    label?: string;
    required?: boolean;
    default?: unknown;
    values?: string[];
}

export interface FieldMapping {
    from?: string;
    to?: string;
    target?: string;
    value?: string;
    default?: unknown;
}

export interface DateSeriesScheduling {
    cadenceField: string;
    cadenceDetailsField: string;
    blackoutField: string;
}

export interface SpawnerConfig {
    mode: 'date-series' | 'template';
    targetTypeField?: string;
    titlePattern?: string;
    dedupeFields?: string[];
    scheduling?: DateSeriesScheduling;
    fieldMapping?: FieldMapping[];
    childrenField?: string;
}

export interface EntityTypeConfig {
    name: string;
    plural: string;
    directory: string;
    description?: string;
    defaultTags?: string[];
    fields: FieldDef[];
    completionField?: string;
    completionValue?: string;
    spawner?: SpawnerConfig;
    calendarDateField?: string;
}

interface EntityTypesFile {
    version: number;
    entityTypes: EntityTypeConfig[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────────────────

let _cache: EntityTypeConfig[] | null = null;

export function invalidateCache(): void {
    _cache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD / SAVE
// ─────────────────────────────────────────────────────────────────────────────

export async function loadEntityTypes(): Promise<EntityTypeConfig[]> {
    if (_cache) return _cache;

    try {
        const { storage } = getPlatform();
        const typesPath = getEntityTypesPath();
        const raw = await storage.readFile(typesPath, 'utf-8');
        const parsed: EntityTypesFile = JSON.parse(raw);
        if (!Array.isArray(parsed.entityTypes)) {
            throw new Error('entity-types.json missing entityTypes array');
        }
        _cache = parsed.entityTypes;
        return _cache;
    } catch (err) {
        debug('entity-types', `No entity-types.json found: ${err}`);
        _cache = [];
        return _cache;
    }
}

export async function saveEntityTypes(types: EntityTypeConfig[]): Promise<void> {
    const { storage } = getPlatform();
    const dir = getVaultConfigDir();
    await storage.mkdir(dir, { recursive: true });
    const typesPath = getEntityTypesPath();
    const file: EntityTypesFile = { version: 1, entityTypes: types };
    await storage.writeFile(typesPath, JSON.stringify(file, null, 2));
    invalidateCache();
}

export async function initEntityTypes(): Promise<void> {
    try {
        const typesPath = getEntityTypesPath();
        await getPlatform().storage.access(typesPath);
        debug('entity-types', 'entity-types.json already exists — skipping init');
    } catch {
        await saveEntityTypes([]);
        debug('entity-types', 'Created empty entity-types.json');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCESSORS
// ─────────────────────────────────────────────────────────────────────────────

export async function getEntityType(name: string): Promise<EntityTypeConfig | null> {
    const types = await loadEntityTypes();
    return types.find(t => t.name === name) ?? null;
}

export async function listEntityTypeNames(): Promise<string[]> {
    const types = await loadEntityTypes();
    return types.map(t => t.name);
}

export async function getSpawnerTypes(): Promise<EntityTypeConfig[]> {
    const types = await loadEntityTypes();
    return types.filter(t => t.spawner !== undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function addEntityType(config: EntityTypeConfig): Promise<void> {
    const types = await loadEntityTypes();
    if (types.find(t => t.name === config.name)) {
        throw new Error(`Entity type "${config.name}" already exists.`);
    }
    if (config.calendarDateField) {
        const field = config.fields.find(f => f.key === config.calendarDateField);
        if (!field) {
            throw new Error(`calendarDateField "${config.calendarDateField}" does not match any field in this entity type.`);
        }
        if (field.type !== 'date' && field.type !== 'datetime') {
            throw new Error(`calendarDateField "${config.calendarDateField}" must be a date or datetime field, got "${field.type}".`);
        }
    }
    types.push(config);
    await saveEntityTypes(types);

    try {
        const { storage, paths } = getPlatform();
        const root = getFoundationRoot();
        const entityDir = paths.join(root, config.directory);
        await storage.mkdir(entityDir, { recursive: true });

        const fieldLines = config.fields.map(f => {
            let desc = `- **${f.key}** (${f.type})`;
            if (f.label) desc += ` — ${f.label}`;
            if (f.type === 'enum' && f.values) desc += `: ${f.values.join(', ')}`;
            if (f.default !== undefined) desc += ` [default: ${f.default}]`;
            return desc;
        });

        const completionNote = config.completionField
            ? `\nCompletion: set \`${config.completionField}\` to \`${config.completionValue ?? 'done'}\` to mark as complete.\n`
            : '';

        const content = `# ${config.plural.charAt(0).toUpperCase() + config.plural.slice(1)}

${config.description || `A collection of ${config.plural}.`}

## Fields

${fieldLines.join('\n')}
${completionNote}
## Guidelines

- Use the exact field names above when creating or updating ${config.plural}.
- Titles should be concise and descriptive.
- When the user refers to "${config.plural}" or "${config.name}", this is the entity type to use.
`;

        await storage.writeFile(paths.join(entityDir, '.cxms.md'), content);
    } catch (err) {
        debug('entity-types', `Failed to create .cxms.md for ${config.name}: ${err}`);
    }
}

export async function updateEntityType(name: string, config: EntityTypeConfig): Promise<void> {
    const types = await loadEntityTypes();
    const idx = types.findIndex(t => t.name === name);
    if (idx === -1) throw new Error(`Entity type "${name}" not found.`);
    types[idx] = config;
    await saveEntityTypes(types);
}

export async function removeEntityType(name: string): Promise<void> {
    const types = await loadEntityTypes();
    const filtered = types.filter(t => t.name !== name);
    if (filtered.length === types.length) throw new Error(`Entity type "${name}" not found.`);
    await saveEntityTypes(filtered);
}

export { BUILT_IN_TYPE_NAMES };

// v5 Aliases
export type ContextTypeConfig = EntityTypeConfig;
export const loadContextTypes = loadEntityTypes;
export const getContextType = getEntityType;
export const listContextTypeNames = listEntityTypeNames;
