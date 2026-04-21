// ─────────────────────────────────────────────────────────────────────────────
// CxMS CXF Serializer — converts context nodes to a CXF/1 document.
// No LLM involvement. Implements CXF-SPEC.md §4–§8.
// ─────────────────────────────────────────────────────────────────────────────

import type { EntityTypeConfig, FieldDef } from '../schema/entity-type-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ContextNodeRecord {
    filepath: string;
    meta: Record<string, unknown>;
    content: string;
}

export interface CxfSerializeOpts {
    vaultId: string;
    ownerName: string;
    exportTime: number;        // Unix seconds
    includeSchema: boolean;
    includeGraph: boolean;
}

export interface CxfSerializeResult {
    document: string;
    entityCount: number;
    schemaCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LINE FOLDING (RFC 5545 §3.1)
// ─────────────────────────────────────────────────────────────────────────────

function foldLine(line: string): string {
    const LIMIT = 75;
    if (Buffer.byteLength(line, 'utf8') <= LIMIT) return line;
    const parts: string[] = [];
    let current = '';
    for (const char of line) {
        if (Buffer.byteLength(current + char, 'utf8') > LIMIT) {
            parts.push(current);
            current = ' ' + char;
        } else {
            current += char;
        }
    }
    if (current) parts.push(current);
    return parts.join('\r\n');
}

function prop(name: string, value: string | undefined | null): string {
    if (value === undefined || value === null || value === '') return '';
    return foldLine(`${name}:${value}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function toIcsDate(iso: string | undefined | null): string {
    if (!iso) return '';
    const d = iso.replace(/[-:]/g, '').split('.')[0];
    if (iso.length <= 10) return d.slice(0, 8);
    return d.endsWith('Z') ? d : d + 'Z';
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS / PRIORITY
// ─────────────────────────────────────────────────────────────────────────────

function mapStatus(status: string | undefined, typeName: string): { icsStatus: string; ext: string } {
    if (typeName === 'todont') {
        const map: Record<string, string> = {
            'open': 'NEEDS-ACTION', 'in-progress': 'IN-PROCESS',
            'done': 'COMPLETED', 'blocked': 'IN-PROCESS', 'cancelled': 'CANCELLED',
        };
        return { icsStatus: map[status ?? 'in-progress'] ?? 'IN-PROCESS', ext: status === 'blocked' ? 'blocked' : '' };
    }
    const map: Record<string, string> = {
        open: 'NEEDS-ACTION', 'in-progress': 'IN-PROCESS', done: 'COMPLETED',
        blocked: 'IN-PROCESS', active: 'IN-PROCESS', completed: 'COMPLETED',
        paused: 'IN-PROCESS', abandoned: 'CANCELLED',
    };
    const ext = status === 'blocked' ? 'blocked' : status === 'paused' ? 'paused' : '';
    return { icsStatus: map[status ?? 'open'] ?? 'NEEDS-ACTION', ext };
}

function mapPriority(priority: string | undefined): string {
    const map: Record<string, string> = { critical: '1', high: '3', medium: '5', low: '9' };
    return map[priority ?? ''] ?? '0';
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE LINKS
// ─────────────────────────────────────────────────────────────name───────────

interface ContextRef { target?: string; label?: string; id?: string; type?: string; }

function buildLinkLines(meta: Record<string, unknown>, vaultId: string): string {
    const refs = meta.references;
    if (!Array.isArray(refs)) return '';
    return refs
        .filter((r): r is ContextRef => r && typeof r === 'object')
        .map(r => {
            const target = r.target ?? (r.type && r.id ? `${r.type}:${r.id}` : null);
            if (!target) return '';
            const label = r.label ?? 'link';
            return foldLine(`X-CXF-LINK;LABEL=${label};EDGE=link:${target}@${vaultId}`);
        })
        .filter(Boolean)
        .join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// VSCHEMA
// ─────────────────────────────────────────────────────────────────────────────

function fieldTypeToCxf(f: FieldDef): string {
    const map: Record<string, string> = {
        string: 'TEXT', number: 'NUMBER', boolean: 'BOOLEAN',
        date: 'DATE', datetime: 'DATETIME', duration: 'DURATION',
        enum: 'ENUM', array: 'ARRAY', object: 'OBJECT',
    };
    return map[f.type] ?? 'TEXT';
}

function buildVSchema(typeConfig: EntityTypeConfig): string {
    const lines: string[] = [
        'BEGIN:VSCHEMA',
        prop('X-CXF-TYPE-NAME', typeConfig.name),
        prop('X-CXF-PLURAL', typeConfig.plural),
        typeConfig.description ? prop('X-CXF-DESCRIPTION', typeConfig.description.replace(/\n/g, '\\n')) : '',
    ];
    for (const f of typeConfig.fields) {
        const required = f.required ? ';REQUIRED=TRUE' : '';
        const values = f.values?.length ? `;VALUES=${f.values.join(',')}` : '';
        lines.push(foldLine(`X-CXF-FIELD;KEY=${f.key};TYPE=${fieldTypeToCxf(f)}${required}${values}:${f.label ?? f.key}`));
    }
    lines.push('END:VSCHEMA');
    return lines.filter(Boolean).join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

const VTODO_TYPES = new Set(['task', 'goal', 'todont']);
const VEVENT_TYPES = new Set(['event']);
const VJOURNAL_TYPES = new Set(['note']);

function nodeToComponent(
    record: ContextNodeRecord,
    typeName: string,
    opts: CxfSerializeOpts,
    archived: boolean,
    deleted: boolean,
): string {
    const m = record.meta;
    const uid = `${m.id}@${opts.vaultId}`;
    const created = toIcsDate(m.created as string);
    const updated = toIcsDate((m.updated ?? m.created) as string);
    const tags = Array.isArray(m.tags) ? (m.tags as string[]).join(',') : '';
    const description = record.content
        ? record.content.replace(/\n/g, '\\n').slice(0, 65535)
        : '';

    const linkLines = opts.includeGraph ? buildLinkLines(m, opts.vaultId) : '';

    const systemKeys = new Set([
        'id', 'title', 'entityType', 'contextType', 'created', 'updated',
        'tags', 'summary', 'references', 'archivedAt', '_filepath',
        'status', 'priority', 'dueDate', 'startDate', 'location', 'duration',
    ]);

    if (VTODO_TYPES.has(typeName)) {
        const { icsStatus, ext } = mapStatus(m.status as string, typeName);
        const lines = [
            'BEGIN:VTODO',
            prop('UID', uid),
            prop('SUMMARY', m.title as string),
            description ? prop('DESCRIPTION', description) : '',
            m.startDate ? prop('DTSTART', toIcsDate(m.startDate as string)) : '',
            m.dueDate ? prop('DUE', toIcsDate(m.dueDate as string)) : '',
            prop('PRIORITY', mapPriority(m.priority as string)),
            prop('STATUS', icsStatus),
            ext ? prop('X-CXF-STATUS-EXT', ext) : '',
            tags ? prop('CATEGORIES', tags) : '',
            prop('CREATED', created),
            prop('LAST-MODIFIED', updated),
            linkLines || '',
            prop('X-CXF-ID', m.id as string),
            prop('X-CXF-TYPE', typeName),
            prop('X-CXF-VAULT', opts.vaultId),
            typeName === 'todont' && m.reason ? prop('X-CXF-FIELD-REASON', String(m.reason)) : '',
            archived ? 'X-CXF-ARCHIVED:TRUE' : '',
            deleted ? 'X-CXF-DELETED:TRUE' : '',
            'END:VTODO',
        ];
        return lines.filter(Boolean).join('\r\n');
    }

    if (VEVENT_TYPES.has(typeName)) {
        const lines = [
            'BEGIN:VEVENT',
            prop('UID', uid),
            prop('SUMMARY', m.title as string),
            description ? prop('DESCRIPTION', description) : '',
            m.startDate ? prop('DTSTART', toIcsDate(m.startDate as string)) : '',
            m.endDate ? prop('DTEND', toIcsDate(m.endDate as string)) : '',
            m.duration ? prop('DURATION', String(m.duration)) : '',
            m.location ? prop('LOCATION', String(m.location).replace(/,/g, '\\,')) : '',
            tags ? prop('CATEGORIES', tags) : '',
            prop('CREATED', created),
            prop('LAST-MODIFIED', updated),
            linkLines || '',
            prop('X-CXF-ID', m.id as string),
            prop('X-CXF-TYPE', typeName),
            prop('X-CXF-VAULT', opts.vaultId),
            archived ? 'X-CXF-ARCHIVED:TRUE' : '',
            deleted ? 'X-CXF-DELETED:TRUE' : '',
            'END:VEVENT',
        ];
        return lines.filter(Boolean).join('\r\n');
    }

    if (VJOURNAL_TYPES.has(typeName)) {
        const lines = [
            'BEGIN:VJOURNAL',
            prop('UID', uid),
            prop('SUMMARY', m.title as string),
            description ? prop('DESCRIPTION', description) : '',
            prop('DTSTART', created.slice(0, 8)),
            tags ? prop('CATEGORIES', tags) : '',
            prop('CREATED', created),
            prop('LAST-MODIFIED', updated),
            linkLines || '',
            prop('X-CXF-ID', m.id as string),
            prop('X-CXF-TYPE', typeName),
            prop('X-CXF-VAULT', opts.vaultId),
            archived ? 'X-CXF-ARCHIVED:TRUE' : '',
            deleted ? 'X-CXF-DELETED:TRUE' : '',
            'END:VJOURNAL',
        ];
        return lines.filter(Boolean).join('\r\n');
    }

    // VCONTEXT — all other types
    const lines = [
        'BEGIN:VCONTEXT',
        prop('UID', uid),
        prop('SUMMARY', m.title as string),
        description ? prop('DESCRIPTION', description) : '',
        tags ? prop('CATEGORIES', tags) : '',
        prop('CREATED', created),
        prop('LAST-MODIFIED', updated),
        prop('X-CXF-ID', m.id as string),
        prop('X-CXF-TYPE', typeName),
        prop('X-CXF-VAULT', opts.vaultId),
    ];

    // Custom fields
    for (const [k, v] of Object.entries(m)) {
        if (systemKeys.has(k) || v === undefined || v === null || v === '') continue;
        const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        lines.push(foldLine(`X-CXF-FIELD-${k.toUpperCase()}:${val}`));
    }

    if (linkLines) lines.push(linkLines);

    lines.push(
        archived ? 'X-CXF-ARCHIVED:TRUE' : '',
        deleted ? 'X-CXF-DELETED:TRUE' : '',
        'END:VCONTEXT',
    );
    return lines.filter(Boolean).join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export function serializeCxmsToCxf(
    records: Array<{ typeName: string; nodes: ContextNodeRecord[] }>,
    entityTypes: EntityTypeConfig[],
    opts: CxfSerializeOpts,
): CxfSerializeResult {
    const components: string[] = [];
    const typeNamesWithNodes = new Set(records.flatMap(r => r.nodes.length > 0 ? [r.typeName] : []));

    if (opts.includeSchema) {
        for (const t of entityTypes) {
            if (typeNamesWithNodes.has(t.name)) {
                components.push(buildVSchema(t));
            }
        }
    }

    let totalNodes = 0;
    for (const { typeName, nodes } of records) {
        for (const record of nodes) {
            const archived = !!(record.meta.archivedAt as string | undefined);
            const deleted = false; // trashed nodes are not included — they appear as tombstones if needed
            components.push(nodeToComponent(record, typeName, opts, archived, deleted));
            totalNodes++;
        }
    }

    const header = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//CxMS//CxMS CXF v1//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        prop('X-CXF-VERSION', '1'),
        prop('X-CXF-VAULT', opts.vaultId),
        prop('X-CXF-EXPORT-TIME', String(opts.exportTime)),
        prop('X-CXF-OWNER-NAME', opts.ownerName),
    ].filter(Boolean).join('\r\n');

    const body = components.join('\r\n');
    const document = `${header}\r\n${body}\r\nEND:VCALENDAR`;

    return {
        document,
        entityCount: totalNodes,
        schemaCount: opts.includeSchema ? typeNamesWithNodes.size : 0,
    };
}
