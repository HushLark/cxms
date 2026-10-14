# MCP Tools Reference

CxMS exposes 25 tools via the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) at the `/mcp` endpoint. Any MCP-compatible client — Claude Desktop, Cursor, or a custom agent — can connect and use these tools to manage Foundation data.

---

## Connecting

CxMS uses **Streamable HTTP transport** (stateless). Each tool call is an independent HTTP POST to `/mcp`.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cxms": {
      "url": "http://localhost:3800/mcp"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project or the global MCP config:

```json
{
  "mcpServers": {
    "cxms": {
      "url": "http://localhost:3800/mcp"
    }
  }
}
```

### Custom agent

Send JSON-RPC 2.0 requests to `/mcp`:

```bash
curl -X POST http://localhost:3800/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "health",
      "arguments": {}
    }
  }'
```

The server responds with JSON or SSE (Server-Sent Events). Stateless mode: each request is fully independent, no session initialization required for tool calls.

---

## Tool Categories

| Category | Tools |
|----------|-------|
| [System](#system) | `health`, `get_analytics` |
| [Context Types](#context-types) | `list_types`, `get_type`, `create_type`, `update_type`, `delete_type` |
| [Context Nodes](#context-nodes) | `list_nodes`, `get_node`, `create_node`, `update_node`, `delete_node` |
| [Search & Discovery](#search--discovery) | `search`, `search_by_date_range` |
| [Context & Summary](#context--summary) | `get_node_summary`, `count_nodes`, `get_moment`, `get_context_tree`, `get_vault_context` |
| [Collections](#collections) | `list_collections`, `get_collection`, `set_collection_item`, `remove_collection_item` |

---

## System

### `health`

Check whether the server is running and the Foundation is accessible.

**Parameters:** none

**Returns:**

```json
{
  "status": "ok",
  "foundation": "/path/to/my-foundation",
  "contextTypes": 4,
  "index": {
    "nodes": 48,
    "edges": 12
  }
}
```

`status` is `"ok"` when a Foundation is configured, `"no_foundation"` otherwise. `index` is `null` if the index has not been built yet.

**When to use:** At agent startup to verify the connection and get a quick overview of the vault state.

---

### `get_analytics`

Get detailed disk usage, file counts, and node counts per context type.

**Parameters:** none

**Returns:**

```json
{
  "foundation": "/path/to/my-foundation",
  "totalFiles": 47,
  "totalBytes": 152340,
  "totalBytesFormatted": "148.8 KB",
  "trashFiles": 3,
  "trashBytes": 12480,
  "contextTypes": {
    "count": 4,
    "types": [
      { "name": "task",   "nodes": 23, "bytes": 48200 },
      { "name": "event",  "nodes": 8,  "bytes": 19600 },
      { "name": "note",   "nodes": 12, "bytes": 31400 },
      { "name": "person", "nodes": 5,  "bytes": 9800  }
    ]
  }
}
```

**When to use:** To give the agent situational awareness about how large the vault is, what types have the most data, or how much has been soft-deleted. Useful at the start of a session or before deciding how to scope a search.

---

## Context Types

### `list_types`

List all defined context types with their field schemas.

**Parameters:** none

**Returns:** Array of type objects:

```json
[
  {
    "name": "task",
    "plural": "tasks",
    "description": "A task to complete",
    "fields": [
      { "key": "status", "type": "enum", "values": ["open", "done"], "required": true },
      { "key": "priority", "type": "enum", "values": ["low", "medium", "high"] }
    ],
    "completionField": "status",
    "completionValue": "done",
    "calendarDateField": "due"
  }
]
```

**When to use:** At agent startup to understand what types exist and what fields each has, before creating nodes or building queries.

---

### `get_type`

Get the full schema for one context type, including the content of its `.cxms.md` context file.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | Yes | Context type name (e.g. `"task"`) |

**Returns:**

```json
{
  "name": "task",
  "plural": "tasks",
  "description": "A task to complete",
  "fields": [...],
  "completionField": "status",
  "completionValue": "done",
  "context": "# Tasks\n\nA task to complete.\n\n## Fields\n\n- **status** (enum)..."
}
```

`context` is the content of the type's `.cxms.md` file — human-authored guidelines for this type.

**When to use:** Before creating nodes of a type you haven't used before. The context content gives you the conventions and field semantics the vault owner has defined.

---

### `create_type`

Create a new context type. Also creates the directory and `.cxms.md` context file.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Singular lowercase name (`"habit"`) |
| `plural` | string | Yes | Plural form (`"habits"`) |
| `directory` | string | Yes | Storage path (`"context-types/habit"`) |
| `description` | string | No | What this type represents |
| `fields` | array | No | Field definitions (see below) |
| `completionField` | string | No | Field that marks completion |
| `completionValue` | string | No | Value that means "done" |
| `calendarDateField` | string | No | Date/datetime field for calendar queries |

**Field definition shape:**

```json
{
  "key": "status",
  "type": "enum",
  "label": "Status",
  "required": true,
  "values": ["open", "in_progress", "done"],
  "default": "open"
}
```

`type` must be one of: `string`, `number`, `boolean`, `date`, `datetime`, `duration`, `enum`, `array`, `object`.

**Returns:**

```json
{ "created": true, "name": "habit" }
```

**When to use:** When the user describes a new category of information they want to track that doesn't fit existing types. Always use `list_types` first to check if a suitable type already exists.

**Example:**

```json
{
  "name": "decision",
  "plural": "decisions",
  "directory": "context-types/decision",
  "description": "A significant decision with rationale and outcome",
  "fields": [
    { "key": "status", "type": "enum", "values": ["proposed", "decided", "reversed"], "required": true, "default": "proposed" },
    { "key": "decided_on", "type": "date" },
    { "key": "decided_by", "type": "string" },
    { "key": "alternatives_considered", "type": "number" }
  ],
  "completionField": "status",
  "completionValue": "decided"
}
```

---

### `update_type`

Update an existing context type's schema. The `name` field is immutable.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Type name to update |
| `config` | object | Yes | Fields to update (merged with existing) |

`config` can include any type property except `name`: `plural`, `directory`, `description`, `fields`, `completionField`, `completionValue`, `calendarDateField`.

**Returns:**

```json
{ "updated": true, "name": "habit" }
```

**Note:** Updating the field schema does not retroactively validate or migrate existing nodes. Existing node files retain whatever fields they were created with.

---

### `delete_type`

Remove a context type from the registry. Node files on disk are **not** deleted.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Type name to delete |

**Returns:**

```json
{ "deleted": true, "name": "habit" }
```

---

## Context Nodes

### `list_nodes`

List context nodes of a given type. Returns titles, IDs, and key metadata.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | Yes | Context type name |
| `status` | string | No | Filter by `status` field value |
| `limit` | number | No | Max results (default: all) |
| `offset` | number | No | Skip N results (for pagination) |

**Returns:** Array of node objects with all metadata fields.

```json
[
  {
    "id": "abc12345",
    "title": "Review Q3 report",
    "summary": "Review the Q3 financial report before Friday standup.",
    "status": "open",
    "priority": "high",
    "created": "2026-04-17T10:00:00.000Z"
  }
]
```

**When to use:** To get an overview of what nodes exist before making decisions. For large vaults, use the `status` filter and pagination to narrow the result set, or use `search` instead.

---

### `get_node`

Get a single context node by type and ID or title. Returns full metadata, content, and file path.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | Yes | Context type name |
| `id` | string | Yes | Node ID (8 chars) **or** exact/partial title match |

Lookup behavior:
1. Exact ID match
2. Exact title match (case-insensitive)
3. Partial title match (title contains the query string)

**Returns:**

```json
{
  "meta": {
    "id": "abc12345",
    "title": "Review Q3 report",
    "entityType": "task",
    "created": "2026-04-17T10:00:00.000Z",
    "status": "open",
    "priority": "high"
  },
  "content": "The report is in SharePoint under Finance > 2026 > Q3...",
  "filepath": "/path/to/foundation/context-types/task/review-q3-report_abc12345.md"
}
```

**When to use:** When you need to read the full content of a specific node, or when you want to update a node and need its current state first.

---

### `create_node`

Create a new context node in the Foundation. Validates fields against the type schema.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | Yes | Context type name |
| `title` | string | Yes | Node title |
| `content` | string | No | Markdown body |
| `fields` | object | No | Custom field values (`{ "status": "open", "priority": "high" }`) |

**Returns:**

```json
{
  "created": true,
  "id": "abc12345",
  "title": "Review Q3 report",
  "type": "task",
  "filepath": "/path/to/foundation/context-types/task/review-q3-report_abc12345.md"
}
```

**When to use:** Any time the user describes something new they want to remember or track. Match the information to the most appropriate context type.

**Example:**

```json
{
  "type": "task",
  "title": "Prepare Q3 investor presentation",
  "content": "Slides due to CEO by EOD Thursday. Use Q3 report as source material.",
  "fields": {
    "status": "open",
    "priority": "critical",
    "due": "2026-04-21"
  }
}
```

---

### `update_node`

Update an existing context node. Merges provided fields with existing metadata.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | Yes | Context type name |
| `id` | string | Yes | Node ID or title |
| `title` | string | No | New title |
| `content` | string | No | Replaces Markdown body |
| `fields` | object | No | Custom fields to set/update |

**Returns:**

```json
{ "updated": true, "id": "abc12345", "title": "Review Q3 report", "type": "task" }
```

**When to use:** When the user reports progress, changes, or new information about something already in the vault. Use `get_node` first to confirm you have the right node before updating.

**Examples:**

Mark a task done:
```json
{
  "type": "task",
  "id": "abc12345",
  "fields": { "status": "done" }
}
```

Update content:
```json
{
  "type": "note",
  "id": "ghi11111",
  "content": "Updated notes from the follow-up meeting...",
  "fields": { "category": "meeting-notes" }
}
```

---

### `delete_node`

Soft-delete a context node by moving it to `.trash/`. The node is immediately removed from the search index.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | Yes | Context type name |
| `id` | string | Yes | Node ID or title |

**Returns:**

```json
{
  "deleted": true,
  "id": "abc12345",
  "title": "Review Q3 report",
  "trashPath": "/path/to/foundation/.trash/task/review-q3-report_abc12345.md"
}
```

**When to use:** When the user explicitly says to remove or delete something. Do not delete nodes just because a task is complete — update the status instead. Deletion is for things the user no longer wants tracked at all.

---

## Search & Discovery

### `search`

Full-text BM25 search across all context nodes (or a specific type). Results are ranked by relevance score.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (keywords or phrases). |
| `type` | string | No | Restrict to this context type |
| `limit` | number | No | Max results (default: 20) |

**Returns:** Array of results sorted by `score` descending:

```json
[
  {
    "type": "task",
    "id": "abc12345",
    "title": "Review Q3 report",
    "score": 4.72,
    "summary": "Review the Q3 financial report before Friday standup."
  }
]
```

**Search features:**
- Stemming: `"meetings"` matches `"meeting"`, `"scheduled"` matches `"schedule"`
- Field weighting: title matches score higher than body matches
- Cross-type: omitting `type` searches all types simultaneously

**When to use:** As the primary retrieval mechanism when the agent needs to find relevant existing nodes before responding to a user query. Use `count_nodes` with a query first if you want a sense of how many matches exist before loading full results.

**Examples:**

```json
{ "query": "quarterly finance review" }
```

```json
{ "query": "Alice meeting", "type": "event", "limit": 5 }
```

```json
{ "query": "urgent deadline", "type": "task" }
```

---

### `search_by_date_range`

Find context nodes whose calendar date field falls within a date range. Only types with a `calendarDateField` are searched.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `start` | string | Yes | Start date `YYYY-MM-DD` (inclusive) |
| `end` | string | Yes | End date `YYYY-MM-DD` (inclusive) |
| `type` | string | No | Restrict to this context type |

**Returns:** Array of nodes sorted by date ascending:

```json
[
  { "type": "event", "id": "abc12345", "title": "Team standup",     "date": "2026-04-18T09:30:00-07:00" },
  { "type": "task",  "id": "def67890", "title": "Submit Q2 report", "date": "2026-04-20" }
]
```

**When to use:** For calendar or timeline views — "what do I have this week", "show me everything due in April".

---

## Context & Summary

### `get_node_summary`

Get a concise summary of a context node: title, key fields, and up to 200 characters of content.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | Yes | Context type name |
| `id` | string | Yes | Node ID or title |

**Returns:**

```json
{
  "id": "abc12345",
  "title": "Review Q3 report",
  "type": "task",
  "summary": "Review the Q3 financial report before Friday standup.",
  "created": "2026-04-17T10:00:00.000Z",
  "status": "open",
  "priority": "high"
}
```

If no `summary` is set in the frontmatter, the first 200 characters of the Markdown body are used as the summary.

**When to use:** When you need a lightweight preview of a node without loading its full content. Useful for displaying search result details or confirming you have the right node before updating.

---

### `count_nodes`

Count context nodes per type. With an optional query, shows how many nodes match the search terms in each type.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | string | No | Count only this type (omit for all types) |
| `query` | string | No | Show match counts for this search query |

**Without query** — returns simple counts:

```json
[
  { "type": "task",   "count": 23 },
  { "type": "event",  "count": 8  },
  { "type": "note",   "count": 12 },
  { "type": "person", "count": 5  }
]
```

**With query** — returns totals and match counts with sample titles:

```json
[
  { "type": "person", "total": 5,  "matches": 1, "samples": ["Bob Smith"] },
  { "type": "event",  "total": 8,  "matches": 2, "samples": ["1:1 with Bob", "Bob's birthday"] },
  { "type": "task",   "total": 23, "matches": 0, "samples": [] },
  { "type": "note",   "total": 12, "matches": 1, "samples": ["Notes from Bob's call"] }
]
```

**When to use:** Before doing a full search, call `count_nodes` with the query to understand the shape of the results. This tells you which types have relevant content without loading all the data. Also useful for displaying vault statistics to the user.

---

### `get_moment`

Get real-time situational context: current date and time, overdue tasks, today's scheduled events.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `user_name` | string | No | User's name, used in the greeting |

**Returns:**

```json
{
  "current_date": "2026-04-18",
  "current_time": "14:23",
  "day_of_week": "Saturday",
  "user_name": "Gary",
  "greeting": "Good afternoon, Gary",
  "overdue_tasks": [
    { "id": "abc12345", "title": "Submit expense report", "due": "2026-04-15", "days_overdue": 3 }
  ],
  "todays_events": [
    { "id": "def67890", "title": "Team standup", "starts_at": "2026-04-18T09:30:00-07:00" }
  ],
  "upcoming_tasks": [...],
  "formatted": "📅 Saturday, April 18 2026  14:23\n\n⚠️ 1 overdue task:\n- Submit expense report (3 days overdue)\n\n📌 Today:\n- Team standup at 9:30am"
}
```

`overdue_tasks` — nodes where the `calendarDateField` is before today AND the completion field is not equal to the completion value.

`todays_events` — nodes where the `calendarDateField` equals today's date.

`formatted` — a pre-rendered string suitable for injecting directly into a system prompt.

**When to use:** At the start of every agent session. Include the `formatted` string in the system prompt to give the agent accurate temporal context without hallucinating the date.

---

### `get_context_tree`

Build a token-budgeted hierarchical context tree for LLM consumption. The scope controls what's included.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `scope_type` | string | No | `"trunk"` (default), `"branch"`, `"branch-full"`, `"leaves"`, or `"cross"` |
| `branches` | string[] | No | Context type names to include as branches (for `branch`, `branch-full`, `leaves`, `cross`) |
| `query` | string | No | Search query for `cross` scope |

**Scope types:**

| Scope | Description | Token cost |
|-------|-------------|------------|
| `trunk` | Root `.cxms.md` + vault stats (type list, total node count) | Minimal |
| `branch` | Trunk + type schemas + recent node summaries (title, metadata) | Medium |
| `branch-full` | Branch but with full Markdown content of each node | Large |
| `leaves` | Specific nodes by key, full content | Varies |
| `cross` | Trunk + named branches + BM25 search results across types | Medium-Large |

**Returns:**

```json
{
  "tree": {
    "trunk": {
      "vaultContext": "# My Foundation\n\nThis Foundation stores...",
      "globals": { "current_date": "2026-04-18", "current_time": "14:23", "day_of_week": "Saturday" },
      "stats": { "totalEntities": 48, "entityTypes": ["task", "event", "note", "person"] }
    },
    "branches": [
      {
        "entityType": "task",
        "plural": "tasks",
        "description": "A task to complete",
        "fields": [...],
        "subdirectoryContext": "# Tasks\n\n## Fields\n...",
        "leafCount": 23,
        "leaves": [
          { "key": "task:abc12345", "title": "Review Q3 report", "summary": "...", "meta": {...} }
        ]
      }
    ],
    "edges": [
      { "source": "task:abc12345", "target": "person:def67890", "edgeType": "mention", "label": null }
    ]
  },
  "serialized": "# My Foundation\n\n> current_date: 2026-04-18...\n\n## Tasks (23)\n\n..."
}
```

`serialized` is the tree rendered as a flat Markdown string, suitable for injecting directly into a prompt.

**When to use:**
- `trunk` — fast vault overview at session start
- `branch ["task"]` — agent needs to know about all tasks
- `cross ["task", "event"] query:"quarterly review"` — agent needs relevant context for a specific topic
- `branch-full ["note"]` — agent needs to read complete notes

---

### `get_vault_context`

Read the root `.cxms.md` file from the Foundation.

**Parameters:** none

**Returns:**

```json
{
  "context": "# My Foundation\n\nThis Foundation stores long-term memory for my personal AI assistant.\n\n## What's here\n\n..."
}
```

**When to use:** When you need just the root context without the full tree. Faster than `get_context_tree` when you only need the vault-level description.

---

## Collections

### `list_collections`

List all key-value collections in the Foundation.

**Parameters:** none

**Returns:**

```json
["shortcuts", "preferences", "contacts"]
```

---

### `get_collection`

Get a collection by name, or a single item by key.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Collection name |
| `key` | string | No | Specific item key (omit for full collection) |

**Full collection:**

```json
{
  "name": "shortcuts",
  "description": "Frequently used values",
  "items": {
    "standup": "Daily standup at 9:30am in Zoom room 123",
    "manager": "Alice Chen"
  }
}
```

**Single item:**

```json
{ "key": "standup", "value": "Daily standup at 9:30am in Zoom room 123" }
```

---

### `set_collection_item`

Set or update a key-value item in a collection. Creates the collection if it doesn't exist.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Collection name |
| `key` | string | Yes | Item key |
| `value` | string | Yes | Item value |
| `description` | string | No | Collection description (used when creating) |

**Returns:**

```json
{ "set": true, "collection": "shortcuts", "key": "standup" }
```

**When to use:** For lightweight key-value storage that doesn't need full node semantics — configuration, preferences, frequently referenced constants.

---

### `remove_collection_item`

Remove a key-value item from a collection.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Collection name |
| `key` | string | Yes | Item key to remove |

**Returns:**

```json
{ "removed": true, "collection": "shortcuts", "key": "standup" }
```

---

## Agent Workflow Patterns

### Session start

```
1. health                          — verify connection, get type count
2. get_moment { user_name: "..." } — get current date/time, overdue tasks, schedule
3. get_context_tree { scope_type: "trunk" } — load vault overview
```

### Finding and reading a node

```
1. search { query: "quarterly review finance" }  — find candidates
2. get_node_summary { type: "task", id: "..." }  — preview the top result
3. get_node { type: "task", id: "..." }          — read full content if needed
```

### Creating a node from conversation

```
1. list_types                          — confirm the right type exists
2. get_type { type: "task" }           — read field schema and guidelines
3. create_node {                       — create the node
     type: "task",
     title: "...",
     fields: { status: "open", priority: "high" },
     content: "..."
   }
```

### Updating based on user report

```
1. search { query: "expense report" }   — find the node
2. get_node { type: "task", id: "..." } — confirm it's the right one
3. update_node {                         — update the field
     type: "task",
     id: "...",
     fields: { status: "done" }
   }
```

### Context-aware query

```
1. count_nodes { query: "Alice project" } — see which types have matches
2. get_context_tree {                     — load relevant branches
     scope_type: "cross",
     branches: ["task", "person"],
     query: "Alice project"
   }
```

---

## See Also

- [REST API](./rest-api.md) — same capabilities via REST
- [Search & Context](./search-and-context.md) — how BM25 and the context tree work
- [Context Types](./context-types.md) — type and field schemas
- [Foundation](./foundation.md) — vault structure and context files
