// ─────────────────────────────────────────────────────────────────────────────
// CxMS Onboarding — Interactive interview (readline, no external deps)
// ─────────────────────────────────────────────────────────────────────────────

import readline from 'readline';
import type { OnboardingAnswers, UserRole, CommunicationStyle, AgentPersonality } from './types.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const C = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    cyan:   '\x1b[36m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    blue:   '\x1b[34m',
    gray:   '\x1b[90m',
    white:  '\x1b[37m',
};

function c(color: keyof typeof C, text: string): string {
    return `${C[color]}${text}${C.reset}`;
}

function box(lines: string[]): void {
    const width = Math.max(...lines.map(l => stripAnsi(l).length)) + 4;
    const bar = '─'.repeat(width - 2);
    console.log(`${C.cyan}╭${bar}╮${C.reset}`);
    for (const line of lines) {
        const pad = width - 2 - stripAnsi(line).length;
        console.log(`${C.cyan}│${C.reset} ${line}${' '.repeat(pad)} ${C.cyan}│${C.reset}`);
    }
    console.log(`${C.cyan}╰${bar}╯${C.reset}`);
}

function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Readline helpers ──────────────────────────────────────────────────────────

function createRl(): readline.Interface {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
    return new Promise(resolve => {
        rl.question(`${C.cyan}  › ${C.reset}${question} `, answer => {
            resolve(answer.trim());
        });
    });
}

async function choose<T extends string>(
    rl: readline.Interface,
    prompt: string,
    options: { value: T; label: string; hint?: string }[],
    defaultValue?: T,
): Promise<T> {
    console.log('');
    console.log(`${C.white}  ${prompt}${C.reset}`);
    options.forEach((o, i) => {
        const num = c('cyan', `  ${i + 1}.`);
        const lbl = c('white', o.label);
        const hint = o.hint ? c('gray', `  — ${o.hint}`) : '';
        const def = defaultValue === o.value ? c('green', ' ✓') : '';
        console.log(`${num} ${lbl}${hint}${def}`);
    });
    console.log('');

    while (true) {
        const raw = await ask(rl, defaultValue ? `(${options.findIndex(o => o.value === defaultValue) + 1}) ` : '');
        if (raw === '' && defaultValue) return defaultValue;
        const n = parseInt(raw, 10);
        if (n >= 1 && n <= options.length) return options[n - 1].value;
        console.log(c('yellow', `  Enter a number between 1 and ${options.length}`));
    }
}

async function multiChoice(
    rl: readline.Interface,
    prompt: string,
    options: string[],
    min = 1,
): Promise<string[]> {
    console.log('');
    console.log(`${C.white}  ${prompt}${C.reset}`);
    console.log(c('gray', `  Enter numbers separated by commas (e.g. 1,3,4) — minimum ${min}`));
    options.forEach((o, i) => console.log(`  ${c('cyan', `${i + 1}.`)} ${c('white', o)}`));
    console.log('');

    while (true) {
        const raw = await ask(rl, '');
        if (!raw) { console.log(c('yellow', `  Please select at least ${min} option(s)`)); continue; }
        const nums = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= options.length);
        if (nums.length < min) { console.log(c('yellow', `  Select at least ${min}`)); continue; }
        return [...new Set(nums)].map(n => options[n - 1]);
    }
}

function print(text: string): void { console.log(text); }
function blank(): void { console.log(''); }

// ── Interview ─────────────────────────────────────────────────────────────────

