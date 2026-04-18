# Foundation

A Foundation is a directory on disk that CxMS manages as a self-contained memory store. It is identified by a `.cxms.md` file at its root. Everything CxMS reads and writes lives inside this directory.

---

## What a Foundation Is

A Foundation is just a directory with a specific layout. There is no database, no daemon required to maintain it, and no proprietary format. Every file inside is plain text: Markdown files with YAML frontmatter. You can open them in any editor, search them with `grep`, commit them to git, or copy them between machines.

You can have multiple independent Foundations — one per project, one per agent persona, one per team. Each runs its own CxMS server instance or is used directly via the library API.

---

## Creating a Foundation

### With the CLI

```bash
# Navigate to the directory you want to use as the Foundation root
cd ~/my-agent-memory

# Initialize
cxms init
```

This creates the directory structure and writes the root `.cxms.md` context file. It also saves the path to `~/.cxms/config.json` so the next `cxms` invocation finds it automatically.

### Manually

Create the following structure:

```
my-foundation/
  .cxms.md
  context-types/
  collections/
  logs/
  .phaibel/
    entity-types.json
```

`.cxms.md` content:

```markdown
---
title: "My Foundation"
created: 2026-04-18
tags: [context, system, root]
---

# My Foundation

Describe the purpose of this Foundation here. This content is read by LLMs
as part of the context tree, so write it for an AI agent reader.
```

`entity-types.json` content:

```json
{
  "version": 1,
  "entityTypes": []
}
```

### Programmatically

```typescript
import { setPlatform, createNodePlatform, setFoundationRoot } from '@gclift/cxms';
import { promises as fs } from 'fs';
import path from 'path';

const foundationDir = '/path/to/my-foundation';

// Create directory structure
await fs.mkdir(path.join(foundationDir, 'context-types'), { recursive: true });
await fs.mkdir(path.join(foundationDir, 'collections'), { recursive: true });
await fs.mkdir(path.join(foundationDir, 'logs'), { recursive: true });
await fs.mkdir(path.join(foundationDir, '.phaibel'), { recursive: true });
await fs.mkdir(path.join(foundationDir, '.trash'), { recursive: true });

// Write root context file
await fs.writeFile(path.join(foundationDir, '.cxms.md'), `---
title: "My Foundation"
created: ${new Date().toISOString().split('T')[0]}
tags: [context, system, root]
---

# My Foundation

This Foundation is managed by CxMS.
`);

// Write empty type registry
await fs.writeFile(
  path.join(foundationDir, '.phaibel', 'entity-types.json'),
  JSON.stringify({ version: 1, entityTypes: [] }, null, 2),
);

// Initialize CxMS
setPlatform(createNodePlatform());
setFoundationRoot(foundationDir);
```

---

## Directory Structure

```
my-foundation/
│
├── .cxms.md                          ← Root context file (Foundation marker)
│
├── context-types/                    ← One subdirectory per context type
│   ├── task/
│   │   ├── .cxms.md                  ← Type context file (schema + guidelines)
│   │   ├── .cxms-examples.md         ← Example nodes for this type (optional)
│   │   ├── review-q3-report_abc12345.md
│   │   ├── deploy-server_def67890.md
│   │   └── ...
│   ├── event/
│   │   ├── .cxms.md
│   │   └── team-standup_ghi11111.md
│   ├── note/
│   ├── person/
│   └── [your custom types]/
│
├── collections/                      ← Key-value stores
│   ├── shortcuts.md
│   └── preferences.md
│
├── logs/                             ← HTTP access and error logs
│   ├── access-2026-04-18.txt
│   └── error-2026-04-18.txt
│
├── .phaibel/                         ← CxMS internal config
│   ├── entity-types.json             ← Type registry (source of truth for schemas)
│   └── embeddings.json              ← Optional embedding store
│
└── .trash/                           ← Soft-deleted nodes
    └── task/
        └── old-task_abc12345.md
```

---

## The Root `.cxms.md` File

The root `.cxms.md` is the Foundation marker and the highest-level context document. Its presence is what CxMS uses to identify a Foundation root — without it, `findFoundationRoot()` will not recognize the directory.

