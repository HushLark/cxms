// ─────────────────────────────────────────────────────────────────────────────
// Context Tree Serializer — Token-efficient text format for LLM consumption
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextTree, ContextTreeBranch, ContextTreeLeaf, ContextTreeEdge } from './context-tree.js';

const MAX_CONTEXT_TREE_TOKENS = 8000;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function serializeTrunk(tree: ContextTree): string {
    const lines: string[] = [];
    if (tree.trunk.vaultContext) { lines.push('## Trunk (Vault Root)'); lines.push(tree.trunk.vaultContext); lines.push(''); }
    lines.push('## Globals');
    for (const [key, value] of Object.entries(tree.trunk.globals)) lines.push(`- ${key}: ${value}`);
    lines.push(`- total_entities: ${tree.trunk.stats.totalEntities}`);
    lines.push(`- entity_types: ${tree.trunk.stats.entityTypes.join(', ')}`);
    lines.push('');
    return lines.join('\n');
}

function serializeLeafMeta(leaf: ContextTreeLeaf): string {
    const metaParts: string[] = [];
    const skipKeys = new Set(['id', 'title', 'entityType', 'created', 'updated', 'tags', 'summary', '_filepath', 'links', 'bodySnippet']);
    for (const [key, value] of Object.entries(leaf.meta)) {
        if (skipKeys.has(key)) continue;
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value) || typeof value === 'object') continue;
        metaParts.push(`${key}=${value}`);
    }
    const metaStr = metaParts.length > 0 ? ` [${metaParts.join(', ')}]` : '';
    const tagsStr = leaf.tags.length > 0 ? ` ${leaf.tags.map(t => `#${t}`).join(' ')}` : '';
    const summaryStr = leaf.summary ? ` — ${leaf.summary}` : '';
    return `- "${leaf.title}"${metaStr}${tagsStr}${summaryStr}`;
}

function serializeBranch(branch: ContextTreeBranch): string {
    const lines: string[] = [];
    lines.push(`## Branch: ${branch.plural} (${branch.leafCount} items)`);
    if (branch.description) lines.push(branch.description);
    if (branch.fields.length > 0) {
        const fieldDescs = branch.fields.map(f => f.values ? `${f.key}:enum(${f.values.join('|')})` : `${f.key}:${f.type}`);
        lines.push(`Fields: ${fieldDescs.join(', ')}`);
    }
    if (branch.subdirectoryContext) { lines.push(''); lines.push(branch.subdirectoryContext); }
    if (branch.leaves.length > 0) {
        lines.push(''); lines.push('### Entities:');
        for (const leaf of branch.leaves) {
            if (leaf.content !== undefined) {
                lines.push(`#### ${leaf.title} (${leaf.key})`);
                const tagsStr = leaf.tags.length > 0 ? `Tags: ${leaf.tags.map(t => `#${t}`).join(' ')}` : '';
                if (tagsStr) lines.push(tagsStr);
                if (leaf.summary) lines.push(`Summary: ${leaf.summary}`);
                if (leaf.content) { lines.push(''); lines.push(leaf.content); }
                lines.push('');
            } else {
                lines.push(serializeLeafMeta(leaf));
            }
        }
        const omitted = branch.leafCount - branch.leaves.length;
        if (omitted > 0) lines.push(`... and ${omitted} more ${branch.plural}`);
    }
    lines.push('');
    return lines.join('\n');
}

function serializeEdges(edges: ContextTreeEdge[]): string {
    if (edges.length === 0) return '';
    const lines: string[] = ['## Connections'];
    for (const edge of edges) { lines.push(`- ${edge.source} ──${edge.label || edge.edgeType}──▶ ${edge.target}`); }
    lines.push('');
    return lines.join('\n');
}

export function serializeContextTree(tree: ContextTree): string {
    const sections: string[] = ['CONTEXT TREE:', ''];
    sections.push(serializeTrunk(tree));
    for (const branch of tree.branches) sections.push(serializeBranch(branch));
    sections.push(serializeEdges(tree.edges));
    let result = sections.join('\n');

    const tokens = estimateTokens(result);
    if (tokens > MAX_CONTEXT_TREE_TOKENS) {
        const trimmedSections: string[] = ['CONTEXT TREE:', ''];
        trimmedSections.push(serializeTrunk(tree));
        for (const branch of tree.branches) {
            const trimmedBranch = { ...branch };
            if (trimmedBranch.leaves.length > 20) trimmedBranch.leaves = trimmedBranch.leaves.slice(0, 20);
            trimmedBranch.leaves = trimmedBranch.leaves.map(l => ({ ...l, content: l.content ? l.content.slice(0, 200) + '...' : undefined }));
            trimmedSections.push(serializeBranch(trimmedBranch));
        }
        trimmedSections.push(serializeEdges(tree.edges.slice(0, 30)));
        result = trimmedSections.join('\n');
    }

    return result;
}
