// ─────────────────────────────────────────────────────────────────────────────
// ENTITY MODEL — markdown files with gray-matter frontmatter
// ─────────────────────────────────────────────────────────────────────────────

import matter from 'gray-matter';
import { getPlatform } from '../platform/index.js';
import { debug } from '../debug.js';
import { getFoundationRoot } from '../foundation.js';
import { getEntityType, loadEntityTypes } from '../schema/entity-type-config.js';
import { getEntityIndex } from '../index/entity-index.js';
import { getEmbeddingIndex } from '../index/embedding-index.js';
import { assertWithinFoundation } from './boundary-guard.js';

// ─────────────────────────────────────────────────────────────────────────────
// SHARED TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type EntityTypeName = string;

export interface EntityLink {
    target: string;
    label: string;
}

export type TaskStatus = 'open' | 'in-progress' | 'done' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface EntityMeta {
    id: string;
    name: string;
    entityType: EntityTypeName;
    created: string;
    updated?: string;
    description?: string;
    /** @deprecated use name */ title?: string;
    /** @deprecated use description */ summary?: string;
}

export const CORE_FRONTMATTER_KEYS = new Set([
    'id', 'entityType', 'contextType',
    'name', 'title',
    'description', 'summary',
    'created', 'updated', 'source', 'references',
]);

function parseFieldScalar(raw: string): unknown {
    const v = raw.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~' || v === '') return null;
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    if (v.startsWith('{') || v.startsWith('[')) {
        try { return JSON.parse(v); } catch { /* fall through */ }
    }
    return v;
}

