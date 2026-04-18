# REST API Reference

The CxMS REST API is served at `/cx/*`. All endpoints return JSON. Errors use [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) with `Content-Type: application/problem+json`.

---

## Base URL and Authentication

### Base URL

```
http://localhost:3800
```

Replace `localhost:3800` with your host and port. Default port is `3800`.

### Authentication

All endpoints except `GET /cx/health` require a bearer token in the `Authorization` header.

```bash
Authorization: Bearer cxms_a3b8f1...
```

Get the token:

```bash
TOKEN=$(cxms token)
```

Or retrieve it from `~/.cxms/token`.

Disable authentication for local development:

```bash
cxms --no-auth
```

Or in the embedded API:

```typescript
import { setAuthEnabled } from '@gclift/cxms';
setAuthEnabled(false);
```

Requests to authenticated endpoints without a valid token receive:

```json
{
  "type": "https://cxms.dev/errors/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Missing or invalid bearer token"
}
```

---

## Error Format

All errors follow RFC 9457 Problem Details:

```json
{
  "type": "https://cxms.dev/errors/not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "Context type \"habit\" not found",
  "instance": "/cx/context-types/habit"
}
```

| HTTP Status | When |
|-------------|------|
| `400 Bad Request` | Missing required fields, invalid JSON, invalid parameters |
| `401 Unauthorized` | Missing or invalid bearer token |
| `404 Not Found` | Resource (type or node) does not exist |
| `405 Method Not Allowed` | HTTP method not supported for this path |
| `409 Conflict` | Creating a type that already exists |
| `422 Unprocessable Entity` | Field validation failed |
| `500 Internal Server Error` | Unexpected server error (details in error log) |

---

## Health

### `GET /cx/health`

Liveness probe. Does **not** require authentication.

**Response `200 OK`:**

```json
{
  "status": "ok",
  "foundation": "/path/to/my-foundation",
  "contextTypes": 4
}
```

If no Foundation root is configured:

```json
{
  "status": "no-foundation",
  "foundation": null,
  "contextTypes": 0
}
```

**Example:**

```bash
curl http://localhost:3800/cx/health
```

---

## Analytics

### `GET /cx/analytics`

Returns disk usage, file counts, and node counts per context type. Requires authentication.

**Response `200 OK`:**

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

**Fields:**

| Field | Description |
|-------|-------------|
| `foundation` | Absolute path to the Foundation root |
| `totalFiles` | Total files in the Foundation (excluding `.trash/`) |
| `totalBytes` | Total bytes in the Foundation (excluding `.trash/`) |
| `totalBytesFormatted` | Human-readable size (`B`, `KB`, `MB`, `GB`) |
| `trashFiles` | Number of files in `.trash/` |
| `trashBytes` | Bytes in `.trash/` |
| `contextTypes.count` | Number of defined context types |
| `contextTypes.types[].name` | Context type name |
| `contextTypes.types[].nodes` | Count of node files (excludes `.cxms.md` and `.cxms-examples.md`) |
| `contextTypes.types[].bytes` | Bytes of node files in this type's directory |

**Example:**

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3800/cx/analytics
```

---

## Context Types

### `GET /cx/context-types`

List all defined context types with their field schemas.

**Response `200 OK`:**

```json
{
  "count": 2,
  "types": [
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
      "completionValue": "done",
      "calendarDateField": null
    }
  ]
}
```

**Example:**

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3800/cx/context-types
```

---

### `GET /cx/context-types/count`

Count the number of defined context types.

**Response `200 OK`:**

```json
{ "count": 4 }
```

---

### `GET /cx/context-types/:type/details`

Get the full schema for a single context type, plus the content of its `.cxms-examples.md` file if one exists.

**Parameters:**

| Name | In | Description |
|------|----|-------------|
| `type` | path | Context type name (e.g. `task`) |

**Response `200 OK`:**

