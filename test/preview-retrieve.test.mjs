/**
 * Preview-then-Retrieve Protocol Test
 *
 * Tests the two-phase retrieval protocol:
 *   Phase 1 — SEARCH: keyword query → lightweight previews (title, tags, summary, fields, bodySnippet)
 *   Phase 2 — REASON:  LLM selects relevant node IDs from previews (cheap categorization model)
 *   Phase 3 — FETCH:  batch_get_nodes fetches full content only for selected nodes
 *
 * If ANTHROPIC_API_KEY is set, Phase 2 is tested with:
 *   - claude-haiku-4-5-20251001  (cheapest categorization)
 *   - claude-sonnet-4-6           (balanced)
 * and token usage + latency + cost is compared.
 *
 * All CxMS mechanics tests run without an API key.
 *
 * Usage:
 *   node test/preview-retrieve.test.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node test/preview-retrieve.test.mjs
 */

import http from 'http';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

import {
    setPlatform, createNodePlatform, setFoundationRoot,
    resetFoundationRoot, resetEntityIndex, invalidateEntityTypeCache,
    getEntityIndex, handleCxRoute, handleMcpRoute, resetMcpServer,
    setAuthEnabled,
} from '../dist/index.js';

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
    if (cond) { passed++; process.stdout.write(`  ✓ ${msg}\n`); }
    else       { failed++; failures.push(msg); process.stdout.write(`  ✗ ${msg}\n`); }
}
function assertEq(actual, expected, msg) {
    assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let port;

async function restReq(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        const bodyStr = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: { 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
        };
        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

async function mcpReq(payload) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(payload);
        const opts = {
            hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(bodyStr) },
        };
        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                const ct = res.headers['content-type'] || '';
                let parsed = null;
                if (ct.includes('text/event-stream')) {
                    for (const line of raw.split('\n')) {
                        if (line.startsWith('data: ')) {
                            try {
                                const obj = JSON.parse(line.slice(6));
                                if (obj.result !== undefined || obj.error !== undefined) { parsed = obj; break; }
                            } catch { /* skip */ }
                        }
                    }
                } else {
                    try { parsed = JSON.parse(raw); } catch { /* skip */ }
                }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

async function mcpToolCall(toolName, args) {
    resetMcpServer();
    const res = await mcpReq({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: args } });
    const content = res.body?.result?.content;
    if (!content?.[0]) return { raw: res.body, data: null };
    try { return { raw: res.body, data: JSON.parse(content[0].text) }; }
    catch { return { raw: res.body, data: content[0].text }; }
}

async function mcpListTools() {
    resetMcpServer();
    const res = await mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    return res.body?.result?.tools || [];
}

// ── Seed data ─────────────────────────────────────────────────────────────────

const SEED_TYPES = [
    {
        name: 'task', plural: 'tasks', directory: 'context-types/task',
        description: 'Action items and work to complete',
        fields: [
            { key: 'status',   type: 'enum', values: ['open', 'in_progress', 'done'], required: true, default: 'open' },
            { key: 'priority', type: 'enum', values: ['low', 'medium', 'high', 'critical'], default: 'medium' },
            { key: 'due',      type: 'date' },
            { key: 'project',  type: 'string' },
        ],
        completionField: 'status', completionValue: 'done', calendarDateField: 'due',
    },
    {
        name: 'note', plural: 'notes', directory: 'context-types/note',
        description: 'Freeform observations, research, and ideas',
        fields: [
            { key: 'category', type: 'string' },
            { key: 'source',   type: 'string' },
        ],
    },
    {
        name: 'person', plural: 'people', directory: 'context-types/person',
        description: 'Contacts and people of interest',
        fields: [
            { key: 'relationship', type: 'enum', values: ['colleague', 'manager', 'friend', 'vendor'], required: true },
            { key: 'email',        type: 'string' },
            { key: 'company',      type: 'string' },
        ],
    },
];

