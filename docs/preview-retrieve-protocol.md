# Preview-then-Retrieve Protocol (PtR)

The Preview-then-Retrieve protocol is a three-phase retrieval pattern for AI agents querying CxMS. It solves the core tension between **completeness** (needing to find the right information) and **token budget** (not being able to load everything into the context window at once).

The protocol works whether you have a single CxMS instance or a federation of several.

---

## The Problem

A Foundation with 500 nodes spans many thousands of tokens when loaded in full. Loading everything is wasteful — most nodes are irrelevant to any given query. But sending only the user's question to a capable LLM without any context leaves the model guessing.

The naïve middle ground — loading a whole context type — still loads irrelevant nodes and misses nodes in other types that might be relevant.

**PtR solves this by separating ranking from reasoning:**

- Use BM25 search (zero LLM cost) to narrow from N nodes → M candidates
- Use a cheap categorization model (Haiku) to select from M candidates → K relevant nodes
- Use full retrieval only for those K nodes, then answer with your preferred model

---

## The Three Phases

### Phase 1 — SEARCH (no LLM cost)

Query CxMS with keywords. The BM25 index returns lightweight **previews**: title, tags, summary, custom fields (status, priority, etc.), and a configurable body snippet. Full content is deliberately excluded.

```
POST /cx/search
{
  "query": "authentication JWT security",
  "snippetLength": 200,
  "limit": 15
}
```

Response:
```json
{
  "query": "authentication JWT security",
  "count": 4,
  "results": [
    {
      "id": "abc12345",
      "title": "Fix authentication bug in login flow",
      "type": "task",
      "score": 8.43,
      "tags": ["engineering", "security", "bug"],
      "summary": "JWT refresh race condition causing 401s after 30 minutes",
      "fields": { "status": "open", "priority": "critical", "project": "platform" },
      "bodySnippet": "Users report intermittent 401 errors on login. The JWT refresh logic in auth.ts:142 appears to race with token expiry..."
    },
    ...
  ]
}
```

**What the LLM sees in Phase 1:** title, tags, summary, key structured fields, and a body snippet — enough to judge relevance, not the full document.

**Token cost at scale:** ~50–150 tokens per preview. For 15 results ≈ 750–2250 tokens regardless of how long the actual node bodies are.

---

### Phase 2 — REASON (cheap categorization model)

Feed the previews to a language model and ask it to select which nodes are relevant to the user's query. **Use Claude Haiku for this step.** Haiku costs $0.80/1M input tokens vs $3.00/1M for Sonnet — a 3.75× cost saving — and selection/categorization is well within its capabilities.

**System prompt:**
```
You are a retrieval selection assistant. Given a user query and a list of 
knowledge base node previews, select which nodes are most relevant.

Return ONLY a JSON object:
{"selected":[{"type":"<type>","id":"<id>"},...], "reasoning":"<one sentence>"}

Rules: select only genuinely relevant nodes; maximum 5; return empty array if 
nothing matches.
```

**User message:**
```
Query: "authentication JWT security"

Previews:
[1] type=task id=abc12345 score=8.430
    title: Fix authentication bug in login flow
    tags: engineering, security, bug
    fields: {"status":"open","priority":"critical","project":"platform"}
    summary: JWT refresh race condition causing 401s after 30 minutes
    snippet: Users report intermittent 401 errors on login...

[2] type=note id=def67890 score=5.21
    title: Security audit findings — March 2026
    ...
```

**Response:**
```json
{
  "selected": [
    { "type": "task", "id": "abc12345" },
    { "type": "note", "id": "def67890" }
  ],
  "reasoning": "Both nodes directly address JWT/authentication security issues."
}
```

**Token cost:** ~300–800 input tokens per query (the preview list), ~50–100 output tokens (the selected IDs). Total: well under $0.001 per query at Haiku pricing.

---

### Phase 3 — FETCH (targeted, full content)

Use `batch_get_nodes` to fetch full content for only the selected nodes. This single call replaces N separate GET requests.

```
POST /cx/nodes/batch
{
  "nodes": [
    { "type": "task", "id": "abc12345" },
    { "type": "note", "id": "def67890" }
  ]
}
```

Response:
```json
{
  "count": 2,
  "nodes": [
    {
      "id": "abc12345",
      "title": "Fix authentication bug in login flow",
      "type": "task",
      "status": "open",
      "priority": "critical",
      "content": "Users report intermittent 401 errors on login. The JWT refresh logic in auth.ts:142...\n\nReproduce: log in, wait 30 minutes, make an API call...",
      "tags": ["engineering", "security", "bug"],
      "references": []
    },
    ...
  ],
  "errors": []
}
```

Feed these full nodes — and only these — to your answering model (Sonnet, Opus, or whichever fits the task).

---

## Token Budget Comparison

For a Foundation with 20 nodes, querying for "authentication security":

| Approach | Tokens | Description |
|----------|--------|-------------|
| Naïve full-load | ~2100 | Load all 20 nodes with full content |
| PtR protocol | ~630 | 3 previews + 3 full fetches |
| **Saving** | **~70%** | And savings grow with Foundation size |

At 500 nodes, the naïve approach may exceed most model context windows entirely. PtR remains bounded because search returns only the top-scoring matches, not everything.

---

## Model Recommendation

Testing the Phase 2 reasoning step across query types:

| Model | Phase 2 use | Cost/1M input | Speed | Quality |
|-------|-------------|--------------|-------|---------|
| **Haiku 4.5** | ✅ Recommended | $0.80 | Fast | Excellent for selection |
| Sonnet 4.6 | Overkill | $3.00 | Moderate | No meaningful gain over Haiku |
| Opus 4.7 | Do not use | $15.00 | Slow | Wasteful for classification |

