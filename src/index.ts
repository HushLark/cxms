// ─────────────────────────────────────────────────────────────────────────────
// @gclift/cxms — Public API
// ─────────────────────────────────────────────────────────────────────────────

// ── Foundation ───────────────────────────────────────────────────────────────
export {
    setFoundationRoot,
    getFoundationRoot,
    findFoundationRoot,
    resetFoundationRoot,
    getVaultRoot,
} from './foundation.js';

// ── Paths ────────────────────────────────────────────────────────────────────
export {
    getFoundationDir,
    getVaultConfigDir,
    getContextTypesDir,
    getProfilesDir,
    getCollectionsDir,
    getFoundationLogsDir,
    getAccessLogPath,
    getErrorLogPath,
    getContextTypeMappingPath,
    getEntityTypesPath,
    getEmbeddingsPath,
} from './paths.js';

// ── Platform ─────────────────────────────────────────────────────────────────
export { getPlatform, setPlatform, resetPlatform } from './platform/index.js';
export type { PlatformProvider, StorageProvider, PathProvider, FileStat } from './platform/types.js';
export { createNodePlatform } from './platform/node.js';

// ── Types ────────────────────────────────────────────────────────────────────
export type {
    ContextType,
    ContextNodeMeta,
    ContextNode,
    ContextReference,
    PresentationDate,
    Collection,
    FieldDef,
    FieldType,
    SpawnerConfig,
} from './types.js';
export {
    toContextType,
    parseReference,
    formatReference,
    FOUNDATION_MARKER,
    LEGACY_FOUNDATION_MARKER,
    LEGACY_VAULT_MARKER,
} from './types.js';

// ── Schema ───────────────────────────────────────────────────────────────────
export type { EntityTypeConfig, FieldMapping } from './schema/entity-type-config.js';
export {
    loadEntityTypes,
    getEntityType,
    addEntityType,
    updateEntityType,
    removeEntityType,
    invalidateCache as invalidateEntityTypeCache,
} from './schema/entity-type-config.js';
export { DEFAULT_ENTITY_TYPES, BUILT_IN_TYPE_NAMES } from './schema/entity-types-defaults.js';
export {
    loadContextTypesFromStore,
    writeContextType,
    writeMappingIndex,
    writeAllContextTypes,
    removeContextTypeDir,
} from './schema/context-type-store.js';

// ── Storage ──────────────────────────────────────────────────────────────────
export type { EntityTypeName, EntityLink, EntityMeta, TaskStatus, TaskPriority } from './storage/entity.js';
export {
    generateNodeId,
    generateEntityId,
    slugify,
    nodeFilename,
    entityFilename,
    createEntityMeta,
    getEntityDir,
    ensureEntityDir,
    parseEntity,
    writeEntity,
    trashEntity,
    findEntityByTitle,
    searchEntities,
    listEntities,
} from './storage/entity.js';
export { validateEntity, formatValidationErrors } from './storage/entity-validator.js';
export type { ValidationError } from './storage/entity-validator.js';
export { assertWithinFoundation } from './storage/boundary-guard.js';
export {
    listCollections,
    loadCollection,
    getCollectionItem,
    countCollectionItems,
    saveCollection,
    setCollectionItem,
    removeCollectionItem,
    deleteCollection,
} from './storage/collections.js';

// ── Index ────────────────────────────────────────────────────────────────────
export type { IndexNode, IndexEdge, IndexStats, EntityIndex } from './index/entity-index.js';
export { getEntityIndex, resetEntityIndex } from './index/entity-index.js';
export { getEmbeddingIndex, setEmbeddingProvider } from './index/embedding-index.js';
export { BM25Index, tokenize, type BM25SearchResult } from './index/bm25.js';
export { stem } from './index/stemmer.js';

// ── Context ──────────────────────────────────────────────────────────────────
export type {
    ContextScope,
    ContextTree,
    ContextTreeTrunk,
    ContextTreeBranch,
    ContextTreeLeaf,
    ContextTreeEdge,
    ContextTreeField,
} from './context/context-tree.js';
export { buildContextTree, expandContextTree } from './context/context-tree.js';
export { serializeContextTree, estimateTokens } from './context/context-tree-serializer.js';
export { classifyScope } from './context/scope-classifier.js';
export type { MomentContext } from './context/moment.js';
export { buildMomentContext, formatMomentBlock, momentToGlobals } from './context/moment.js';
export type { RelevanceResult, RelevantType } from './context/query-relevance.js';
export { extractKeywords, analyzeQueryRelevance, filterCatalogNodes } from './context/query-relevance.js';
export { extractPeopleMentions, extractEntityRefs, resolveReferences } from './context/mentions.js';
export {
    buildContextChain,
    getContextString,
    getVaultContext,
    getSubdirectoryContext,
    getEnrichedContext,
} from './context/reader.js';

// ── Server ───────────────────────────────────────────────────────────────────
export { handleCxRoute } from './server/cx-router.js';
export type { ProblemDetail } from './server/problem-details.js';
export {
    problemResponse,
    badRequest,
    notFound,
    methodNotAllowed,
    conflict,
    unprocessable,
    serverError,
    jsonResponse,
    readBody,
    parseJsonBody,
} from './server/problem-details.js';
export { authenticateRequest, setAuthEnabled, isAuthEnabled, resetCachedToken } from './server/auth.js';
export { handleMcpRoute, resetMcpServer } from './server/mcp-server.js';
export type { CxmsConfig } from './server/system-config.js';
export {
    getSystemDir,
    ensureSystemDir,
    loadSystemConfig,
    saveSystemConfig,
    loadBearerToken,
    regenerateToken,
    initFromSystemConfig,
    setInstanceIdentity,
    getInstanceIdentity,
    resetInstanceIdentity,
} from './server/system-config.js';

// ── Log ──────────────────────────────────────────────────────────────────────
export { logAccess } from './log/access-log.js';
export { logError } from './log/error-log.js';

// ── Migration ────────────────────────────────────────────────────────────────
export type { ProfileMigrationCallback } from './migration/auto-migrate.js';
export { autoMigrateV4ToV5, setProfileMigrator } from './migration/auto-migrate.js';

// ── Onboarding ───────────────────────────────────────────────────────────────
export type {
    UserRole,
    CommunicationStyle,
    AgentPersonality,
    OnboardingAnswers,
    UserProfileDoc,
    AgentProfileDoc,
    OnboardingStatus,
    OnboardingResult,
} from './onboarding/index.js';
export {
    getStarterTypes,
    createFoundationIfNeeded,
    runOnboarding,
    getOnboardingStatus,
    runInteractiveInterview,
} from './onboarding/index.js';

// ── Debug ────────────────────────────────────────────────────────────────────
export { debug } from './debug.js';