// 20 diverse nodes spanning engineering, business, design, and people
const SEED_NODES = [
    { type: 'task', title: 'Fix authentication bug in login flow',         tags: ['engineering','security','bug'],        status: 'open',        priority: 'critical', project: 'platform', due: '2026-04-20', content: 'Users report intermittent 401 errors on login. The JWT refresh logic in auth.ts:142 appears to race with token expiry. Reproduce: log in, wait 30 minutes, make an API call. Assignee: Bob Martinez.' },
    { type: 'task', title: 'Migrate database to PostgreSQL 16',            tags: ['engineering','database','infrastructure'], status: 'in_progress', priority: 'high',     project: 'platform', due: '2026-05-01', content: 'PostgreSQL 14 reaches end-of-life in November. Migration plan: stage → prod in two weekends. Backup strategy already documented in the runbook. Contact Bob if blocked.' },
    { type: 'task', title: 'Write unit tests for payment processor',       tags: ['engineering','testing','payments'],    status: 'open',        priority: 'medium',   project: 'billing',  content: 'Coverage is at 42%. Need to reach 80% before next audit. Focus on edge cases: declined cards, partial refunds, currency conversion.' },
    { type: 'task', title: 'Design new dashboard wireframes',              tags: ['design','product'],                    status: 'open',        priority: 'medium',   project: 'growth',   content: 'Product wants a redesigned analytics dashboard. Figma access in the shared drive. Carol Kim is leading this. Reference: Stripe and Linear as inspiration.' },
    { type: 'task', title: 'Upgrade React from 17 to 18',                 tags: ['engineering','frontend','dependencies'], status: 'done',        priority: 'low',      project: 'platform', content: 'Completed migration. Breaking changes: StrictMode double-renders in dev. All tests passing after fixing render batching issues.' },
    { type: 'task', title: 'Prepare Q2 board presentation',               tags: ['executive','finance','quarterly'],     status: 'open',        priority: 'critical', project: 'company',  due: '2026-04-28', content: 'Board meets April 28. Slides need: revenue vs forecast, churn analysis, roadmap priorities, hiring plan update. David Park owns the financial sections.' },
    { type: 'task', title: 'Renew AWS enterprise agreement',              tags: ['infrastructure','contracts','finance'], status: 'open',        priority: 'high',     project: 'operations', due: '2026-05-15', content: 'Current agreement expires May 31. Negotiate committed spend discount. Target: 20% reduction. Contact: Sarah Nguyen at AWS Enterprise Sales.' },
    { type: 'task', title: 'Conduct Q1 performance reviews',              tags: ['hr','management','quarterly'],         status: 'in_progress', priority: 'high',     project: 'hr',       content: 'Engineering team reviews in progress. 6 of 12 completed. Deadline is April 30. Alice Chen is coordinating.' },

    { type: 'note', title: 'Architecture decision: event sourcing vs CQRS', tags: ['engineering','architecture','research'], category: 'architecture', source: 'internal',       content: 'Event sourcing gives us a full audit log and time-travel debugging but adds operational complexity. CQRS alone gives better read performance. Recommendation: CQRS now, evaluate event sourcing in 12 months.' },
    { type: 'note', title: 'Security audit findings — March 2026',          tags: ['security','compliance','engineering'],  category: 'security',     source: 'external-audit', content: 'Critical: JWT tokens not rotated on password change. High: admin endpoints missing rate limiting. Medium: verbose error messages expose stack traces in production. Remediation plan sent to CTO.' },
    { type: 'note', title: 'Competitor analysis: pricing changes Q1 2026',  tags: ['business','competitive','product'],     category: 'competitive',  source: 'research',       content: 'Competitor A raised prices 15% in January. Competitor B launched a free tier targeting startups. Our pricing is well positioned for mid-market but we may be losing SMB deals.' },
    { type: 'note', title: 'Customer interview: enterprise onboarding pain', tags: ['product','customer','research'],        category: 'customer',     source: 'interview',      content: 'Interviewed 5 enterprise customers about onboarding. Main friction: SSO setup takes too long (avg 4 hours). Customers want: video walkthrough, pre-built SAML configs for Okta and Azure AD.' },
    { type: 'note', title: 'On-call runbook: database failover procedure',   tags: ['operations','runbook','database','engineering'], category: 'operations', source: 'internal', content: 'Step 1: Confirm primary unreachable. Step 2: Promote replica in RDS console. Step 3: Update connection string in Parameter Store. Step 4: Verify app health. RTO target: 10 minutes.' },
    { type: 'note', title: 'Meeting notes: product roadmap Q2 2026',         tags: ['product','planning','quarterly'],       category: 'planning',     source: 'meeting',        content: 'Q2 priorities agreed: (1) enterprise SSO, (2) API rate limiting, (3) improved dashboard. Deferred: mobile app, offline mode. Next roadmap review: July 1.' },

    { type: 'person', title: 'Alice Chen',   tags: ['engineering','management'], relationship: 'manager',   email: 'alice@company.com',  company: 'Acme Corp',              content: 'VP of Engineering. Leads platform and growth teams. Strong background in distributed systems. Weekly 1:1 on Tuesdays. Coordinates performance reviews.' },
    { type: 'person', title: 'Bob Martinez', tags: ['engineering','backend'],    relationship: 'colleague',  email: 'bob@company.com',    company: 'Acme Corp',              content: 'Senior backend engineer. Owns payment processing and authentication service. Expert in PostgreSQL and Redis.' },
    { type: 'person', title: 'Carol Kim',    tags: ['design','product'],         relationship: 'colleague',  email: 'carol@company.com',  company: 'Acme Corp',              content: 'Head of Design. Leading the dashboard redesign. Previously at Stripe, strong sense for data-dense UIs.' },
    { type: 'person', title: 'David Park',   tags: ['finance','executive'],      relationship: 'colleague',  email: 'david@company.com',  company: 'Acme Corp',              content: 'CFO. Owns board presentation and Q2 financial forecast. Prefers Slack over email. Primary contact for budget questions.' },
    { type: 'person', title: 'Sarah Nguyen', tags: ['vendor','aws'],             relationship: 'vendor',     email: 'sarah@aws.com',      company: 'Amazon Web Services',    content: 'Enterprise account manager at AWS. Primary contact for contract renewal and support escalations. Usually replies within 4 hours.' },
    { type: 'person', title: 'Emma Wilson',  tags: ['customer','enterprise'],    relationship: 'colleague',  email: 'emma@bigcorp.com',   company: 'BigCorp Inc',            content: 'IT Director at BigCorp, our largest enterprise customer. Main stakeholder for SSO and compliance. Most detailed onboarding feedback.' },
];