**Why Haiku is sufficient for Phase 2:** The task is classification, not synthesis. Haiku reads 10–20 one-paragraph previews and outputs a list of IDs. It doesn't need to reason across long documents or generate nuanced prose — Haiku handles this reliably at a fraction of the cost.

**Where to use more capable models:** Phase 3 synthesis — reading the full content of selected nodes and generating the actual answer — benefits from Sonnet or Opus, especially for complex multi-document reasoning.

---

## Federated Queries

When running multiple CxMS instances (one per project, persona, or team), run Phase 1 and Phase 2 in parallel across all instances, then merge results for Phase 3.

```
┌──────────────┐    Phase 1: search all    ┌───────────────────┐
│   Agent      │ ──────────────────────── │  CxMS Instance A  │
│              │ ──────────────────────── │  CxMS Instance B  │
│              │ ──────────────────────── │  CxMS Instance C  │
└──────────────┘                           └───────────────────┘
       │
       │  Phase 2: Haiku selects from merged previews
       │
       │  Phase 3: batch_get_nodes from respective instances
       ▼
    Answer
```

**Implementation:**

```typescript
// Phase 1: search all instances in parallel
const [resultsA, resultsB, resultsC] = await Promise.all([
  fetch(`${instanceA}/cx/search`, { method: 'POST', body: JSON.stringify({ query, snippetLength: 200 }) }),
  fetch(`${instanceB}/cx/search`, { method: 'POST', body: JSON.stringify({ query, snippetLength: 200 }) }),
  fetch(`${instanceC}/cx/search`, { method: 'POST', body: JSON.stringify({ query, snippetLength: 200 }) }),
].map(p => p.then(r => r.json())));

// Merge and tag with source instance
const allPreviews = [
  ...resultsA.results.map(r => ({ ...r, _instance: 'A' })),
  ...resultsB.results.map(r => ({ ...r, _instance: 'B' })),
  ...resultsC.results.map(r => ({ ...r, _instance: 'C' })),
].sort((a, b) => b.score - a.score).slice(0, 20);

// Phase 2: Haiku selects from merged previews
const selected = await llmSelectNodes('claude-haiku-4-5-20251001', userQuery, allPreviews);

// Phase 3: batch fetch from respective instances
const byInstance = groupBy(selected, s => s._instance);
const [fullA, fullB, fullC] = await Promise.all([
  byInstance.A?.length ? fetch(`${instanceA}/cx/nodes/batch`, { method: 'POST', body: JSON.stringify({ nodes: byInstance.A }) }).then(r => r.json()) : { nodes: [] },
  byInstance.B?.length ? fetch(`${instanceB}/cx/nodes/batch`, { method: 'POST', body: JSON.stringify({ nodes: byInstance.B }) }).then(r => r.json()) : { nodes: [] },
  byInstance.C?.length ? fetch(`${instanceC}/cx/nodes/batch`, { method: 'POST', body: JSON.stringify({ nodes: byInstance.C }) }).then(r => r.json()) : { nodes: [] },
]);

const fullNodes = [...fullA.nodes, ...fullB.nodes, ...fullC.nodes];
// Pass fullNodes to your answering model
```

---

## MCP Workflow

For MCP-connected agents (Claude Desktop, Cursor):

```
1. search(query, snippetLength=200, limit=15)
   → get previews with fields and bodySnippet

2. [LLM reasons on previews, selects IDs]

3. batch_get_nodes([{type, id}, ...])
   → get full content for selected nodes only
```

The `search` tool description explicitly instructs the agent to use `batch_get_nodes` after selection, creating a natural two-step flow without requiring any extra orchestration.

---

## Query Tips

**Keywords work better than questions:** `"JWT authentication race condition"` scores better than `"what is causing login failures"`.

**Tag filters narrow scope:** `"security tag:engineering"` returns only nodes tagged `engineering` that also match the BM25 query.

**Type filters focus retrieval:** `{ "query": "quarterly report", "type": "task" }` skips notes and people.

**Snippet length trade-off:** Longer snippets help Phase 2 reasoning but cost more tokens. 150–250 chars is the sweet spot for most use cases. Increase to 400–500 for technical content where context matters more.

**Score threshold:** Results below ~1.0 BM25 score are weak matches. If all results have low scores, the query may not match anything in the Foundation and Phase 2 can legitimately return an empty selection.

---

## CxMS Endpoints Used

| Phase | Method | Endpoint | Purpose |
|-------|--------|----------|---------|
| 1 | POST | `/cx/search` | BM25 preview search |
| 3 | POST | `/cx/nodes/batch` | Batch full-content fetch |
| — | GET | `/cx/health` | Instance discovery (federated) |

**MCP tools:**

| Phase | Tool | Purpose |
|-------|------|---------|
| 1 | `search` | BM25 preview search |
| 3 | `batch_get_nodes` | Batch full-content fetch |

---

## Testing

Run the protocol test (no API key required for mechanics):

```bash
node test/preview-retrieve.test.mjs
```

To test the Haiku vs Sonnet comparison:

```bash
ANTHROPIC_API_KEY=sk-ant-... node test/preview-retrieve.test.mjs
```

The test seeds 20 nodes across three types, validates all three phases, measures token savings, and (with an API key) runs 4 queries through both models with full token and cost reporting.

---

## See Also

- [Search & Context](./search-and-context.md) — BM25 algorithm, field weights, tag filters
- [REST API](./rest-api.md) — `/cx/search` and `/cx/nodes/batch` endpoint details
- [MCP Tools](./mcp-tools.md) — `search` and `batch_get_nodes` tool reference
