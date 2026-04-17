// ─────────────────────────────────────────────────────────────────────────────
// ENTITY INDEX & RELATIONSHIP GRAPH
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from '../platform/index.js';
import { getFoundationRoot } from '../foundation.js';
import { parseEntity, type EntityTypeName, type EntityLink } from '../storage/entity.js';
import { loadEntityTypes } from '../schema/entity-type-config.js';
import { extractPeopleMentions, extractEntityRefs } from '../context/mentions.js';
import { debug } from '../debug.js';
import { BM25Index } from './bm25.js';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface IndexNode {
    id: string;
    type: EntityTypeName;
    title: string;
    filepath: string;
    tags: string[];
    summary: string;
    bodySnippet: string;
    meta: Record<string, unknown>;
}

export interface IndexSearchResult {
    node: IndexNode;
    score: number;
}

export interface IndexEdge {
    source: string;
    target: string;
    edgeType: 'mention' | 'reference' | 'link';
    label?: string;
}

export interface IndexStats {
    nodeCount: number;
    edgeCount: number;
    byType: Record<string, number>;
    builtAt: string;
}

function extractFrontmatterLinks(meta: Record<string, unknown>): EntityLink[] {
    const raw = meta.links;
    if (!Array.isArray(raw)) return [];
    const links: EntityLink[] = [];
    for (const item of raw) {
        if (item && typeof item === 'object' && typeof item.target === 'string' && typeof item.label === 'string') {
            links.push({ target: item.target, label: item.label });
        }
    }
    return links;
}

export class EntityIndex {
    private nodes = new Map<string, IndexNode>();
    private edges: IndexEdge[] = [];
    private _builtAt: Date | null = null;
    private bm25 = new BM25Index();

    private static key(type: EntityTypeName, id: string): string {
        return `${type}:${id}`;
    }

    async build(): Promise<void> {
        const { storage, paths } = getPlatform();
        const root = getFoundationRoot();
        const entityTypes = await loadEntityTypes();

        for (const typeConfig of entityTypes) {
            const entityType = typeConfig.name;
            const dir = paths.join(root, typeConfig.directory);

            try {
                const files = await storage.readdir(dir);
                for (const file of files) {
                    if (!file.endsWith('.md') || file.startsWith('.')) continue;
                    const filepath = paths.join(dir, file);
                    try {
                        const raw = await storage.readFile(filepath, 'utf-8');
                        const { meta, content } = parseEntity(filepath, raw);
                        const id = (meta.id as string) || paths.basename(file, '.md');
                        const key = EntityIndex.key(entityType, id);
                        const title = (meta.title as string) || id;
                        const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
                        const summary = (meta.summary as string) ?? '';
                        this.nodes.set(key, {
                            id, type: entityType, title, filepath,
                            tags, summary,
                            bodySnippet: content.slice(0, 500), meta,
                        });
                        this.bm25.addDocument(key, entityType, {
                            title, tags, summary, body: content,
                            customFields: meta,
                        });
                    } catch (err) {
                        debug('index', `Failed to parse ${filepath}: ${err}`);
                    }
                }
            } catch { /* Directory doesn't exist */ }
        }

        const typeNames = entityTypes.map(t => t.name);
        for (const typeConfig of entityTypes) {
            const entityType = typeConfig.name;
            const dir = paths.join(root, typeConfig.directory);
            try {
                const files = await storage.readdir(dir);
                for (const file of files) {
                    if (!file.endsWith('.md') || file.startsWith('.')) continue;
                    const filepath = paths.join(dir, file);
                    try {
                        const raw = await storage.readFile(filepath, 'utf-8');
                        const { meta, content } = parseEntity(filepath, raw);
                        const id = (meta.id as string) || paths.basename(file, '.md');
                        const sourceKey = EntityIndex.key(entityType, id);

                        for (const slug of extractPeopleMentions(content)) {
                            const targetKey = EntityIndex.key('person', slug);
                            if (this.nodes.has(targetKey)) {
                                this.edges.push({ source: sourceKey, target: targetKey, edgeType: 'mention' });
                            }
                        }

                        for (const ref of extractEntityRefs(content, typeNames)) {
                            const targetKey = EntityIndex.key(ref.type, ref.slug);
                            if (this.nodes.has(targetKey)) {
                                this.edges.push({ source: sourceKey, target: targetKey, edgeType: 'reference' });
                            }
                        }

                        for (const link of extractFrontmatterLinks(meta)) {
                            if (this.nodes.has(link.target)) {
                                this.edges.push({ source: sourceKey, target: link.target, edgeType: 'link', label: link.label });
                            }
                        }
                    } catch (err) {
                        debug('index', `Failed to extract refs from ${filepath}: ${err}`);
                    }
                }
            } catch { /* Directory doesn't exist */ }
        }

        this._builtAt = new Date();
        if (typeof process !== 'undefined' && process.env?.PHAIBEL_DEBUG === '1') {
            console.debug(`[index] Built index: ${this.nodes.size} nodes, ${this.edges.length} edges`);
        }
    }

    async rebuild(): Promise<void> {
        this.nodes.clear();
        this.edges = [];
        this.bm25.clear();
        this._builtAt = null;
        await this.build();
    }

    get isBuilt(): boolean {
        return this._builtAt !== null;
    }

