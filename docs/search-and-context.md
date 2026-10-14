# Search & Context

CxMS provides two complementary retrieval systems: **BM25 full-text search** for finding nodes by content, and the **context tree** for loading structured, token-budgeted snapshots of the Foundation into an LLM's context window. Both systems are built on the same in-memory index, which is populated at startup and updated incrementally on every write.

---

## Full-Text Search

### BM25 Ranking

CxMS uses the BM25 (Best Match 25) ranking algorithm, the industry-standard probabilistic retrieval model used in search engines like Elasticsearch and Solr. BM25 addresses two problems with naive keyword matching: term saturation (a word appearing 100× is not 100× more relevant than once) and document length bias (a match in a long document should score lower than the same match in a short one).

The BM25 score for document `d` and query `q` is:

```
score(d, q) = Σ IDF(t) × (tf(t,d) × (k1 + 1)) / (tf(t,d) + k1 × (1 - b + b × |d|/avgdl))
```

Where:
- `t` iterates over query terms
- `tf(t,d)` — term frequency: how often term `t` appears in document `d`
- `IDF(t)` — inverse document frequency: `log((N - n(t) + 0.5) / (n(t) + 0.5) + 1)` where `N` is total documents and `n(t)` is documents containing the term
- `|d|` — document length in tokens
- `avgdl` — average document length across the collection
- `k1 = 1.2` — term frequency saturation: controls how much additional occurrences matter
- `b = 0.75` — length normalization: how strongly length affects scoring

**What this means in practice:**

- A term that appears in 2 out of 1000 nodes scores much higher per match than one appearing in 500 out of 1000 (IDF weighting — rare terms are more discriminating)
- Matching "quarterly" once in a 10-word title matters more than matching it 5 times in a 2000-word body (length normalization)
- The BM25 score saturates quickly: the 3rd occurrence of a term adds far less than the 1st (term frequency saturation)

### Porter Stemming

Before indexing and before querying, CxMS applies Porter stemming to each token. Stemming reduces words to their base form so that variations match:

| Query term | Stems to | Matches |
|------------|----------|---------|
| `meetings` | `meet` | meeting, meets, met, meeting's |
| `running` | `run` | run, runs, ran, runner |
| `quarterly` | `quarterli` | quarter, quarterly |
| `blocked` | `block` | block, blocking, blocker |

Stemming is applied symmetrically: both the query tokens and the indexed tokens are stemmed. So `"unblocking tasks"` correctly matches a node with `status: "blocked"` if the body mentions unblocking.

Stopwords (`the`, `a`, `is`, `in`, etc.) are filtered before stemming to avoid noise.

### Field Weights

CxMS indexes four fields per node, each with a different weight multiplier:

| Field | Weight | Rationale |
|-------|--------|-----------|
| `title` | 5× | The author's intentional label; highest signal |
| `summary` | 2× | Human-authored one-liner; dense signal |
| Custom fields | 1.5× | Status, priority, category — structured but not prose |
| `body` | 1× | Full content; high noise relative to title |

A query match in the title outweighs five matches in the body. This reflects the reality that titles are deliberately chosen to represent the document's essence, while body text contains incidental mentions.

**Custom field indexing**: All custom fields from the type schema are concatenated into a single weighted field. So if a task has `status: "blocked"` and `assignee: "alice"`, searching `"blocked alice"` will score that node highly even if neither word appears in the title or body.

### Making a Search Request

#### REST API

```bash
POST /cx/search
Content-Type: application/json

{
  "query": "quarterly review",
  "type": "task",
  "limit": 10,
  "offset": 0
}
```

All fields except `query` are optional:
- `type` — restrict to a single context type
- `limit` — max results (default 20, max 100)
- `offset` — for pagination

Response:
```json
{
  "count": 3,
  "results": [
    {
      "id": "abc12345",
      "title": "Review Q3 quarterly report",
      "type": "task",
      "score": 12.47,
      "summary": "Review the Q3 financial report before Friday standup."
    }
  ]
}
```

Scores are BM25 scores — higher is more relevant. There is no maximum; scores depend on the size of your collection and the query specificity.

#### MCP Tool

```json
{
  "tool": "search",
  "arguments": {
    "query": "quarterly review",
    "type": "task",
    "limit": 10
  }
}
```

Returns the same shape as the REST response.

### Index Lifecycle

The BM25 index is an in-memory singleton built at startup:

```typescript
const index = getEntityIndex();
await index.build(); // Reads all nodes from disk; called once at server start
```