### Frontmatter

```yaml
---
title: "My Foundation"
created: 2026-04-18
tags: [context, system, root]
---
```

Only `title` is required for CxMS to function. The remaining fields are conventions for readability and LLM consumption.

### Body

The body of the root `.cxms.md` is a free-form Markdown description of the Foundation's purpose. Write it for an AI agent reader — describe what this memory store is for, what kinds of information it contains, any naming conventions, and any important context the agent should always keep in mind.

```markdown
# My Foundation

This Foundation stores long-term memory for my personal AI assistant.

## What's here

- **Tasks** — anything I need to do, with status and priority
- **Events** — scheduled meetings and appointments
- **Notes** — ideas, observations, and research
- **People** — contacts and relationship context
- **Goals** — longer-horizon objectives

## Conventions

- Tasks use ISO 8601 dates in the `due` field
- Priorities are: low, medium, high, critical
- All people have a `relationship` field: colleague, friend, family, vendor
- Reference people in task bodies with @firstname to create relationship edges
```

---

## Type Context Files

Each context type's directory contains a `.cxms.md` file automatically generated when the type is created via `addEntityType()`. This file describes the type's schema and guidelines.

When CxMS creates this file, it generates content like:

```markdown
# Tasks

A task to complete.

## Fields

- **status** (enum) — Values: open, in_progress, done
- **priority** (enum) — Values: low, medium, high, critical
- **due** (date) — Due date

Completion: set `status` to `done` to mark as complete.

## Guidelines

- Use the exact field names above when creating or updating tasks.
- Titles should be concise and descriptive.
- When the user refers to "tasks" or "task", this is the entity type to use.
```

You can edit this file freely. CxMS reads it at context tree build time and includes it in the branch context for LLMs. Use it to document conventions, examples of good titles, field value meanings, and anything else that helps an agent correctly create and update nodes of this type.

### Example files

You can create a `.cxms-examples.md` file in any type directory. This is not automatically generated — you write it manually. Include representative nodes in Markdown+frontmatter format to show the agent what well-formed nodes look like. Accessible via `GET /cx/context-types/:type/details`.

```markdown
## Examples

### Open task with priority and due date

```markdown
---
id: abc12345
title: Submit expense report
entityType: task
status: open
priority: high
due: 2026-04-25
tags: [finance, admin]
---

Submit April receipts through the Concur portal before month-end close.
```

### Completed task

```markdown
---
id: def67890
title: Review Q1 roadmap
entityType: task
status: done
priority: medium
tags: [planning]
---

Reviewed and signed off with the product team on 2026-03-15.
```
```

---

## Node Files

Context nodes are stored as `{slug}_{id}.md` files inside the type directory. The slug is derived from the title — lowercased, spaces replaced with hyphens, non-alphanumeric characters removed. The id is an 8-character alphanumeric string.

Example: a task titled "Review Q3 report" with id `abc12345` becomes `review-q3-report_abc12345.md`.

### Node frontmatter

All nodes have these system fields in their frontmatter:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | 8-char alphanumeric, immutable after creation |
| `title` | string | Human-readable name |
| `entityType` | string | The context type name (e.g. `task`) |
| `created` | ISO 8601 | Set at creation, never changed |
| `updated` | ISO 8601 | Updated on every write (optional but set by the server) |
| `tags` | string[] | Array of tag strings |

Optional system fields:

| Field | Type | Description |
|-------|------|-------------|
| `summary` | string | One-sentence summary (max 150 chars) |
| `source` | string | `user`, `assumed`, or `system` |
| `references` | array | Labeled references to other nodes |

Custom fields follow — any fields defined in the type's schema.

### References

References are labeled links from one node to another. They appear in the frontmatter as an array:

```yaml
references:
  - "blocks:task:def67890"
  - "assigned-to:person:abc12345"
  - "about:event:ghi11111"
```

The shorthand format is `label:contextType:nodeId`. You can also store them as objects:

```yaml
references:
  - label: "blocks"
    contextType: "task"
    nodeId: "def67890"
```

Both formats are supported. References are parsed into relationship graph edges at index build time.