    async addOrUpdate(type: EntityTypeName, id: string, title: string, filepath: string, tags?: string[], summary?: string): Promise<void> {
        const { storage } = getPlatform();
        const key = EntityIndex.key(type, id);

        let bodySnippet = '';
        let meta: Record<string, unknown> = {};
        try {
            const raw = await storage.readFile(filepath, 'utf-8');
            const parsed = parseEntity(filepath, raw);
            bodySnippet = parsed.content.slice(0, 500);
            meta = parsed.meta;
        } catch { /* keep defaults */ }

        const nodeTags = tags ?? [];
        const nodeSummary = summary ?? '';
        this.nodes.set(key, { id, type, title, filepath, tags: nodeTags, summary: nodeSummary, bodySnippet, meta });
        this.edges = this.edges.filter(e => e.source !== key);

        try {
            const raw = await storage.readFile(filepath, 'utf-8');
            const { meta, content } = parseEntity(filepath, raw);

            this.bm25.addDocument(key, type, {
                title, tags: nodeTags, summary: nodeSummary,
                body: content, customFields: meta,
            });

            for (const slug of extractPeopleMentions(content)) {
                const targetKey = EntityIndex.key('person', slug);
                if (this.nodes.has(targetKey)) {
                    this.edges.push({ source: key, target: targetKey, edgeType: 'mention' });
                }
            }

            const entityTypes = await loadEntityTypes();
            const typeNames = entityTypes.map(t => t.name);
            for (const ref of extractEntityRefs(content, typeNames)) {
                const targetKey = EntityIndex.key(ref.type, ref.slug);
                if (this.nodes.has(targetKey)) {
                    this.edges.push({ source: key, target: targetKey, edgeType: 'reference' });
                }
            }

            for (const link of extractFrontmatterLinks(meta)) {
                if (this.nodes.has(link.target)) {
                    this.edges.push({ source: key, target: link.target, edgeType: 'link', label: link.label });
                }
            }
        } catch (err) {
            debug('index', `Failed to scan edges for ${filepath}: ${err}`);
        }
    }

    remove(type: EntityTypeName, id: string): void {
        const key = EntityIndex.key(type, id);
        this.nodes.delete(key);
        this.bm25.removeDocument(key);
        this.edges = this.edges.filter(e => e.source !== key && e.target !== key);
    }

    search(query: string, entityType?: EntityTypeName): IndexSearchResult[] {
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

        if (searchTokens.length === 0 && tagTokens.length === 0) return [];

        // Tag-only query: return all matching nodes
        if (searchTokens.length === 0) {
            const results: IndexSearchResult[] = [];
            for (const node of this.nodes.values()) {
                if (entityType && node.type !== entityType) continue;
                const tagsLower = node.tags.map(t => t.toLowerCase());
                if (tagTokens.some(ft => tagsLower.includes(ft))) {
                    results.push({ node, score: 1 });
                }
            }
            return results;
        }

        // BM25 full-text search
        const searchQuery = searchTokens.join(' ');
        const bm25Results = this.bm25.search(searchQuery, entityType);

        // If tag filters are present, filter BM25 results by tag
        let filtered = bm25Results;
        if (tagTokens.length > 0) {
            filtered = bm25Results.filter(r => {
                const node = this.nodes.get(r.key);
                if (!node) return false;
                const tagsLower = node.tags.map(t => t.toLowerCase());
                return tagTokens.some(ft => tagsLower.includes(ft));
            });
        }

        // Map BM25 results to IndexSearchResult
        const results: IndexSearchResult[] = [];
        for (const r of filtered) {
            const node = this.nodes.get(r.key);
            if (node) results.push({ node, score: r.score });
        }
        return results;
    }

    findByTitle(entityType: EntityTypeName, titleOrId: string): IndexNode | null {
        const needle = titleOrId.toLowerCase();
        let partialMatch: IndexNode | null = null;

        for (const node of this.nodes.values()) {
            if (node.type !== entityType) continue;
            if (node.id === titleOrId || node.title.toLowerCase() === needle) return node;
            if (!partialMatch) {
                const titleLower = node.title.toLowerCase();
                if (titleLower.includes(needle) || needle.includes(titleLower)) {
                    partialMatch = node;
                }
            }
        }

        return partialMatch;
    }

    getNode(key: string): IndexNode | undefined { return this.nodes.get(key); }
    getNodes(type?: EntityTypeName): IndexNode[] {
        const all = [...this.nodes.values()];
        return type ? all.filter(n => n.type === type) : all;
    }
    getEdgesFrom(key: string): IndexEdge[] { return this.edges.filter(e => e.source === key); }
    getEdgesTo(key: string): IndexEdge[] { return this.edges.filter(e => e.target === key); }

    getNeighbors(key: string): { node: IndexNode; direction: 'out' | 'in'; edgeType: string; label?: string }[] {
        const results: { node: IndexNode; direction: 'out' | 'in'; edgeType: string; label?: string }[] = [];
        const seen = new Set<string>();
        for (const edge of this.edges) {
            if (edge.source === key && !seen.has(`out:${edge.target}`)) {
                const node = this.nodes.get(edge.target);
                if (node) { results.push({ node, direction: 'out', edgeType: edge.edgeType, label: edge.label }); seen.add(`out:${edge.target}`); }
            }
            if (edge.target === key && !seen.has(`in:${edge.source}`)) {
                const node = this.nodes.get(edge.source);
                if (node) { results.push({ node, direction: 'in', edgeType: edge.edgeType, label: edge.label }); seen.add(`in:${edge.source}`); }
            }
        }
        return results;
    }

    getAllEdges(): IndexEdge[] { return [...this.edges]; }

    getStats(): IndexStats {
        const byType: Record<string, number> = {};
        for (const node of this.nodes.values()) {
            byType[node.type] = (byType[node.type] || 0) + 1;
        }
        return {
            nodeCount: this.nodes.size,
            edgeCount: this.edges.length,
            byType,
            builtAt: this._builtAt?.toISOString() || 'never',
        };
    }
}

// Singleton
let _index: EntityIndex | null = null;

export function getEntityIndex(): EntityIndex {
    if (!_index) _index = new EntityIndex();
    return _index;
}

export function resetEntityIndex(): void {
    _index = null;
}
