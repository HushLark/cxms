// ─────────────────────────────────────────────────────────────────────────────
// CxMS — Auto-Migration (v4 → v5)
// ─────────────────────────────────────────────────────────────────────────────
// Detects a v4 vault (.vault.md) or v4.5 (.phaibel.md) and auto-converts
// to v5 Foundation (.cxms.md) on first access. Runs once, writes a marker.
//
// Steps:
//   1. Rename .vault.md/.phaibel.md → .cxms.md
//   2. Create v5 directories (context-types/, collections/, logs/)
//   3. Migrate .state.json → profile data (via injected callback)
//   4. Migrate entity-types.json → context-types/{type}/.cxms.md
//   5. Move entity files: todos/ → context-types/task/, notes/ → context-types/note/, etc.
//   6. Move .phaibel/processes/ → feral/processes/
//   7. Regenerate node IDs to 8-char format (update frontmatter + filenames)
//   8. Write migration marker
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from '../platform/index.js';
import matter from 'gray-matter';
import { debug } from '../debug.js';
import { generateNodeId, slugify, nodeFilename } from '../storage/entity.js';
import { writeContextType, writeMappingIndex } from '../schema/context-type-store.js';
import type { EntityTypeConfig } from '../schema/entity-type-config.js';

const MIGRATION_MARKER = '.v5-migrated';

// ── Profile Migration Callback ───────────────────────────────────────────────

/**
 * Callback to save migrated profile data.
 * Host applications inject this to handle their own profile format.
 * The state object is the raw .state.json content.
 */
export type ProfileMigrationCallback = (root: string, state: Record<string, unknown>) => Promise<void>;

let _profileMigrator: ProfileMigrationCallback | null = null;

/**
 * Set the profile migration callback. Call this before autoMigrateV4ToV5
 * if you want .state.json to be migrated to profiles.
 */
