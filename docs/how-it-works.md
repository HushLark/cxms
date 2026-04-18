# How CxMS Works

CxMS is a structured memory system for AI agents. This page explains the architecture from the ground up — what the layers are, how data flows through them, and what happens when an agent stores or retrieves a node.

---

## The Mental Model

A CxMS system is built around three concepts:

**Foundation** — A directory on disk marked by a `.cxms.md` file at its root. Everything CxMS stores lives inside this directory. You can have multiple independent Foundations for different projects, agents, or personas.

**Context Type** — A schema definition for a category of information. A context type has a name (`task`), a plural (`tasks`), a set of typed fields (`status`, `priority`), and optional completion and calendar semantics. CxMS ships with no default types — you define exactly what your agent needs.

**Context Node** — A single record within a context type. Stored as a Markdown file with YAML frontmatter. The frontmatter holds the structured data (id, title, tags, custom fields); the Markdown body holds free-form content. Nodes are files you can open in any editor, commit to git, or manipulate with standard tools.

---

## Architecture: Seven Layers

CxMS is organized into seven layers, each building on the ones below it.

```
┌─────────────────────────────────────┐
│  Server Layer                       │  REST API, MCP tools, auth, logging
├─────────────────────────────────────┤
│  Context Layer                      │  Context tree, query relevance, moment
├─────────────────────────────────────┤
│  Index Layer                        │  BM25 full-text search, relationship graph
├─────────────────────────────────────┤
│  Storage Layer                      │  Node I/O, validation, collections
├─────────────────────────────────────┤
│  Schema Layer                       │  Type definitions, field config, persistence
├─────────────────────────────────────┤
│  Foundation Layer                   │  Root discovery, path resolution
├─────────────────────────────────────┤
│  Platform Layer                     │  File I/O abstraction (Node.js / custom)
└─────────────────────────────────────┘
```

### Platform Layer (`src/platform/`)

The platform layer abstracts all file I/O and path operations behind a `PlatformProvider` interface. This is the only place CxMS touches the filesystem directly. Every other layer goes through the platform.

```typescript
interface StorageProvider {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; mtime: Date; size: number }>;
  // ... plus access, unlink, appendFile
}
```

Before calling any CxMS function, you must set the platform:

```typescript
import { setPlatform, createNodePlatform } from '@gclift/cxms';
setPlatform(createNodePlatform()); // Node.js built-ins (fs, path, os, crypto)
```

To run CxMS on React Native or another runtime, implement `PlatformProvider` with that platform's file APIs and call `setPlatform(myPlatform)`.

### Foundation Layer (`src/foundation.ts`, `src/paths.ts`)

The foundation layer knows where data lives. It resolves the Foundation root directory — either from an explicit `setFoundationRoot()` call or by scanning upward from the current working directory looking for a `.cxms.md` file. From the root, it derives all other paths:

| Function | Path |
|----------|------|
| `getContextTypesDir()` | `{root}/context-types/` |
| `getCollectionsDir()` | `{root}/collections/` |
| `getFoundationLogsDir()` | `{root}/logs/` |
| `getVaultConfigDir()` | `{root}/.phaibel/` |
| `getEntityTypesPath()` | `{root}/.phaibel/entity-types.json` |

The Foundation root is a process-global singleton. In multi-tenant scenarios (e.g. the integration tests), you reset and re-set it per request: `resetFoundationRoot()` then `setFoundationRoot(dir)`.

### Schema Layer (`src/schema/`)

The schema layer manages context type definitions. Types are stored in `.phaibel/entity-types.json` — a JSON file with a `version` number and an `entityTypes` array of `EntityTypeConfig` objects.

```json
{
  "version": 1,
  "entityTypes": [
    {
      "name": "task",
      "plural": "tasks",
      "directory": "context-types/task",
      "description": "A task to complete",
      "fields": [
        { "key": "status", "type": "enum", "values": ["open", "done"], "required": true },
        { "key": "priority", "type": "enum", "values": ["low", "medium", "high"] }
      ],
      "completionField": "status",
      "completionValue": "done"
    }
  ]
}
```

The schema layer also writes a `.cxms.md` context file into each type's directory when the type is created. This file describes the type's purpose, fields, and guidelines — it is read by LLMs as part of the context tree.

Type definitions are cached in memory (`_cache`) and invalidated on write. Calling `invalidateEntityTypeCache()` clears the cache on the next read.

### Storage Layer (`src/storage/`)

The storage layer reads and writes context nodes as Markdown files. Each node's filename is `{slug}_{id}.md` where the slug is a URL-safe version of the title and the id is an 8-character alphanumeric string generated at creation time.

**Reading a node** — `parseEntity(filepath, raw)` splits the file into YAML frontmatter (`meta`) and Markdown body (`content`) using `gray-matter`. The `meta` object contains all frontmatter fields including id, title, tags, created, and any custom type-specific fields.

**Writing a node** — `writeEntity(filepath, meta, content)` serializes the meta object back to YAML frontmatter and writes the file atomically.