```json
{
  "name": "task",
  "plural": "tasks",
  "directory": "context-types/task",
  "description": "A task to complete",
  "fields": [...],
  "completionField": "status",
  "completionValue": "done",
  "calendarDateField": "due",
  "examples": "## Examples\n\n### Open task\n\n```markdown\n---\nid: abc12345\n..."
}
```

`examples` is the raw content of `.cxms-examples.md`, or `null` if the file does not exist.

**Response `404 Not Found`:** Type does not exist.

---

### `POST /cx/context-types`

Create a new context type. Creates the directory and `.cxms.md` context file.

**Request body:**

```json
{
  "name": "habit",
  "plural": "habits",
  "directory": "context-types/habit",
  "description": "A daily habit to track",
  "fields": [
    { "key": "frequency", "type": "enum", "values": ["daily", "weekly"], "required": true },
    { "key": "streak", "type": "number", "default": 0 }
  ],
  "completionField": "status",
  "completionValue": "done",
  "calendarDateField": null,
  "defaultTags": []
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Singular lowercase name (e.g. `habit`) |
| `plural` | Yes | Plural form (e.g. `habits`) |
| `directory` | No | Defaults to `context-types/{name}` if omitted in code; should be provided |
| `description` | No | Human-readable description |
| `fields` | No | Array of field definitions (see [Context Types](./context-types.md)) |
| `completionField` | No | Field that marks completion |
| `completionValue` | No | Value that means "done" |
| `calendarDateField` | No | Date/datetime field for calendar queries |
| `defaultTags` | No | Tags applied to all new nodes |

**Response `201 Created`:** Returns the created type config.

**Response `409 Conflict`:** Type with that name already exists.

**Response `400 Bad Request`:** Missing `name` or `plural`, or invalid `calendarDateField`.

---

### `PUT /cx/context-types/:type`

Update an existing context type. The `name` field is immutable; all other fields are replaced with the provided values.

**Request body:** Same shape as `POST`, but all fields except `name` can be updated.

**Response `200 OK`:** Returns the updated type config.

**Response `404 Not Found`:** Type does not exist.

---

### `DELETE /cx/context-types/:type`

Remove a context type from the registry. The node files on disk are **not** deleted.

**Response `200 OK`:**

```json
{ "deleted": "habit" }
```

**Response `404 Not Found`:** Type does not exist.

---

## Context Nodes

### `GET /cx/context-types/:type`

List nodes of a given type. Supports filtering and pagination.

**Parameters:**

| Name | In | Type | Description |
|------|----|------|-------------|
| `type` | path | string | Context type name |
| `status` | query | string | Filter by `status` field value |
| `tag` | query | string | Filter to nodes with this tag |
| `limit` | query | integer | Max nodes to return |
| `offset` | query | integer | Skip this many nodes (for pagination) |

**Response `200 OK`:**

```json
{
  "type": "task",
  "total": 23,
  "count": 10,
  "offset": 0,
  "nodes": [
    {
      "id": "abc12345",
      "title": "Review Q3 report",
      "type": "task",
      "tags": ["work", "urgent"],
      "summary": "Review the Q3 financial report before Friday standup.",
      "created": "2026-04-17T10:00:00.000Z",
      "updated": "2026-04-18T09:00:00.000Z",
      "status": "open",
      "priority": "high"
    }
  ]
}
```

`total` is the total count before pagination. `count` is the number of nodes in this response. Custom type fields are included inline with system fields.

**Examples:**

```bash
# All open tasks
curl "http://localhost:3800/cx/context-types/task?status=open" \
  -H "Authorization: Bearer $TOKEN"

# Tasks tagged 'urgent', paginated
curl "http://localhost:3800/cx/context-types/task?tag=urgent&limit=5&offset=0" \
  -H "Authorization: Bearer $TOKEN"

# All notes (no filter)
curl "http://localhost:3800/cx/context-types/note" \
  -H "Authorization: Bearer $TOKEN"
```

---

### `GET /cx/context-types/:type/count`

Count nodes of a given type. Optionally filter by status or tag (via query params — same as listing).

**Response `200 OK`:**

```json
{ "type": "task", "count": 23 }
```

**Response `404 Not Found`:** Type does not exist.

---

### `GET /cx/context-types/:type/:id`

Get a single node by ID. Returns full metadata, Markdown content, and ancestor context chain (root `.cxms.md` → type `.cxms.md` text).

**Parameters:**

| Name | In | Description |
|------|----|-------------|
| `type` | path | Context type name |
| `id` | path | 8-char node ID |

**Response `200 OK`:**

```json
{
  "id": "abc12345",
  "title": "Review Q3 report",
  "type": "task",
  "tags": ["work", "urgent"],
  "summary": "Review the Q3 financial report before Friday standup.",
  "created": "2026-04-17T10:00:00.000Z",
  "updated": "2026-04-18T09:00:00.000Z",
  "status": "open",
  "priority": "high",
  "content": "The report is in SharePoint under Finance > 2026 > Q3...",
  "references": ["blocks:task:def67890"],
  "ancestorContext": [
    "# My Foundation\n\nThis Foundation stores...",
    "# Tasks\n\nA task to complete...\n\n## Fields..."
  ]
}
```

`ancestorContext` is an array of strings — the content of `.cxms.md` files from the Foundation root down to the type directory, in root-first order.

**Response `404 Not Found`:** Type or node does not exist.

---

### `POST /cx/context-types/:type`

Create a new context node.

**Request body:**

```json
{
  "title": "Review Q3 report",
  "tags": ["work", "urgent"],
  "summary": "Review the Q3 financial report before Friday standup.",
  "content": "The report is in SharePoint under Finance > 2026 > Q3...",
  "status": "open",
  "priority": "high"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Node title (used to generate the filename) |
| `tags` | No | Array of tag strings |
| `summary` | No | One-sentence summary |
| `content` | No | Markdown body |
| `references` | No | Array of reference strings |
| `[custom fields]` | Depends on type schema | Any fields defined in the type |

The server assigns `id` and `created` automatically. Custom fields are validated against the type's schema.

**Response `201 Created`:**

```json
{
  "id": "abc12345",
  "title": "Review Q3 report",
  "type": "task",
  "filepath": "review-q3-report_abc12345.md"
}
```

**Response `404 Not Found`:** Type does not exist.

**Response `422 Unprocessable Entity`:** Field validation failed.

**Example:**

```bash
curl -X POST http://localhost:3800/cx/context-types/task \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Review Q3 report",
    "tags": ["work", "urgent"],
    "status": "open",
    "priority": "high",
    "content": "Review before Friday standup."
  }'
