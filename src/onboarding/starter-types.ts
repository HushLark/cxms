// ─────────────────────────────────────────────────────────────────────────────
// CxMS Onboarding — Role-based starter context types
// ─────────────────────────────────────────────────────────────────────────────

import type { EntityTypeConfig } from '../schema/entity-type-config.js';
import type { UserRole } from './types.js';

// ── Universal types (everyone gets these) ────────────────────────────────────

const TYPE_TASK: EntityTypeConfig = {
    name: 'task',
    plural: 'tasks',
    directory: 'context-types/task',
    description: 'An action item or to-do with status and optional due date',
    fields: [
        { key: 'status',   type: 'enum', values: ['open', 'in_progress', 'done', 'cancelled'], required: true, default: 'open' },
        { key: 'priority', type: 'enum', values: ['low', 'medium', 'high', 'critical'], default: 'medium' },
        { key: 'due',      type: 'date',   label: 'Due date' },
        { key: 'project',  type: 'string', label: 'Project or area' },
    ],
    completionField: 'status',
    completionValue: 'done',
    calendarDateField: 'due',
    defaultTags: [],
};

const TYPE_NOTE: EntityTypeConfig = {
    name: 'note',
    plural: 'notes',
    directory: 'context-types/note',
    description: 'A freeform observation, idea, reference, or memory',
    fields: [
        { key: 'category', type: 'string', label: 'Category' },
    ],
    defaultTags: [],
};

const TYPE_EVENT: EntityTypeConfig = {
    name: 'event',
    plural: 'events',
    directory: 'context-types/event',
    description: 'A calendar event, appointment, or scheduled activity',
    fields: [
        { key: 'starts_at',    type: 'datetime', label: 'Start time', required: true },
        { key: 'duration',     type: 'duration',  label: 'Duration (ISO 8601)' },
        { key: 'location',     type: 'string',    label: 'Location' },
        { key: 'participants', type: 'array',      label: 'Attendees' },
    ],
    calendarDateField: 'starts_at',
    defaultTags: [],
};

// ── Role-specific supplemental types ─────────────────────────────────────────

const TYPE_PERSON: EntityTypeConfig = {
    name: 'person',
    plural: 'people',
    directory: 'context-types/person',
    description: 'A contact or person of interest — colleague, family member, vendor, etc.',
    fields: [
        { key: 'relationship', type: 'enum', values: ['family', 'friend', 'colleague', 'manager', 'report', 'vendor', 'advisor', 'other'], required: true },
        { key: 'email',        type: 'string',     label: 'Email' },
        { key: 'phone',        type: 'string',     label: 'Phone' },
        { key: 'company',      type: 'reference',  label: 'Company', targetType: 'company' },
        { key: 'birthday',     type: 'date-fixed', label: 'Birthday' },
        { key: 'last_contact', type: 'date',       label: 'Last contact date' },
    ],
    defaultTags: [],
};

const TYPE_COMPANY: EntityTypeConfig = {
    name: 'company',
    plural: 'companies',
    directory: 'context-types/company',
    description: 'A company, organization, or institution',
    fields: [
        { key: 'website',         type: 'string',    label: 'Website' },
        { key: 'industry',        type: 'string',    label: 'Industry' },
        { key: 'size',            type: 'enum',      label: 'Size',
          values: ['micro', 'small', 'medium', 'large', 'enterprise'] },
        { key: 'phone',           type: 'string',    label: 'Phone' },
        { key: 'email',           type: 'string',    label: 'Email' },
        { key: 'location',        type: 'string',    label: 'Location' },
        { key: 'primary_contact', type: 'reference', label: 'Primary Contact', targetType: 'person' },
    ],
    defaultTags: [],
};

const TYPE_GOAL: EntityTypeConfig = {
    name: 'goal',
    plural: 'goals',
    directory: 'context-types/goal',
    description: 'A medium or long-horizon objective with measurable success criteria',
    fields: [
        { key: 'status',       type: 'enum',   values: ['draft', 'active', 'achieved', 'abandoned'], required: true, default: 'active' },
        { key: 'horizon',      type: 'enum',   values: ['weekly', 'monthly', 'quarterly', 'annual'] },
        { key: 'target_date',  type: 'date',   label: 'Target date' },
        { key: 'metric',       type: 'string', label: 'How success is measured' },
    ],
    completionField: 'status',
    completionValue: 'achieved',
    calendarDateField: 'target_date',
    defaultTags: [],
};

