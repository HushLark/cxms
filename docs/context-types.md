# Context Types

A context type is a named schema that defines the structure of a category of information in your Foundation. Before you can store any nodes, you must define at least one type. CxMS ships with no built-in types — the schema is entirely yours to design.

---

## What a Type Defines

A context type specifies:

- **Name and plural** — how the type is referred to (`task` / `tasks`)
- **Directory** — where node files live inside the Foundation (`context-types/task`)
- **Description** — a human-readable summary of what this type stores
- **Fields** — typed field definitions that nodes of this type must validate against
- **Default tags** — tags automatically applied to new nodes
- **Completion semantics** — which field and value mark a node as "done" (used by the context tree and moment context)
- **Calendar date field** — which field holds the date for calendar/timeline placement (used by date queries)
- **Spawner config** — advanced: rules for generating child nodes from a parent

---

## Creating a Type

### Via the REST API

```bash
curl -X POST http://localhost:3800/cx/context-types \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "task",
    "plural": "tasks",
    "directory": "context-types/task",
    "description": "A task or action item to complete",
    "fields": [
      { "key": "status", "type": "enum", "values": ["open", "in_progress", "done"], "required": true, "default": "open" },
      { "key": "priority", "type": "enum", "values": ["low", "medium", "high", "critical"], "default": "medium" },
      { "key": "due", "type": "date", "label": "Due date" },
      { "key": "assignee", "type": "string", "label": "Assigned to" }
    ],
    "completionField": "status",
    "completionValue": "done",
    "calendarDateField": "due",
    "defaultTags": []
  }'
```

Response (`201 Created`):

```json
{
  "name": "task",
  "plural": "tasks",
  "directory": "context-types/task",
  "description": "A task or action item to complete",
  "fields": [...],
  "completionField": "status",
  "completionValue": "done",
  "calendarDateField": "due"
}
```

CxMS creates the `context-types/task/` directory and writes a `.cxms.md` context file describing the schema.

### Via MCP

Using the `create_type` tool:

```json
{
  "name": "habit",
  "plural": "habits",
  "directory": "context-types/habit",
  "description": "Daily habits to track",
  "fields": [
    { "key": "frequency", "type": "enum", "values": ["daily", "weekly", "monthly"] },
    { "key": "streak", "type": "number" },
    { "key": "last_completed", "type": "date" }
  ],
  "completionField": "status",
  "completionValue": "done"
}
```

### Programmatically

```typescript
import { addEntityType } from '@gclift/cxms';

await addEntityType({
  name: 'person',
  plural: 'people',
  directory: 'context-types/person',
  description: 'A contact or person of interest',
  fields: [
    { key: 'relationship', type: 'enum', values: ['colleague', 'friend', 'family', 'vendor'], required: true },
    { key: 'email', type: 'string', label: 'Email address' },
    { key: 'company', type: 'string' },
    { key: 'last_contact', type: 'date' },
  ],
  defaultTags: [],
});
```

---

## Field Types

Every field in a context type has a `type` that determines how values are stored and validated.

### `string`

A single-line text value. No length limit enforced by the schema; use `summary` for the one-line convention.

```json
{ "key": "assignee", "type": "string", "label": "Assigned to" }
```

Example value: `"Alice Chen"`

### `number`

A numeric value. Stored as a number in YAML (not a string).

```json
{ "key": "streak", "type": "number", "label": "Current streak (days)" }
```

Example value: `14`

### `boolean`

A true/false value.

```json
{ "key": "recurring", "type": "boolean" }
```

Example value: `true`

### `date`

A calendar date in `YYYY-MM-DD` format.

```json
{ "key": "due", "type": "date", "label": "Due date" }
```

Example value: `"2026-05-01"`

Only `date` and `datetime` fields can be used as `calendarDateField`.

### `datetime`

A full ISO 8601 timestamp with timezone.

```json
{ "key": "starts_at", "type": "datetime", "label": "Start time" }
```

Example value: `"2026-04-18T14:30:00-07:00"`

### `duration`

An ISO 8601 duration string.

```json
{ "key": "duration", "type": "duration", "label": "Estimated duration" }
```

Example value: `"PT1H30M"` (1 hour 30 minutes)

### `enum`

A value from a fixed set. The `values` array is required for enum fields.

```json
{
  "key": "status",
  "type": "enum",
  "values": ["open", "in_progress", "blocked", "done"],
  "required": true,
  "default": "open"
}
```

Example value: `"open"`

Enum validation checks that the stored value appears in the `values` array. Unknown values produce a validation error.

### `array`

