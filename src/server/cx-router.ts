// ─────────────────────────────────────────────────────────────────────────────
// CxMS — REST Router (/cx/*)
// ─────────────────────────────────────────────────────────────────────────────
// All /cx/* endpoints for the Context Management System.
// Uses RFC 9457 Problem Details for errors.
// ─────────────────────────────────────────────────────────────────────────────

import type http from 'http';
import { getPlatform } from '../platform/index.js';
import {
    listEntities,
    parseEntity,
    writeEntity,
    trashEntity,
    archiveEntity,
    restoreEntity,
    searchEntities,
    generateNodeId,
    ensureEntityDir,
    nodeFilename,
} from '../storage/entity.js';
import {
    loadEntityTypes,
    getEntityType,
    addEntityType,
    updateEntityType,
    removeEntityType,
    type EntityTypeConfig,
} from '../schema/entity-type-config.js';
import { validateEntity, formatValidationErrors } from '../storage/entity-validator.js';
import {
    loadContextTypesFromStore,
    writeContextType,
    writeAllContextTypes,
    removeContextTypeDir,
} from '../schema/context-type-store.js';
import {
    listCollections,
    loadCollection,
    getCollectionItem,
    countCollectionItems,
} from '../storage/collections.js';
import {
    jsonResponse,
    badRequest,
    notFound,
    methodNotAllowed,
    conflict,
    unprocessable,
    serverError,
    readBody,
} from './problem-details.js';
import { findFoundationRoot } from '../foundation.js';
import { getVaultAnalytics } from '../analytics.js';
import { authenticateRequest } from './auth.js';
import { getInstanceIdentity } from './system-config.js';
import { runOnboarding, getOnboardingStatus } from '../onboarding/index.js';
import { logAccess } from '../log/access-log.js';
import { logError } from '../log/error-log.js';
import { debug } from '../debug.js';
import { serializeCxmsToCxf } from '../cxf/cxf-serializer.js';

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Handle all /cx/* routes. Returns true if handled, false if not matched.
 * All routes except /cx/health require a valid bearer token.
 */
export async function handleCxRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
): Promise<boolean> {
    const pathname = url.pathname;
    const method = req.method || 'GET';
    const startTime = Date.now();
    let handled = false;

    try {
        handled = await routeRequest(req, res, url, pathname, method);
        return handled;
    } catch (err) {
        debug('cx-router', `Error: ${err}`);
        logError(err, req).catch(() => {});
        serverError(res, err instanceof Error ? err.message : String(err), pathname);
        handled = true;
        return true;
    } finally {
        if (handled) {
            logAccess(req, res, startTime).catch(() => {});
        }
    }
}

