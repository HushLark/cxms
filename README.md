# CxMS — Context Management System

CxMS gives AI agents structured, persistent memory. Instead of losing context between conversations or stuffing everything into a system prompt, agents store and retrieve knowledge through typed context nodes — tasks, events, notes, people, goals, and any custom type you define. Content is stored as human-readable Markdown files with YAML frontmatter, organized in a Foundation directory. CxMS provides full-text search (BM25 with stemming), a relationship graph between nodes, and a token-budgeted context tree that agents can use to load exactly the right information for a given query. It ships with both a REST API and an MCP tool server, so any agent framework can plug in.

## Two Ways to Use CxMS

### Method 1: Embed in Your Project

Install the package and mount the API and MCP server on your own HTTP server. This gives you full programmatic access to the CxMS internals alongside your application logic.

```bash
npm install @gclift/cxms
```

```typescript
import http from 'http';
import {
  setPlatform,
  createNodePlatform,
  setFoundationRoot,
  initFromSystemConfig,
  handleCxRoute,
  handleMcpRoute,
  setAuthEnabled,
  getEntityIndex,
} from '@gclift/cxms';

// 1. Initialize platform (Node.js)
setPlatform(createNodePlatform());

// 2. Load config from ~/.cxms/config.json (sets foundation root if configured)
const config = await initFromSystemConfig();

// Or set foundation root explicitly
setFoundationRoot('/path/to/my/foundation');

// 3. Build the search index
const index = getEntityIndex();
await index.build();

// 4. Start HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  // REST API — /cx/*
  if (url.pathname.startsWith('/cx/')) {
    await handleCxRoute(req, res, url);
    return;
  }

  // MCP server — /mcp
  if (url.pathname === '/mcp') {
    await handleMcpRoute(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(config.port || 3800, () => {
  console.log('CxMS listening on port', config.port || 3800);
});
```

You can also use CxMS functions directly without the HTTP layer:

```typescript
import {
  setPlatform, createNodePlatform, setFoundationRoot,
  getEntityIndex, listEntities, searchEntities, writeEntity,
  generateNodeId, ensureEntityDir, nodeFilename, loadEntityTypes,
} from '@gclift/cxms';

setPlatform(createNodePlatform());
setFoundationRoot('/path/to/foundation');

const index = getEntityIndex();
await index.build();

// Search for tasks
const results = await searchEntities('quarterly review', 'task');

// Create a node
const id = generateNodeId();
const dir = await ensureEntityDir('note');
const filepath = `${dir}/${nodeFilename('Agent memory snapshot', id)}`;
await writeEntity(filepath, {
  id, title: 'Agent memory snapshot', entityType: 'note',
  created: new Date().toISOString(), tags: ['agent', 'memory'],
}, 'Key observations from today...');
```

### Method 2: Run Standalone

Install globally and run CxMS as a headless server. Agents connect over HTTP (REST API) or MCP.

```bash
npm install -g @gclift/cxms

# Initialize a Foundation in the current directory
cxms init

# Start the server
cxms
```

```
CxMS listening on http://localhost:3800
  REST API:  http://localhost:3800/cx/health
  MCP:       http://localhost:3800/mcp
  Token:     cxms_a3b8f1...
```

**Connect an MCP client** (Claude Desktop, Cursor, or any MCP-compatible agent):

```json
{
  "mcpServers": {
    "cxms": {
      "url": "http://localhost:3800/mcp"
    }
  }
}
```

**Use the REST API** from any language or agent framework:

```bash
TOKEN=$(cxms token)

# Create a task
curl -X POST http://localhost:3800/cx/context-types/task \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Review Q3 report", "tags": ["work"], "status": "open"}'

# Search across all nodes
curl -X POST http://localhost:3800/cx/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "quarterly review"}'
```

**CLI options:**

```
cxms                              Start the server
cxms init                         Initialize a Foundation in the current directory
cxms token                        Print the bearer token
cxms token --regenerate           Generate a new bearer token

--port, -p <port>                 Port (default: 3800)
--foundation, -f <path>           Foundation root directory
--no-auth                         Disable bearer token authentication
```