// ── Anthropic API ─────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODELS = [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  inputCost: 0.80,  outputCost: 4.00  },
    { id: 'claude-sonnet-4-6',          label: 'Sonnet 4.6', inputCost: 3.00,  outputCost: 15.00 },
];

async function llmSelectNodes(modelId, userQuery, previews) {
    const system = `You are a retrieval selection assistant. Given a user query and a list of knowledge base node previews, select which nodes are most relevant.

Return ONLY a JSON object with this exact structure:
{"selected":[{"type":"<type>","id":"<id>"},...], "reasoning":"<one sentence>"}

Rules: select only genuinely relevant nodes; maximum 5; return empty array if nothing matches.`;

    const previewText = previews.map((p, i) =>
        `[${i+1}] type=${p.type} id=${p.id} score=${p.score?.toFixed(3)}\n` +
        `    title: ${p.title}\n` +
        `    tags: ${(p.tags||[]).join(', ')}\n` +
        `    fields: ${JSON.stringify(p.fields||{})}\n` +
        `    summary: ${p.summary||'(none)'}\n` +
        `    snippet: ${p.bodySnippet||'(none)'}`
    ).join('\n\n');

    const t0 = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
            model: modelId, max_tokens: 512,
            system,
            messages: [{ role: 'user', content: `Query: "${userQuery}"\n\nPreviews:\n${previewText}` }],
        }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const latencyMs = Date.now() - t0;

    let parsed;
    try { parsed = JSON.parse(json.content[0].text); }
    catch { throw new Error(`Invalid JSON from model: ${json.content[0]?.text}`); }

    return { selected: parsed.selected || [], reasoning: parsed.reasoning || '', usage: json.usage, latencyMs };
}

// ── Main ──────────────────────────────────────────────────────────────────────

let tempDir, server;

