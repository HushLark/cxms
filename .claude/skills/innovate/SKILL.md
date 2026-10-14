---
name: innovate
description: "Autonomously improve CxMS across validation, schema creation, search, speed, and the daemon — up to 10 improvement loops"
allowed-tools: Bash(npm run build), Bash(npm run clean), Bash(node test/*), Bash(git *), Read, Edit, Write, Glob, Grep, Agent
---

# Innovate — Autonomous CxMS Improvement

You are an autonomous improvement agent for the CxMS library (`@gclift/cxms`). Your job is to read the code, identify concrete weaknesses, make targeted improvements, verify correctness, and commit. Repeat up to 10 times.

## Arguments

`$ARGUMENTS` specifies which aspect to improve. Default to `all` if missing.

**Aspects:**
- `validation` — entity validation, field type checking, error messages
- `schema` — type definition creation/loading, default types, Zod schemas
- `search` — BM25 ranking, stemming, relevance scoring, query handling
- `speed` — index build time, file I/O, request throughput, startup cost
- `daemon` — MCP server, REST router, auth, config loading, CLI
- `all` — cycle through all aspects, one improvement per loop

**Examples:**
- `/innovate` — pick the weakest area and improve it
- `/innovate search` — focus on BM25 and relevance improvements only
- `/innovate validation` — tighten field validation and error messages
- `/innovate speed` — profile and reduce index build / request latency

## Key Files by Aspect

### Validation
- `src/storage/entity-validator.ts` — validates node fields against type schema
- `src/schema/entity-type-config.ts` — type definitions (field configs, required/optional)
- `src/schema/entity-types-defaults.ts` — built-in type defaults
- `src/types.ts` — `FieldConfig`, `EntityTypeConfig`, `ContextNode` TypeScript types

Common gaps to look for:
- Missing validation for field types (enum values not checked, date formats not parsed)
- No max-length enforcement on string/text fields
- Error messages that don't name the offending field
- `required` fields not enforced at write time
- No coercion for numeric string → number fields

### Schema Creation
- `src/schema/entity-type-config.ts` — `createEntityType`, `updateEntityType`, `getEntityType`
- `src/schema/context-type-store.ts` — persists types to `.phaibel/entity-types.json`
- `src/schema/entity-types-defaults.ts` — default types (task, event, note, person, goal)
- `src/server/cx-router.ts` lines around `/cx/context-types` — REST endpoint for type CRUD

Common gaps:
- Default types missing useful fields (e.g. `task` missing `due_date`, `person` missing `email`)
- No validation that field names are valid identifiers
- Type updates don't migrate existing nodes to new schema
- Missing Zod schemas for the type config payloads in the REST API

### Search
- `src/index/bm25.ts` — BM25 with Porter stemming
- `src/index/stemmer.ts` — Porter stemmer
- `src/index/entity-index.ts` — inverted index, relationship graph, `searchEntities()`
- `src/context/query-relevance.ts` — relevance ranking for context tree

Current field weights: Title (5×), Summary (2×), Custom fields (1.5×), Body (1×)

Common gaps:
- Stopword list missing or too short (a, an, the, is, are, was...)
- Exact phrase matching not boosted above individual terms
- `k1` and `b` BM25 params not tuned for typical vault sizes
- Short queries (≤2 chars) not handled gracefully

### Speed
- `src/index/entity-index.ts` — `build()` reads all files serially; could batch
- `src/storage/entity.ts` — `listEntities()` reads every file to build listing
- `src/platform/node.ts` — underlying file operations
- `src/server/cx-router.ts` — index rebuilt on demand vs. incremental updates

Common gaps:
- `build()` is fully serial — should use `Promise.all()` with concurrency cap
- No incremental index updates when a single node changes (full rebuild on write)
- `listEntities()` stats every file even when only metadata needed
- No response caching for stable read-heavy endpoints (e.g. `/cx/context-types`)

### Daemon (Server + CLI)
- `src/server/mcp-server.ts` — MCP tool server, tool definitions and handlers
- `src/server/cx-router.ts` — REST API router, request/response handling
- `src/server/auth.ts` — bearer token validation
- `src/server/system-config.ts` — `~/.cxms/config.json` loading
- `src/cli.ts` — CLI entry, argument parsing, `cxms init` / `cxms token`

Common gaps:
- MCP tool schemas missing optional field descriptions (LLMs can't infer usage)
- REST endpoints don't set `Content-Type: application/json` explicitly on errors
- `system-config.ts` doesn't handle `~/.cxms/` missing gracefully on first run
- `cxms init` doesn't validate that target dir is writable before creating files
- No graceful shutdown on SIGTERM (index write flush, log close)

## Workflow — Repeat up to 10 times

### Step 1: Pick a target

If `$ARGUMENTS` names an aspect, work within that aspect. If `all` (or blank), read recent commit messages to see what was last changed, then pick the aspect that hasn't been touched recently and has the most obvious gaps.

Read the relevant files listed above. Look for: missing edge cases, weak type safety, TODO comments, areas where a failure would silently produce wrong results.

Write down the specific problem in one sentence before changing anything.

### Step 2: Make ONE targeted change

Small is better. Target 5-30 lines changed. Examples of good single changes:
- Add a stopword list to `bm25.ts` (15 lines)
- Add `due_date` field to the default task type in `entity-types-defaults.ts` (8 lines)
- Add enum value checking to `entity-validator.ts` (12 lines)
- Parallelize `build()` with `Promise.all()` in `entity-index.ts` (10 lines)
- Add missing `Content-Type` header to error responses in `cx-router.ts` (3 lines)

Do NOT refactor surrounding code unless it is blocking the improvement.

Always read the target file before editing it.

### Step 3: Build and verify

```bash
npm run build
```

If build fails, fix the errors before continuing. TypeScript errors mean the change is wrong — don't proceed with a broken build.

If the change touches entity I/O, search, or the server, also run:
```bash
node test/federated-cxms.test.mjs
```

### Step 4: Assess the improvement

Ask yourself:
- Does this actually fix the identified problem?
- Does it introduce any regressions (new type errors, behavior changes for existing callers)?
- Is it minimal — no unnecessary scope creep?

If the change is good: stage and commit the changed source files.

```bash
git add <changed files>
git commit -m "<aspect>: <what changed and why in one line>"
```

If the change introduced a regression or doesn't solve the problem:
```bash
git checkout -- <files>
```

Then try a different approach in the next loop.

### Step 5: Repeat

Go back to Step 1. After each loop, pick the next most impactful improvement. Stop after 10 loops or when you've exhausted meaningful improvements in the target aspect.

## Rules

1. **One change per loop** — never combine validation + search changes in one commit.
2. **Build must pass** — never commit a change that breaks `npm run build`.
3. **Read before editing** — always use Read before Edit.
4. **Small edits** — 5-30 lines changed. Large rewrites are hard to verify.
5. **Name the problem first** — write one sentence describing the bug/gap before editing.
6. **Revert failures** — if a change doesn't help or regresses, revert before next loop.
7. **No TODOs** — don't leave TODO comments; either fix it now or skip it.
8. **No new dependencies** — use what's already in package.json (gray-matter, zod, @modelcontextprotocol/server, @modelcontextprotocol/node).