**Soft deletion** — `trashEntity(filepath)` moves the file to `.trash/{type}/` instead of deleting it. The trash directory mirrors the type directory structure. To permanently delete, remove files from `.trash/` manually.

**Validation** — `validateEntity(meta, typeConfig, isCreate, changedKeys?)` checks each field against the type's field schema. On create (`isCreate: true`), required fields without defaults must be present. On update, only fields in `changedKeys` are validated.

**Collections** — Key-value stores in `collections/{name}.md`. Each collection is a Markdown file with YAML frontmatter listing the items. Collections support `get`, `set`, `list`, `remove`, and `count` operations.

**Boundary guard** — `assertWithinFoundation(filepath)` prevents path traversal attacks by checking that every file path resolves within the Foundation root before any read or write.

### Index Layer (`src/index/`)

The index layer provides in-memory full-text search and a relationship graph. It is built on startup and updated incrementally on writes.

**BM25 full-text search** — `BM25Index` in `src/index/bm25.ts` implements the BM25 ranking function with Porter stemming (`src/index/stemmer.ts`). Each node is indexed across five weighted fields:

| Field | Weight | Rationale |
|-------|--------|-----------|
| `title` | 5× | The most discriminating signal |
| `tags` | 3× | User-curated labels |
| `summary` | 2× | Human-authored one-liner |
| Custom fields | 1.5× | Status, priority, category, etc. |
| `body` | 1× | Full markdown content |

BM25 accounts for document length: a match in a short document scores higher than the same match buried in a long one. IDF weighting ensures rare terms score higher than common ones.

**Porter stemming** — Queries and documents are both stemmed before indexing. This means a search for `"meetings"` matches nodes containing `"meeting"`, `"met"`, or `"meet"`.

**Tag prefix queries** — Tokens beginning with `tag:` are treated as exact tag filters applied after BM25 scoring. `"tag:urgent quarterly review"` returns nodes matching the full-text query AND tagged `urgent`.

**Relationship graph** — The index also builds a directed edge graph. Edges are extracted from:
- `@firstname` mentions in the Markdown body → `mention` edges to `person` nodes
- `[[type:slug]]` references in the body → `reference` edges to the target node
- `links:` frontmatter arrays → `link` edges with labels

**Index lifecycle:**

```typescript
const index = getEntityIndex(); // global singleton
await index.build();            // read all nodes from disk; called at startup

// After writing a node:
await index.addOrUpdate(type, id, title, filepath, tags, summary);

// After deleting a node:
index.remove(type, id);

// Get index stats:
const stats = index.getStats(); // { nodeCount, edgeCount, byType, builtAt }
```

The index singleton is reset by calling `resetEntityIndex()`.

### Context Layer (`src/context/`)

The context layer turns raw index data into structured output optimized for LLM consumption.

**Context tree** — A hierarchical representation of the vault with a configurable scope. The scope determines how much data is loaded:

| Scope | What's included |
|-------|----------------|
| `trunk` | Root `.cxms.md`, stats (type list, total nodes). Smallest. |
| `branch` | Trunk + type schemas + summary metadata for recent nodes per branch |
| `branch-full` | Same as branch but includes full Markdown content of each node |
| `leaves` | Specific nodes by key, with full content |
| `cross` | Trunk + named branches + BM25 search results across all types |

Each scope is designed to fit within a typical LLM context window. The `trunk` scope is cheap (metadata only). `cross` is best for query-driven retrieval.

**Moment context** — `buildMomentContext()` returns real-time information: today's date and time, day of week, overdue tasks (tasks past their calendar date with an open status), and today's scheduled events. This is injected into system prompts to give agents situational awareness.

**Query relevance** — `analyzeQueryRelevance(query, types)` scores each context type's relevance to a natural language query, helping agents decide which branches to load before committing to a full search.

**Vault context** — The root `.cxms.md` file and each type's `.cxms.md` file are read as plain strings and embedded in the context tree. These files are the primary mechanism for giving agents long-term, human-authored guidance about the vault's purpose and conventions.

### Server Layer (`src/server/`)

The server layer exposes everything above via HTTP.

**REST router** (`cx-router.ts`) — handles `/cx/*` routes. All routes except `/cx/health` require a bearer token. Errors are returned as [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) with `Content-Type: application/problem+json`.

**MCP server** (`mcp-server.ts`) — uses `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport` to expose 21 tools at `/mcp`. The transport is stateless (`sessionIdGenerator: undefined`) — each HTTP POST to `/mcp` is handled as an independent request.

**Auth** (`auth.ts`) — bearer token stored in `~/.cxms/token`. Load with `loadBearerToken()`, regenerate with `regenerateToken()`. Disable entirely with `setAuthEnabled(false)`.

**Access logging** (`log/access-log.ts`) — Apache Combined Log Format, written to `{foundation}/logs/access-YYYY-MM-DD.txt`, rotated daily.

**Error logging** (`log/error-log.ts`) — writes caught exceptions and stack traces to `{foundation}/logs/error-YYYY-MM-DD.txt`.

---

## Data Flow: Creating a Node

