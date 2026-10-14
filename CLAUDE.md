# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CxMS** (`@gclift/cxms`) is a TypeScript library and CLI providing structured persistent memory for AI agents. Agents store typed context nodes (tasks, events, notes, people, goals) as human-readable Markdown with YAML frontmatter. The system exposes both a REST API and MCP tool server.

## Commands

```bash
npm run build      # Compile TypeScript → dist/
npm run dev        # Watch mode compilation
npm run clean      # Remove dist/
bash ship.sh       # Build, bump patch version, commit, push to origin main
```

**Integration test** (manual, no test runner):
```bash
node test/federated-cxms.test.mjs
```

**CLI usage** (after build):
```bash
node dist/cli.js            # Start server
node dist/cli.js init       # Initialize foundation
node dist/cli.js token      # Print bearer token
```

## Architecture

The codebase has 7 layers (bottom to top):

### 1. Platform (`src/platform/`)
Abstracts all file I/O via `StorageProvider` and `PathProvider`. Always initialize before anything else:
```typescript
setPlatform(createNodePlatform());
setFoundationRoot('/path/to/foundation');
```

### 2. Foundation & Paths (`foundation.ts`, `paths.ts`)
Foundation root is any directory containing `.cxms.md`. `paths.ts` computes all derived paths (vault config, type dirs, collections, logs).

### 3. Schema (`src/schema/`)
- `entity-type-config.ts` — loads/manages type definitions (field schemas)
- `context-type-store.ts` — persists types to `.phaibel/entity-types.json`
- Built-in types: task, event, note, person, goal

### 4. Storage (`src/storage/`)
- `entity.ts` — reads/writes markdown nodes with gray-matter frontmatter
- `entity-validator.ts` — validates nodes against type schemas
- `boundary-guard.ts` — path traversal protection
- IDs are 8-char alphanumeric (always start with a letter)

### 5. Indexing & Search (`src/index/`)
- `entity-index.ts` — in-memory inverted index + relationship graph; built on startup via `getEntityIndex().build()`
- `bm25.ts` + `stemmer.ts` — BM25 full-text search with Porter stemming
- Field weights: Title (5×), Summary (2×), Custom fields (1.5×), Body (1×)

### 6. Context (`src/context/`)
- `context-tree.ts` — token-budgeted hierarchical context tree for LLM consumption
- `moment.ts` — real-time context (today's date, overdue tasks, schedule)
- `query-relevance.ts` — ranks entities by query relevance
- `reader.ts` — reads `.cxms.md` vault context files

### 7. Server (`src/server/`)
- `cx-router.ts` — REST API (GET/POST/PUT/DELETE for types, nodes, search, collections)
- `mcp-server.ts` — MCP tool server via StreamableHTTP transport (25 tools)
- `system-config.ts` — loads `~/.cxms/config.json` and bearer tokens
- `auth.ts` — bearer token authentication
- Default port: 3800

## Foundation Directory Layout

```
foundation-root/
  .cxms.md                    # Root context (read by LLMs)
  context-types/
    task/
      .cxms.md                # Type context + schema
      .cxms-examples.md       # Example nodes
      review-q3_abc12345.md   # Actual nodes (slug_id.md)
    event/ note/ person/ goal/ [custom]/
  collections/                # Key-value YAML stores
  logs/                       # Apache Combined format, rotated daily
  .phaibel/
    entity-types.json         # Type definitions
    embeddings.json           # Optional embeddings
  .trash/                     # Soft-deleted nodes
```

**Node file format**: `{slug}_{id}.md` where id is 8 chars alphanumeric.

## Key Design Decisions

- **ESM only** (`"type": "module"`, NodeNext resolution) — all imports need `.js` extensions even for `.ts` source files
- **Strict TypeScript** — `tsconfig.json` has strict mode enabled
- **No test framework** — only one manual integration test covering federated multi-server scenarios
- **MCP transport** — uses StreamableHTTP (not stdio), so MCP clients connect over HTTP
- **Auth** — single bearer token per server instance, stored in `~/.cxms/`
- **Soft deletes** — nodes move to `.trash/` rather than being permanently deleted immediately