An array of strings. Useful for lists that aren't tags (tags are always arrays and handled separately).

```json
{ "key": "participants", "type": "array", "label": "Meeting participants" }
```

Example value: `["alice", "bob", "carol"]`

### `object`

An arbitrary nested object. Not validated beyond existence. Use sparingly — structured data is better expressed as separate fields.

```json
{ "key": "metadata", "type": "object" }
```

Example value: `{ "source": "Jira", "jira_id": "ENG-1234" }`

---

## Field Options

Every field definition can include these optional properties in addition to `key` and `type`:

| Option | Type | Description |
|--------|------|-------------|
| `label` | string | Human-readable display name (used in `.cxms.md` context files) |
| `required` | boolean | If true, the field must be present on create. Defaults to `false`. |
| `default` | any | Value applied when the field is absent at create time |
| `values` | string[] | Allowed values, required for `enum` fields |

### Required fields

A field marked `required: true` must be present in the request body when creating a node. If it is absent and has no `default`, the request fails with `422 Unprocessable Entity` and an error message naming the missing field.

```json
{ "key": "status", "type": "enum", "values": ["open", "done"], "required": true }
```

On create without `status`:
```json
{
  "type": "https://cxms.dev/errors/validation-error",
  "title": "Validation failed",
  "status": 422,
  "detail": "status: required field missing"
}
```

### Default values

If a field has a `default`, that value is applied automatically when the field is absent at create time. Required fields with defaults are always satisfied.

```json
{ "key": "priority", "type": "enum", "values": ["low", "medium", "high"], "default": "medium" }
```

---

## Completion Semantics

A type can designate a field as its "completion" signal. When a node's completion field equals the completion value, CxMS considers it complete.

```json
{
  "completionField": "status",
  "completionValue": "done"
}
```

Completion is used in two places:

1. **Moment context** — `buildMomentContext()` filters tasks for the "overdue" list by checking that the completion field is not equal to the completion value. If a task is done, it does not appear as overdue.

2. **Context tree** — Completed nodes can be deprioritized in summary views.

Any field can be used for completion, including custom string and boolean fields:

```json
{
  "completionField": "completed",
  "completionValue": "true"
}
```

---

## Calendar Date Field

A type can designate one `date` or `datetime` field as its calendar date. This field is used for:

- **Date queries** — `GET /cx/date` and `GET /cx/date-range/:start/:end` only consider types with a `calendarDateField`
- **Moment context** — overdue detection compares the calendar date field against today's date

```json
{
  "calendarDateField": "due"
}
```

Only one field per type can be the calendar date, and it must be of type `date` or `datetime`. If you specify a field that doesn't exist in the `fields` array, or one that is not a date/datetime field, `addEntityType` throws an error.

---

## Updating a Type

You can update any type property except `name` (which is immutable). The update is a full merge — you provide the full updated type config.

### Via REST

```bash
curl -X PUT http://localhost:3800/cx/context-types/task \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plural": "tasks",
    "directory": "context-types/task",
    "description": "A task or action item",
    "fields": [
      { "key": "status", "type": "enum", "values": ["open", "in_progress", "blocked", "done"], "required": true, "default": "open" },
      { "key": "priority", "type": "enum", "values": ["low", "medium", "high", "critical"], "default": "medium" },
      { "key": "due", "type": "date" },
      { "key": "assignee", "type": "string" },
      { "key": "story_points", "type": "number" }
    ],
    "completionField": "status",
    "completionValue": "done"
  }'
```

**Important:** Updating a type schema does **not** retroactively validate or migrate existing nodes. Nodes created before the schema change retain their old fields. New required fields without defaults will fail validation on any subsequent update to those nodes, but existing values in the files are not touched.

### Via MCP

Using `update_type`:

```json
{
  "name": "task",
  "config": {
    "fields": [
      { "key": "status", "type": "enum", "values": ["open", "in_progress", "blocked", "done"], "required": true },
      { "key": "priority", "type": "enum", "values": ["low", "medium", "high", "critical"] },
      { "key": "due", "type": "date" },
      { "key": "story_points", "type": "number" }
    ]
  }
}
```

The `config` object is merged with the existing type — fields not specified in `config` are kept as-is.

---

## Deleting a Type

Deleting a type removes it from the type registry. It does **not** delete the node files on disk — the `context-types/{name}/` directory and all its files remain. The nodes simply become invisible to CxMS until the type is re-created.

```bash
curl -X DELETE http://localhost:3800/cx/context-types/habit \
  -H "Authorization: Bearer $TOKEN"
```

Response:
```json
{ "deleted": "habit" }
```