```

---

### `PUT /cx/context-types/:type/:id`

Update an existing node. Only the fields provided in the request body are changed. Other fields are preserved.

**Request body:** Any combination of system and custom fields.

```json
{
  "status": "done",
  "tags": ["work", "completed"],
  "content": "Reviewed and approved. No issues found."
}
```

**Updatable system fields:**

| Field | Description |
|-------|-------------|
| `title` | New title (filename is NOT renamed) |
| `tags` | Replaces the tag array entirely |
| `summary` | Replaces the summary |
| `references` | Replaces the references array |
| `content` | Replaces the Markdown body |
| `[custom fields]` | Any field defined in the type schema |

**Response `200 OK`:**

```json
{ "id": "abc12345", "title": "Review Q3 report", "type": "task", "updated": true }
```

**Response `404 Not Found`:** Type or node does not exist.

**Response `422 Unprocessable Entity`:** Updated field fails validation.

**Example:**

```bash
# Mark a task as done
curl -X PUT http://localhost:3800/cx/context-types/task/abc12345 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "status": "done" }'
```

---

### `DELETE /cx/context-types/:type/:id`

Soft-delete a node by moving it to `.trash/{type}/`. The node is removed from the search index immediately.

**Response `200 OK`:**

```json
{
  "deleted": "abc12345",
  "trashedTo": "review-q3-report_abc12345.md"
}
```

`trashedTo` is the filename within `.trash/{type}/`.

**Response `404 Not Found`:** Type or node does not exist.

**Example:**

```bash
curl -X DELETE http://localhost:3800/cx/context-types/task/abc12345 \
  -H "Authorization: Bearer $TOKEN"
