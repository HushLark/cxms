// ─────────────────────────────────────────────────────────────────────────────
// Scope Classifier — Heuristic scope selection for context tree
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextScope } from './context-tree.js';
import type { EntityTypeConfig } from '../schema/entity-type-config.js';
import type { IndexStats } from '../index/entity-index.js';

const FULL_KEYWORDS = /\b(all|every|reflect|review|list|summarize|summary|overview|report|show me|audit|analyze|breakdown|digest)\b/i;
const CROSS_KEYWORDS = /\b(relat|connect|across|between|link|depend|impact|affect|overlap)\b/i;

export function classifyScope(
    userInput: string,
    entityTypes: EntityTypeConfig[],
    _stats: IndexStats,
): ContextScope {
    const input = userInput.toLowerCase();
    const mentionedTypes: string[] = [];
    for (const et of entityTypes) {
        if (input.includes(et.name) || input.includes(et.plural)) mentionedTypes.push(et.name);
    }

    if (CROSS_KEYWORDS.test(input) && mentionedTypes.length >= 2) return { type: 'cross', branches: mentionedTypes };
    if (CROSS_KEYWORDS.test(input) && mentionedTypes.length === 0) return { type: 'cross', branches: entityTypes.map(t => t.name) };
    if (FULL_KEYWORDS.test(input) && mentionedTypes.length > 0) return { type: 'branch-full', branches: mentionedTypes };
    if (mentionedTypes.length > 0) return { type: 'branch', branches: mentionedTypes };
    return { type: 'trunk' };
}
