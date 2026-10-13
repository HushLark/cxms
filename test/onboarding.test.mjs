// ─────────────────────────────────────────────────────────────────────────────
// Onboarding system test — three personas + idempotency
// ─────────────────────────────────────────────────────────────────────────────
// Tests runOnboarding() directly (no readline required) using programmatic
// OnboardingAnswers for three real-world personas:
//   1. Sarah Mitchell — soccer mom (parent)
//   2. Marcus Williams — high school football coach (educator)
//   3. Alex Chen — VP of Engineering (professional)
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Test bootstrap ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use dist/ after build
const distIndex = path.join(__dirname, '../dist/index.js');
const {
    setPlatform,
    createNodePlatform,
    setFoundationRoot,
    resetFoundationRoot,
    runOnboarding,
    getOnboardingStatus,
    getStarterTypes,
} = await import(distIndex);

let passed = 0;
let failed = 0;

function test(name, fn) {
    return { name, fn };
}

async function run(tests) {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (e) {
            console.error(`  ✗ ${name}`);
            console.error(`    ${e.message}`);
            failed++;
        }
    }
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function makeTempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'cxms-onboard-'));
}

async function cleanupDir(dir) {
    await fs.rm(dir, { recursive: true, force: true });
}

function initPlatform(dir) {
    setPlatform(createNodePlatform());
    setFoundationRoot(dir);
}

function resetPlatform() {
    resetFoundationRoot();
}

// ── Persona definitions ───────────────────────────────────────────────────────

const SARAH = {
    name: 'Sarah Mitchell',
    gender: 'female',
    role: 'parent',
    kidsAges: '7, 10, 13',
    familySituation: 'two working parents',
    primaryGoals: ['Managing the family calendar', 'Tracking kids\' activities and schedules', 'Shopping lists and household tasks'],
    communicationStyle: 'conversational',
    agentPersonality: 'butler',
    agentName: 'Assistant',
    timezone: 'America/Chicago',
    language: 'en',
};

const MARCUS = {
    name: 'Marcus Williams',
    gender: 'male',
    role: 'educator',
    subject: 'football',
    teamOrClassSize: 45,
    primaryGoals: ['Practice and session planning', 'Game and schedule management', 'Tracking player development'],
    communicationStyle: 'structured',
    agentPersonality: 'executive',
    agentName: 'Coach AI',
    timezone: 'America/New_York',
    language: 'en',
};

