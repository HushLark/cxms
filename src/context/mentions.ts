// ─────────────────────────────────────────────────────────────────────────────
// Entity Cross-References & @Mentions
// ─────────────────────────────────────────────────────────────────────────────

import { findEntityByTitle, type EntityTypeName } from '../storage/entity.js';
import { listEntityTypeNames } from '../schema/entity-type-config.js';
import { debug } from '../debug.js';

const DEFAULT_ENTITY_TYPES: readonly string[] = [
    'note', 'task', 'todo', 'event', 'research', 'goal', 'recurrence', 'person',
];

export function extractPeopleMentions(text: string): string[] {
    const matches = new Set<string>();
    const re = /(?:^|(?<=\s))@([a-z0-9][-a-z0-9]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        matches.add(m[1]);
    }
    return [...matches];
}

export function extractEntityRefs(text: string, validTypes?: readonly string[]): { type: EntityTypeName; slug: string }[] {
    const types = validTypes ?? DEFAULT_ENTITY_TYPES;
    const refs: { type: EntityTypeName; slug: string }[] = [];
    const seen = new Set<string>();
    const typePattern = [...new Set([...types, 'todo'])].join('|');
    const re = new RegExp(`\\b(${typePattern}):([a-z0-9][-a-z0-9]*)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const key = `${m[1]}:${m[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const type = m[1] === 'todo' ? 'task' : m[1];
        refs.push({ type: type as EntityTypeName, slug: m[2] });
    }
    return refs;
}

function formatPersonContext(meta: Record<string, unknown>): string {
    const parts: string[] = [meta.title as string || 'Unknown'];
    if (meta.company) parts.push(`company: ${meta.company}`);
    if (meta.group) parts.push(`group: ${meta.group}`);
    if (meta.handle) parts.push(`handle: @${meta.handle}`);
    if (meta.email) parts.push(`email: ${meta.email}`);
    if (meta.phone) parts.push(`phone: ${meta.phone}`);
    return parts.join(' | ');
}

function formatEntityContext(type: string, meta: Record<string, unknown>, content: string): string {
    const title = (meta.title as string) || 'Untitled';
    const excerpt = content.length > 200 ? content.slice(0, 200) + '…' : content;
    const metaParts: string[] = [];
    if (meta.priority) metaParts.push(`priority=${meta.priority}`);
    if (meta.status) metaParts.push(`status=${meta.status}`);
    if (meta.dueDate) metaParts.push(`due=${meta.dueDate}`);
    const metaStr = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
    return `[${type}] ${title}${metaStr}: ${excerpt}`;
}

export async function resolveReferences(text: string): Promise<string> {
    const sections: string[] = [];

    let typeNames: string[] | undefined;
    try {
        typeNames = await listEntityTypeNames();
    } catch { /* Fall back to hardcoded defaults */ }

    const peopleSlugs = extractPeopleMentions(text);
    if (peopleSlugs.length > 0) {
        const lines: string[] = [];
        for (const slug of peopleSlugs) {
            try {
                const found = await findEntityByTitle('person', slug);
                if (found) lines.push(`- ${formatPersonContext(found.meta)}`);
            } catch (err) {
                debug('mentions', `Failed to resolve @${slug}: ${err}`);
            }
        }
        if (lines.length > 0) sections.push('REFERENCED PEOPLE:\n' + lines.join('\n'));
    }

    const entityRefs = extractEntityRefs(text, typeNames);
    if (entityRefs.length > 0) {
        const lines: string[] = [];
        for (const ref of entityRefs) {
            try {
                const found = await findEntityByTitle(ref.type, ref.slug);
                if (found) lines.push(`- ${formatEntityContext(ref.type, found.meta, found.content)}`);
            } catch (err) {
                debug('mentions', `Failed to resolve ${ref.type}:${ref.slug}: ${err}`);
            }
        }
        if (lines.length > 0) sections.push('REFERENCED ENTITIES:\n' + lines.join('\n'));
    }

    return sections.join('\n\n');
}