---

## Configuration

CxMS stores system config in `~/.cxms/`:

| File | Purpose |
|------|---------|
| `config.json` | `{ foundationRoot?: string, port?: number }` |
| `token` | Bearer token for API auth (auto-generated on first use) |

## Authentication

All REST endpoints except `GET /cx/health` require a bearer token:

```bash
TOKEN=$(cxms token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3800/cx/context-types
```

Disable auth for local development:

```typescript
import { setAuthEnabled } from '@gclift/cxms';
setAuthEnabled(false);
```

Or with the CLI:

```bash
cxms --no-auth
```

---

## REST API

All endpoints return JSON. Errors use [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) (`application/problem+json`).

### Health

```
GET /cx/health
```

No auth required. Returns foundation status and context type count.

### Context Types

```
GET    /cx/context-types              — List all types with schemas
GET    /cx/context-types/count        — Count types
POST   /cx/context-types              — Create a new type
GET    /cx/context-types/:type/details — Get type schema + examples
PUT    /cx/context-types/:type        — Update type schema
DELETE /cx/context-types/:type        — Remove type (built-ins protected)
```

**Create a type:**

```bash
curl -X POST http://localhost:3800/cx/context-types \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "habit",
    "plural": "habits",
    "directory": "context-types/habit",
    "description": "Daily habits to track",
    "fields": [
      { "key": "frequency", "type": "enum", "values": ["daily", "weekly"] },
      { "key": "streak", "type": "number" }
    ],
    "completionField": "status",
    "completionValue": "done"
  }'
```

### Context Nodes

```
GET    /cx/context-types/:type            — List nodes (query: ?status=&tag=&limit=&offset=)
GET    /cx/context-types/:type/count      — Count nodes of type
GET    /cx/context-types/:type/:id        — Get node with ancestor context
POST   /cx/context-types/:type            — Create node
PUT    /cx/context-types/:type/:id        — Update node
DELETE /cx/context-types/:type/:id        — Soft-delete to .trash/
```

**Create a node:**

```bash
curl -X POST http://localhost:3800/cx/context-types/task \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Review Q3 report",
    "tags": ["work", "urgent"],
    "status": "open",
    "priority": "high",
    "content": "Need to review before Friday standup."
  }'
```

**Update a node:**

```bash
curl -X PUT http://localhost:3800/cx/context-types/task/abc123 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "status": "done" }'
```

### Search

```
POST /cx/search                        — Full-text search (BM25)
GET  /cx/tag/:tag                      — Find nodes by tag
GET  /cx/date                          — Today's calendar entries
GET  /cx/date-range/:start/:end        — Date range query (YYYY-MM-DD)
```

**Search:**

```bash
curl -X POST http://localhost:3800/cx/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "query": "meeting with Bob", "type": "event" }'
```

### Collections

```
GET /cx/collections                    — List collection names
GET /cx/collection/:name               — Get full collection
GET /cx/collection/:name/:key          — Get single item
GET /cx/collection/:name/count         — Count items
```

---

## MCP Tools

