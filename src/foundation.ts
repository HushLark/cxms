// ─────────────────────────────────────────────────────────────────────────────
// Foundation — Root directory configuration
// ─────────────────────────────────────────────────────────────────────────────
// CxMS requires an explicit foundation root. Callers must call
// setFoundationRoot() before using any CxMS functions.
//
// This replaces Phaibel's findFoundationRoot() which walks up the directory
// tree — CxMS does not walk directories; it receives the root explicitly.
// ─────────────────────────────────────────────────────────────────────────────

let _foundationRoot: string | null = null;

/**
 * Set the Foundation root path. Must be called before any CxMS operations.
 */
export function setFoundationRoot(root: string): void {
    _foundationRoot = root;
}

/**
 * Get the Foundation root path. Throws if not set.
 */
export function getFoundationRoot(): string {
    if (!_foundationRoot) {
        throw new Error('CxMS: Foundation root not set. Call setFoundationRoot() before using CxMS.');
    }
    return _foundationRoot;
}

/**
 * Get the Foundation root path, or null if not set.
 */
export function findFoundationRoot(): string | null {
    return _foundationRoot;
}

/**
 * Reset the Foundation root (for testing).
 */
export function resetFoundationRoot(): void {
    _foundationRoot = null;
}

/**
 * Alias for getFoundationRoot() — backward compatibility with Phaibel's getVaultRoot().
 */
export const getVaultRoot = getFoundationRoot;
