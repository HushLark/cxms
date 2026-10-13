// ─────────────────────────────────────────────────────────────────────────────
// CxMS Onboarding — Foundation creation and profile writing
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from '../platform/index.js';
import { setFoundationRoot, findFoundationRoot } from '../foundation.js';
import {
    addEntityType, loadEntityTypes, invalidateCache,
} from '../schema/entity-type-config.js';
import { writeContextType } from '../schema/context-type-store.js';
import { getStarterTypes } from './starter-types.js';
import type { OnboardingAnswers, UserProfileDoc, AgentProfileDoc, OnboardingResult, OnboardingStatus } from './types.js';

const AGENT_PROFILE_FILE = 'agent-profile.md';
/** Written by older versions; still read so existing Foundations stay onboarded. */
const LEGACY_AGENT_PROFILE_FILE = 'phaibel-profile.md';

// ── Foundation creation ───────────────────────────────────────────────────────

export async function createFoundationIfNeeded(dir: string): Promise<void> {
    const { storage, paths } = getPlatform();
    const marker = paths.join(dir, '.cxms.md');

    // Already a foundation
    try { await storage.stat(marker); return; } catch { /* create it */ }

    const name = paths.basename(dir);
    const today = new Date().toISOString().split('T')[0];

    await storage.writeFile(marker, `---
title: "${name}"
created: ${today}
tags: [context, system, root]
---

# ${name}

This Foundation is managed by CxMS. It will be personalized after onboarding.
`);

    for (const d of ['context-types', 'collections', 'logs', '.phaibel', 'profiles', '.trash']) {
        await storage.mkdir(paths.join(dir, d), { recursive: true });
    }

    await storage.writeFile(
        paths.join(dir, '.phaibel', 'entity-types.json'),
        JSON.stringify({ version: 1, entityTypes: [] }, null, 2),
    );
}

// ── Profile writing ───────────────────────────────────────────────────────────

function buildUserProfileMd(p: UserProfileDoc): string {
    const meta: Record<string, unknown> = {
        name: p.name,
        role: p.role,
        interviewComplete: p.interviewComplete,
        lastUsed: p.lastUsed,
        communicationStyle: p.communicationStyle,
        primaryGoals: p.primaryGoals,
    };
    if (p.gender)           meta.gender           = p.gender;
    if (p.timezone)         meta.timezone         = p.timezone;
    if (p.language)         meta.language         = p.language;
    if (p.homeLocation)     meta.homeLocation     = p.homeLocation;
    if (p.employer)         meta.employer         = p.employer;
    if (p.workType)         meta.workType         = p.workType;
    if (p.familySituation)  meta.familySituation  = p.familySituation;

    const yaml = Object.entries(meta)
        .map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map(x => `  - ${x}`).join('\n')}` : `${k}: ${JSON.stringify(v)}`)
        .join('\n');

    return `---\n${yaml}\n---\n\n# ${p.name}\n\nUser profile for the personal assistant.\n`;
}

function buildAgentProfileMd(p: AgentProfileDoc): string {
    const yaml = [
        `name: ${JSON.stringify(p.name)}`,
        `personality: ${JSON.stringify(p.personality)}`,
        `version: ${JSON.stringify(p.version)}`,
        p.honorific ? `honorific: ${JSON.stringify(p.honorific)}` : null,
    ].filter(Boolean).join('\n');

    return `---\n${yaml}\n---\n\n# ${p.name}\n\nAgent profile.\n`;
}

function buildRootContextMd(answers: OnboardingAnswers): string {
    const today = new Date().toISOString().split('T')[0];
    const name = answers.foundationName || `${answers.name}'s Foundation`;

    const roleBlurb: Record<string, string> = {
        parent: `${answers.name} is a parent${answers.familySituation ? ` (${answers.familySituation})` : ''} managing family life${answers.kidsAges ? `, with kids aged ${answers.kidsAges}` : ''}. The focus is on family scheduling, activities, and household organisation.`,
        educator: `${answers.name} is a ${answers.subject ? answers.subject + ' ' : ''}coach/educator${answers.teamOrClassSize ? ` with a team/class of ${answers.teamOrClassSize}` : ''}. The focus is on practice planning, scheduling, and player/student development.`,
        professional: `${answers.name} is a ${answers.jobTitle || 'professional'} at ${answers.employer || 'their company'}${answers.teamSize ? `, leading a team of ${answers.teamSize}` : ''}. The focus is on project delivery, team management, and strategic priorities.`,
        entrepreneur: `${answers.name} is an entrepreneur${answers.employer ? ` at ${answers.employer}` : ''}. The focus is on projects, customers, and business priorities.`,
        student: `${answers.name} is a student. The focus is on academic goals, deadlines, and personal development.`,
        other: `${answers.name} uses this Foundation to organise their life and work.`,
    };

    const goalsText = answers.primaryGoals.length
        ? answers.primaryGoals.map(g => `- ${g}`).join('\n')
        : '- Stay organised\n- Track tasks and events';

    return `---
title: "${name}"
created: ${today}
owner: "${answers.name}"
role: "${answers.role}"
tags: [context, system, root]
---

# ${name}

${roleBlurb[answers.role] || roleBlurb.other}

## What's Here

Context types installed for ${answers.name}:
- **Tasks** — action items with status, priority, and due dates
- **Notes** — ideas, observations, and reference material
- **Events** — calendar events and appointments
${answers.role === 'parent' ? '- **Activities** — recurring activities for each child\n- **People** — contacts and family members\n- **Goals** — personal and family goals' : ''}${answers.role === 'educator' ? '- **Players** — team members with development tracking\n- **Practices** — practice session plans\n- **People** — contacts and parents\n- **Goals** — team and personal goals' : ''}${answers.role === 'professional' ? '- **Projects** — work initiatives with status and timeline\n- **Decisions** — architectural and strategic decisions\n- **People** — team members, stakeholders, and contacts\n- **Goals** — OKRs and strategic objectives' : ''}${answers.role === 'entrepreneur' ? '- **Projects** — business initiatives\n- **People** — customers, partners, and contacts\n- **Goals** — business objectives' : ''}${answers.role === 'student' ? '- **Goals** — academic and personal objectives\n- **People** — professors, mentors, and collaborators' : ''}

## Primary Goals

${goalsText}

## Agent

The assistant is named **${answers.agentName || 'Assistant'}** with a **${answers.agentPersonality}** personality.
Communication style preference: **${answers.communicationStyle}**.

## Conventions

- Dates use YYYY-MM-DD format
- Timezone: ${answers.timezone || 'local'}
- When the user mentions something actionable, create a task node
- Link related content (task → project, event → person, etc.)
- Keep responses ${answers.communicationStyle === 'brief' ? 'short and direct' : answers.communicationStyle === 'structured' ? 'well-organised with clear headings' : 'friendly and conversational'}
`;
}

