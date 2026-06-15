// ─────────────────────────────────────────────────────────────────────────────
// Query Relevance Filter — Deterministic catalog node pre-filter
// ─────────────────────────────────────────────────────────────────────────────

import type { EntityTypeConfig } from '../schema/entity-type-config.js';
import type { EntityIndex } from '../index/entity-index.js';

const STOP_WORDS = new Set([
    'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
    'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
    'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs',
    'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
    'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
    'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above',
    'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
    'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
    'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's',
    't', 'can', 'will', 'just', 'don', 'should', 'now', 'd', 'll', 'm', 'o', 're',
    've', 'y', 'ain', 'aren', 'couldn', 'didn', 'doesn', 'hadn', 'hasn', 'haven',
    'isn', 'ma', 'mightn', 'mustn', 'needn', 'shan', 'shouldn', 'wasn', 'weren',
    'won', 'wouldn', 'could', 'would', 'might', 'must', 'shall', 'need',
    'want', 'know', 'think', 'make', 'go', 'get', 'take', 'come', 'see', 'look',
    'give', 'tell', 'say', 'help', 'let', 'try', 'keep', 'put', 'set', 'show',
    'add', 'create', 'update', 'delete', 'remove', 'change', 'mark', 'find',
    'list', 'search', 'check', 'remember', 'save', 'track', 'also', 'please',
    'like', 'new', 'today', 'tomorrow', 'yesterday', 'next', 'last', 'first',
    'really', 'something', 'thing', 'things', 'stuff', 'much', 'many', 'well',
]);

const ACTION_TYPE_HINTS: Record<string, string[]> = {
    'appointment': ['event'], 'meeting': ['event'], 'schedule': ['event'], 'calendar': ['event'],
    'deadline': ['task', 'event'], 'todo': ['task'], 'done': ['task'], 'complete': ['task'],
    'finish': ['task'], 'buy': ['task'], 'call': ['task', 'person'], 'email': ['task', 'person'],
    'contact': ['person'], 'meet': ['person', 'event'], 'goal': ['goal'], 'achieve': ['goal'],
    'objective': ['goal'], 'idea': ['note'], 'note': ['note'], 'remember': ['note'],
    'password': ['note'], 'recipe': ['note'], 'stop': ['todont'], 'quit': ['todont'],
    'avoid': ['todont'], 'never': ['todont'], 'recurring': ['recurrence'], 'repeat': ['recurrence'],
    'every': ['recurrence'], 'daily': ['recurrence'], 'weekly': ['recurrence'], 'monthly': ['recurrence'],
};

export interface RelevanceResult {
    keywords: string[];
    relevantTypes: RelevantType[];
    mentionedTypes: string[];
    relevanceHint: string;
    filteredNodeCount: number;
    totalNodeCount: number;
}

export interface RelevantType {
    type: string;
    reason: 'mentioned' | 'entity_match' | 'action_hint' | 'always';
    matchCount: number;
    matchSamples: string[];
}

export function extractKeywords(input: string): string[] {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

export function analyzeQueryRelevance(
    userInput: string,
    entityTypes: EntityTypeConfig[],
    entityIndex: EntityIndex,
): RelevanceResult {
    const keywords = extractKeywords(userInput);
    const inputLower = userInput.toLowerCase();
    const typeMap = new Map<string, RelevantType>();

    const mentionedTypes: string[] = [];
    for (const et of entityTypes) {
        if (inputLower.includes(et.name) || inputLower.includes(et.plural)) {
            mentionedTypes.push(et.name);
            typeMap.set(et.name, { type: et.name, reason: 'mentioned', matchCount: 0, matchSamples: [] });
        }
    }

    const matchesByType = new Map<string, { count: number; samples: string[] }>();
    for (const keyword of keywords) {
        if (!entityIndex.isBuilt) break;
        const results = entityIndex.search(keyword);
        for (const result of results) {
            const type = result.node.type;
            const existing = matchesByType.get(type) ?? { count: 0, samples: [] };
            existing.count++;
            if (existing.samples.length < 3 && !existing.samples.includes(result.node.title)) existing.samples.push(result.node.title);
            matchesByType.set(type, existing);
        }
    }

    for (const [type, matches] of matchesByType) {
        if (!typeMap.has(type)) {
            typeMap.set(type, { type, reason: 'entity_match', matchCount: matches.count, matchSamples: matches.samples });
        } else {
            const existing = typeMap.get(type)!;
            existing.matchCount = matches.count;
            existing.matchSamples = matches.samples;
        }
    }

    for (const keyword of keywords) {
        const hints = ACTION_TYPE_HINTS[keyword];
        if (hints) {
            for (const type of hints) {
                if (entityTypes.some(et => et.name === type) && !typeMap.has(type)) {
                    typeMap.set(type, { type, reason: 'action_hint', matchCount: 0, matchSamples: [] });
                }
            }
        }
    }

    const relevantTypes = Array.from(typeMap.values());
    if (relevantTypes.length === 0) {
        for (const et of entityTypes) {
            relevantTypes.push({ type: et.name, reason: 'always', matchCount: 0, matchSamples: [] });
        }
    }

    const hintParts: string[] = [];
    for (const keyword of keywords) {
        const typeCounts: string[] = [];
        for (const [type] of matchesByType) {
            const kwMatches = entityIndex.search(keyword).filter(r => r.node.type === type);
            if (kwMatches.length > 0) typeCounts.push(`${type}:${kwMatches.length}`);
        }
        if (typeCounts.length > 0) hintParts.push(`"${keyword}" → ${typeCounts.join(', ')}`);
    }

    return {
        keywords, relevantTypes, mentionedTypes,
        relevanceHint: hintParts.length > 0 ? hintParts.join('\n') : '',
        filteredNodeCount: 0, totalNodeCount: 0,
    };
}

/**
 * Generic catalog node filter. Accepts any object with a `key` and `group` property.
 */
export function filterCatalogNodes<T extends { key: string; group: string }>(
    allNodes: T[],
    relevantTypes: RelevantType[],
    entityTypes: EntityTypeConfig[],
): T[] {
    const relevantTypeNames = new Set(relevantTypes.map(rt => rt.type));

    return allNodes.filter(node => {
        if (node.group !== 'entity') return true;
        const key = node.key;
        if (
            key === 'search_all_entities' || key === 'create_content_type' ||
            key === 'update_content_type' || key === 'link_entities' ||
            key === 'create_recurring_task' || key.startsWith('import_')
        ) return true;

        for (const et of entityTypes) {
            if (
                key === `list_${et.plural}` || key === `search_${et.plural}` ||
                key === `find_${et.name}` || key === `create_${et.name}` ||
                key === `update_${et.name}` || key === `delete_${et.name}` ||
                key === `complete_${et.name}` || key === `sort_${et.plural}` ||
                key === `load_vault_context_${et.name}` || key === `review_${et.name}` ||
                key === `questions_${et.name}` ||
                key.startsWith(`set_${et.name}_`)
            ) {
                return relevantTypeNames.has(et.name);
            }
        }

        return true;
    });
}