async function routeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    pathname: string,
    method: string,
): Promise<boolean> {
    // GET /cx/health — unauthenticated (liveness probe)
        if (pathname === '/cx/health' && method === 'GET') {
            return await handleHealth(res);
        }

        // All other routes require authentication
        if (!await authenticateRequest(req, res)) return true;

        // GET /cx/cxf — CXF/1 export
        if (pathname === '/cx/cxf' && method === 'GET') {
            return await handleCxfExport(res, url);
        }

        // GET /cx/analytics
        if (pathname === '/cx/analytics' && method === 'GET') {
            return await handleAnalytics(res);
        }

        // POST /cx/onboard
        if (pathname === '/cx/onboard' && method === 'POST') {
            return await handleOnboard(req, res);
        }

        // GET /cx/onboard/status
        if (pathname === '/cx/onboard/status' && method === 'GET') {
            return await handleOnboardStatus(res);
        }

        // POST /cx/search
        if (pathname === '/cx/search' && method === 'POST') {
            return await handleSearch(req, res);
        }

        // GET /cx/search/summary — Progressive Disclosure: frontmatter-only results
        if (pathname === '/cx/search/summary' && method === 'GET') {
            return await handleSearchSummary(req, res, url);
        }

        // POST /cx/nodes/detail — Progressive Disclosure: batch fetch full NodeDetail
        if (pathname === '/cx/nodes/detail' && method === 'POST') {
            return await handleNodeDetail(req, res);
        }

        // POST /cx/nodes/batch
        if (pathname === '/cx/nodes/batch' && method === 'POST') {
            return await handleBatchGetNodes(req, res);
        }

        // GET /cx/tag/{tag}
        const tagMatch = pathname.match(/^\/cx\/tag\/([^/]+)$/);
        if (tagMatch && method === 'GET') {
            return await handleTagSearch(res, decodeURIComponent(tagMatch[1]));
        }

        // GET /cx/date
        if (pathname === '/cx/date' && method === 'GET') {
            return await handleDateToday(res);
        }

        // GET /cx/date-range/{start}/{end}
        const dateRangeMatch = pathname.match(/^\/cx\/date-range\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
        if (dateRangeMatch && method === 'GET') {
            return await handleDateRange(res, dateRangeMatch[1], dateRangeMatch[2]);
        }

        // ── Collections ──────────────────────────────────────────────────

        // GET /cx/collections
        if (pathname === '/cx/collections' && method === 'GET') {
            return await handleListCollections(res);
        }

        // GET /cx/collection/{name}/count
        const collCountMatch = pathname.match(/^\/cx\/collection\/([^/]+)\/count$/);
        if (collCountMatch && method === 'GET') {
            return await handleCollectionCount(res, decodeURIComponent(collCountMatch[1]));
        }

        // GET /cx/collection/{name}/{key}
        const collItemMatch = pathname.match(/^\/cx\/collection\/([^/]+)\/([^/]+)$/);
        if (collItemMatch && method === 'GET') {
            return await handleCollectionItem(res, decodeURIComponent(collItemMatch[1]), decodeURIComponent(collItemMatch[2]));
        }

        // GET /cx/collection/{name}
        const collMatch = pathname.match(/^\/cx\/collection\/([^/]+)$/);
        if (collMatch && method === 'GET') {
            return await handleGetCollection(res, decodeURIComponent(collMatch[1]));
        }

        // ── Context Types ────────────────────────────────────────────────

        // GET /cx/context-types/count
        if (pathname === '/cx/context-types/count' && method === 'GET') {
            return await handleTypeCount(res);
        }

        // GET /cx/context-types
        if (pathname === '/cx/context-types' && method === 'GET') {
            return await handleListTypes(res);
        }

        // POST /cx/context-types
        if (pathname === '/cx/context-types' && method === 'POST') {
            return await handleCreateType(req, res);
        }

        // Routes with {type} param
        const typeMatch = pathname.match(/^\/cx\/context-types\/([^/]+)$/);
        if (typeMatch) {
            const typeName = decodeURIComponent(typeMatch[1]);
            if (method === 'GET') return await handleListNodes(req, res, url, typeName);
            if (method === 'POST') return await handleCreateNode(req, res, typeName);
            if (method === 'PUT') return await handleUpdateType(req, res, typeName);
            if (method === 'DELETE') return await handleDeleteType(res, typeName);
            methodNotAllowed(res, ['GET', 'POST', 'PUT', 'DELETE'], pathname);
            return true;
        }

        // GET /cx/context-types/{type}/details
        const detailsMatch = pathname.match(/^\/cx\/context-types\/([^/]+)\/details$/);
        if (detailsMatch && method === 'GET') {
            return await handleTypeDetails(res, decodeURIComponent(detailsMatch[1]));
        }

        // GET /cx/context-types/{type}/summaries — Progressive Disclosure: frontmatter-only list
        const summariesMatch = pathname.match(/^\/cx\/context-types\/([^/]+)\/summaries$/);
        if (summariesMatch && method === 'GET') {
            return await handleTypeSummaries(res, url, decodeURIComponent(summariesMatch[1]));
        }

        // GET /cx/context-types/{type}/count
        const nodeCountMatch = pathname.match(/^\/cx\/context-types\/([^/]+)\/count$/);
        if (nodeCountMatch && method === 'GET') {
            return await handleNodeCount(res, decodeURIComponent(nodeCountMatch[1]));
        }

        // Routes with {type}/{id}
        const nodeMatch = pathname.match(/^\/cx\/context-types\/([^/]+)\/([^/]+)$/);
        if (nodeMatch) {
            const typeName = decodeURIComponent(nodeMatch[1]);
            const nodeId = decodeURIComponent(nodeMatch[2]);
            if (method === 'GET') return await handleGetNode(res, typeName, nodeId);
            if (method === 'PUT') return await handleUpdateNode(req, res, typeName, nodeId);
            if (method === 'DELETE') return await handleDeleteNode(res, typeName, nodeId, url);
            methodNotAllowed(res, ['GET', 'PUT', 'DELETE'], pathname);
            return true;
        }

        return false; // Not a /cx/ route we handle
}

// ── Health ───────────────────────────────────────────────────────────────────

async function handleHealth(res: http.ServerResponse): Promise<boolean> {
    const root = findFoundationRoot();
    const types = await loadEntityTypes();
    const { name, description } = getInstanceIdentity();
    jsonResponse(res, 200, {
        status: root ? 'ok' : 'no-foundation',
        name,
        description,
        foundation: root || null,
        contextTypes: types.length,
    });
    return true;
}

// ── Analytics ────────────────────────────────────────────────────────────────

async function handleAnalytics(res: http.ServerResponse): Promise<boolean> {
    const analytics = await getVaultAnalytics();
    jsonResponse(res, 200, analytics);
    return true;
}

// ── Onboarding ───────────────────────────────────────────────────────────────

async function handleOnboard(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const raw = await readBody(req);
    let body: { answers?: unknown; foundationDir?: string };
    try { body = JSON.parse(raw || '{}'); } catch {
        badRequest(res, 'Invalid JSON', '/cx/onboard'); return true;
    }
    if (!body.answers) { badRequest(res, 'Missing required field: answers', '/cx/onboard'); return true; }
    const root = findFoundationRoot();
    const foundationDir = body.foundationDir || root;
    if (!foundationDir) { badRequest(res, 'No foundation root — pass foundationDir or set one up', '/cx/onboard'); return true; }
    try {
        const result = await runOnboarding(body.answers as Parameters<typeof runOnboarding>[0], foundationDir);
        jsonResponse(res, 200, result);
    } catch (e) {
        serverError(res, e instanceof Error ? e.message : String(e), '/cx/onboard');
    }
    return true;
}

async function handleOnboardStatus(res: http.ServerResponse): Promise<boolean> {
    const status = await getOnboardingStatus();
    jsonResponse(res, 200, status);
    return true;
}

// ── Search ───────────────────────────────────────────────────────────────────

async function handleSearch(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const raw = await readBody(req);
    let body: { query?: string; type?: string; tags?: string[]; snippetLength?: number };
    try {
        body = JSON.parse(raw || '{}');
    } catch {
        badRequest(res, 'Invalid JSON body');
        return true;
    }

    if (!body.query) {
        badRequest(res, 'Missing required field: query');
        return true;
    }

    const snippetLength = Math.min(body.snippetLength ?? 200, 500);
    const results = await searchEntities(body.query, body.type, { tags: body.tags });

    // Pre-load type configs for custom field extraction
    const allTypes = await loadEntityTypes();
    const typeConfigMap = new Map(allTypes.map(t => [t.name, t]));

    jsonResponse(res, 200, {
        query: body.query,
        count: results.length,
        results: results.map(r => {
            const typeName = String(r.meta.entityType || r.meta.contextType || '');
            const typeConfig = typeConfigMap.get(typeName);
            const fields = typeConfig ? extractCustomFields(r.meta, typeConfig) : {};
            const snippet = r.content?.slice(0, snippetLength).replace(/\n+/g, ' ').trim() || '';
            return {
                id: r.meta.id,
                title: r.meta.title,
                type: typeName,
                score: r.score,
                tags: r.meta.tags,
                summary: r.meta.summary,
                fields,
                bodySnippet: snippet,
            };
        }),
    });
    return true;
}

// ── Batch Node Fetch ──────────────────────────────────────────────────────────

async function handleBatchGetNodes(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const raw = await readBody(req);
    let body: { nodes?: Array<{ type: string; id: string }> };
    try {
        body = JSON.parse(raw || '{}');
    } catch {
        badRequest(res, 'Invalid JSON body');
        return true;
    }

    if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
        badRequest(res, 'Missing required field: nodes (array of {type, id})');
        return true;
    }

    if (body.nodes.length > 50) {
        badRequest(res, 'Batch size limit is 50 nodes');
        return true;
    }

    const allTypes = await loadEntityTypes();
    const typeConfigMap = new Map(allTypes.map(t => [t.name, t]));
    const results: Array<Record<string, unknown>> = [];
    const errors: Array<{ type: string; id: string; error: string }> = [];

    for (const ref of body.nodes) {
        if (!ref.type || !ref.id) {
            errors.push({ type: ref.type || '', id: ref.id || '', error: 'Missing type or id' });
            continue;
        }
        const typeConfig = typeConfigMap.get(ref.type);
        if (!typeConfig) {
            errors.push({ type: ref.type, id: ref.id, error: `Unknown type "${ref.type}"` });
            continue;
        }
        try {
            const entities = await listEntities(ref.type);
            const entity = entities.find(e => e.meta.id === ref.id);
            if (!entity) {
                errors.push({ type: ref.type, id: ref.id, error: 'Not found' });
                continue;
            }
            results.push({
                id: entity.meta.id,
                title: entity.meta.title,
                type: ref.type,
                tags: entity.meta.tags || [],
                summary: entity.meta.summary,
                created: entity.meta.created,
                updated: entity.meta.updated,
                ...extractCustomFields(entity.meta, typeConfig),
                content: entity.content,
                references: entity.meta.references || entity.meta.links || [],
            });
        } catch (err) {
            errors.push({ type: ref.type, id: ref.id, error: err instanceof Error ? err.message : String(err) });
        }
    }

    jsonResponse(res, 200, { count: results.length, nodes: results, errors });
    return true;
}