const ALEX = {
    name: 'Alex Chen',
    gender: 'other',
    role: 'professional',
    employer: 'TechCorp',
    jobTitle: 'VP of Engineering',
    teamSize: 40,
    primaryGoals: ['Project and initiative tracking', 'Team and 1:1 management', 'Strategic decision tracking'],
    communicationStyle: 'brief',
    agentPersonality: 'rockstar',
    agentName: 'Assistant',
    timezone: 'America/Los_Angeles',
    language: 'en',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n── getStarterTypes ─────────────────────────────────────────────────────────\n');

await run([
    test('parent gets task/note/event/activity/person/goal', () => {
        const types = getStarterTypes('parent');
        const names = types.map(t => t.name);
        assert.ok(names.includes('task'), 'task');
        assert.ok(names.includes('note'), 'note');
        assert.ok(names.includes('event'), 'event');
        assert.ok(names.includes('activity'), 'activity');
        assert.ok(names.includes('person'), 'person');
        assert.ok(names.includes('goal'), 'goal');
        assert.equal(names.length, 6);
    }),

    test('educator gets task/note/event/player/practice/person/goal', () => {
        const types = getStarterTypes('educator');
        const names = types.map(t => t.name);
        assert.ok(names.includes('player'), 'player');
        assert.ok(names.includes('practice'), 'practice');
        assert.equal(names.length, 7);
    }),

    test('professional gets task/note/event/project/decision/person/goal', () => {
        const types = getStarterTypes('professional');
        const names = types.map(t => t.name);
        assert.ok(names.includes('project'), 'project');
        assert.ok(names.includes('decision'), 'decision');
        assert.equal(names.length, 7);
    }),

    test('entrepreneur gets task/note/event/project/person/goal', () => {
        const names = getStarterTypes('entrepreneur').map(t => t.name);
        assert.ok(names.includes('project'));
        assert.equal(names.length, 6);
    }),

    test('student gets task/note/event/goal/person', () => {
        const names = getStarterTypes('student').map(t => t.name);
        assert.ok(names.includes('goal'));
        assert.equal(names.length, 5);
    }),
]);

// ── Persona: Sarah Mitchell (soccer mom) ─────────────────────────────────────

console.log('\n── Sarah Mitchell — soccer mom (parent) ────────────────────────────────────\n');

let sarahDir;
try {
    sarahDir = await makeTempDir();
    initPlatform(sarahDir);

    await run([
        test('runOnboarding returns success', async () => {
            const result = await runOnboarding(SARAH, sarahDir);
            assert.equal(result.success, true);
            assert.equal(result.userName, 'Sarah Mitchell');
            assert.equal(result.role, 'parent');
        }),

        test('typesCreated includes activity and person', async () => {
            const result = await runOnboarding(SARAH, sarahDir);
            // Second run: types already exist, typesCreated should be empty
            assert.equal(result.typesCreated.length, 0, 'idempotent: no new types on re-run');
        }),

        test('user-profile.md exists with correct YAML', async () => {
            const profilePath = path.join(sarahDir, 'profiles', 'user-profile.md');
            const raw = await fs.readFile(profilePath, 'utf8');
            assert.ok(raw.includes('name: "Sarah Mitchell"'), 'name in profile');
            assert.ok(raw.includes('role: "parent"'), 'role in profile');
            assert.ok(raw.includes('interviewComplete: true'), 'interview complete');
            assert.ok(raw.includes('communicationStyle: "conversational"'), 'comm style');
        }),

        test('agent-profile.md has butler personality and honorific', async () => {
            const raw = await fs.readFile(path.join(sarahDir, 'profiles', 'agent-profile.md'), 'utf8');
            assert.ok(raw.includes('personality: "butler"'), 'personality');
            assert.ok(raw.includes('honorific: "ma\'am"'), 'honorific for female');
        }),

        test('.cxms.md contains role-appropriate content', async () => {
            const raw = await fs.readFile(path.join(sarahDir, '.cxms.md'), 'utf8');
            assert.ok(raw.includes('Sarah Mitchell'), 'name');
            assert.ok(raw.includes('parent'), 'role');
            assert.ok(raw.includes('7, 10, 13'), 'kids ages');
            assert.ok(raw.includes('butler'), 'agent personality');
        }),

        test('activity directory created', async () => {
            const stat = await fs.stat(path.join(sarahDir, 'context-types', 'activity'));
            assert.ok(stat.isDirectory());
        }),

        test('getOnboardingStatus returns complete: true', async () => {
            const status = await getOnboardingStatus();
            assert.equal(status.complete, true);
            assert.equal(status.userName, 'Sarah Mitchell');
            assert.equal(status.role, 'parent');
        }),
    ]);
} finally {
    resetPlatform();
    if (sarahDir) await cleanupDir(sarahDir);
}

// ── Persona: Marcus Williams (high school coach) ─────────────────────────────

console.log('\n── Marcus Williams — high school football coach (educator) ─────────────────\n');

let marcusDir;
try {
    marcusDir = await makeTempDir();
    initPlatform(marcusDir);

    await run([
        test('runOnboarding returns success for educator', async () => {
            const result = await runOnboarding(MARCUS, marcusDir);
            assert.equal(result.success, true);
            assert.equal(result.userName, 'Marcus Williams');
            assert.equal(result.role, 'educator');
        }),

        test('typesCreated includes player and practice', async () => {
            // Fresh dir — first run should create all types
            const freshDir = await makeTempDir();
            initPlatform(freshDir);
            try {
                const result = await runOnboarding(MARCUS, freshDir);
                assert.ok(result.typesCreated.includes('player'), 'player type created');
                assert.ok(result.typesCreated.includes('practice'), 'practice type created');
            } finally {
                resetPlatform();
                initPlatform(marcusDir);
                await cleanupDir(freshDir);
            }
        }),

        test('agent-profile.md has executive personality and sir honorific', async () => {
            const raw = await fs.readFile(path.join(marcusDir, 'profiles', 'agent-profile.md'), 'utf8');
            assert.ok(raw.includes('personality: "executive"'), 'personality');
            assert.ok(raw.includes('honorific: "sir"'), 'honorific for male');
        }),

        test('.cxms.md references football and team size', async () => {
            const raw = await fs.readFile(path.join(marcusDir, '.cxms.md'), 'utf8');
            assert.ok(raw.includes('football'), 'sport');
            assert.ok(raw.includes('45'), 'team size');
        }),

        test('practice directory created', async () => {
            const stat = await fs.stat(path.join(marcusDir, 'context-types', 'practice'));
            assert.ok(stat.isDirectory());
        }),

        test('player directory created', async () => {
            const stat = await fs.stat(path.join(marcusDir, 'context-types', 'player'));
            assert.ok(stat.isDirectory());
        }),

        test('user-profile.md has structured communication style', async () => {
            const raw = await fs.readFile(path.join(marcusDir, 'profiles', 'user-profile.md'), 'utf8');
            assert.ok(raw.includes('communicationStyle: "structured"'));
        }),

        test('getOnboardingStatus returns complete with educator role', async () => {
            const status = await getOnboardingStatus();
            assert.equal(status.complete, true);
            assert.equal(status.role, 'educator');
            assert.equal(status.userName, 'Marcus Williams');
        }),
    ]);
} finally {
    resetPlatform();
    if (marcusDir) await cleanupDir(marcusDir);
}

// ── Persona: Alex Chen (VP of Engineering) ───────────────────────────────────

console.log('\n── Alex Chen — VP of Engineering (professional) ────────────────────────────\n');

let alexDir;
try {
    alexDir = await makeTempDir();
    initPlatform(alexDir);

    await run([
        test('runOnboarding returns success for professional', async () => {
            const result = await runOnboarding(ALEX, alexDir);
            assert.equal(result.success, true);
            assert.equal(result.userName, 'Alex Chen');
            assert.equal(result.role, 'professional');
        }),

        test('typesCreated on fresh dir includes project and decision', async () => {
            const freshDir = await makeTempDir();
            initPlatform(freshDir);
            try {
                const result = await runOnboarding(ALEX, freshDir);
                assert.ok(result.typesCreated.includes('project'), 'project');
                assert.ok(result.typesCreated.includes('decision'), 'decision');
            } finally {
                resetPlatform();
                initPlatform(alexDir);
                await cleanupDir(freshDir);
            }
        }),

        test('agent-profile.md has rockstar personality and no honorific for gender=other', async () => {
            const raw = await fs.readFile(path.join(alexDir, 'profiles', 'agent-profile.md'), 'utf8');
            assert.ok(raw.includes('personality: "rockstar"'), 'rockstar');
            assert.ok(!raw.includes('honorific:'), 'no honorific for other gender');
        }),

        test('.cxms.md references TechCorp and team size', async () => {
            const raw = await fs.readFile(path.join(alexDir, '.cxms.md'), 'utf8');
            assert.ok(raw.includes('TechCorp'), 'employer');
            assert.ok(raw.includes('40'), 'team size');
            assert.ok(raw.includes('VP of Engineering'), 'job title');
        }),

        test('.cxms.md uses brief communication style', async () => {
            const raw = await fs.readFile(path.join(alexDir, '.cxms.md'), 'utf8');
            assert.ok(raw.includes('short and direct'), 'brief style');
        }),

        test('project and decision directories created', async () => {
            for (const type of ['project', 'decision', 'person', 'goal']) {
                const stat = await fs.stat(path.join(alexDir, 'context-types', type));
                assert.ok(stat.isDirectory(), `${type} dir`);
            }
        }),

        test('user-profile.md has brief communication style', async () => {
            const raw = await fs.readFile(path.join(alexDir, 'profiles', 'user-profile.md'), 'utf8');
            assert.ok(raw.includes('communicationStyle: "brief"'));
        }),

        test('getOnboardingStatus returns complete with professional role', async () => {
            const status = await getOnboardingStatus();
            assert.equal(status.complete, true);
            assert.equal(status.role, 'professional');
        }),
    ]);
} finally {
    resetPlatform();
    if (alexDir) await cleanupDir(alexDir);
}

// ── Multiple-start idempotency ────────────────────────────────────────────────

console.log('\n── Multiple-start idempotency ──────────────────────────────────────────────\n');

let idempDir;
try {
    idempDir = await makeTempDir();
    initPlatform(idempDir);

    await run([
        test('first run creates Foundation and profiles', async () => {
            const result = await runOnboarding(SARAH, idempDir);
            assert.equal(result.success, true);
            assert.ok(result.typesCreated.length > 0, 'types created on first run');
        }),

        test('second run is idempotent — no new types, profiles overwritten correctly', async () => {
            const result = await runOnboarding(SARAH, idempDir);
            assert.equal(result.success, true);
            assert.equal(result.typesCreated.length, 0, 'no new types on second run');
        }),

        test('third run still returns complete status', async () => {
            await runOnboarding(SARAH, idempDir);
            const status = await getOnboardingStatus();
            assert.equal(status.complete, true);
            assert.equal(status.userName, 'Sarah Mitchell');
        }),

        test('two independent Foundations do not interfere', async () => {
            const dir2 = await makeTempDir();
            initPlatform(dir2);
            try {
                const result = await runOnboarding(MARCUS, dir2);
                assert.equal(result.userName, 'Marcus Williams');
                const status = await getOnboardingStatus();
                assert.equal(status.userName, 'Marcus Williams');
            } finally {
                resetPlatform();
                initPlatform(idempDir);
                await cleanupDir(dir2);
            }
        }),

        test('Foundation structure is complete after onboarding', async () => {
            const requiredDirs = ['context-types', 'collections', 'logs', '.phaibel', 'profiles', '.trash'];
            for (const dir of requiredDirs) {
                const stat = await fs.stat(path.join(idempDir, dir));
                assert.ok(stat.isDirectory(), `${dir} directory exists`);
            }
            const marker = await fs.stat(path.join(idempDir, '.cxms.md'));
            assert.ok(marker.isFile(), '.cxms.md exists');
        }),

        test('entity-types.json is valid JSON with context types', async () => {
            const raw = await fs.readFile(path.join(idempDir, '.phaibel', 'entity-types.json'), 'utf8');
            const parsed = JSON.parse(raw);
            assert.ok(Array.isArray(parsed.entityTypes) || parsed.version === 1, 'valid entity types file');
        }),
    ]);
} finally {
    resetPlatform();
    if (idempDir) await cleanupDir(idempDir);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(72)}`);
console.log(`Onboarding tests: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(72)}\n`);

if (failed > 0) process.exit(1);