Every write operation (create, update, delete, restore) updates the index incrementally — there is no periodic rebuild or background sync. After a node is written, it is immediately searchable.

```typescript
// After writing a node:
await index.addOrUpdate(type, id, title, filepath, summary);

// After deleting a node:
index.remove(type, id);
```

Index stats are available via `GET /cx/index` (REST) or `get_index_stats` (MCP):

```json
{
  "nodeCount": 142,
  "edgeCount": 38,
  "byType": {
    "task": 87,
    "note": 31,
    "person": 24
  },
  "builtAt": "2026-04-18T10:00:00.000Z"
}
```

---

## Relationship Graph

The index also maintains a directed relationship graph alongside the BM25 index. Edges are extracted from node content at index build time and updated on every `addOrUpdate`.

### Edge Types

**`mention`** — Created from `@firstname` references in the Markdown body. CxMS looks up `person` nodes whose title begins with that first name.

```markdown
Spoke with @alice today about the roadmap direction.
```

→ `mention` edge from this node to `person:alice-chen` (if a person node titled "Alice Chen" exists)

Mention edges are best-effort: if no matching person node exists, no edge is created. The `@mention` text remains in the body regardless.

**`reference`** — Created from `[[type:slug]]` syntax in the Markdown body.

```markdown
This task depends on [[task:infrastructure-upgrade]].
See also [[note:architecture-decisions]].
```

→ `reference` edges from this node to `task:infrastructure-upgrade` and `note:architecture-decisions`. The slug must match the node's filename slug (not the id).

**`link`** — Created from the `references` array in YAML frontmatter. This is the most explicit and reliable edge type.

```yaml
references:
  - "blocks:task:def67890"
  - "assigned-to:person:abc12345"
  - "about:event:ghi11111"
```

The shorthand format is `label:contextType:nodeId`. You can also use the object form:

```yaml
references:
  - label: "blocks"
    contextType: "task"
    nodeId: "def67890"
```

Both formats are parsed identically. The label is a free-form string — use whatever relationship vocabulary makes sense for your domain (`blocks`, `depends-on`, `assigned-to`, `related-to`, `parent`, `child`, etc.).

### Graph Traversal

The relationship graph is not directly exposed via REST but is used internally by the context tree. You can query neighbors via the programmatic API:

```typescript
const index = getEntityIndex();

// All edges from a node
const outEdges = index.getEdgesFrom('task:abc12345');
// [{ from: 'task:abc12345', to: 'person:def67890', label: 'assigned-to', type: 'link' }]

// All edges to a node
const inEdges = index.getEdgesTo('person:def67890');
// [{ from: 'task:abc12345', to: 'person:def67890', label: 'assigned-to', type: 'link' }]

// Both directions
const neighbors = index.getNeighbors('task:abc12345');
// [{ key: 'person:def67890', label: 'assigned-to', type: 'link', direction: 'out' }]
```

The node key format is `{typeName}:{nodeId}` (e.g. `task:abc12345`).

---

## Context Tree

The context tree is how CxMS packages Foundation data for LLM consumption. Rather than dumping all node content into a prompt, the context tree provides structured, scoped views that balance completeness against token budget.

### Scope Types

CxMS defines five scopes, from smallest to largest:

#### `trunk`

The root of the Foundation only. Includes:
- The text of the root `.cxms.md` file (purpose, conventions)
- A type list with node counts per type
- Total node count

**Use when**: You need to orient an agent without loading any actual data. Useful at the start of a session to decide which branches to load next.

**Typical token cost**: 500–1500 tokens

```bash
GET /cx/context?scope=trunk
```

#### `branch`

Trunk plus, for each context type:
- The type's `.cxms.md` schema and guidelines file
- A summary list of recent nodes (title, id, summary, key fields)

Full node body content is **not** included. This gives the agent enough to know what exists without reading every word.

**Use when**: The agent needs an overview of a specific type to decide which nodes to load in full.

**Typical token cost**: 2000–8000 tokens (depends on node count and summary length)

```bash
GET /cx/context?scope=branch&type=task
```

If `type` is omitted, all branches are included. If you have many types with many nodes, specify the type.

#### `branch-full`

Same as `branch` but includes the full Markdown body of each node.

**Use when**: You need complete content for all nodes of a type — for example, building a comprehensive context for a planning session.

**Typical token cost**: 5000–50000+ tokens (depends heavily on node body length)

```bash
GET /cx/context?scope=branch-full&type=note
```

Use with caution. If the type has 200 long notes, this will exceed most context windows.

#### `leaves`

Loads specific nodes by their full key (`type:id`). Returns complete frontmatter and body for each.

