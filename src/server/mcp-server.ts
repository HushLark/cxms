// ─────────────────────────────────────────────────────────────────────────────
// CxMS — MCP Server
// ─────────────────────────────────────────────────────────────────────────────
// Exposes the CxMS as an MCP tool server so any MCP-compatible client
// (Claude Desktop, Cursor, etc.) can manage Foundation data.
//
// Tools:
//   Context Types:  list_types, get_type, create_type, update_type, delete_type
//   Context Nodes:  list_nodes, get_node, create_node, update_node, delete_node
//   Search:         search, batch_get_nodes, search_by_tag, search_by_date_range
//   Context:        get_node_summary, count_nodes, get_moment, get_context_tree
//   Collections:    list_collections, get_collection, set_collection_item,
//                   remove_collection_item
//   System:         health, get_analytics, onboard_status
// ─────────────────────────────────────────────────────────────────────────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type http from 'http';
import { findFoundationRoot } from '../foundation.js';
import { getInstanceIdentity } from './system-config.js';
import { debug } from '../debug.js';

// Schema
import {
    loadEntityTypes,
    getEntityType,
    addEntityType,
    updateEntityType,
    removeEntityType,
} from '../schema/entity-type-config.js';
import type { EntityTypeConfig } from '../schema/entity-type-config.js';

// Storage
import {
    listEntities,
    findEntityByTitle,
    searchEntities,
    writeEntity,
    trashEntity,
    generateNodeId,
    ensureEntityDir,
    nodeFilename,
    parseEntity,
} from '../storage/entity.js';
import { validateEntity, formatValidationErrors } from '../storage/entity-validator.js';

// Collections
import {
    listCollections,
    loadCollection,
    getCollectionItem,
    setCollectionItem,
    removeCollectionItem,
} from '../storage/collections.js';

// Index
import { getEntityIndex } from '../index/entity-index.js';

// Context
import { buildMomentContext, formatMomentBlock } from '../context/moment.js';
import { buildContextTree, type ContextScope } from '../context/context-tree.js';
import { serializeContextTree } from '../context/context-tree-serializer.js';
import { getVaultContext, getSubdirectoryContext } from '../context/reader.js';
import { getPlatform } from '../platform/index.js';
import { getVaultAnalytics } from '../analytics.js';
import { getOnboardingStatus } from '../onboarding/index.js';

// ─────────────────────────────────────────────────────────────────────────────

let _server: McpServer | null = null;
let _transport: StreamableHTTPServerTransport | null = null;

function ok(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
}

function getOrCreateServer(): McpServer {
    if (_server) return _server;

    _server = new McpServer(
        { name: 'cxms', version: '1.0.0' },
        { capabilities: { tools: { listChanged: false } } },
    );

    registerTools(_server);
    return _server;
}

