// ─────────────────────────────────────────────────────────────────────────────
// Context Tree — Hierarchical vault context for LLM consumption
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from '../platform/index.js';
import { getVaultContext, getSubdirectoryContext } from './reader.js';
import { getEntityIndex, type IndexNode, type IndexEdge } from '../index/entity-index.js';
import { loadEntityTypes, type EntityTypeConfig, type FieldDef } from '../schema/entity-type-config.js';
import { parseEntity } from '../storage/entity.js';
import { debug } from '../debug.js';

export type ContextScope =
    | { type: 'trunk' }
    | { type: 'branch'; branches: string[] }
    | { type: 'branch-full'; branches: string[] }
    | { type: 'leaves'; keys: string[] }
    | { type: 'cross'; branches: string[]; query?: string };

export interface ContextTreeTrunk {
    vaultContext: string;
    globals: Record<string, string>;
    stats: { totalEntities: number; entityTypes: string[] };
}

export interface ContextTreeField { key: string; type: string; values?: string[]; }
export interface ContextTreeLeaf { key: string; title: string; summary: string; meta: Record<string, unknown>; content?: string; }
export interface ContextTreeBranch { entityType: string; plural: string; description: string; fields: ContextTreeField[]; subdirectoryContext: string; leafCount: number; leaves: ContextTreeLeaf[]; }
export interface ContextTreeEdge { source: string; target: string; edgeType: string; label?: string; }
export interface ContextTree { trunk: ContextTreeTrunk; branches: ContextTreeBranch[]; edges: ContextTreeEdge[]; }

const MAX_LEAVES_PER_BRANCH = 50;
const MAX_FULL_CONTENT_LEAVES = 50;

function fieldToTreeField(f: FieldDef): ContextTreeField {
    const tf: ContextTreeField = { key: f.key, type: f.type };
    if (f.type === 'enum' && f.values) tf.values = f.values;
    return tf;
}

function indexNodeToLeaf(node: IndexNode, includeContent?: string): ContextTreeLeaf {
    return { key: `${node.type}:${node.id}`, title: node.title, summary: node.summary, meta: node.meta, content: includeContent };
}

async function buildTrunk(globals: Record<string, string>): Promise<ContextTreeTrunk> {
    const vaultContext = await getVaultContext().catch(() => '');
    const index = getEntityIndex();
    const stats = index.getStats();
    return { vaultContext, globals, stats: { totalEntities: stats.nodeCount, entityTypes: Object.keys(stats.byType) } };
}

async function buildBranch(typeConfig: EntityTypeConfig, leafMode: 'none' | 'summary' | 'full'): Promise<ContextTreeBranch> {
    const index = getEntityIndex();
    const subdirContext = await getSubdirectoryContext(typeConfig.directory).catch(() => '');
    const nodes = index.getNodes(typeConfig.name);
    let leaves: ContextTreeLeaf[] = [];

    if (leafMode === 'summary') {
        const sorted = [...nodes].sort((a, b) => ((b.meta.created as string) || '').localeCompare((a.meta.created as string) || ''));
        leaves = sorted.slice(0, MAX_LEAVES_PER_BRANCH).map(n => indexNodeToLeaf(n));
    } else if (leafMode === 'full') {
        const sorted = [...nodes].sort((a, b) => ((b.meta.created as string) || '').localeCompare((a.meta.created as string) || ''));
        const toLoad = sorted.slice(0, MAX_FULL_CONTENT_LEAVES);
        leaves = await Promise.all(toLoad.map(async (n) => {
            try {
                const raw = await getPlatform().storage.readFile(n.filepath);
                const { content } = parseEntity(n.filepath, raw);
                return indexNodeToLeaf(n, content);
            } catch { return indexNodeToLeaf(n); }
        }));
    }

    return {
        entityType: typeConfig.name, plural: typeConfig.plural, description: typeConfig.description || '',
        fields: typeConfig.fields.map(fieldToTreeField), subdirectoryContext: subdirContext,
        leafCount: nodes.length, leaves,
    };
}

function filterEdges(allEdges: IndexEdge[], includedKeys: Set<string>): ContextTreeEdge[] {
    return allEdges
        .filter(e => includedKeys.has(e.source) && includedKeys.has(e.target))
        .map(e => ({ source: e.source, target: e.target, edgeType: e.edgeType, label: e.label }));
}

export async function buildContextTree(scope: ContextScope, globals: Record<string, string>): Promise<ContextTree> {
    const entityTypes = await loadEntityTypes();
    const index = getEntityIndex();
    const trunk = await buildTrunk(globals);
    let branches: ContextTreeBranch[] = [];
    const includedLeafKeys = new Set<string>();

    switch (scope.type) {
        case 'trunk':
            branches = await Promise.all(entityTypes.map(t => buildBranch(t, 'none')));
            break;
        case 'branch':
            branches = await Promise.all(entityTypes.map(t => buildBranch(t, scope.branches.includes(t.name) ? 'summary' : 'none')));
            break;
        case 'branch-full':
            branches = await Promise.all(entityTypes.map(t => buildBranch(t, scope.branches.includes(t.name) ? 'full' : 'none')));
            break;
        case 'leaves': {
            const leafTypes = new Set<string>();
            for (const key of scope.keys) { const node = index.getNode(key); if (node) leafTypes.add(node.type); }
            branches = await Promise.all(entityTypes.map(t => buildBranch(t, leafTypes.has(t.name) ? 'summary' : 'none')));
            break;
        }
        case 'cross':
            branches = await Promise.all(entityTypes.map(t => buildBranch(t, scope.branches.includes(t.name) ? 'summary' : 'none')));
            break;
    }

    for (const branch of branches) { for (const leaf of branch.leaves) { includedLeafKeys.add(leaf.key); } }
    const edges = filterEdges(index.getAllEdges(), includedLeafKeys);

    debug('context-tree', `Built tree: scope=${scope.type}, branches=${branches.length}, leaves=${includedLeafKeys.size}, edges=${edges.length}`);
    return { trunk, branches, edges };
}

export async function expandContextTree(tree: ContextTree, additionalBranches: string[]): Promise<ContextTree> {
    const entityTypes = await loadEntityTypes();
    const existingTypes = new Set(tree.branches.map(b => b.entityType));

    for (const typeName of additionalBranches) {
        if (existingTypes.has(typeName)) {
            const existing = tree.branches.find(b => b.entityType === typeName)!;
            if (existing.leaves.length === 0 && existing.leafCount > 0) {
                const typeConfig = entityTypes.find(t => t.name === typeName);
                if (typeConfig) { const upgraded = await buildBranch(typeConfig, 'summary'); Object.assign(existing, upgraded); }
            }
            continue;
        }
        const typeConfig = entityTypes.find(t => t.name === typeName);
        if (typeConfig) { tree.branches.push(await buildBranch(typeConfig, 'summary')); }
    }

    const includedLeafKeys = new Set<string>();
    for (const branch of tree.branches) { for (const leaf of branch.leaves) { includedLeafKeys.add(leaf.key); } }
    const index = getEntityIndex();
    tree.edges = filterEdges(index.getAllEdges(), includedLeafKeys);
    return tree;
}