CxMS exposes an [MCP](https://modelcontextprotocol.io) tool server via Streamable HTTP transport at `/mcp`. Any MCP-compatible client can connect and use these tools:

**Context Types**

| Tool | Description |
|------|-------------|
| `list_types` | List all context types with field schemas |
| `get_type` | Get type schema + `.cxms.md` context |
| `create_type` | Create a new context type |
| `update_type` | Update type schema |
| `delete_type` | Remove a context type |

**Context Nodes**

| Tool | Description |
|------|-------------|
| `list_nodes` | List nodes by type (filter by status, tag, limit, offset) |
| `get_node` | Get node by ID or title — full metadata + content |
| `create_node` | Create node with schema validation |
| `update_node` | Update fields, tags, content |
| `delete_node` | Soft-delete to .trash/ |

**Search & Discovery**

| Tool | Description |
|------|-------------|
| `search` | Full-text BM25 search with ranked results |
| `search_by_tag` | Find nodes by tag across all types |
| `search_by_date_range` | Query by calendar date field |

**Context**

| Tool | Description |
|------|-------------|
| `get_node_summary` | Title, tags, key fields, content snippet |
| `count_nodes` | Node counts per type, with optional search match breakdown |
| `get_moment` | Real-time context: date, overdue tasks, today's schedule |
| `get_context_tree` | Token-budgeted hierarchical context for LLMs |
| `get_vault_context` | Read the root `.cxms.md` file |

**Collections**

| Tool | Description |
|------|-------------|
| `list_collections` | List all key-value collections |
| `get_collection` | Get full collection or single item |
| `set_collection_item` | Set a key-value pair |
| `remove_collection_item` | Remove a key-value pair |

**System**

| Tool | Description |
|------|-------------|
| `health` | Foundation path, type count, index stats |

### Example: count_nodes with search terms

The `count_nodes` tool accepts a `query` parameter to show how many nodes in each type match search terms — useful for narrowing focus before a full search:

```json
{ "query": "Bob" }
```

Returns:

```json
[
  { "type": "person", "total": 42, "matches": 1, "samples": ["Bob Smith"] },
  { "type": "event",  "total": 15, "matches": 2, "samples": ["1:1 with Bob", "Bob's birthday"] },
  { "type": "task",   "total": 87, "matches": 0, "samples": [] }
]
```

---

## Search

CxMS uses a BM25 inverted index with Porter stemming for full-text search. No embeddings or external APIs required.

**Indexed fields with weights:**

| Field | Weight | Description |
|-------|--------|-------------|
| Title | 5x | Node title |
| Tags | 3x | All tags |
| Summary | 2x | Frontmatter summary |
| Custom fields | 1.5x | Status, priority, and other field values |
| Body | 1x | Full markdown content |

**Features:**
- Stemming: "meetings" matches "meeting", "scheduled" matches "schedule"
- Stop word removal: common words filtered out
- Length normalization: long documents don't unfairly dominate
- IDF weighting: rare terms score higher than common ones
- Tag prefix filtering: `tag:urgent` filters by tag before scoring

The index is built on startup with `getEntityIndex().build()` and stays in sync via `addOrUpdate()` / `remove()` on writes.

---

## Foundation Structure

A Foundation is a directory marked by a `.cxms.md` file at its root:

```
my-foundation/
  .cxms.md                         # Root context (read by LLMs)
  context-types/
    task/
      .cxms.md                     # Type context + schema description
      .cxms-examples.md            # Example nodes for this type
      review-q3-report_abc123.md   # A context node
    event/
    note/
    ...
  collections/
    shortcuts.md                   # Key-value collection
  logs/
    access-2026-04-17.txt          # Daily access log (Apache Combined)
    error-2026-04-17.txt           # Daily error log
  .phaibel/
    entity-types.json              # Type definitions
    embeddings.json                # Optional embedding store
  .trash/                          # Soft-deleted nodes
```

Each context node is a Markdown file with YAML frontmatter:

```markdown
---
id: abc123
title: Review Q3 report
entityType: task
created: 2026-04-17T10:00:00.000Z
tags: [work, urgent]
status: open
priority: high
---

Need to review before Friday standup.
```

---

## Platform Abstraction

CxMS abstracts file I/O and path operations so it can run on Node.js, React Native, or any platform:

```typescript
import { setPlatform, createNodePlatform } from '@gclift/cxms';

// Node.js (default, auto-detected)
setPlatform(createNodePlatform());

// Custom platform
import type { PlatformProvider } from '@gclift/cxms/platform/types';

const myPlatform: PlatformProvider = {
  storage: { readFile, writeFile, readdir, mkdir, rename, access, unlink, appendFile, stat },
  paths: { join, basename, dirname, resolve, extname, sep },
  homedir: () => '/custom/home',
  generateId: (len) => randomString(len),
};
setPlatform(myPlatform);
```

## License

MIT
