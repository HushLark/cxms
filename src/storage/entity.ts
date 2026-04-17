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
    title: string;
    entityType: EntityTypeName;
    created: string;
    updated?: string;
    tags: string[];
    summary?: string;
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
    opts: { tags?: string[] } = {},
): EntityMeta {
    return {
        id: generateNodeId(),
        title,
        entityType,
        created: new Date().toISOString(),
        tags: opts.tags ?? [],
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
    const { data, content } = matter(rawContent);
    data._filepath = filepath;
    return { meta: data, content: content.trim() };
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
    for (const key of Object.keys(cleanMeta)) {
        if (cleanMeta[key] === undefined) {
            delete cleanMeta[key];
        }
    }
    const fileContent = matter.stringify(content, cleanMeta);
    await getPlatform().storage.writeFile(filepath, fileContent);
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
    options?: { tags?: string[] },
): Promise<{ filepath: string; meta: Record<string, unknown>; content: string; score: number }[]> {
    const index = getEntityIndex();
    if (index.isBuilt) {
        const tagPrefix = (options?.tags ?? []).map(t => `tag:${t}`).join(' ');
        const fullQuery = tagPrefix ? `${tagPrefix} ${query}` : query;

        const keywordResults = index.search(fullQuery, entityType);

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
    const rawTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const tagTokens: string[] = [];
    const searchTokens: string[] = [];
    for (const token of rawTokens) {
        if (token.startsWith('tag:') || token.startsWith('tags:')) {
            const tagValue = token.slice(token.indexOf(':') + 1);
            if (tagValue) tagTokens.push(tagValue);
        } else {
            searchTokens.push(token);
        }
    }
    const allFilterTags = [...tagTokens, ...(options?.tags ?? []).map(t => t.toLowerCase())];

    if (searchTokens.length === 0 && allFilterTags.length === 0) return [];

    let allEntities: { filepath: string; meta: Record<string, unknown>; content: string }[];
    if (entityType) {
        allEntities = await listEntities(entityType);
    } else {
        const types = await loadEntityTypes();
        const lists = await Promise.all(types.map(t => listEntities(t.name)));
        allEntities = lists.flat();
    }

    if (allFilterTags.length > 0) {
        allEntities = allEntities.filter(e => {
            const entityTags = ((e.meta.tags as string[]) ?? []).map(t => t.toLowerCase());
            return allFilterTags.some(ft => entityTags.includes(ft));
        });
    }

    if (searchTokens.length === 0) {
        return allEntities.map(e => ({ filepath: e.filepath, meta: e.meta, content: e.content, score: 1 }));
    }

    const results: { filepath: string; meta: Record<string, unknown>; content: string; score: number }[] = [];
    for (const entity of allEntities) {
        const title = ((entity.meta.title as string) ?? '').toLowerCase();
        const tags = ((entity.meta.tags as string[]) ?? []).map(t => t.toLowerCase());
        const body = entity.content.toLowerCase();

        let score = 0;
        let allMatched = true;

        for (const token of searchTokens) {
            let matched = false;
            if (title.includes(token)) { score += 3; matched = true; }
            if (tags.some(tag => tag.includes(token))) { score += 2; matched = true; }
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
    options?: { tags?: string[]; metaOnly?: boolean },
): Promise<{ filepath: string; meta: Record<string, unknown>; content: string }[]> {
    const index = getEntityIndex();
    if (index.isBuilt) {
        let nodes = index.getNodes(entityType);

        if (options?.tags && options.tags.length > 0) {
            const filterTags = options.tags.map(t => t.toLowerCase());
            nodes = nodes.filter(n => {
                const nodeTags = n.tags.map(t => t.toLowerCase());
                return filterTags.some(ft => nodeTags.includes(ft));
            });
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

    if (options?.tags && options.tags.length > 0) {
        const filterTags = options.tags.map(t => t.toLowerCase());
        return entities.filter(e => {
            const entityTags = ((e.meta.tags as string[]) ?? []).map(t => t.toLowerCase());
            return filterTags.some(ft => entityTags.includes(ft));
        });
    }

    return entities;
}