// ── Tag Search ───────────────────────────────────────────────────────────────

async function handleTagSearch(res: http.ServerResponse, tag: string): Promise<boolean> {
    const types = await loadEntityTypes();
    const allResults: Array<{ id: string; title: string; type: string; tags: string[] }> = [];

    for (const t of types) {
        const entities = await listEntities(t.name, { tags: [tag] });
        for (const e of entities) {
            allResults.push({
                id: e.meta.id as string,
                title: e.meta.title as string,
                type: t.name,
                tags: (e.meta.tags as string[]) || [],
            });
        }
    }

    jsonResponse(res, 200, { tag, count: allResults.length, nodes: allResults });
    return true;
}

// ── Date Queries ─────────────────────────────────────────────────────────────

async function handleDateToday(res: http.ServerResponse): Promise<boolean> {
    const today = new Date().toISOString().split('T')[0];
    const nodes = await getNodesForDateRange(today, today);
    jsonResponse(res, 200, { date: today, count: nodes.length, nodes });
    return true;
}

async function handleDateRange(res: http.ServerResponse, start: string, end: string): Promise<boolean> {
    if (start > end) {
        badRequest(res, 'Start date must be before or equal to end date');
        return true;
    }
    const nodes = await getNodesForDateRange(start, end);
    jsonResponse(res, 200, { start, end, count: nodes.length, nodes });
    return true;
}