Here is the complete data path when an agent calls `POST /cx/context-types/task`:

1. **HTTP request arrives** at the Node.js server with a JSON body
2. **Auth middleware** (`authenticateRequest`) checks the `Authorization: Bearer` header
3. **Router** matches `/cx/context-types/task` → `handleCreateNode(req, res, 'task')`
4. **Schema layer** loads the `task` type config from the in-memory cache (or disk if cache is empty)
5. **Storage layer** validates the request body against the type's field schema (`validateEntity`)
6. **ID generation** — `generateNodeId()` produces an 8-char alphanumeric string
7. **File path** — `ensureEntityDir('task')` creates `{foundation}/context-types/task/` if needed; `nodeFilename(title, id)` produces `review-q3-report_abc12345.md`
8. **Write** — `writeEntity(filepath, meta, content)` serializes and writes the file
9. **Index update** — `index.addOrUpdate(...)` adds the node to the BM25 index and scans for relationship edges
10. **Response** — `201 Created` with `{ id, title, type, filepath }`

---

## Data Flow: Searching

When an agent calls `POST /cx/search` with `{ "query": "quarterly review" }`:

1. **Router** dispatches to `handleSearch`
2. **`searchEntities(query, type?, options?)`** is called in the storage layer
3. **Index layer** tokenizes and stems the query: `["quarter", "review"]`
4. **BM25** ranks all indexed nodes by relevance score
5. **Optional tag filter** removes nodes that don't match required tags
6. **Results** are sorted by score and returned as `{ id, title, type, score, tags, summary }`

Search is always in-memory after the initial `index.build()`. There are no database queries.

---

## Node File Format

Every context node is a self-describing Markdown file:

```markdown
---
id: abc12345
title: Review Q3 report
entityType: task
created: 2026-04-17T10:00:00.000Z
updated: 2026-04-18T09:30:00.000Z
tags: [work, urgent]
summary: Review the Q3 financial report before Friday standup.
status: open
priority: high
references:
  - "blocks:task:def67890"
---

The report is in SharePoint under Finance > 2026 > Q3.

Key sections to review:
- Revenue vs forecast
- Headcount changes
- Capex breakdown

Flag anything that differs from the board deck by more than 5%.
```

**System fields** (always present):
- `id` — 8-char alphanumeric, unique within the type
- `title` — human-readable name
- `entityType` — the context type name
- `created` — ISO 8601 timestamp set at creation
- `tags` — array of strings

**Optional system fields:**
- `updated` — ISO 8601 timestamp, set on every write
- `summary` — one-sentence summary (max 150 chars), agent-generated
- `source` — `user | assumed | system`
- `references` — labeled links to other nodes in shorthand format `label:type:id`

**Custom fields** — everything else, validated against the type's field schema.

---

## Relationship Graph

Edges in the relationship graph are extracted at index build time and on every `addOrUpdate` call. Three edge types:

**mention** — `@firstname` in the Markdown body creates a mention edge to any `person` node whose title starts with that first name.

```markdown
Spoke with @alice today about the roadmap.
```
→ `mention` edge from this node to `person:alice-smith` (if that node exists)

**reference** — `[[type:slug]]` creates a reference edge to the target node.

```markdown
This task depends on [[task:infrastructure-upgrade]].
```
→ `reference` edge from this node to `task:infrastructure-upgrade`

**link** — frontmatter `links:` array creates typed link edges with labels.

```yaml
links:
  - target: "person:abc12345"
    label: "assigned-to"
```
→ `link` edge with label `assigned-to`

Edges are bidirectional in traversal: `getEdgesFrom(key)` and `getEdgesTo(key)`. `getNeighbors(key)` returns both directions with `direction: 'in' | 'out'`.

---

## Multi-Foundation / Multi-Tenant

CxMS uses process-global singletons for the foundation root, platform, entity type cache, and search index. For single-tenant servers this is transparent. For multi-tenant scenarios (e.g. one process serving multiple Foundations), reset and re-initialize per request:

```typescript
import {
  resetFoundationRoot, setFoundationRoot,
  resetEntityIndex, getEntityIndex,
  invalidateEntityTypeCache,
  setPlatform, createNodePlatform,
} from '@gclift/cxms';

server.on('request', async (req, res) => {
  const foundationDir = getFoundationForTenant(req);

  resetFoundationRoot();
  resetEntityIndex();
  invalidateEntityTypeCache();
  setPlatform(createNodePlatform());
  setFoundationRoot(foundationDir);

  const index = getEntityIndex();
  if (!index.isBuilt) await index.build();

  // route request...
});
```

This pattern is used in the integration tests to run three independent Foundation servers in a single Node.js process.

---

## See Also

- [Foundation](./foundation.md) — directory structure and context files in detail
- [Context Types](./context-types.md) — field types, schema config, and type management
- [REST API](./rest-api.md) — complete endpoint reference
- [MCP Tools](./mcp-tools.md) — all 21 MCP tools with examples
- [Search & Context](./search-and-context.md) — BM25, context tree scopes, analytics