// Parent-specific
const TYPE_ACTIVITY: EntityTypeConfig = {
    name: 'activity',
    plural: 'activities',
    directory: 'context-types/activity',
    description: "A child's recurring activity — sport, class, club, or lesson",
    fields: [
        { key: 'child',      type: 'string', label: 'Child name',    required: true },
        { key: 'category',   type: 'enum',   values: ['sport', 'music', 'academic', 'arts', 'social', 'other'], required: true },
        { key: 'day',        type: 'string', label: 'Day(s) of week' },
        { key: 'time',       type: 'string', label: 'Time' },
        { key: 'location',   type: 'string', label: 'Location' },
        { key: 'coach',      type: 'string', label: 'Coach or instructor' },
        { key: 'season_end', type: 'date',   label: 'Season end date' },
    ],
    calendarDateField: 'season_end',
    defaultTags: [],
};

// Educator/coach-specific
const TYPE_PLAYER: EntityTypeConfig = {
    name: 'player',
    plural: 'players',
    directory: 'context-types/player',
    description: 'A student, athlete, or team member with performance tracking',
    fields: [
        { key: 'grade_or_year', type: 'string', label: 'Grade or year' },
        { key: 'position',      type: 'string', label: 'Position or role' },
        { key: 'status',        type: 'enum',   values: ['active', 'injured', 'inactive'], default: 'active' },
        { key: 'parent_email',  type: 'string', label: 'Parent/guardian email' },
        { key: 'notes',         type: 'string', label: 'Development notes' },
    ],
    defaultTags: [],
};

const TYPE_PRACTICE: EntityTypeConfig = {
    name: 'practice',
    plural: 'practices',
    directory: 'context-types/practice',
    description: 'A practice session plan with drills, focus areas, and notes',
    fields: [
        { key: 'date',        type: 'date',   label: 'Practice date', required: true },
        { key: 'duration',    type: 'string', label: 'Duration (e.g. 90 min)' },
        { key: 'location',    type: 'string', label: 'Field or gym' },
        { key: 'focus',       type: 'string', label: 'Main focus area' },
        { key: 'attendance',  type: 'number', label: 'Players present' },
    ],
    calendarDateField: 'date',
    defaultTags: [],
};

// Professional-specific
const TYPE_PROJECT: EntityTypeConfig = {
    name: 'project',
    plural: 'projects',
    directory: 'context-types/project',
    description: 'A work project or initiative with status, owner, and timeline',
    fields: [
        { key: 'status',     type: 'enum',   values: ['planning', 'active', 'on_hold', 'complete', 'cancelled'], required: true, default: 'active' },
        { key: 'owner',      type: 'string', label: 'Project owner' },
        { key: 'team',       type: 'array',  label: 'Team members' },
        { key: 'start_date', type: 'date',   label: 'Start date' },
        { key: 'target_date',type: 'date',   label: 'Target completion' },
        { key: 'priority',   type: 'enum',   values: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    ],
    completionField: 'status',
    completionValue: 'complete',
    calendarDateField: 'target_date',
    defaultTags: [],
};

const TYPE_DECISION: EntityTypeConfig = {
    name: 'decision',
    plural: 'decisions',
    directory: 'context-types/decision',
    description: 'An architectural or strategic decision with context and rationale (ADR-style)',
    fields: [
        { key: 'status',     type: 'enum', values: ['proposed', 'accepted', 'deprecated', 'superseded'], default: 'proposed' },
        { key: 'date',       type: 'date', label: 'Decision date' },
        { key: 'driver',     type: 'string', label: 'Who decided' },
    ],
    defaultTags: [],
};

// ── Role → type set ───────────────────────────────────────────────────────────

export function getStarterTypes(role: UserRole): EntityTypeConfig[] {
    const universal = [TYPE_TASK, TYPE_NOTE, TYPE_EVENT, TYPE_PERSON, TYPE_COMPANY];

    switch (role) {
        case 'parent':
            return [...universal, TYPE_ACTIVITY, TYPE_GOAL];

        case 'educator':
            return [...universal, TYPE_PLAYER, TYPE_PRACTICE, TYPE_GOAL];

        case 'professional':
            return [...universal, TYPE_PROJECT, TYPE_DECISION, TYPE_GOAL];

        case 'entrepreneur':
            return [...universal, TYPE_PROJECT, TYPE_GOAL];

        case 'student':
            return [...universal, TYPE_GOAL];

        default:
            return [...universal, TYPE_GOAL];
    }
}