async function getNodesForDateRange(start: string, end: string): Promise<Array<Record<string, unknown>>> {
    const types = await loadEntityTypes();
    const results: Array<Record<string, unknown>> = [];

    for (const t of types) {
        if (!t.calendarDateField) continue;
        const entities = await listEntities(t.name);
        for (const e of entities) {
            const dateVal = String(e.meta[t.calendarDateField] || '').split('T')[0];
            if (dateVal >= start && dateVal <= end) {
                results.push({
                    id: e.meta.id,
                    title: e.meta.title,
                    type: t.name,
                    date: dateVal,
                    [t.calendarDateField]: e.meta[t.calendarDateField],
                });
            }
        }
    }

    return results;
}

// ── Collections ──────────────────────────────────────────────────────────────

async function handleListCollections(res: http.ServerResponse): Promise<boolean> {
    const names = await listCollections();
    jsonResponse(res, 200, { count: names.length, collections: names });
    return true;
}

async function handleGetCollection(res: http.ServerResponse, name: string): Promise<boolean> {
    const collection = await loadCollection(name);
    if (!collection) {
        notFound(res, `Collection "${name}" not found`);
        return true;
    }
    jsonResponse(res, 200, collection);
    return true;
}

async function handleCollectionItem(res: http.ServerResponse, name: string, key: string): Promise<boolean> {
    const value = await getCollectionItem(name, key);
    if (value === null) {
        notFound(res, `Item "${key}" not found in collection "${name}"`);
        return true;
    }
    jsonResponse(res, 200, { key, value });
    return true;
}

async function handleCollectionCount(res: http.ServerResponse, name: string): Promise<boolean> {
    const count = await countCollectionItems(name);
    jsonResponse(res, 200, { collection: name, count });
    return true;
}

// ── Context Type CRUD ────────────────────────────────────────────────────────

async function handleListTypes(res: http.ServerResponse): Promise<boolean> {
    const types = await loadEntityTypes();
    jsonResponse(res, 200, {
        count: types.length,
        types: types.map(t => ({
            name: t.name,
            plural: t.plural,
            directory: t.directory,
            description: t.description,
            fields: t.fields,
            completionField: t.completionField,
            calendarDateField: t.calendarDateField,
        })),
    });
    return true;
}

async function handleTypeCount(res: http.ServerResponse): Promise<boolean> {
    const types = await loadEntityTypes();
    jsonResponse(res, 200, { count: types.length });
    return true;
}