To also remove the node files, delete the directory manually after removing the type.

---

## Listing and Inspecting Types

### List all types

```bash
GET /cx/context-types
```

```json
{
  "count": 3,
  "types": [
    {
      "name": "task",
      "plural": "tasks",
      "directory": "context-types/task",
      "description": "A task or action item",
      "fields": [...],
      "completionField": "status",
      "completionValue": "done",
      "calendarDateField": "due"
    },
    ...
  ]
}
```

### Get type schema + context

```bash
GET /cx/context-types/task/details
```

Returns the full type config plus `examples` — the content of `.cxms-examples.md` if it exists.

### Count types

```bash
GET /cx/context-types/count
```

```json
{ "count": 3 }
```

---

## Example Type Designs

### Task (GTD-style)

```json
{
  "name": "task",
  "plural": "tasks",
  "directory": "context-types/task",
  "description": "An action item with status and optional due date",
  "fields": [
    { "key": "status", "type": "enum", "values": ["open", "in_progress", "waiting", "done", "cancelled"], "required": true, "default": "open" },
    { "key": "priority", "type": "enum", "values": ["low", "medium", "high", "critical"], "default": "medium" },
    { "key": "due", "type": "date" },
    { "key": "project", "type": "string" },
    { "key": "context", "type": "string", "label": "GTD context (@home, @work, @computer)" }
  ],
  "completionField": "status",
  "completionValue": "done",
  "calendarDateField": "due"
}
```

### Event (calendar)

```json
{
  "name": "event",
  "plural": "events",
  "directory": "context-types/event",
  "description": "A calendar event or scheduled meeting",
  "fields": [
    { "key": "starts_at", "type": "datetime", "required": true, "label": "Start time" },
    { "key": "duration", "type": "duration", "label": "Duration (ISO 8601)" },
    { "key": "location", "type": "string" },
    { "key": "participants", "type": "array" },
    { "key": "recurrence", "type": "string", "label": "RRULE string" }
  ],
  "calendarDateField": "starts_at"
}
```

### Person (contact)

```json
{
  "name": "person",
  "plural": "people",
  "directory": "context-types/person",
  "description": "A contact or person of interest",
  "fields": [
    { "key": "relationship", "type": "enum", "values": ["colleague", "manager", "report", "friend", "family", "vendor", "advisor"], "required": true },
    { "key": "email", "type": "string" },
    { "key": "company", "type": "string" },
    { "key": "role", "type": "string" },
    { "key": "timezone", "type": "string" },
    { "key": "last_contact", "type": "date" }
  ]
}
```

### Note (freeform)

```json
{
  "name": "note",
  "plural": "notes",
  "directory": "context-types/note",
  "description": "A freeform observation, idea, or reference document",
  "fields": [
    { "key": "category", "type": "string" },
    { "key": "source", "type": "string", "label": "Origin of this note" }
  ]
}
```

### Goal (OKR-style)

```json
{
  "name": "goal",
  "plural": "goals",
  "directory": "context-types/goal",
  "description": "A medium or long-horizon objective",
  "fields": [
    { "key": "status", "type": "enum", "values": ["draft", "active", "achieved", "abandoned"], "required": true, "default": "draft" },
    { "key": "horizon", "type": "enum", "values": ["weekly", "monthly", "quarterly", "annual"] },
    { "key": "target_date", "type": "date" },
    { "key": "metric", "type": "string", "label": "How success is measured" },
    { "key": "current_value", "type": "string" },
    { "key": "target_value", "type": "string" }
  ],
  "completionField": "status",
  "completionValue": "achieved",
  "calendarDateField": "target_date"
}
```

---

## The Type Registry

All type definitions are stored in `.phaibel/entity-types.json`. This file is the source of truth — if you want to inspect or manually edit the schema, look here.

```json
{
  "version": 1,
  "entityTypes": [
    {
      "name": "task",
      "plural": "tasks",
      "directory": "context-types/task",
      "description": "...",
      "fields": [...],
      "completionField": "status",
      "completionValue": "done"
    }
  ]
}
```

When the library starts up, it reads this file and caches the result in memory. The cache is invalidated on every write. You can force a cache refresh by calling `invalidateEntityTypeCache()`.

---

## See Also

- [Foundation](./foundation.md) — how types map to directories and `.cxms.md` files
- [REST API](./rest-api.md) — type CRUD endpoint details
- [MCP Tools](./mcp-tools.md) — `create_type`, `update_type`, `delete_type`, `list_types`, `get_type`
- [Search & Context](./search-and-context.md) — how types participate in the context tree and BM25 index
