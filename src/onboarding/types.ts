// ─────────────────────────────────────────────────────────────────────────────
// CxMS Onboarding — Types
// ─────────────────────────────────────────────────────────────────────────────

/** Primary life context — drives which starter types and questions get asked. */
export type UserRole =
    | 'parent'        // Soccer mom, family organizer
    | 'educator'      // Teacher, coach, school admin
    | 'professional'  // VP, manager, individual contributor
    | 'entrepreneur'  // Founder, freelancer, solopreneur
    | 'student'       // University, grad school
    | 'other';        // Everything else

/** Preferred communication style for the agent's responses. */
export type CommunicationStyle = 'brief' | 'conversational' | 'structured';

/** Agent personality chosen during onboarding. */
export type AgentPersonality = 'butler' | 'rockstar' | 'executive' | 'friend';

/**
 * Collected answers from the onboarding interview.
 * All fields optional — the interview collects what it can.
 */
export interface OnboardingAnswers {
    // Identity
    name: string;
    gender?: 'male' | 'female' | 'other';
    timezone?: string;
    language?: string;
    homeLocation?: string;

    // Life context
    role: UserRole;
    employer?: string;

    // Role: parent
    familySize?: number;
    kidsAges?: string;          // e.g. "7, 10, 13"
    familySituation?: string;   // e.g. "single parent", "two parents working"

    // Role: educator/coach
    subject?: string;           // sport or subject taught
    teamOrClassSize?: number;

    // Role: professional
    jobTitle?: string;
    teamSize?: number;
    primaryFocus?: string;      // e.g. "delivery", "people", "strategy"

    // Goals & preferences
    primaryGoals: string[];     // e.g. ["manage family calendar", "track projects"]
    communicationStyle: CommunicationStyle;

    // Agent setup
    agentName?: string;         // what to call the AI (default: "Phaibel")
    agentPersonality: AgentPersonality;

    // Metadata
    foundationName?: string;    // override Foundation display name
}

/** Written to profiles/user-profile.md */
export interface UserProfileDoc {
    name: string;
    gender?: string;
    timezone?: string;
    language?: string;
    homeLocation?: string;
    employer?: string;
    workType?: string;
    familySituation?: string;
    primaryGoals: string[];
    communicationStyle: CommunicationStyle;
    role: UserRole;
    interviewComplete: boolean;
    lastUsed: string;
}

/** Written to profiles/phaibel-profile.md */
export interface AgentProfileDoc {
    name: string;
    personality: AgentPersonality;
    honorific?: string;
    version: string;
}

/** Returned by GET /cx/onboard/status */
export interface OnboardingStatus {
    complete: boolean;
    hasFoundation: boolean;
    hasUserProfile: boolean;
    hasAgentProfile: boolean;
    userName?: string;
    agentName?: string;
    role?: UserRole;
}

/** Returned by POST /cx/onboard */
export interface OnboardingResult {
    success: boolean;
    userName: string;
    agentName: string;
    role: UserRole;
    foundationPath: string;
    typesCreated: string[];
    profilesWritten: string[];
}