```

---

## Search

### `POST /cx/search`

Full-text BM25 search across all nodes (or a specific type). Results are ranked by relevance score.

**Request body:**

```json
{
  "query": "quarterly review finance",
  "type": "task",
  "tags": ["work"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `query` | Yes | Full-text search query (supports `tag:` prefix) |
| `type` | No | Restrict results to this context type |
| `tags` | No | Additional tag filter (AND logic) |

**Response `200 OK`:**

```json
{
  "query": "quarterly review finance",
  "count": 3,
  "results": [
    {
      "id": "abc12345",
      "title": "Review Q3 report",
      "type": "task",
      "score": 4.72,
      "tags": ["work", "urgent"],
      "summary": "Review the Q3 financial report before Friday standup."
    },
    {
      "id": "def67890",
      "title": "Q3 Finance Review Notes",
      "type": "note",
      "score": 3.14,
      "tags": ["finance"],
      "summary": null
    }
  ]
}
```

`score` is the BM25 relevance score — higher is more relevant. Results are sorted descending by score.

**Examples:**

```bash
# Search everything
curl -X POST http://localhost:3800/cx/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "quarterly review"}'

# Search only tasks, with tag filter
curl -X POST http://localhost:3800/cx/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "review", "type": "task", "tags": ["urgent"]}'

# Tag-prefix query
curl -X POST http://localhost:3800/cx/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "tag:urgent quarterly"}'
```

---

### `GET /cx/tag/:tag`

Find all nodes with a specific tag, across all context types.

**Parameters:**

| Name | In | Description |
|------|----|-------------|
| `tag` | path | Tag to search for (URL-encoded) |

**Response `200 OK`:**

```json
{
  "tag": "urgent",
  "count": 5,
  "nodes": [
    { "id": "abc12345", "title": "Review Q3 report", "type": "task", "tags": ["work", "urgent"] },
    { "id": "def67890", "title": "Deploy hotfix", "type": "task", "tags": ["engineering", "urgent"] }
  ]
}
```

**Example:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3800/cx/tag/urgent
```

---

### `GET /cx/date`

Return all nodes whose `calendarDateField` value is today's date.

Only types with a `calendarDateField` defined participate.

**Response `200 OK`:**

```json
{
  "date": "2026-04-18",
  "count": 2,
  "nodes": [
    {
      "id": "abc12345",
      "title": "Team standup",
      "type": "event",
      "date": "2026-04-18",
      "starts_at": "2026-04-18T09:30:00-07:00"
    },
    {
      "id": "def67890",
      "title": "Submit expense report",
      "type": "task",
      "date": "2026-04-18",
      "due": "2026-04-18"
    }
  ]
}
```

**Example:**

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3800/cx/date
```

---

### `GET /cx/date-range/:start/:end`

Return all nodes whose `calendarDateField` value falls within a date range (inclusive).

**Parameters:**

| Name | In | Format | Description |
|------|----|--------|-------------|
| `start` | path | `YYYY-MM-DD` | Range start (inclusive) |
| `end` | path | `YYYY-MM-DD` | Range end (inclusive) |

**Response `200 OK`:**

```json
{
  "start": "2026-04-18",
  "end": "2026-04-25",
  "count": 7,
  "nodes": [...]
}
```

**Response `400 Bad Request`:** Start is after end.

**Example:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3800/cx/date-range/2026-04-18/2026-04-25
```

---

## Collections

### `GET /cx/collections`

List the names of all key-value collections.

**Response `200 OK`:**

```json
{ "count": 2, "collections": ["shortcuts", "preferences"] }
```

---

### `GET /cx/collection/:name`

Get the full contents of a collection.

**Response `200 OK`:**

```json
{
  "name": "shortcuts",
  "description": "Frequently used values",
  "items": {
    "standup": "Daily standup at 9:30am",
    "manager": "Alice Chen"
  }
}
```

**Response `404 Not Found`:** Collection does not exist.

---

### `GET /cx/collection/:name/:key`

Get a single item from a collection.

**Response `200 OK`:**

```json
{ "key": "standup", "value": "Daily standup at 9:30am" }
```

**Response `404 Not Found`:** Collection or key does not exist.

---

### `GET /cx/collection/:name/count`

Count items in a collection.

**Response `200 OK`:**

```json
{ "collection": "shortcuts", "count": 4 }
```

---

## Pagination

List endpoints (`GET /cx/context-types/:type`) support `limit` and `offset` query parameters for pagination.

```bash
# First page (10 results)
GET /cx/context-types/task?limit=10&offset=0

# Second page
GET /cx/context-types/task?limit=10&offset=10
```

The response always includes `total` (total matching records before pagination) and `count` (records in this page). When `limit` is 0 or omitted, all results are returned.

---

## Combining Filters

For node listing, `status` and `tag` filters can be combined:

```bash
# Open tasks tagged 'urgent'
GET /cx/context-types/task?status=open&tag=urgent
```

For search, use the `type` and `tags` fields in the request body, or use `tag:` prefix syntax in the query string:

```json
{ "query": "quarterly tag:urgent", "type": "task" }
```

---

## Client Examples

### Python

```python
import httpx

BASE = "http://localhost:3800"
TOKEN = "cxms_a3b8f1..."
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# Create a task
r = httpx.post(f"{BASE}/cx/context-types/task", headers=HEADERS, json={
    "title": "Review Q3 report",
    "status": "open",
    "priority": "high",
    "tags": ["work"],
})
node_id = r.json()["id"]

# Search
r = httpx.post(f"{BASE}/cx/search", headers=HEADERS, json={"query": "quarterly review"})
for result in r.json()["results"]:
    print(result["title"], result["score"])

# Update
httpx.put(f"{BASE}/cx/context-types/task/{node_id}", headers=HEADERS, json={"status": "done"})
```

### TypeScript / Node.js

```typescript
const BASE = 'http://localhost:3800';
const TOKEN = process.env.CXMS_TOKEN!;
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const create = await fetch(`${BASE}/cx/context-types/task`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ title: 'Review Q3 report', status: 'open', priority: 'high' }),
});
const { id } = await create.json();

const search = await fetch(`${BASE}/cx/search`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ query: 'quarterly review' }),
});
const { results } = await search.json();
```

### curl with environment variable

```bash
export TOKEN=$(cxms token)
export BASE=http://localhost:3800
export H="-H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json'"

# Create
curl -X POST $BASE/cx/context-types/task $H \
  -d '{"title":"My task","status":"open"}'

# List open tasks
curl "$BASE/cx/context-types/task?status=open" -H "Authorization: Bearer $TOKEN"

# Search
curl -X POST $BASE/cx/search $H -d '{"query":"review"}'
```

---

## See Also

- [MCP Tools](./mcp-tools.md) — same capabilities via MCP protocol
- [Context Types](./context-types.md) — field type reference and schema design
- [Search & Context](./search-and-context.md) — how BM25 ranking works
- [How It Works](./how-it-works.md) — architecture and request data flow