async function handleTypeDetails(res: http.ServerResponse, typeName: string): Promise<boolean> {
    const typeConfig = await getEntityType(typeName);
    if (!typeConfig) {
        notFound(res, `Context type "${typeName}" not found`);
        return true;
    }

    let examples: string | null = null;
    const root = findFoundationRoot();
    if (root) {
        const { storage, paths } = getPlatform();
        const examplesPath = paths.join(root, 'context-types', typeName, '.cxms-examples.md');
        try {
            examples = await storage.readFile(examplesPath);
        } catch {
            // No examples file
        }
    }

    jsonResponse(res, 200, { ...typeConfig, examples });
    return true;
}

async function handleCreateType(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const raw = await readBody(req);
    let body: Partial<EntityTypeConfig>;
    try {
        body = JSON.parse(raw || '{}');
    } catch {
        badRequest(res, 'Invalid JSON body');
        return true;
    }

    if (!body.name || !body.plural) {
        badRequest(res, 'Missing required fields: name, plural');
        return true;
    }

    const config: EntityTypeConfig = {
        name: body.name,
        plural: body.plural,
        directory: `context-types/${body.name}`,
        description: body.description,
        defaultTags: body.defaultTags,
        fields: body.fields || [],
        completionField: body.completionField,
        completionValue: body.completionValue,
        calendarDateField: body.calendarDateField,
        spawner: body.spawner,
    };

    try {
        await addEntityType(config);
        await writeContextType(config);
        jsonResponse(res, 201, config);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already exists')) {
            conflict(res, msg);
        } else {
            badRequest(res, msg);
        }
    }
    return true;
}

async function handleUpdateType(req: http.IncomingMessage, res: http.ServerResponse, typeName: string): Promise<boolean> {
    const existing = await getEntityType(typeName);
    if (!existing) {
        notFound(res, `Context type "${typeName}" not found`);
        return true;
    }

    const raw = await readBody(req);
    let body: Partial<EntityTypeConfig>;
    try {
        body = JSON.parse(raw || '{}');
    } catch {
        badRequest(res, 'Invalid JSON body');
        return true;
    }

    const updated: EntityTypeConfig = {
        ...existing,
        ...body,
        name: typeName, // name is immutable
        directory: `context-types/${typeName}`,
    };

    try {
        await updateEntityType(typeName, updated);
        await writeContextType(updated);
        jsonResponse(res, 200, updated);
    } catch (err) {
        badRequest(res, err instanceof Error ? err.message : String(err));
    }
    return true;
}

async function handleDeleteType(res: http.ServerResponse, typeName: string): Promise<boolean> {
    try {
        await removeEntityType(typeName);
        await removeContextTypeDir(typeName);
        jsonResponse(res, 200, { deleted: typeName });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
            notFound(res, msg);
        } else {
            badRequest(res, msg);
        }
    }
    return true;
}

// ── Context Node CRUD ────────────────────────────────────────────────────────

