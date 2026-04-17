// ─────────────────────────────────────────────────────────────────────────────
// ENTITY VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

import type { FieldDef, EntityTypeConfig } from '../schema/entity-type-config.js';

export interface ValidationError {
    field: string;
    message: string;
    value?: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/;
const DURATION_RE = /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;

function validateField(fieldDef: FieldDef, value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value === 'null') return null;

    switch (fieldDef.type) {
        case 'string':
            if (typeof value !== 'string') return `must be a string, got ${typeof value}`;
            break;
        case 'number':
            if (typeof value !== 'number' || isNaN(value)) return `must be a number, got ${typeof value}`;
            break;
        case 'boolean':
            if (typeof value !== 'boolean') return `must be a boolean, got ${typeof value}`;
            break;
        case 'date':
            if (typeof value !== 'string') return `must be a date string (YYYY-MM-DD), got ${typeof value}`;
            if (!DATE_RE.test(value)) return `must be YYYY-MM-DD format, got "${value}"`;
            if (isNaN(new Date(value + 'T00:00:00').getTime())) return `invalid date: "${value}"`;
            break;
        case 'datetime':
            if (typeof value !== 'string') return `must be a datetime string, got ${typeof value}`;
            if (!DATETIME_RE.test(value)) return `must be ISO datetime format (YYYY-MM-DDTHH:MM...), got "${value}"`;
            if (isNaN(new Date(value).getTime())) return `invalid datetime: "${value}"`;
            break;
        case 'duration':
            if (typeof value !== 'string') return `must be a duration string, got ${typeof value}`;
            if (!DURATION_RE.test(value) || value === 'P' || value === 'PT')
                return `must be ISO 8601 duration (e.g. PT2H30M, P1D), got "${value}"`;
            break;
        case 'enum':
            if (typeof value !== 'string') return `must be a string, got ${typeof value}`;
            if (fieldDef.values && fieldDef.values.length > 0) {
                if (!fieldDef.values.includes(value)) {
                    return `must be one of [${fieldDef.values.join(', ')}], got "${value}"`;
                }
            }
            break;
        case 'array':
            if (!Array.isArray(value)) return `must be an array, got ${typeof value}`;
            break;
        case 'object':
            if (typeof value !== 'object' || Array.isArray(value)) return `must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`;
            break;
    }

    return null;
}

export function validateEntity(
    meta: Record<string, unknown>,
    typeConfig: EntityTypeConfig,
    isCreate: boolean,
    onlyFields?: Set<string>,
): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const fieldDef of typeConfig.fields) {
        if (onlyFields && !onlyFields.has(fieldDef.key)) continue;
        const value = meta[fieldDef.key];

        if (isCreate && fieldDef.required && (value === null || value === undefined) && fieldDef.default === undefined) {
            errors.push({ field: fieldDef.key, message: `is required` });
            continue;
        }

        if (value === null || value === undefined) continue;

        const typeError = validateField(fieldDef, value);
        if (typeError) {
            errors.push({ field: fieldDef.key, message: typeError, value });
        }
    }

    return errors;
}

export function formatValidationErrors(errors: ValidationError[]): string {
    return errors.map(e => `${e.field}: ${e.message}`).join('; ');
}