export async function runInteractiveInterview(): Promise<OnboardingAnswers> {
    const rl = createRl();

    try {
        // Welcome
        blank();
        box([
            c('bold', 'Welcome to CxMS'),
            c('gray',  'Let\'s set up your personal assistant'),
            c('gray',  'Press Enter to skip any question'),
        ]);
        blank();

        // 1. Name
        print(c('cyan', '  Step 1 of 6 — About you'));
        const name = await ask(rl, 'What\'s your name?');
        if (!name) { print(c('yellow', '  Name is required.')); process.exit(1); }
        blank();

        // 2. Gender (for honorific)
        const gender = await choose<'male' | 'female' | 'other'>(
            rl, 'How should your assistant address you?',
            [
                { value: 'male',   label: 'Sir / He',  hint: 'sir, boss, chief' },
                { value: 'female', label: 'Ma\'am / She', hint: 'ma\'am, miss, boss' },
                { value: 'other',  label: 'Neutral',   hint: 'boss, friend, they' },
            ],
            'other',
        );

        // 3. Role
        print(c('cyan', '  Step 2 of 6 — Your life context'));
        const role = await choose<UserRole>(
            rl, 'What best describes your primary role right now?',
            [
                { value: 'parent',       label: 'Parent / Family manager', hint: 'kids, schedules, household' },
                { value: 'educator',     label: 'Coach / Teacher / Educator', hint: 'team, students, season' },
                { value: 'professional', label: 'Manager / Executive / Professional', hint: 'team, projects, strategy' },
                { value: 'entrepreneur', label: 'Entrepreneur / Freelancer', hint: 'business, clients, projects' },
                { value: 'student',      label: 'Student', hint: 'coursework, deadlines, goals' },
                { value: 'other',        label: 'Other', hint: 'custom setup' },
            ],
        );

        // 4. Role-specific questions
        print(c('cyan', `  Step 3 of 6 — Your ${role === 'parent' ? 'family' : role === 'educator' ? 'team' : 'work'}`));

        let employer: string | undefined;
        let jobTitle: string | undefined;
        let teamSize: number | undefined;
        let primaryFocus: string | undefined;
        let familySituation: string | undefined;
        let kidsAges: string | undefined;
        let subject: string | undefined;
        let teamOrClassSize: number | undefined;

        if (role === 'parent') {
            const kids = await ask(rl, 'Kids\' ages? (e.g. 7, 10, 13 — or skip)');
            if (kids) kidsAges = kids;
            const sit = await ask(rl, 'Family situation? (e.g. "two working parents", "single parent" — or skip)');
            if (sit) familySituation = sit;
        }

        if (role === 'educator') {
            const sp = await ask(rl, 'What sport or subject? (e.g. football, math — or skip)');
            if (sp) subject = sp;
            const ts = await ask(rl, 'Team or class size? (number — or skip)');
            if (ts) teamOrClassSize = parseInt(ts, 10) || undefined;
        }

        if (role === 'professional' || role === 'entrepreneur') {
            employer = await ask(rl, 'Company or organisation name? (or skip)') || undefined;
            jobTitle = await ask(rl, 'Your title or role? (e.g. VP of Engineering — or skip)') || undefined;
            const ts = await ask(rl, 'Team size? (number — or skip)');
            if (ts) teamSize = parseInt(ts, 10) || undefined;
        }

        // 5. Goals
        print(c('cyan', '  Step 4 of 6 — What you want help with'));
        const goalOptions: Record<UserRole, string[]> = {
            parent: [
                'Managing the family calendar',
                'Tracking kids\' activities and schedules',
                'Shopping lists and household tasks',
                'Staying on top of school communications',
                'Personal goals and self-care',
                'Finances and budgeting',
                'Coordinating with my partner',
            ],
            educator: [
                'Practice and session planning',
                'Game and schedule management',
                'Tracking player development',
                'Communicating with parents',
                'Meeting and appointment scheduling',
                'Personal goals and development',
                'Admin and paperwork',
            ],
            professional: [
                'Project and initiative tracking',
                'Team and 1:1 management',
                'Meeting and calendar management',
                'Strategic decision tracking',
                'Hiring pipeline',
                'Personal productivity and goals',
                'Stakeholder communication',
            ],
            entrepreneur: [
                'Project and client tracking',
                'Business goals and OKRs',
                'Meeting scheduling',
                'Financial tracking',
                'Marketing and outreach',
                'Personal productivity',
                'Partner and investor relations',
            ],
            student: [
                'Assignment deadlines and coursework',
                'Study planning',
                'Personal goals',
                'Networking and connections',
                'Internship and job applications',
                'Side projects',
            ],
            other: [
                'Task management',
                'Calendar and scheduling',
                'Note-taking and research',
                'Personal goals',
                'Contacts and relationships',
                'Project tracking',
            ],
        };

        const primaryGoals = await multiChoice(
            rl,
            'What do you most want help with? (pick at least 2)',
            goalOptions[role] || goalOptions.other,
            2,
        );

        // 6. Communication style
        print(c('cyan', '  Step 5 of 6 — Communication style'));
        const communicationStyle = await choose<CommunicationStyle>(
            rl, 'How should your assistant communicate?',
            [
                { value: 'brief',          label: 'Brief and direct', hint: 'short answers, bullet points, no fluff' },
                { value: 'conversational', label: 'Conversational',   hint: 'friendly, natural, a bit of personality' },
                { value: 'structured',     label: 'Structured',       hint: 'headers, sections, always well-organised' },
            ],
            'conversational',
        );

        // 7. Agent personality & name
        print(c('cyan', '  Step 6 of 6 — Your assistant'));
        const agentPersonality = await choose<AgentPersonality>(
            rl, 'What personality would you like for your assistant?',
            [
                { value: 'butler',     label: 'Butler',     hint: 'formal, proper, "Very good, sir."' },
                { value: 'friend',     label: 'Friend',     hint: 'warm, casual, encouraging' },
                { value: 'executive',  label: 'Executive',  hint: 'sharp, professional, results-focused' },
                { value: 'rockstar',   label: 'Rockstar',   hint: 'high-energy, fun, enthusiastic' },
                { value: 'model',      label: 'European Male Model', hint: 'effortlessly charming, smouldering, impossibly stylish' },
                { value: 'pip',        label: 'Pip',                hint: 'devoted house helper, speaks in third person, overcome with joy to assist' },
            ],
            'friend',
        );

        const agentNameInput = await ask(rl, 'What should your assistant be called? (default: Assistant)');
        const agentName = agentNameInput || 'Assistant';

        // Timezone
        blank();
        const tzInput = await ask(rl, 'Timezone? (e.g. America/Chicago, Europe/London — or skip for local)');
        const timezone = tzInput || Intl.DateTimeFormat().resolvedOptions().timeZone;

        // Done
        blank();
        print(c('green', `  ✓ Got it, ${name}. Setting up your Foundation...`));
        blank();

        return {
            name,
            gender,
            role,
            employer,
            jobTitle,
            teamSize,
            primaryFocus,
            familySituation,
            kidsAges,
            subject,
            teamOrClassSize,
            primaryGoals,
            communicationStyle,
            agentPersonality,
            agentName,
            timezone,
            language: 'en',
        };
    } finally {
        rl.close();
    }
}