async function handleListNodes(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    typeName: string,
): Promise<boolean> {
    const typeConfig = await getEntityType(typeName);
    if (!typeConfig) {
        notFound(res, `Context type "${typeName}" not found`);
        return true;
    }

    const statusFilter = url.searchParams.get('status');
    const tagFilter = url.searchParams.get('tag');
    const limit = parseInt(url.searchParams.get('limit') || '0', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    let entities = await listEntities(typeName, tagFilter ? { tags: [tagFilter] } : undefined);

    if (statusFilter) {
        entities = entities.filter(e => e.meta.status === statusFilter);
    }

    const total = entities.length;

    if (offset > 0) entities = entities.slice(offset);
    if (limit > 0) entities = entities.slice(0, limit);

    jsonResponse(res, 200, {
        type: typeName,
        total,
        count: entities.length,
        offset,
        nodes: entities.map(e => ({
            id: e.meta.id,
            title: e.meta.title,
            type: typeName,
            tags: e.meta.tags || [],
            summary: e.meta.summary,
            created: e.meta.created,
            updated: e.meta.updated,
            ...extractCustomFields(e.meta, typeConfig),
        })),
    });
    return true;
}

async function handleGetNode(res: http.ServerResponse, typeName: string, nodeId: string): Promise<boolean> {
    const typeConfig = await getEntityType(typeName);
    if (!typeConfig) {
        notFound(res, `Context type "${typeName}" not found`);
        return true;
    }

    const entities = await listEntities(typeName);
    const entity = entities.find(e => e.meta.id === nodeId);
    if (!entity) {
        notFound(res, `Node "${nodeId}" not found in type "${typeName}"`);
        return true;
    }

    const ancestorContext = await buildAncestorContext(typeName);

    jsonResponse(res, 200, {
        id: entity.meta.id,
        title: entity.meta.title,
        type: typeName,
        tags: entity.meta.tags || [],
        summary: entity.meta.summary,
        created: entity.meta.created,
        updated: entity.meta.updated,
        ...extractCustomFields(entity.meta, typeConfig),
        content: entity.content,
        references: entity.meta.references || entity.meta.links || [],
        ancestorContext,
    });
    return true;
}

async function handleCreateNode(req: http.IncomingMessage, res: http.ServerResponse, typeName: string): Promise<boolean> {
    const typeConfig = await getEntityType(typeName);
    if (!typeConfig) {
        notFound(res, `Context type "${typeName}" not found`);
        return true;
    }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(raw || '{}');
    } catch {
        badRequest(res, 'Invalid JSON body');
        return true;
    }

    if (!body.title) {
        badRequest(res, 'Missing required field: title');
        return true;
    }

    const id = generateNodeId();
    const now = new Date().toISOString();
    const meta: Record<string, unknown> = {
        id,
        title: body.title,
        entityType: typeName,
        contextType: typeName,
        created: now,
        tags: (body.tags as string[]) || typeConfig.defaultTags || [],
        ...extractBodyFields(body, typeConfig),
    };

    for (const field of typeConfig.fields) {
        if (meta[field.key] === undefined && field.default !== undefined) {
            meta[field.key] = field.default;
        }
    }

    const errors = validateEntity(meta, typeConfig, true);
    if (errors.length > 0) {
        unprocessable(res, formatValidationErrors(errors));
        return true;
    }

    const { paths } = getPlatform();
    const dir = await ensureEntityDir(typeName);
    const filename = nodeFilename(body.title as string, id);
    const filepath = paths.join(dir, filename);
    const content = (body.content as string) || '';
    await writeEntity(filepath, meta, content);

    jsonResponse(res, 201, { id, title: body.title, type: typeName, filepath: filename });
    return true;
}

async function handleUpdateNode(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    typeName: string,
    nodeId: string,
): Promise<boolean> {
    const typeConfig = await getEntityType(typeName);
    if (!typeConfig) {
        notFound(res, `Context type "${typeName}" not found`);
        return true;
    }

    const entities = await listEntities(typeName, { includeArchived: true });
    const entity = entities.find(e => e.meta.id === nodeId);
    if (!entity) {
        notFound(res, `Node "${nodeId}" not found in type "${typeName}"`);
        return true;
    }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(raw || '{}');
    } catch {
        badRequest(res, 'Invalid JSON body');
        return true;
    }

    const updatedMeta = { ...entity.meta };
    if (body.title !== undefined) updatedMeta.title = body.title;
    if (body.tags !== undefined) updatedMeta.tags = body.tags;
    if (body.summary !== undefined) updatedMeta.summary = body.summary;
    if (body.references !== undefined) updatedMeta.references = body.references;
    // null explicitly clears archivedAt (restore from archive)
    if (body.archivedAt === null) delete updatedMeta.archivedAt;

    const customFields = extractBodyFields(body, typeConfig);
    Object.assign(updatedMeta, customFields);

    const changedKeys = new Set(Object.keys(customFields));
    if (changedKeys.size > 0) {
        const errors = validateEntity(updatedMeta, typeConfig, false, changedKeys);
        if (errors.length > 0) {
            unprocessable(res, formatValidationErrors(errors));
            return true;
        }
    }

    const content = body.content !== undefined ? (body.content as string) : entity.content;
    await writeEntity(entity.filepath, updatedMeta, content);

    jsonResponse(res, 200, { id: nodeId, title: updatedMeta.title, type: typeName, updated: true });
    return true;
}

async function handleDeleteNode(
    res: http.ServerResponse,
    typeName: string,
    nodeId: string,
    url: URL,
): Promise<boolean> {
    const typeConfig = await getEntityType(typeName);
    if (!typeConfig) {
        notFound(res, `Context type "${typeName}" not found`);
        return true;
    }

    const entities = await listEntities(typeName, { includeArchived: true });
    const entity = entities.find(e => e.meta.id === nodeId);
    if (!entity) {
        notFound(res, `Node "${nodeId}" not found in type "${typeName}"`);
        return true;
    }

    const hard = url.searchParams.get('hard') === 'true';
    if (hard) {
        const trashPath = await trashEntity(entity.filepath);
        const { paths } = getPlatform();
        jsonResponse(res, 200, { deleted: nodeId, hard: true, trashedTo: paths.basename(trashPath) });
    } else {
        await archiveEntity(entity.filepath, entity.meta);
        jsonResponse(res, 200, { archived: nodeId, hard: false });
    }
    return true;
}