export function setProfileMigrator(fn: ProfileMigrationCallback): void {
    _profileMigrator = fn;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a legacy vault needs migration and run it if so.
 * Detects .vault.md (v4) or .phaibel.md (v4.5) and migrates to .cxms.md (v5).
 * Returns true if migration was performed.
 */
export async function autoMigrateV4ToV5(root: string): Promise<boolean> {
    const { storage, paths } = getPlatform();

    // Already migrated?
    try {
        await storage.access(paths.join(root, MIGRATION_MARKER));
        return false;
    } catch {
        // Not yet migrated — continue
    }

    // Detect legacy marker: .vault.md or .phaibel.md
    let legacyMarker: string | null = null;
    for (const marker of ['.vault.md', '.phaibel.md']) {
        try {
            await storage.access(paths.join(root, marker));
            legacyMarker = marker;
            break;
        } catch { /* try next */ }
    }
    if (!legacyMarker) return false;

    console.log('Migrating to CxMS Foundation...');
    debug('migrate', `Starting migration at ${root} (found ${legacyMarker})`);

    try {
        await renameRootMarker(root);
        await createV5Directories(root);
        await migrateProfiles(root);
        const types = await migrateEntityTypes(root);
        const idMap = await migrateEntityFiles(root, types);
        await migrateFeralProcesses(root);

        if (idMap.size > 0) {
            await updateCrossReferences(root, types, idMap);
        }

        const marker = JSON.stringify({
            migratedAt: new Date().toISOString(),
            fromVersion: 4,
            toVersion: 5,
            idsRemapped: idMap.size,
        }, null, 2);
        await storage.writeFile(paths.join(root, MIGRATION_MARKER), marker);

        console.log('Migration complete.');
        debug('migrate', `v4→v5 migration complete. ${idMap.size} IDs remapped.`);
        return true;
    } catch (err) {
        console.error('Migration failed:', err);
        debug('migrate', `Migration failed: ${err}`);
        return false;
    }
}

// ── Step 1: Rename root marker ───────────────────────────────────────────────

async function renameRootMarker(root: string): Promise<void> {
    const { storage, paths } = getPlatform();
    const newPath = paths.join(root, '.cxms.md');

    // Find the legacy marker
    for (const legacy of ['.vault.md', '.phaibel.md']) {
        const oldPath = paths.join(root, legacy);
        try {
            await storage.access(oldPath);
        } catch {
            continue;
        }

        const raw = await storage.readFile(oldPath);
        const updated = raw
            .replace(/vault/gi, (match) => {
                if (match === 'vault') return 'foundation';
                if (match === 'Vault') return 'Foundation';
                if (match === 'VAULT') return 'FOUNDATION';
                return match;
            });
        await storage.writeFile(newPath, updated);
        try {
            await storage.unlink(oldPath);
        } catch {
            // Concurrent migration may have already removed it
        }
        debug('migrate', `Renamed ${legacy} → .cxms.md`);
        return;
    }

    debug('migrate', 'No legacy marker found — skipping rename');
}

// ── Step 2: Create v5 directories ────────────────────────────────────────────

async function createV5Directories(root: string): Promise<void> {
    const { storage, paths } = getPlatform();
    const dirs = [
        'profiles',
        'context-types',
        'collections',
        'logs',
        'feral',
        'feral/processes',
        'feral/logs',
        'feral/catalog',
    ];
    for (const dir of dirs) {
        await storage.mkdir(paths.join(root, dir), { recursive: true });
    }
    debug('migrate', 'Created v5 directory structure');
}

// ── Step 3: Migrate profiles ─────────────────────────────────────────────────

async function migrateProfiles(root: string): Promise<void> {
    const { storage, paths } = getPlatform();
    const stateFile = paths.join(root, '.state.json');
    try {
        const raw = await storage.readFile(stateFile);
        const state = JSON.parse(raw) as Record<string, unknown>;

        if (_profileMigrator) {
            await _profileMigrator(root, state);
            debug('migrate', 'Migrated .state.json → profiles/ (via callback)');
        } else {
            debug('migrate', 'No profile migrator set — skipping .state.json migration');
        }
    } catch {
        debug('migrate', 'No .state.json found — skipping profile migration');
    }
}

// ── Step 4: Migrate entity types ─────────────────────────────────────────────

async function migrateEntityTypes(root: string): Promise<EntityTypeConfig[]> {
    const { storage, paths } = getPlatform();
    let types: EntityTypeConfig[];

    const typesFile = paths.join(root, '.phaibel', 'entity-types.json');
    try {
        const raw = await storage.readFile(typesFile);
        const parsed = JSON.parse(raw);
        types = parsed.entityTypes ?? parsed;
    } catch {
        debug('migrate', 'No entity-types.json found');
        types = [];
    }

    for (const t of types) {
        t.directory = `context-types/${t.name}`;
    }

    for (const t of types) {
        await writeContextType(t);
    }
    await writeMappingIndex(types);

    debug('migrate', `Migrated ${types.length} entity types to context-types/`);
    return types;
}

// ── Step 5: Move entity files ────────────────────────────────────────────────

const DIR_TO_TYPE: Record<string, string> = {
    todos: 'task',
    notes: 'note',
    events: 'event',
    goals: 'goal',
    people: 'person',
    recurrences: 'recurrence',
    research: 'research',
    todonts: 'todont',
};

async function migrateEntityFiles(
    root: string,
    types: EntityTypeConfig[],
): Promise<Map<string, string>> {
    const { storage, paths } = getPlatform();
    const idMap = new Map<string, string>();
    const typeByName = new Map(types.map(t => [t.name, t]));

    for (const [v4Dir, typeName] of Object.entries(DIR_TO_TYPE)) {
        const srcDir = paths.join(root, v4Dir);
        const typeConfig = typeByName.get(typeName);
        if (!typeConfig) continue;

        const destDir = paths.join(root, typeConfig.directory);
        await storage.mkdir(destDir, { recursive: true });

        let files: string[];
        try {
            files = await storage.readdir(srcDir);
        } catch {
            continue;
        }

        for (const file of files) {
            if (!file.endsWith('.md') || file.startsWith('.')) continue;

            const srcPath = paths.join(srcDir, file);
            try {
                const raw = await storage.readFile(srcPath);
                const { data, content } = matter(raw);

                const oldId = data.id as string;
                const newId = generateNodeId();
                if (oldId) idMap.set(oldId, newId);

                data.id = newId;
                data.contextType = typeName;
                delete data.entityType;
                delete data._filepath;

                const title = (data.title as string) || file.replace(/\.md$/, '');
                const newFile = nodeFilename(title, newId);
                const destPath = paths.join(destDir, newFile);

                const newContent = matter.stringify(content, data);
                await storage.writeFile(destPath, newContent);

                debug('migrate', `Moved ${v4Dir}/${file} → ${typeConfig.directory}/${newFile}`);
            } catch (err) {
                debug('migrate', `Failed to migrate ${srcPath}: ${err}`);
            }
        }
    }

    // Custom types not in DIR_TO_TYPE
    for (const t of types) {
        if (Object.values(DIR_TO_TYPE).includes(t.name)) continue;
        const oldDirName = t.name + 's';
        const srcDir = paths.join(root, oldDirName);
        const destDir = paths.join(root, t.directory);

        try {
            const files = await storage.readdir(srcDir);
            await storage.mkdir(destDir, { recursive: true });
            for (const file of files) {
                if (!file.endsWith('.md') || file.startsWith('.')) continue;
                const srcPath = paths.join(srcDir, file);
                const raw = await storage.readFile(srcPath);
                const { data, content } = matter(raw);

                const oldId = data.id as string;
                const newId = generateNodeId();
                if (oldId) idMap.set(oldId, newId);

                data.id = newId;
                data.contextType = t.name;
                delete data.entityType;
                delete data._filepath;

                const title = (data.title as string) || file.replace(/\.md$/, '');
                const newFile = nodeFilename(title, newId);
                const destPath = paths.join(destDir, newFile);

                const newContent = matter.stringify(content, data);
                await storage.writeFile(destPath, newContent);
            }
        } catch {
            // Directory doesn't exist — skip
        }
    }

    debug('migrate', `Remapped ${idMap.size} entity IDs`);
    return idMap;
}

// ── Step 6: Move Feral processes ─────────────────────────────────────────────

async function migrateFeralProcesses(root: string): Promise<void> {
    const { storage, paths } = getPlatform();
    const oldDir = paths.join(root, '.phaibel', 'processes');
    const newDir = paths.join(root, 'feral', 'processes');

    try {
        const files = await storage.readdir(oldDir);
        await storage.mkdir(newDir, { recursive: true });

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const src = paths.join(oldDir, file);
            const dest = paths.join(newDir, file);
            const content = await storage.readFile(src);
            await storage.writeFile(dest, content);
            debug('migrate', `Copied process: ${file}`);
        }
    } catch {
        debug('migrate', 'No .phaibel/processes/ found — skipping');
    }
}

// ── Step 7: Update cross-references ──────────────────────────────────────────

async function updateCrossReferences(
    root: string,
    types: EntityTypeConfig[],
    idMap: Map<string, string>,
): Promise<void> {
    const { storage, paths } = getPlatform();
    for (const t of types) {
        const dir = paths.join(root, t.directory);
        let files: string[];
        try {
            files = await storage.readdir(dir);
        } catch {
            continue;
        }

        for (const file of files) {
            if (!file.endsWith('.md') || file.startsWith('.')) continue;
            const filepath = paths.join(dir, file);
            let raw = await storage.readFile(filepath);
            let changed = false;

            for (const [oldId, newId] of idMap) {
                if (raw.includes(oldId)) {
                    raw = raw.replaceAll(oldId, newId);
                    changed = true;
                }
            }

            if (changed) {
                await storage.writeFile(filepath, raw);
                debug('migrate', `Updated references in ${t.directory}/${file}`);
            }
        }
    }
}