// ── Main onboarding function ──────────────────────────────────────────────────

export async function runOnboarding(
    answers: OnboardingAnswers,
    foundationDir: string,
): Promise<OnboardingResult> {
    const { storage, paths } = getPlatform();

    // 1. Create Foundation structure
    await createFoundationIfNeeded(foundationDir);
    setFoundationRoot(foundationDir);
    invalidateCache();

    // 2. Write personalized .cxms.md
    await storage.writeFile(
        paths.join(foundationDir, '.cxms.md'),
        buildRootContextMd(answers),
    );

    // 3. Create role-appropriate context types
    const existingTypes = await loadEntityTypes();
    const existingNames = new Set(existingTypes.map(t => t.name));
    const starterTypes = getStarterTypes(answers.role);
    const typesCreated: string[] = [];

    for (const t of starterTypes) {
        if (existingNames.has(t.name)) continue;
        await addEntityType(t);
        await writeContextType(t);
        await storage.mkdir(paths.join(foundationDir, t.directory), { recursive: true });
        typesCreated.push(t.name);
    }

    // 4. Write user profile
    const userProfile: UserProfileDoc = {
        name: answers.name,
        role: answers.role,
        interviewComplete: true,
        lastUsed: new Date().toISOString(),
        communicationStyle: answers.communicationStyle,
        primaryGoals: answers.primaryGoals,
        gender: answers.gender,
        timezone: answers.timezone,
        language: answers.language,
        homeLocation: answers.homeLocation,
        employer: answers.employer,
        familySituation: answers.familySituation,
    };

    const profilesDir = paths.join(foundationDir, 'profiles');
    await storage.mkdir(profilesDir, { recursive: true });
    await storage.writeFile(
        paths.join(profilesDir, 'user-profile.md'),
        buildUserProfileMd(userProfile),
    );

    // 5. Write agent profile
    const agentProfile: AgentProfileDoc = {
        name: answers.agentName || 'Assistant',
        personality: answers.agentPersonality,
        version: '1.0',
        honorific: answers.gender === 'male' ? 'sir' : answers.gender === 'female' ? 'ma\'am' : undefined,
    };
    await storage.writeFile(
        paths.join(profilesDir, AGENT_PROFILE_FILE),
        buildAgentProfileMd(agentProfile),
    );

    return {
        success: true,
        userName: answers.name,
        agentName: agentProfile.name,
        role: answers.role,
        foundationPath: foundationDir,
        typesCreated,
        profilesWritten: ['user-profile.md', AGENT_PROFILE_FILE],
    };
}

// ── Status check ──────────────────────────────────────────────────────────────

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
    const { storage, paths } = getPlatform();
    const root = findFoundationRoot();

    if (!root) {
        return { complete: false, hasFoundation: false, hasUserProfile: false, hasAgentProfile: false };
    }

    const profilesDir = paths.join(root, 'profiles');

    let hasUserProfile = false;
    let hasAgentProfile = false;
    let userName: string | undefined;
    let agentName: string | undefined;
    let role: string | undefined;

    try {
        const raw = await storage.readFile(paths.join(profilesDir, 'user-profile.md'));
        const match = raw.match(/^name:\s*"?([^"\n]+)"?/m);
        const roleMatch = raw.match(/^role:\s*"?([^"\n]+)"?/m);
        const completeMatch = raw.match(/^interviewComplete:\s*true/m);
        if (match) userName = match[1];
        if (roleMatch) role = roleMatch[1];
        hasUserProfile = true;
        hasAgentProfile = !!completeMatch;
    } catch { /* no profile */ }

    for (const file of [AGENT_PROFILE_FILE, LEGACY_AGENT_PROFILE_FILE]) {
        try {
            const raw = await storage.readFile(paths.join(profilesDir, file));
            const match = raw.match(/^name:\s*"?([^"\n]+)"?/m);
            if (match) agentName = match[1];
            hasAgentProfile = true;
            break;
        } catch { /* no agent profile under this name */ }
    }

    return {
        complete: hasUserProfile && hasAgentProfile,
        hasFoundation: true,
        hasUserProfile,
        hasAgentProfile,
        userName,
        agentName,
        role: role as OnboardingStatus['role'],
    };
}