async function handleNodeCount(res: http.ServerResponse, typeName: string): Promise<boolean> {
    const typeConfig = await getEntityType(typeName);
    if (!typeConfig) {
        notFound(res, `Context type "${typeName}" not found`);
        return true;
    }

    const entities = await listEntities(typeName);
    jsonResponse(res, 200, { type: typeName, count: entities.length });
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CXF/1 Export Handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleCxfExport(res: http.ServerResponse, url: URL): Promise<boolean> {
    const since = url.searchParams.get('since');
    const typesParam = url.searchParams.get('types');
    const includeSchema = url.searchParams.get('include_schema') !== 'false';
    const includeGraph = url.searchParams.get('include_graph') !== 'false';
    const excludeArchived = url.searchParams.get('exclude_archived') !== 'false'; // default true
    const tagsParam = url.searchParams.get('tags');
    const filterTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];
    const filterTypes = typesParam ? typesParam.split(',').map(t => t.trim()).filter(Boolean) : [];
    const sinceIso = since ? new Date(parseInt(since, 10) * 1000).toISOString() : null;

    const allTypes = await loadEntityTypes();
    const types = filterTypes.length ? allTypes.filter(t => filterTypes.includes(t.name)) : allTypes;

    const records: Array<{ typeName: string; nodes: import('../cxf/cxf-serializer.js').ContextNodeRecord[] }> = [];

    for (const typeConfig of types) {
        let nodes = await listEntities(typeConfig.name, {
            tags: filterTags.length ? filterTags : undefined,
            includeArchived: !excludeArchived,
        });

        if (sinceIso) {
            nodes = nodes.filter(n => {
                const upd = (n.meta.updated ?? n.meta.created) as string | undefined;
                return upd ? upd >= sinceIso : true;
            });
        }

        records.push({ typeName: typeConfig.name, nodes });
    }

    const exportTime = Math.floor(Date.now() / 1000);
    const instance = getInstanceIdentity();
    const vaultId = instance.name.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'cxms';

    const result = serializeCxmsToCxf(records, types, {
        vaultId,
        ownerName: 'CxMS',
        exportTime,
        includeSchema,
        includeGraph,
    });

    res.writeHead(200, {
        'Content-Type': 'text/cxf; charset=utf-8',
        'X-CXF-Export-Time': String(exportTime),
        'X-CXF-Entity-Count': String(result.entityCount),
        'X-CXF-Schema-Count': String(result.schemaCount),
    });
    res.end(result.document);
    return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract type-specific fields from entity meta, excluding system fields. */
function extractCustomFields(meta: Record<string, unknown>, typeConfig: EntityTypeConfig): Record<string, unknown> {
    const custom: Record<string, unknown> = {};
    for (const field of typeConfig.fields) {
        if (meta[field.key] !== undefined) {
            custom[field.key] = meta[field.key];
        }
    }
    return custom;
}

/** Extract type-specific fields from request body. */
function extractBodyFields(body: Record<string, unknown>, typeConfig: EntityTypeConfig): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const field of typeConfig.fields) {
        if (body[field.key] !== undefined) {
            fields[field.key] = body[field.key];
        }
    }
    return fields;
}

/** Build ancestor context chain: root .cxms.md → type .cxms.md */
async function buildAncestorContext(typeName: string): Promise<string[]> {
    const root = findFoundationRoot();
    if (!root) return [];

    const { paths } = getPlatform();
    const { buildContextChain } = await import('../context/reader.js');
    const typeDir = paths.join(root, 'context-types', typeName);

    // buildContextChain walks up from typeDir → root, collecting .cxms.md files
    // Returns deepest-first, so we reverse to get root → type order
    const chain = await buildContextChain(typeDir);
    return chain.reverse();
}

// ── Progressive Disclosure Handlers ──────────────────────────────────────────

/**
 * GET /cx/search/summary?q=...&types=type1,type2&limit=30
 * Returns NodeSummary[] (frontmatter only) for token-efficient context retrieval.
 */