---

## Collections

Collections are simple key-value stores in the `collections/` directory. Each collection is a Markdown file with YAML frontmatter listing the key-value pairs.

```
collections/shortcuts.md
```

```markdown
---
name: shortcuts
description: Quick shortcuts and frequently used values
items:
  standup: "Daily standup at 9:30am in Zoom room 123"
  manager: "Alice Chen — alice@company.com"
  sprint-end: "2026-05-02"
---
```

Collections are useful for storing configuration, frequently referenced values, or small lookup tables that don't warrant a full context type. They are accessible via:

- `GET /cx/collections` — list all collection names
- `GET /cx/collection/:name` — get full collection
- `GET /cx/collection/:name/:key` — get single value
- MCP tools: `list_collections`, `get_collection`, `set_collection_item`, `remove_collection_item`

Collections do not participate in BM25 search or the relationship graph.

---

## Logs

CxMS writes two log files per day into the `logs/` directory:

**Access log** (`access-YYYY-MM-DD.txt`) — Apache Combined Log Format. One line per HTTP request. Includes method, path, status code, response time, and user agent.

```
127.0.0.1 - - [18/Apr/2026:10:23:45 +0000] "POST /cx/context-types/task HTTP/1.1" 201 87 "-" "curl/7.88.1" 12ms
```

**Error log** (`error-YYYY-MM-DD.txt`) — Error messages and stack traces from unhandled exceptions during request handling.

Logs rotate daily at midnight (UTC). Old log files are not automatically deleted — manage them with your own log rotation tool or a cron job.

---

## The `.trash/` Directory

Deleted nodes are moved to `.trash/{type}/` rather than permanently removed. The trash directory mirrors the type directory structure.

```
.trash/
  task/
    old-task_abc12345.md
  note/
    draft-note_def67890.md
```

Nodes in `.trash/` do **not** appear in searches or listings — the index and all list operations exclude this directory. Vault analytics (`GET /cx/analytics`) report trash separately via `trashFiles` and `trashBytes`.

To permanently delete a node, remove it from `.trash/` manually. To restore a node, move it back to `context-types/{type}/` and rebuild the index.

---

## System Config (`~/.cxms/`)

The CxMS CLI reads and writes a system-level config directory in your home directory:

| File | Purpose |
|------|---------|
| `~/.cxms/config.json` | `{ "foundationRoot": "/path/to/foundation", "port": 3800 }` |
| `~/.cxms/token` | Bearer token for API auth (auto-generated on first `cxms token`) |

The config is only used by the CLI (`cxms` command). When embedding CxMS in your own application, you set the foundation root and port yourself via `setFoundationRoot()` and the server `listen()` call.

---

## Multiple Foundations

CxMS supports multiple independent Foundations. To run two separate agents with separate memories:

```bash
# Agent 1
cxms --foundation ~/agent-work-memory --port 3801

# Agent 2
cxms --foundation ~/agent-personal-memory --port 3802
```

Each server is fully independent — different schemas, different nodes, different bearer tokens.

You can also switch Foundations at runtime in the embedded API by calling `resetFoundationRoot()` and `setFoundationRoot(newPath)`, though you must also reset the index and type cache (see [How It Works — Multi-Foundation](./how-it-works.md#multi-foundation--multi-tenant)).

---

## Version Control

Because every node is a plain text file, you can version-control a Foundation with git:

```bash
cd my-foundation
git init
git add .
git commit -m "Initial Foundation"
```

Useful patterns:
- Commit after a conversation session to snapshot the agent's memory state
- Use branches to experiment with different memory configurations
- Use `git log` to see how the agent's understanding has evolved
- Use `git diff` to review what an agent added or changed

The `.phaibel/embeddings.json` file can be large — consider adding it to `.gitignore` if you use embeddings.

---

## See Also

- [Context Types](./context-types.md) — type definitions and field schemas
- [How It Works](./how-it-works.md) — architecture and data flow
- [REST API](./rest-api.md) — managing Foundation data via HTTP
- [MCP Tools](./mcp-tools.md) — managing Foundation data via MCP