function registerTools(server: McpServer): void {
    // ── Health ────────────────────────────────────────────────────────────

    server.tool(
        'health',
        'Check CxMS health — foundation path, context type count, index stats.',
        {},
        async () => {
            try {
                const root = findFoundationRoot();
                const types = await loadEntityTypes();
                const index = getEntityIndex();
                const stats = index.isBuilt ? index.getStats() : null;
                const { name, description } = getInstanceIdentity();
                return ok({
                    status: root ? 'ok' : 'no_foundation',
                    name,
                    description,
                    foundation: root,
                    contextTypes: types.length,
                    index: stats ? { nodes: stats.nodeCount, edges: stats.edgeCount } : null,
                });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'get_analytics',
        'Get vault analytics: disk usage (total bytes, formatted), file counts, trash size, and node count per context type.',
        {},
        async () => {
            try {
                return ok(await getVaultAnalytics());
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'onboard_status',
        'Check whether this Foundation has been onboarded — returns completion status, user name, agent name, and role.',
        {},
        async () => {
            try {
                return ok(await getOnboardingStatus());
            } catch (e) { return err(e); }
        },
    );

    // ── Context Types ────────────────────────────────────────────────────

    server.tool(
        'list_types',
        'List all context types with their schemas (fields, completion, calendar, spawner).',
        {},
        async () => {
            try {
                const types = await loadEntityTypes();
                return ok(types.map(t => ({
                    name: t.name,
                    plural: t.plural,
                    description: t.description,
                    fields: t.fields.map(f => ({
                        key: f.key, type: f.type, label: f.label,
                        required: f.required, values: f.values,
                    })),
                    completionField: t.completionField,
                    completionValue: t.completionValue,
                    calendarDateField: t.calendarDateField,
                })));
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'get_type',
        'Get the full schema for a single context type, including its .cxms.md context.',
        { type: z.string().describe('Context type name (e.g. "task", "event")') },
        async ({ type }) => {
            try {
                const config = await getEntityType(type);
                if (!config) return err(`Context type "${type}" not found`);
                const ctx = await getSubdirectoryContext(`context-types/${type}`);
                return ok({ ...config, context: ctx || undefined });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'create_type',
        'Create a new context type with fields, directory, and optional completion/calendar config.',
        {
            name: z.string().describe('Type name (singular, lowercase, e.g. "habit")'),
            plural: z.string().describe('Plural form (e.g. "habits")'),
            directory: z.string().describe('Storage directory (e.g. "context-types/habit")'),
            description: z.string().optional().describe('What this type represents'),
            fields: z.array(z.object({
                key: z.string(),
                type: z.enum(['string', 'number', 'boolean', 'date', 'datetime', 'duration', 'enum', 'array', 'object']),
                label: z.string().optional(),
                required: z.boolean().optional(),
                values: z.array(z.string()).optional(),
            })).describe('Field definitions'),
            defaultTags: z.array(z.string()).optional(),
            completionField: z.string().optional().describe('Field name that marks completion'),
            completionValue: z.string().optional().describe('Value that means "done"'),
            calendarDateField: z.string().optional().describe('Field for calendar placement'),
        },
        async (params) => {
            try {
                const config: EntityTypeConfig = {
                    name: params.name,
                    plural: params.plural,
                    directory: params.directory,
                    description: params.description,
                    fields: params.fields,
                    defaultTags: params.defaultTags,
                    completionField: params.completionField,
                    completionValue: params.completionValue,
                    calendarDateField: params.calendarDateField,
                };
                await addEntityType(config);
                return ok({ created: true, name: params.name });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'update_type',
        'Update an existing context type schema.',
        {
            name: z.string().describe('Type name to update'),
            config: z.object({
                plural: z.string().optional(),
                directory: z.string().optional(),
                description: z.string().optional(),
                fields: z.array(z.object({
                    key: z.string(),
                    type: z.enum(['string', 'number', 'boolean', 'date', 'datetime', 'duration', 'enum', 'array', 'object']),
                    label: z.string().optional(),
                    required: z.boolean().optional(),
                    values: z.array(z.string()).optional(),
                })).optional(),
                defaultTags: z.array(z.string()).optional(),
                completionField: z.string().optional(),
                completionValue: z.string().optional(),
                calendarDateField: z.string().optional(),
            }).describe('Fields to update (merged with existing)'),
        },
        async ({ name, config }) => {
            try {
                const existing = await getEntityType(name);
                if (!existing) return err(`Context type "${name}" not found`);
                const merged: EntityTypeConfig = { ...existing, ...config, name };
                await updateEntityType(name, merged);
                return ok({ updated: true, name });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'delete_type',
        'Remove a context type. Built-in types cannot be removed.',
        { name: z.string().describe('Type name to delete') },
        async ({ name }) => {
            try {
                await removeEntityType(name);
                return ok({ deleted: true, name });
            } catch (e) { return err(e); }
        },
    );

    // ── Context Nodes ────────────────────────────────────────────────────

    server.tool(
        'list_nodes',
        'List context nodes of a given type. Returns titles, IDs, tags, and key metadata.',
        {
            type: z.string().describe('Context type (e.g. "task", "event", "note")'),
            status: z.string().optional().describe('Filter by status field'),
            tag: z.string().optional().describe('Filter by tag'),
            limit: z.number().optional().describe('Max results (default all)'),
            offset: z.number().optional().describe('Skip N results'),
        },
        async ({ type, status, tag, limit, offset }) => {
            try {
                const filters: { tags?: string[]; metaOnly?: boolean } = {};
                if (tag) filters.tags = [tag];
                let entities = await listEntities(type, filters);
                if (status) {
                    entities = entities.filter(e => String(e.meta.status) === status);
                }
                if (offset) entities = entities.slice(offset);
                if (limit) entities = entities.slice(0, limit);
                return ok(entities.map(e => ({
                    id: e.meta.id as string,
                    title: e.meta.title as string,
                    tags: e.meta.tags as string[],
                    summary: e.meta.summary as string | undefined,
                    ...Object.fromEntries(
                        Object.entries(e.meta).filter(([k]) =>
                            !['id', 'title', 'tags', 'summary', 'entityType'].includes(k)),
                    ),
                })));
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'get_node',
        'Get a single context node by type and ID or title. Returns full metadata, content, and ancestor context.',
        {
            type: z.string().describe('Context type'),
            id: z.string().describe('Node ID or title'),
        },
        async ({ type, id }) => {
            try {
                const entity = await findEntityByTitle(type, id);
                if (!entity) return err(`Node not found: ${type}/${id}`);
                return ok({
                    meta: entity.meta,
                    content: entity.content,
                    filepath: entity.filepath,
                });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'create_node',
        'Create a new context node in the Foundation. Validates fields against the type schema.',
        {
            type: z.string().describe('Context type'),
            title: z.string().describe('Node title'),
            content: z.string().optional().describe('Markdown body'),
            tags: z.array(z.string()).optional().describe('Tags'),
            fields: z.record(z.string(), z.unknown()).optional().describe('Additional frontmatter fields'),
        },
        async ({ type, title, content, tags, fields }) => {
            try {
                const typeConfig = await getEntityType(type);
                if (!typeConfig) return err(`Unknown context type: ${type}`);

                const id = generateNodeId();
                const now = new Date().toISOString();
                const meta: Record<string, unknown> = {
                    id,
                    title,
                    entityType: type,
                    created: now,
                    tags: tags || typeConfig.defaultTags || [],
                    ...fields,
                };

                const errors = validateEntity(meta, typeConfig, true);
                if (errors.length > 0) return err(formatValidationErrors(errors));

                const dir = await ensureEntityDir(type);
                const filename = nodeFilename(title, id);
                const filepath = getPlatform().paths.join(dir, filename);
                await writeEntity(filepath, meta, content || '');

                return ok({ created: true, id, title, type, filepath });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'update_node',
        'Update an existing context node. Merges provided fields with existing metadata.',
        {
            type: z.string().describe('Context type'),
            id: z.string().describe('Node ID or title'),
            title: z.string().optional().describe('New title'),
            content: z.string().optional().describe('New markdown body'),
            tags: z.array(z.string()).optional().describe('Replace tags'),
            add_tags: z.array(z.string()).optional().describe('Add tags to existing'),
            fields: z.record(z.string(), z.unknown()).optional().describe('Fields to set/update'),
        },
        async ({ type, id, title, content, tags, add_tags, fields }) => {
            try {
                const entity = await findEntityByTitle(type, id);
                if (!entity) return err(`Node not found: ${type}/${id}`);

                const meta = { ...entity.meta };
                if (title) meta.title = title;
                if (tags) meta.tags = tags;
                if (add_tags) {
                    const existing = Array.isArray(meta.tags) ? meta.tags : [];
                    meta.tags = [...new Set([...existing, ...add_tags])];
                }
                if (fields) Object.assign(meta, fields);

                const typeConfig = await getEntityType(type);
                if (typeConfig) {
                    const errors = validateEntity(meta, typeConfig, false);
                    if (errors.length > 0) return err(formatValidationErrors(errors));
                }

                const body = content !== undefined ? content : entity.content;
                await writeEntity(entity.filepath, meta, body);

                return ok({ updated: true, id: meta.id, title: meta.title, type });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'delete_node',
        'Soft-delete a context node by moving it to .trash/.',
        {
            type: z.string().describe('Context type'),
            id: z.string().describe('Node ID or title'),
        },
        async ({ type, id }) => {
            try {
                const entity = await findEntityByTitle(type, id);
                if (!entity) return err(`Node not found: ${type}/${id}`);
                const trashPath = await trashEntity(entity.filepath);
                return ok({ deleted: true, id: entity.meta.id, title: entity.meta.title, trashPath });
            } catch (e) { return err(e); }
        },
    );

    // ── Search & Discovery ───────────────────────────────────────────────

    server.tool(
        'search',
        'Full-text BM25 search across context nodes. Returns ranked previews: title, tags, summary, key custom fields, and a body snippet. Use batch_get_nodes to fetch full content for selected results.',
        {
            query: z.string().describe('Search query — keywords, phrases, or tag:value filters'),
            type: z.string().optional().describe('Filter to a single context type'),
            limit: z.number().optional().describe('Max results (default 20)'),
            snippetLength: z.number().optional().describe('Body preview length in chars (default 200, max 500)'),
        },
        async ({ query, type, limit, snippetLength }) => {
            try {
                const results = await searchEntities(query, type);
                const top = results.slice(0, limit || 20);
                const allTypes = await loadEntityTypes();
                const typeConfigMap = new Map(allTypes.map(t => [t.name, t]));
                const snipLen = Math.min(snippetLength ?? 200, 500);
                return ok(top.map(r => {
                    const typeName = (r.meta.entityType || r.meta.contextType) as string;
                    const typeConfig = typeConfigMap.get(typeName);
                    const fields: Record<string, unknown> = {};
                    if (typeConfig) {
                        for (const f of typeConfig.fields) {
                            if (r.meta[f.key] !== undefined) fields[f.key] = r.meta[f.key];
                        }
                    }
                    return {
                        type: typeName,
                        id: r.meta.id as string,
                        title: r.meta.title as string,
                        score: r.score,
                        summary: r.meta.summary as string | undefined,
                        tags: r.meta.tags as string[],
                        fields,
                        bodySnippet: r.content?.slice(0, snipLen).replace(/\n+/g, ' ').trim() || '',
                    };
                }));
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'batch_get_nodes',
        'Fetch full content for multiple nodes in one call. Use after search to retrieve only the nodes the agent has selected as relevant. Limit: 50 nodes per request.',
        {
            nodes: z.array(z.object({
                type: z.string().describe('Context type name'),
                id: z.string().describe('Node ID'),
            })).describe('List of nodes to fetch'),
        },
        async ({ nodes }) => {
            try {
                const allTypes = await loadEntityTypes();
                const typeConfigMap = new Map(allTypes.map(t => [t.name, t]));
                const results: Array<Record<string, unknown>> = [];
                const errors: Array<{ type: string; id: string; error: string }> = [];
                for (const ref of nodes.slice(0, 50)) {
                    const typeConfig = typeConfigMap.get(ref.type);
                    if (!typeConfig) { errors.push({ ...ref, error: `Unknown type "${ref.type}"` }); continue; }
                    try {
                        const entities = await listEntities(ref.type);
                        const entity = entities.find(e => e.meta.id === ref.id);
                        if (!entity) { errors.push({ ...ref, error: 'Not found' }); continue; }
                        const fields: Record<string, unknown> = {};
                        for (const f of typeConfig.fields) {
                            if (entity.meta[f.key] !== undefined) fields[f.key] = entity.meta[f.key];
                        }
                        results.push({
                            id: entity.meta.id, title: entity.meta.title, type: ref.type,
                            tags: entity.meta.tags || [], summary: entity.meta.summary,
                            created: entity.meta.created, updated: entity.meta.updated,
                            ...fields, content: entity.content,
                            references: entity.meta.references || entity.meta.links || [],
                        });
                    } catch (e) { errors.push({ ...ref, error: e instanceof Error ? e.message : String(e) }); }
                }
                return ok({ count: results.length, nodes: results, errors });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'search_by_tag',
        'Find all context nodes with a specific tag, optionally filtered by type.',
        {
            tag: z.string().describe('Tag to search for'),
            type: z.string().optional().describe('Filter to context type'),
        },
        async ({ tag, type }) => {
            try {
                const typeNames = type ? [type] : (await loadEntityTypes()).map(t => t.name);
                const results: Array<{ type: string; id: string; title: string; tags: string[] }> = [];
                for (const t of typeNames) {
                    const entities = await listEntities(t, { tags: [tag] });
                    for (const e of entities) {
                        results.push({
                            type: t,
                            id: e.meta.id as string,
                            title: e.meta.title as string,
                            tags: e.meta.tags as string[],
                        });
                    }
                }
                return ok(results);
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'search_by_date_range',
        'Find context nodes with a calendar date field within a date range.',
        {
            start: z.string().describe('Start date (YYYY-MM-DD)'),
            end: z.string().describe('End date (YYYY-MM-DD)'),
            type: z.string().optional().describe('Filter to context type'),
        },
        async ({ start, end, type }) => {
            try {
                const types = await loadEntityTypes();
                const calendarTypes = types.filter(t =>
                    t.calendarDateField && (!type || t.name === type));
                const results: Array<{ type: string; id: string; title: string; date: string }> = [];
                for (const t of calendarTypes) {
                    const entities = await listEntities(t.name);
                    for (const e of entities) {
                        const dateVal = String(e.meta[t.calendarDateField!] || '');
                        const dateOnly = dateVal.slice(0, 10);
                        if (dateOnly >= start && dateOnly <= end) {
                            results.push({
                                type: t.name,
                                id: e.meta.id as string,
                                title: e.meta.title as string,
                                date: dateVal,
                            });
                        }
                    }
                }
                results.sort((a, b) => a.date.localeCompare(b.date));
                return ok(results);
            } catch (e) { return err(e); }
        },
    );

    // ── Context & Summary ────────────────────────────────────────────────

    server.tool(
        'get_node_summary',
        'Get a concise summary of a context node — title, tags, key fields, and first 200 chars of content.',
        {
            type: z.string().describe('Context type'),
            id: z.string().describe('Node ID or title'),
        },
        async ({ type, id }) => {
            try {
                const entity = await findEntityByTitle(type, id);
                if (!entity) return err(`Node not found: ${type}/${id}`);
                const snippet = entity.content.length > 200
                    ? entity.content.slice(0, 200) + '…'
                    : entity.content;
                return ok({
                    id: entity.meta.id as string,
                    title: entity.meta.title as string,
                    type,
                    tags: entity.meta.tags as string[],
                    summary: (entity.meta.summary as string) || snippet,
                    created: entity.meta.created as string,
                    updated: entity.meta.updated as string | undefined,
                    ...Object.fromEntries(
                        Object.entries(entity.meta).filter(([k]) =>
                            !['id', 'title', 'entityType', 'tags', 'summary', 'created', 'updated'].includes(k)),
                    ),
                });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'count_nodes',
        'Count context nodes per type, or for a specific type. Optionally filter by search terms to see how many nodes match in each type.',
        {
            type: z.string().optional().describe('Specific type to count'),
            query: z.string().optional().describe('Search terms — returns match counts per type'),
        },
        async ({ type, query }) => {
            try {
                const types = type
                    ? [await getEntityType(type)].filter(Boolean) as EntityTypeConfig[]
                    : await loadEntityTypes();

                if (query) {
                    // Return match counts per type with sample titles
                    const index = getEntityIndex();
                    const counts: Array<{ type: string; total: number; matches: number; samples: string[] }> = [];
                    for (const t of types) {
                        const all = await listEntities(t.name);
                        const hits = index.search(query, t.name);
                        counts.push({
                            type: t.name,
                            total: all.length,
                            matches: hits.length,
                            samples: hits.slice(0, 3).map(h => h.node.title),
                        });
                    }
                    return ok(counts.filter(c => c.matches > 0 || c.total > 0));
                }

                // Simple counts
                const counts: Array<{ type: string; count: number }> = [];
                for (const t of types) {
                    const entities = await listEntities(t.name);
                    counts.push({ type: t.name, count: entities.length });
                }
                return ok(counts);
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'get_moment',
        'Get real-time context: current date/time, overdue tasks, today\'s schedule, upcoming tasks.',
        { user_name: z.string().optional().describe('User name for greeting') },
        async ({ user_name }) => {
            try {
                const moment = buildMomentContext(user_name);
                return ok({
                    ...moment,
                    formatted: formatMomentBlock(moment),
                });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'get_context_tree',
        'Build a token-budgeted context tree for LLM consumption. Specify scope to control what\'s included.',
        {
            scope_type: z.enum(['trunk', 'branch', 'branch-full', 'leaves', 'cross'])
                .optional().describe('Scope type (default "trunk")'),
            branches: z.array(z.string()).optional().describe('Context types to include as branches'),
            query: z.string().optional().describe('Query for leaf-level scope'),
        },
        async ({ scope_type, branches, query }) => {
            try {
                const st = scope_type || 'trunk';
                let scope: ContextScope;
                if (st === 'trunk') {
                    scope = { type: 'trunk' };
                } else if (st === 'branch') {
                    scope = { type: 'branch', branches: branches || [] };
                } else if (st === 'branch-full') {
                    scope = { type: 'branch-full', branches: branches || [] };
                } else if (st === 'leaves') {
                    scope = { type: 'leaves', keys: branches || [] };
                } else {
                    scope = { type: 'cross', branches: branches || [], query };
                }
                const moment = buildMomentContext();
                const globals = {
                    current_date: moment.current_date,
                    current_time: moment.current_time,
                    day_of_week: moment.day_of_week,
                };
                const tree = await buildContextTree(scope, globals);
                const serialized = serializeContextTree(tree);
                return ok({ tree, serialized });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'get_vault_context',
        'Read the root .cxms.md context file from the Foundation.',
        {},
        async () => {
            try {
                const ctx = await getVaultContext();
                return ok({ context: ctx });
            } catch (e) { return err(e); }
        },
    );

    // ── Collections ──────────────────────────────────────────────────────

    server.tool(
        'list_collections',
        'List all key-value collections in the Foundation.',
        {},
        async () => {
            try {
                const names = await listCollections();
                return ok(names);
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'get_collection',
        'Get a collection by name, or a single item by key.',
        {
            name: z.string().describe('Collection name'),
            key: z.string().optional().describe('Specific item key (omit for full collection)'),
        },
        async ({ name, key }) => {
            try {
                if (key) {
                    const value = await getCollectionItem(name, key);
                    if (value === null) return err(`Item "${key}" not found in collection "${name}"`);
                    return ok({ key, value });
                }
                const collection = await loadCollection(name);
                if (!collection) return err(`Collection "${name}" not found`);
                return ok(collection);
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'set_collection_item',
        'Set or update a key-value item in a collection.',
        {
            name: z.string().describe('Collection name'),
            key: z.string().describe('Item key'),
            value: z.string().describe('Item value'),
            description: z.string().optional().describe('Collection description (used on create)'),
        },
        async ({ name, key, value, description }) => {
            try {
                await setCollectionItem(name, key, value, description);
                return ok({ set: true, collection: name, key });
            } catch (e) { return err(e); }
        },
    );

    server.tool(
        'remove_collection_item',
        'Remove a key-value item from a collection.',
        {
            name: z.string().describe('Collection name'),
            key: z.string().describe('Item key to remove'),
        },
        async ({ name, key }) => {
            try {
                const removed = await removeCollectionItem(name, key);
                if (!removed) return err(`Item "${key}" not found in collection "${name}"`);
                return ok({ removed: true, collection: name, key });
            } catch (e) { return err(e); }
        },
    );
}

// ── HTTP Handler ─────────────────────────────────────────────────────────────

/**
 * Handle an MCP request via Streamable HTTP transport.
 * Route: POST /mcp, GET /mcp, DELETE /mcp
 */
export async function handleMcpRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const server = getOrCreateServer();

    if (!_transport) {
        _transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless
        });
        await server.connect(_transport);
        debug('mcp-server', 'CxMS MCP server transport connected');
    }

    await _transport.handleRequest(req, res);
}

/**
 * Reset server and transport. Used for testing.
 */
export function resetMcpServer(): void {
    _server = null;
    _transport = null;
}
