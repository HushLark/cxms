# CxMS — Context Management System

CxMS gives AI agents structured, persistent memory. Agents store and retrieve knowledge through typed **context nodes** — tasks, events, notes, people, goals, and any custom type you define. Content lives as human-readable Markdown files with YAML frontmatter in a **Foundation** directory on disk. CxMS provides BM25 full-text search with Porter stemming, a relationship graph between nodes, token-budgeted context trees for LLM consumption, vault analytics, and both a REST API and an MCP tool server so any agent framework can plug in.

## Documentation

| Page | Description |
|------|-------------|
| [How It Works](docs/how-it-works.md) | Architecture, data model, layers, and internals |
| [Foundation](docs/foundation.md) | Foundation directory structure and context files |
| [Context Types](docs/context-types.md) | Schema system, field types, and type management |
| [REST API](docs/rest-api.md) | Complete REST endpoint reference with examples |
| [MCP Tools](docs/mcp-tools.md) | All MCP tools with parameters and usage |
| [Search & Context](docs/search-and-context.md) | BM25 search, context trees, analytics, and real-time context |

---

## Highlights

- **Schema-first** — define typed context types with field validation before writing a single node
- **Human-readable storage** — every node is a plain `.md` file you can open, edit, and commit to git
- **BM25 search** — full-text search with stemming and weighted fields, no embeddings or external APIs required
- **Relationship graph** — edges extracted automatically from `@mentions`, `[[references]]`, and frontmatter links
- **Token-budgeted context tree** — agents load exactly the right memory for a query without blowing their context window
- **Vault analytics** — disk usage, file counts, and node counts per type via REST and MCP
- **Dual interface** — REST API for any language or framework, MCP tools for Claude Desktop, Cursor, and compatible agents
- **Platform-agnostic** — file I/O abstracted so CxMS runs on Node.js, React Native, or any custom runtime

---

## Quick Start

### Method 1 — Standalone server

```bash
npm install -g @gclift/cxms

# Initialize a Foundation in the current directory
cxms init

# Start the server (default port 3800)
cxms
```

```
Foundation: /path/to/my-foundation
Building index...
Indexed 0 nodes, 0 edges

CxMS listening on http://localhost:3800
  REST API:  http://localhost:3800/cx/health
  MCP:       http://localhost:3800/mcp
  Token:     cxms_a3b8f1...
```

**Connect Claude Desktop or any MCP client:**

```json
{
  "mcpServers": {
    "cxms": {
      "url": "http://localhost:3800/mcp"
    }
  }
}
```

**Use the REST API from any language:**

```bash
TOKEN=$(cxms token)

# Create a task
curl -X POST http://localhost:3800/cx/context-types/task \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Review Q3 report", "tags": ["work"], "status": "open"}'

# Full-text search
curl -X POST http://localhost:3800/cx/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "quarterly review"}'
```

### Method 2 — Embedded in your project

```bash
npm install @gclift/cxms
```

```typescript
import http from 'http';
import {
  setPlatform, createNodePlatform, setFoundationRoot,
  handleCxRoute, handleMcpRoute, getEntityIndex,
} from '@gclift/cxms';

setPlatform(createNodePlatform());
setFoundationRoot('/path/to/my-foundation');

const index = getEntityIndex();
await index.build();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/cx/')) { await handleCxRoute(req, res, url); return; }
  if (url.pathname === '/mcp') { await handleMcpRoute(req, res); return; }
  res.writeHead(404); res.end('Not found');
});

server.listen(3800);
```

Or call the library directly, with no HTTP layer:

```typescript
import {
  setPlatform, createNodePlatform, setFoundationRoot,
  getEntityIndex, searchEntities, writeEntity, generateNodeId, ensureEntityDir, nodeFilename,
} from '@gclift/cxms';

setPlatform(createNodePlatform());
setFoundationRoot('/path/to/foundation');
await getEntityIndex().build();

const results = await searchEntities('quarterly review', 'task');

const id = generateNodeId();
const dir = await ensureEntityDir('note');
await writeEntity(`${dir}/${nodeFilename('Agent memory snapshot', id)}`, {
  id, title: 'Agent memory snapshot', entityType: 'note',
  created: new Date().toISOString(), tags: ['agent', 'memory'],
}, 'Key observations from today...');
```

---

## CLI Reference

```
cxms                              Start the server
cxms init                         Initialize a Foundation in the current directory
cxms token                        Print the bearer token
cxms token --regenerate           Regenerate the bearer token

--port,        -p <port>          Port (default: 3800)
--foundation,  -f <path>          Foundation root directory
--no-auth                         Disable bearer token authentication
```

System config lives in `~/.cxms/config.json` — `{ "foundationRoot": "...", "port": 3800 }`.

---

## License

MIT