try {
    // ── Setup ─────────────────────────────────────────────────────────────────

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cxms-ptr-test-'));

    resetFoundationRoot(); resetEntityIndex(); invalidateEntityTypeCache(); resetMcpServer();
    setPlatform(createNodePlatform());
    setFoundationRoot(tempDir);
    setAuthEnabled(false);

    await fs.writeFile(path.join(tempDir, '.cxms.md'), '---\ntitle: PTR Test\ncreated: 2026-04-18\ntags: [test]\n---\n');
    await fs.mkdir(path.join(tempDir, '.phaibel'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.phaibel', 'entity-types.json'), JSON.stringify({ version: 1, entityTypes: [] }));

    server = http.createServer(async (req, res) => {
        resetMcpServer();
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        if (url.pathname.startsWith('/cx/')) { await handleCxRoute(req, res, url); return; }
        if (url.pathname === '/mcp') { await handleMcpRoute(req, res); return; }
        res.writeHead(404); res.end();
    });
    await new Promise(r => server.listen(0, r));
    port = server.address().port;

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  Preview-then-Retrieve Protocol Test                ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    console.log(`Temp dir : ${tempDir}`);
    console.log(`Port     : ${port}`);
    console.log(`LLM test : ${ANTHROPIC_API_KEY ? 'ENABLED (ANTHROPIC_API_KEY set)' : 'skipped (no ANTHROPIC_API_KEY)'}\n`);

    // Seed types
    for (const t of SEED_TYPES) {
        const r = await restReq('POST', '/cx/context-types', t);
        if (r.status !== 201) throw new Error(`Failed to create type ${t.name}: ${JSON.stringify(r.body)}`);
    }

    // Seed nodes
    console.log('── Seeding 20 nodes ──');
    const nodeIds = {};
    for (const n of SEED_NODES) {
        const { type, ...fields } = n;
        const r = await restReq('POST', `/cx/context-types/${type}`, fields);
        if (r.status !== 201) throw new Error(`Failed to create "${n.title}": ${JSON.stringify(r.body)}`);
        (nodeIds[type] ??= []).push(r.body.id);
    }
    const index = getEntityIndex();
    await index.build();
    const stats = index.getStats();
    console.log(`  Indexed: ${stats.nodeCount} nodes — ${Object.entries(stats.byType).map(([t,c])=>`${t}:${c}`).join(', ')}\n`);

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 1: Search returns enriched previews (not full content)
    // ═════════════════════════════════════════════════════════════════════════

    console.log('── Phase 1: Preview search ──');

    const s1 = await restReq('POST', '/cx/search', { query: 'authentication security bug', snippetLength: 200 });
    assert(s1.status === 200,                   'search returns 200');
    assert(Array.isArray(s1.body.results),      'results is an array');
    assert(s1.body.count > 0,                  `found ${s1.body.count} results for "authentication security bug"`);

    const hit = s1.body.results[0];
    assert(typeof hit.id === 'string',           'result.id is string');
    assert(typeof hit.type === 'string',         'result.type is string');
    assert(typeof hit.score === 'number',        'result.score is number');
    assert(typeof hit.fields === 'object',       'result.fields object present');
    assert(typeof hit.bodySnippet === 'string',  'result.bodySnippet present');
    assert(hit.bodySnippet.length <= 200,        `bodySnippet ≤200 chars (${hit.bodySnippet.length})`);
    assert(!hit.content,                         'full content NOT in search results (preview only)');

    const authHit = s1.body.results.find(r => r.title?.toLowerCase().includes('auth'));
    assert(authHit !== undefined,                'authentication task appears in results');
    assert(authHit?.fields?.status !== undefined,'custom field "status" in preview');
    assert(authHit?.fields?.priority !== undefined, 'custom field "priority" in preview');

    // Cross-type
    const s2 = await restReq('POST', '/cx/search', { query: 'database postgres' });
    const types2 = [...new Set(s2.body.results.map(r => r.type))];
    assert(types2.length >= 2,                  `cross-type search spans ${types2.length} types: ${types2.join(', ')}`);

    // Tag filter
    const s3 = await restReq('POST', '/cx/search', { query: 'security tag:engineering' });
    assert(s3.body.results.every(r => (r.tags||[]).includes('engineering')), 'tag filter works: all results tagged "engineering"');

    // Type filter
    const s4 = await restReq('POST', '/cx/search', { query: 'quarterly board', type: 'task' });
    assert(s4.body.results.every(r => r.type === 'task'), 'type filter: all results are tasks');

    // Snippet length
    const s5 = await restReq('POST', '/cx/search', { query: 'database', snippetLength: 50 });
    assert(s5.body.results.every(r => r.bodySnippet.length <= 50), 'snippetLength=50 respected');

    console.log('');

    // ═════════════════════════════════════════════════════════════════════════
    // TOKEN EFFICIENCY: Preview vs full-content load
    // ═════════════════════════════════════════════════════════════════════════

    console.log('── Token efficiency ──');

    // Scenario A: naïve — load ALL nodes of all types in full (no search filter)
    const allTasksR  = await restReq('GET', '/cx/context-types/task');
    const allNotesR  = await restReq('GET', '/cx/context-types/note');
    const allPeopleR = await restReq('GET', '/cx/context-types/person');
    const allNodesPayload = [...allTasksR.body.nodes, ...allNotesR.body.nodes, ...allPeopleR.body.nodes];
    const naiveFullRefs = allNodesPayload.map(n => ({ type: n.type, id: n.id }));
    const naiveFullBatch = await restReq('POST', '/cx/nodes/batch', { nodes: naiveFullRefs });
    const naiveTokens = Math.round(JSON.stringify(naiveFullBatch.body.nodes).length / 4);

    // Scenario B: protocol — search previews + batch fetch top 3
    const previewRes = await restReq('POST', '/cx/search', { query: 'authentication security bug', snippetLength: 200 });
    const previewTokens = Math.round(JSON.stringify(previewRes.body.results).length / 4);
    const selectedRefs = previewRes.body.results.slice(0, 3).map(r => ({ type: r.type, id: r.id }));
    const selectedFull = await restReq('POST', '/cx/nodes/batch', { nodes: selectedRefs });
    const selectedTokens = Math.round(JSON.stringify(selectedFull.body.nodes).length / 4);
    const protocolTokens = previewTokens + selectedTokens;

    const saving = naiveTokens > 0 ? Math.round((naiveTokens - protocolTokens) / naiveTokens * 100) : 0;
    console.log(`  Naïve (${naiveFullBatch.body.count} full nodes, no filter): ~${naiveTokens} tokens`);
    console.log(`  Protocol (${previewRes.body.count} previews + ${selectedFull.body.count} full fetches): ~${protocolTokens} tokens`);
    console.log(`    └ Phase 1 previews: ~${previewTokens} tokens`);
    console.log(`    └ Phase 3 selected: ~${selectedTokens} tokens`);
    console.log(`  Token saving: ~${saving}% vs naïve full-load\n`);
    assert(protocolTokens < naiveTokens,        `protocol uses fewer tokens than naïve full-load (${saving}% less)`);
    assert(saving >= 20,                        `saving ≥20% vs naïve (got ${saving}%)`);
    assert(previewRes.body.count < naiveFullBatch.body.count, `search filters: ${previewRes.body.count} previews < ${naiveFullBatch.body.count} full nodes`);

    // ═════════════════════════════════════════════════════════════════════════
    // PHASE 3: Batch fetch returns full content
    // ═════════════════════════════════════════════════════════════════════════

    console.log('── Phase 3: Batch fetch ──');

    const searchForBatch = await restReq('POST', '/cx/search', { query: 'authentication database security' });
    const refs = searchForBatch.body.results.slice(0, 3).map(r => ({ type: r.type, id: r.id }));

    const b1 = await restReq('POST', '/cx/nodes/batch', { nodes: refs });
    assert(b1.status === 200,                        'batch returns 200');
    assertEq(b1.body.count, refs.length,             `fetched ${refs.length} nodes`);
    assert(Array.isArray(b1.body.nodes),             'nodes array present');
    assertEq(b1.body.errors.length, 0,              'no errors');
    assert(typeof b1.body.nodes[0].content === 'string', 'full node has content body');
    assert(b1.body.nodes[0].content.length > 0,     'content is non-empty');
    assert(b1.body.nodes[0].fields === undefined,    'full node uses spread fields (not nested fields key)');

    // Mixed valid/invalid
    const b2 = await restReq('POST', '/cx/nodes/batch', { nodes: [refs[0], { type: 'task', id: 'doesnotexist' }, { type: 'bogus_type', id: 'x' }] });
    assertEq(b2.body.count, 1,              'only 1 valid node returned in mixed batch');
    assertEq(b2.body.errors.length, 2,     '2 errors for invalid refs');

    // Size limit
    const b3 = await restReq('POST', '/cx/nodes/batch', { nodes: Array.from({ length: 51 }, (_, i) => ({ type: 'task', id: `x${i}` })) });
    assert(b3.status === 400,              'batch >50 nodes returns 400');

    console.log('');

    // ═════════════════════════════════════════════════════════════════════════
    // LLM COMPARISON: Haiku vs Sonnet for Phase 2 reasoning
    // ═════════════════════════════════════════════════════════════════════════

    if (ANTHROPIC_API_KEY) {
        const TEST_QUERIES = [
            { query: 'security vulnerabilities and authentication',     hint: ['task', 'note'] },
            { query: 'AWS cloud infrastructure costs and contracts',    hint: ['task', 'person'] },
            { query: 'board presentation financial forecast quarterly', hint: ['task', 'person'] },
            { query: 'enterprise customer SSO onboarding friction',     hint: ['note', 'person'] },
        ];

        const totals = {};

        for (const { id: modelId, label, inputCost, outputCost } of MODELS) {
            console.log(`── LLM Phase 2: ${label} ──`);
            totals[label] = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };

            for (const { query, hint } of TEST_QUERIES) {
                // Phase 1
                const previews = (await restReq('POST', '/cx/search', { query, snippetLength: 200, limit: 12 })).body.results;

                // Phase 2 — categorize with LLM
                let result;
                try { result = await llmSelectNodes(modelId, query, previews); }
                catch (e) { console.log(`  ! ${query}: ${e.message}`); failed++; continue; }

                const { selected, reasoning, usage, latencyMs } = result;
                totals[label].inputTokens  += usage.input_tokens;
                totals[label].outputTokens += usage.output_tokens;
                totals[label].latencyMs    += latencyMs;

                // Phase 3 — fetch selected
                const fetched = selected.length > 0
                    ? (await restReq('POST', '/cx/nodes/batch', { nodes: selected })).body
                    : { count: 0, nodes: [] };

                const selTypes = [...new Set(selected.map(s => s.type))];
                const relevant = hint.some(h => selTypes.includes(h));

                console.log(`  Query: "${query}"`);
                console.log(`    Selected: ${selected.length} node(s) → fetched ${fetched.count}`);
                if (selected.length > 0) console.log(`    Types: ${selTypes.join(', ')}`);
                console.log(`    Reasoning: ${reasoning}`);
                console.log(`    Tokens: ${usage.input_tokens}in / ${usage.output_tokens}out  Latency: ${latencyMs}ms`);

                assert(selected.length > 0, `${label}: selected ≥1 node for "${query.slice(0,45)}"`);
                assert(relevant || selected.length === 0, `${label}: selected relevant types (expected ${hint.join(' or ')})`);
            }

            const t = totals[label];
            const costUsd = (t.inputTokens / 1e6 * inputCost + t.outputTokens / 1e6 * outputCost).toFixed(5);
            console.log(`\n  ${label} (${TEST_QUERIES.length} queries):`);
            console.log(`    Input tokens:  ${t.inputTokens}   Output tokens: ${t.outputTokens}`);
            console.log(`    Total latency: ${t.latencyMs}ms   Est. cost: $${costUsd}\n`);
        }

        // Side-by-side comparison
        const h = totals['Haiku 4.5'];
        const s = totals['Sonnet 4.6'];
        if (h && s) {
            const hModel = MODELS.find(m => m.label === 'Haiku 4.5');
            const sModel = MODELS.find(m => m.label === 'Sonnet 4.6');
            const hCost = (h.inputTokens / 1e6 * hModel.inputCost + h.outputTokens / 1e6 * hModel.outputCost);
            const sCost = (s.inputTokens / 1e6 * sModel.inputCost + s.outputTokens / 1e6 * sModel.outputCost);
            const speedup  = (s.latencyMs / Math.max(h.latencyMs, 1)).toFixed(1);
            const savings  = sCost > 0 ? ((sCost - hCost) / sCost * 100).toFixed(0) : 0;

            console.log('── Model comparison ──');
            console.log(`  Haiku is ${speedup}x faster than Sonnet for Phase 2`);
            console.log(`  Haiku saves ~${savings}% cost vs Sonnet for Phase 2`);
            console.log(`  Haiku cost/1M input: $${hModel.inputCost}  Sonnet: $${sModel.inputCost}  (${(sModel.inputCost/hModel.inputCost).toFixed(1)}x)`);
            console.log('');
            console.log('  RECOMMENDATION:');
            console.log('    Phase 1 (search):  CxMS BM25 — no LLM cost');
            console.log('    Phase 2 (select):  Haiku — cheap, fast, accurate for classification');
            console.log('    Phase 3 (answer):  Sonnet/Opus — only on selected nodes, not full corpus\n');
        }
    } else {
        console.log('── LLM Phase 2: skipped ──');
        console.log('  Run with ANTHROPIC_API_KEY=... to compare Haiku vs Sonnet\n');
    }

    // ═════════════════════════════════════════════════════════════════════════
    // MCP TOOLS: search + batch_get_nodes
    // ═════════════════════════════════════════════════════════════════════════

    console.log('── MCP: search and batch_get_nodes ──');

    const tools = await mcpListTools();
    assert(tools.some(t => t.name === 'search'),          'search tool registered');
    assert(tools.some(t => t.name === 'batch_get_nodes'), 'batch_get_nodes tool registered');

    const searchTool = tools.find(t => t.name === 'search');
    assert(searchTool?.description?.includes('preview'),          'search description mentions "preview"');
    assert(searchTool?.description?.includes('batch_get_nodes'),  'search description references batch_get_nodes');

    const batchTool = tools.find(t => t.name === 'batch_get_nodes');
    assert(batchTool?.description?.includes('search'),            'batch_get_nodes description references search');

    const mSearch = await mcpToolCall('search', { query: 'authentication security', snippetLength: 150 });
    assert(Array.isArray(mSearch.data),                           'MCP search returns array');
    assert((mSearch.data?.length || 0) > 0,                      `MCP search found ${mSearch.data?.length || 0} results`);
    assert(mSearch.data?.[0]?.bodySnippet !== undefined,          'MCP search result has bodySnippet');
    assert(mSearch.data?.[0]?.fields !== undefined,               'MCP search result has fields');
    assert(mSearch.data?.[0]?.content === undefined,              'MCP search result has no full content');

    const mToFetch = (mSearch.data || []).slice(0, 2).map(r => ({ type: r.type, id: r.id }));
    if (mToFetch.length > 0) {
        const mBatch = await mcpToolCall('batch_get_nodes', { nodes: mToFetch });
        assert(typeof mBatch.data === 'object',                   'MCP batch_get_nodes returns object');
        assertEq(mBatch.data?.count, mToFetch.length,            `MCP batch fetched ${mToFetch.length} nodes`);
        assert(typeof mBatch.data?.nodes?.[0]?.content === 'string', 'MCP batch result has full content');
    }

    console.log('');

} finally {
    if (server) {
        await new Promise(r => server.close(r));
        resetMcpServer(); resetEntityIndex(); resetFoundationRoot(); invalidateEntityTypeCache();
    }
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });

    console.log('══════════════════════════════════════════════════════');
    console.log('  Test Summary');
    console.log('══════════════════════════════════════════════════════');
    console.log(`  Temp dir  : ${tempDir}  (removed ✓)`);
    console.log(`  Total     : ${passed + failed}`);
    console.log(`  Passed    : ${passed}`);
    console.log(`  Failed    : ${failed}`);
    if (failures.length > 0) {
        console.log('\n  Failures:');
        for (const f of failures) console.log(`    ✗ ${f}`);
    }
    console.log('══════════════════════════════════════════════════════\n');

    process.exit(failed > 0 ? 1 : 0);
}