function serializeFieldScalar(value: unknown): string {
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

export function parseEntityBody(body: string): { fields: Record<string, unknown>; content: string } {
    const lines = body.split('\n');
    const fields: Record<string, unknown> = {};
    let fieldLineCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
            fieldLineCount = i + 1;
            break;
        }
        const match = line.match(/^([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
        if (match) {
            fields[match[1]] = parseFieldScalar(match[2]);
            fieldLineCount = i + 1;
        } else {
            return { fields: {}, content: body.trim() };
        }
    }

    return { fields, content: lines.slice(fieldLineCount).join('\n').trim() };
}

export function serializeEntityBody(domainFields: Record<string, unknown>, content: string): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(domainFields)) {
        if (value === undefined || value === null) continue;
        lines.push(`${key}: ${serializeFieldScalar(value)}`);
    }
    if (lines.length === 0) return content;
    return lines.join('\n') + '\n\n' + content;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function generateNodeId(): string {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    let id = alpha[Math.floor(Math.random() * 26)];
    for (let i = 1; i < 8; i++) id += chars[Math.floor(Math.random() * 36)];
    return id;
}

export function generateEntityId(_typeName: string): string {
    return generateNodeId();
}

export function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

export function nodeFilename(title: string, id: string): string {
    const slug = slugify(title);
    return `${slug}_${id}.md`;
}

export function entityFilename(title: string, id: string): string {
    return nodeFilename(title, id);
}

export function createEntityMeta(
    entityType: EntityTypeName,
    title: string,
): EntityMeta {
    return {
        id: generateNodeId(),
        name: title,
        entityType,
        created: new Date().toISOString(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE I/O
// ─────────────────────────────────────────────────────────────────────────────

export async function getEntityDir(entityType: EntityTypeName): Promise<string> {
    const { paths } = getPlatform();
    const root = getFoundationRoot();
    const typeConfig = await getEntityType(entityType);
    if (!typeConfig) {
        throw new Error(`Unknown entity type: "${entityType}".`);
    }
    return paths.join(root, typeConfig.directory);
}

export async function ensureEntityDir(entityType: EntityTypeName): Promise<string> {
    const { storage } = getPlatform();
    const dir = await getEntityDir(entityType);
    await storage.mkdir(dir, { recursive: true });
    return dir;
}

export function parseEntity(filepath: string, rawContent: string): { meta: Record<string, unknown>; content: string } {
    const { data, content: rawBody } = matter(rawContent);

    // Normalise legacy field names
    if (data.title !== undefined && data.name === undefined) data.name = data.title;
    if (data.summary !== undefined && data.description === undefined) data.description = data.summary;
    if (data.name !== undefined) data.title = data.name;

    const { fields, content } = parseEntityBody(rawBody.trim());
    const meta: Record<string, unknown> = { ...fields, ...data };
    meta._filepath = filepath;
    return { meta, content };
}

export async function writeEntity(
    filepath: string,
    meta: Record<string, unknown>,
    content: string,
): Promise<void> {
    await assertWithinFoundation(filepath);
    meta.updated = new Date().toISOString();

    const cleanMeta = { ...meta };
    delete cleanMeta._filepath;

    // Normalise title → name, summary → description
    if (cleanMeta.title !== undefined && cleanMeta.name === undefined) cleanMeta.name = cleanMeta.title;
    delete cleanMeta.title;
    if (cleanMeta.summary !== undefined && cleanMeta.description === undefined) cleanMeta.description = cleanMeta.summary;
    delete cleanMeta.summary;

    // Split core (frontmatter) from domain (body)
    const frontmatter: Record<string, unknown> = {};
    const domainFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cleanMeta)) {
        if (value === undefined) continue;
        if (CORE_FRONTMATTER_KEYS.has(key)) {
            frontmatter[key] = value;
        } else {
            domainFields[key] = value;
        }
    }

    const fullBody = serializeEntityBody(domainFields, content);
    const fileContent = matter.stringify(fullBody, frontmatter);
    await getPlatform().storage.writeFile(filepath, fileContent);
}

/**
 * Archive (soft-delete) a node in place by setting archivedAt on its meta.
 * The file stays in its directory — use trashEntity for hard delete.
 */
export async function archiveEntity(filepath: string, meta: Record<string, unknown>): Promise<void> {
    meta.archivedAt = new Date().toISOString();
    await writeEntity(filepath, meta, '');
}

/**
 * Restore a previously archived node by clearing archivedAt.
 */
export async function restoreEntity(filepath: string, meta: Record<string, unknown>): Promise<void> {
    delete meta.archivedAt;
    await writeEntity(filepath, meta, '');
}

export async function trashEntity(filepath: string): Promise<string> {
    await assertWithinFoundation(filepath);
    const { storage, paths } = getPlatform();
    const { join, basename, dirname } = paths;
    const root = getFoundationRoot();
    const trashRoot = join(root, '.trash');

    const parentDir = basename(dirname(filepath));
    const trashDir = join(trashRoot, parentDir);
    await storage.mkdir(trashDir, { recursive: true });

    const filename = basename(filepath);
    let trashPath = join(trashDir, filename);

    try {
        await storage.access(trashPath);
        const stem = basename(filename, '.md');
        const ts = Date.now();
        trashPath = join(trashDir, `${stem}-${ts}.md`);
    } catch {
        // No collision
    }

    await storage.rename(filepath, trashPath);
    debug('entities', `Trashed ${filepath} → ${trashPath}`);
    return trashPath;
}

export async function findEntityByTitle(
    entityType: EntityTypeName,
    titleOrFilename: string,
): Promise<{ filepath: string; meta: Record<string, unknown>; content: string } | null> {
    const { storage, paths } = getPlatform();
    const index = getEntityIndex();
    if (index.isBuilt) {
        const node = index.findByTitle(entityType, titleOrFilename);
        if (node) {
            try {
                const rawContent = await storage.readFile(node.filepath, 'utf-8');
                const { meta, content } = parseEntity(node.filepath, rawContent);
                return { filepath: node.filepath, meta, content };
            } catch (err) {
                debug('entities', `Index hit but file read failed: ${err}`);
            }
        }

        const embeddingIndex = getEmbeddingIndex();
        if (embeddingIndex.isLoaded) {
            try {
                const results = await embeddingIndex.search(titleOrFilename, 1, entityType);
                if (results.length > 0) {
                    const matchedNode = index.getNode(results[0].key);
                    if (matchedNode) {
                        const rawContent = await storage.readFile(matchedNode.filepath, 'utf-8');
                        const { meta, content } = parseEntity(matchedNode.filepath, rawContent);
                        return { filepath: matchedNode.filepath, meta, content };
                    }
                }
            } catch (err) {
                debug('entities', `Semantic search failed: ${err}`);
            }
        }

        return null;
    }

    // Fallback: filesystem scan
    let dir: string;
    try {
        dir = await getEntityDir(entityType);
    } catch (err) {
        debug('entities', err);
        return null;
    }
    try {
        const files = await storage.readdir(dir);
        const needle = titleOrFilename.toLowerCase();
        let partialMatch: { filepath: string; meta: Record<string, unknown>; content: string } | null = null;

        for (const file of files) {
            if (!file.endsWith('.md') || file.startsWith('.')) continue;
            const filepath = paths.join(dir, file);
            const rawContent = await storage.readFile(filepath, 'utf-8');
            const { meta, content } = parseEntity(filepath, rawContent);

            if (
                meta.id === titleOrFilename ||
                (meta.title && (meta.title as string).toLowerCase() === needle)
            ) {
                return { filepath, meta, content };
            }

            if (!partialMatch && meta.title) {
                const titleLower = (meta.title as string).toLowerCase();
                if (titleLower.includes(needle) || needle.includes(titleLower)) {
                    partialMatch = { filepath, meta, content };
                }
            }
        }

        if (partialMatch) return partialMatch;
    } catch (err) {
        debug('entities', err);
    }

    return null;
}

export async function searchEntities(
    query: string,
    entityType?: EntityTypeName,
): Promise<{ filepath: string; meta: Record<string, unknown>; content: string; score: number }[]> {
    const index = getEntityIndex();
    if (index.isBuilt) {
        const keywordResults = index.search(query, entityType);

        const embeddingIndex = getEmbeddingIndex();
        const mergedScores = new Map<string, { node: typeof keywordResults[0]['node']; score: number }>();

        const maxKeyword = keywordResults.length > 0 ? keywordResults[0].score : 1;
        for (const { node, score } of keywordResults) {
            const key = `${node.type}:${node.id}`;
            const normalized = maxKeyword > 0 ? score / maxKeyword : 0;
            mergedScores.set(key, { node, score: normalized * 0.6 });
        }

        if (embeddingIndex.isLoaded && query) {
            try {
                const semanticResults = await embeddingIndex.search(query, 20, entityType ?? undefined);
                for (const { key, similarity } of semanticResults) {
                    const existing = mergedScores.get(key);
                    if (existing) {
                        existing.score += similarity * 0.4;
                    } else {
                        const node = index.getNode(key);
                        if (node) {
                            mergedScores.set(key, { node, score: similarity * 0.4 });
                        }
                    }
                }
            } catch (err) {
                debug('entities', `Semantic search failed, using keyword-only: ${err}`);
            }
        }

        const sorted = [...mergedScores.values()].sort((a, b) => b.score - a.score);
        const { storage } = getPlatform();
        const results: { filepath: string; meta: Record<string, unknown>; content: string; score: number }[] = [];
        for (const { node, score } of sorted) {
            try {
                const rawContent = await storage.readFile(node.filepath, 'utf-8');
                const { meta, content } = parseEntity(node.filepath, rawContent);
                results.push({ filepath: node.filepath, meta, content, score });
            } catch (err) {
                debug('entities', `Index hit but file read failed for ${node.filepath}: ${err}`);
            }
        }
        return results;
    }

    // Fallback: filesystem scan
    const searchTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (searchTokens.length === 0) return [];

    let allEntities: { filepath: string; meta: Record<string, unknown>; content: string }[];
    if (entityType) {
        allEntities = await listEntities(entityType);
    } else {
        const types = await loadEntityTypes();
        const lists = await Promise.all(types.map(t => listEntities(t.name)));
        allEntities = lists.flat();
    }

    const results: { filepath: string; meta: Record<string, unknown>; content: string; score: number }[] = [];
    for (const entity of allEntities) {
        const title = ((entity.meta.title as string) ?? '').toLowerCase();
        const body = entity.content.toLowerCase();

        let score = 0;
        let allMatched = true;

        for (const token of searchTokens) {
            let matched = false;
            if (title.includes(token)) { score += 3; matched = true; }
            if (body.includes(token)) { score += 1; matched = true; }
            if (!matched) { allMatched = false; break; }
        }

        if (allMatched && score > 0) {
            results.push({ filepath: entity.filepath, meta: entity.meta, content: entity.content, score });
        }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
}

export async function listEntities(
    entityType: EntityTypeName,
    options?: { metaOnly?: boolean; includeArchived?: boolean },
): Promise<{ filepath: string; meta: Record<string, unknown>; content: string }[]> {
    const index = getEntityIndex();
    if (index.isBuilt) {
        let nodes = index.getNodes(entityType);

        if (!options?.includeArchived) {
            nodes = nodes.filter(n => !n.meta.archivedAt);
        }

        if (options?.metaOnly) {
            return nodes.map(n => ({
                filepath: n.filepath,
                meta: n.meta,
                content: '',
            }));
        }

        const { storage: stg } = getPlatform();
        const results: { filepath: string; meta: Record<string, unknown>; content: string }[] = [];
        for (const n of nodes) {
            try {
                const rawContent = await stg.readFile(n.filepath, 'utf-8');
                const { meta, content } = parseEntity(n.filepath, rawContent);
                results.push({ filepath: n.filepath, meta, content });
            } catch (err) {
                debug('entities', `Index hit but file read failed for ${n.filepath}: ${err}`);
            }
        }
        return results;
    }

    // Fallback: filesystem scan
    const { storage, paths } = getPlatform();
    let dir: string;
    try {
        dir = await getEntityDir(entityType);
    } catch (err) {
        debug('entities', err);
        return [];
    }

    const entities: { filepath: string; meta: Record<string, unknown>; content: string }[] = [];
    try {
        const files = await storage.readdir(dir);
        for (const file of files) {
            if (!file.endsWith('.md') || file.startsWith('.')) continue;
            const filepath = paths.join(dir, file);
            const rawContent = await storage.readFile(filepath, 'utf-8');
            const { meta, content } = parseEntity(filepath, rawContent);
            entities.push({ filepath, meta, content });
        }
    } catch (err) {
        debug('entities', err);
    }

    const filtered = options?.includeArchived ? entities : entities.filter(e => !e.meta.archivedAt);
    return filtered;
}