async function handleSearchSummary(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
): Promise<boolean> {
    const q = url.searchParams.get('q') ?? '';
    const typesParam = url.searchParams.get('types');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10), 100);
    const filterTypes = typesParam ? typesParam.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (!q.trim()) {
        badRequest(res, 'Missing required query parameter: q', '/cx/search/summary');
        return true;
    }

    const { searchEntities, CORE_FRONTMATTER_KEYS } = await import('../storage/entity.js');
    const allTypes = await loadEntityTypes();
    const targetTypes = filterTypes.length
        ? allTypes.filter(t => filterTypes.includes(t.name))
        : allTypes;

    const summaries: import('../types.js').NodeSummary[] = [];

    for (const typeConfig of targetTypes) {
        if (summaries.length >= limit) break;
        const results = await searchEntities(q, typeConfig.name);
        for (const { meta } of results) {
            if (summaries.length >= limit) break;
            if (meta.archivedAt) continue;
            summaries.push({
                id: meta.id as string,
                name: (meta.name as string) || (meta.title as string) || String(meta.id),
                contextType: typeConfig.name,
                description: (meta.description as string) || (meta.summary as string) || undefined,
                tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
                created: (meta.created as string) || '',
                updated: (meta.updated as string) || undefined,
            });
        }
    }

    jsonResponse(res, 200, { summaries, total: summaries.length });
    return true;
}

/**
 * POST /cx/nodes/detail
 * Body: { ids: string[] }
 * Returns NodeDetail[] — full node with domain fields and body text.
 */
async function handleNodeDetail(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<boolean> {
    const body = await readBody(req);
    let ids: string[];
    try {
        const parsed = JSON.parse(body);
        ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    } catch {
        badRequest(res, 'Body must be JSON with an "ids" array', '/cx/nodes/detail');
        return true;
    }

    if (ids.length === 0) {
        jsonResponse(res, 200, { nodes: [] });
        return true;
    }

    const { getPlatform } = await import('../platform/index.js');
    const { parseEntity, CORE_FRONTMATTER_KEYS } = await import('../storage/entity.js');
    const { paths, storage } = getPlatform();
    const root = findFoundationRoot() ?? '';
    const allTypes = await loadEntityTypes();
    const nodes: import('../types.js').NodeDetail[] = [];

    for (const id of ids.slice(0, 50)) { // cap at 50 to prevent abuse
        let found = false;
        for (const typeConfig of allTypes) {
            const dir = paths.join(root, typeConfig.directory);
            try {
                const files = await storage.readdir(dir);
                const match = files.find(f => f.includes(`_${id}.md`) || f === `${id}.md`);
                if (!match) continue;
                const filepath = paths.join(dir, match);
                const raw = await storage.readFile(filepath, 'utf-8');
                const { meta, content } = parseEntity(filepath, raw);
                const domainFields: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(meta)) {
                    if (!CORE_FRONTMATTER_KEYS.has(key) && !key.startsWith('_')) {
                        domainFields[key] = value;
                    }
                }
                nodes.push({
                    id: meta.id as string,
                    name: (meta.name as string) || (meta.title as string) || id,
                    contextType: typeConfig.name,
                    description: (meta.description as string) || (meta.summary as string) || undefined,
                    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
                    created: (meta.created as string) || '',
                    updated: (meta.updated as string) || undefined,
                    fields: domainFields,
                    body: content,
                });
                found = true;
                break;
            } catch { /* skip */ }
        }
        if (!found) debug('cx-router', `Node not found for detail: ${id}`);
    }

    jsonResponse(res, 200, { nodes });
    return true;
}

/**
 * GET /cx/context-types/{type}/summaries?page=1&limit=30
 * Returns paginated NodeSummary[] for a specific context type.
 */
async function handleTypeSummaries(
    res: http.ServerResponse,
    url: URL,
    typeName: string,
): Promise<boolean> {
    const typeConfig = await getEntityType(typeName);
    if (!typeConfig) {
        notFound(res, `Context type not found: ${typeName}`, `/cx/context-types/${typeName}/summaries`);
        return true;
    }

    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10), 100);
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));

    const allNodes = await listEntities(typeName, { metaOnly: true });
    const total = allNodes.length;
    const start = (page - 1) * limit;
    const paged = allNodes.slice(start, start + limit);

    const summaries: import('../types.js').NodeSummary[] = paged
        .filter(({ meta }) => !meta.archivedAt)
        .map(({ meta }) => ({
            id: meta.id as string,
            name: (meta.name as string) || (meta.title as string) || String(meta.id),
            contextType: typeName,
            description: (meta.description as string) || (meta.summary as string) || undefined,
            tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
            created: (meta.created as string) || '',
            updated: (meta.updated as string) || undefined,
        }));

    jsonResponse(res, 200, { summaries, total, page, limit, pages: Math.ceil(total / limit) });
    return true;
}
