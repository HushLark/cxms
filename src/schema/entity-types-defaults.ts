// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT ENTITY TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

import type { EntityTypeConfig } from './entity-type-config.js';

/**
 * CxMS ships with no default entity types.
 * The host application is responsible for creating
 * context types via addEntityType() or the REST/MCP API.
 */
export const DEFAULT_ENTITY_TYPES: EntityTypeConfig[] = [];

export const BUILT_IN_TYPE_NAMES = new Set<string>();
