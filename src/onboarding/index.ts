// ─────────────────────────────────────────────────────────────────────────────
// CxMS Onboarding — Public API
// ─────────────────────────────────────────────────────────────────────────────

export type {
    UserRole,
    CommunicationStyle,
    AgentPersonality,
    OnboardingAnswers,
    UserProfileDoc,
    AgentProfileDoc,
    OnboardingStatus,
    OnboardingResult,
} from './types.js';

export { getStarterTypes } from './starter-types.js';
export {
    createFoundationIfNeeded,
    runOnboarding,
    getOnboardingStatus,
} from './foundation-setup.js';
export { runInteractiveInterview } from './interview.js';