**Use when**: You know exactly which nodes you need (e.g., from a prior search result or the agent's memory).

```bash
GET /cx/context?scope=leaves&keys=task:abc12345,task:def67890,person:ghi11111
```

This is the most surgical scope — minimum tokens, maximum specificity.

#### `cross`

Trunk plus named branches plus BM25 search results across all types for a query.

**Use when**: The agent has a natural language query and needs results from multiple types simultaneously.

```bash
GET /cx/context?scope=cross&query=Q3+quarterly+review&branches=task,note
```

Parameters:
- `query` — BM25 search query applied across all types
- `branches` — comma-separated list of branches to include in full
- `limit` — max search results to include (default 10)

The response interleaves the branch summaries with search results, giving the LLM both schema context and relevant matching nodes.

### Context Tree via MCP

The `get_context` MCP tool wraps the same endpoint:

```json
{
  "tool": "get_context",
  "arguments": {
    "scope": "cross",
    "query": "Q3 quarterly review",
    "branches": ["task", "note"],
    "limit": 10
  }
}
```

For simple branch loads:

```json
{
  "tool": "get_context",
  "arguments": {
    "scope": "branch",
    "type": "task"
  }
}
```

### Query Relevance Scoring

Before committing to loading a full branch, use `analyzeQueryRelevance` to rank which types are most relevant to a query. This is a lightweight heuristic — it scores types based on their name, description, and field names against the query terms.

```bash
GET /cx/context/relevance?query=meeting+tomorrow+with+alice
```

Response:

```json
{
  "ranked": [
    { "type": "event", "score": 0.82 },
    { "type": "person", "score": 0.61 },
    { "type": "task", "score": 0.34 },
    { "type": "note", "score": 0.21 }
  ]
}
```

Use this to decide which branches to include in a `cross` scope request, rather than loading all branches blindly.

**Agent workflow using relevance scoring:**

1. Get moment context (`get_moment`) — understand today's date and any overdue items
2. Get relevance scores for the user's query
3. Load `cross` scope with top 2–3 branches and the user's query
4. If needed, load specific nodes by `leaves` scope using ids from search results

---

## Real-Time Context (Moment)

The moment context provides situational awareness: what time it is, what's overdue, and what's scheduled for today. Inject this at the start of every system prompt to give agents a time anchor.

### Getting Moment Context

```bash
GET /cx/moment
```

Response:

```json
{
  "now": "2026-04-18T14:23:00-07:00",
  "date": "2026-04-18",
  "time": "14:23",
  "dayOfWeek": "Saturday",
  "overdue": [
    {
      "id": "abc12345",
      "title": "Submit Q1 expense report",
      "type": "task",
      "due": "2026-04-15",
      "daysOverdue": 3,
      "priority": "high"
    }
  ],
  "today": [
    {
      "id": "def67890",
      "title": "Weekly team standup",
      "type": "event",
      "starts_at": "2026-04-18T09:30:00-07:00",
      "duration": "PT30M"
    }
  ]
}
```

### How Overdue Detection Works

A node is considered overdue if **all three** conditions are true:

1. Its context type has a `calendarDateField` (e.g. `"due"`)
2. The value of that field is a date in the past
3. The type has a `completionField` and the node's completion field value does **not** equal `completionValue`

So a task with `status: "done"` is never overdue, even if `due` is in the past. A task with `status: "open"` and `due: "2026-04-01"` is overdue.

Context types without `calendarDateField` (e.g. a `note` type) never produce overdue entries, regardless of any date fields they contain.

### How Today's Events Work

Nodes appear in the `today` array if their `calendarDateField` value is today's date (for `date` fields) or today's date (extracted from the datetime) for `datetime` fields.

Events with `starts_at` of type `datetime` appear in `today` if the date portion matches today. They are sorted chronologically.

### MCP Tool

```json
{ "tool": "get_moment" }
```

Returns the same shape. Use this at the start of every agent session.

### Injecting Into a System Prompt

A typical pattern for agent system prompts:

```typescript
const moment = await mcpClient.callTool('get_moment', {});

const systemPrompt = `
You are a personal assistant with access to the user's Foundation.

## Current Context

Today is ${moment.dayOfWeek}, ${moment.date} at ${moment.time}.

${moment.overdue.length > 0 ? `
### Overdue Items (${moment.overdue.length})
${moment.overdue.map(item =>
  `- **${item.title}** (${item.type}) — ${item.daysOverdue} days overdue — ${item.due}`
).join('\n')}
` : 'No overdue items.'}

${moment.today.length > 0 ? `
### Today's Schedule
${moment.today.map(item =>
  `- **${item.title}** — ${item.starts_at || item.date}`
).join('\n')}
` : 'Nothing scheduled for today.'}
`;
```

This pattern keeps agents grounded in real time, prevents them from treating stale data as current, and surfaces actionable items without requiring a search.

---

## Vault Analytics

Analytics give you a snapshot of Foundation size and health. Use them to understand growth over time, identify bloated types, and monitor trash accumulation.

### Requesting Analytics

```bash
GET /cx/analytics
```

Response:

```json
{
  "totalFiles": 187,
  "totalBytes": 284672,
  "totalFormatted": "278.0 KB",
  "nodeCount": 142,
  "typeCount": 4,
  "trashFiles": 12,
  "trashBytes": 18432,
  "trashFormatted": "18.0 KB",
  "byType": [
    { "type": "task", "nodes": 87, "directory": "context-types/task" },
    { "type": "note", "nodes": 31, "directory": "context-types/note" },
    { "type": "person", "nodes": 24, "directory": "context-types/person" },
    { "type": "event", "nodes": 0, "directory": "context-types/event" }
  ]
}
```

### Field Reference

| Field | Description |
|-------|-------------|
| `totalFiles` | Count of all files in the Foundation (excluding `.trash/`) |
| `totalBytes` | Total bytes on disk (excluding `.trash/`) |
| `totalFormatted` | Human-readable size string (B / KB / MB / GB) |
| `nodeCount` | Total context nodes across all types (excludes `.cxms.md`, `.cxms-examples.md`) |
| `typeCount` | Number of registered context types |
| `trashFiles` | Files in `.trash/` |
| `trashBytes` | Bytes in `.trash/` |
| `trashFormatted` | Human-readable trash size |
| `byType` | Per-type breakdown of node counts |

**What counts as a node**: Files in `context-types/{type}/` that are not named `.cxms.md` or `.cxms-examples.md`. Every other `.md` file is a context node.

**What is excluded from `totalFiles`**: The `.trash/` directory is walked separately. Files inside `.trash/` contribute to `trashFiles`/`trashBytes` only.

### Analytics via MCP

```json
{ "tool": "get_analytics" }
```

Returns the same shape. Useful for agents doing self-reporting or Foundation health checks.

### Interpreting Analytics

**High `trashFiles` relative to `nodeCount`**: You've deleted a lot of nodes without permanently removing them. Consider pruning `.trash/` periodically if you don't need the safety net.

**Low `nodeCount` but high `totalFiles`**: May indicate many `.cxms.md` context files, log files, or collection files relative to actual nodes.

**`byType` with 0 nodes**: A type was registered but no nodes have been created yet, or all its nodes were deleted and trashed.

**`totalBytes` over 10MB**: Consider whether the `body` content of nodes is getting long. BM25 search is still fast at this size (it's all in memory), but context tree loads at `branch-full` scope may produce very large LLM prompts.

---

## Performance Notes

**Search is always in-memory.** The BM25 index is built once at startup and updated incrementally. There are no disk reads during search — every query operates on in-memory data structures. Search latency on a Foundation with 10,000 nodes is typically under 10ms.

**Index build time scales linearly.** Building the index from a cold start requires reading every node file from disk. On a Foundation with 1,000 nodes (typical file size: 1–3KB), expect 200–500ms on a local SSD.

**Context tree builds are disk-bound for `branch-full`.** Loading full node content requires reading each file. For large collections, prefer `branch` scope (summaries only) and then `leaves` scope for specific nodes.

**The relationship graph has no query cost.** Edge lookup is `O(1)` via hash maps keyed by node key. Neighbor traversal is bounded by degree, not collection size.

**Embeddings are optional.** CxMS does not require embeddings for search. The BM25 + stemming approach works well for structured personal knowledge bases where documents are authored with deliberate terminology. If you want semantic vector search, CxMS can store embeddings in `.phaibel/embeddings.json` but this is an optional extension.

---

## See Also

- [REST API](./rest-api.md) — `/cx/search`, `/cx/context`, `/cx/moment`, `/cx/analytics`, `/cx/index` endpoint details
- [MCP Tools](./mcp-tools.md) — `search`, `get_context`, `get_moment`, `get_analytics`, `get_index_stats`
- [Context Types](./context-types.md) — `completionField`, `completionValue`, `calendarDateField`
- [Foundation](./foundation.md) — directory structure that the index walks
- [How It Works](./how-it-works.md) — Index Layer and Context Layer architecture details
