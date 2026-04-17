// ─────────────────────────────────────────────────────────────────────────────
// Context Reader — .cxms.md chain reader
// ─────────────────────────────────────────────────────────────────────────────
// Walks up the directory tree from a target path to the Foundation root,
// collecting .cxms.md context files at each level. This builds an ancestor
// chain that gives LLMs hierarchical context about where a node sits.
//
// Example chain for a task node:
//   (Root)/.cxms.md → (Root)/context-types/task/.cxms.md
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatform } from '../platform/index.js';
import { debug } from '../debug.js';
import { getFoundationRoot } from '../foundation.js';

const CXMS_FILE = '.cxms.md';
const LEGACY_FILES = ['.phaibel.md', '.vault.md'];

/**
 * Read the .cxms.md file from a directory.
 * Falls back to legacy .phaibel.md / .vault.md if .cxms.md doesn't exist.
 */
async function readContextFile(dirPath: string): Promise<string | null> {
    const { storage, paths } = getPlatform();

    // Try .cxms.md first
    try {
        return await storage.readFile(paths.join(dirPath, CXMS_FILE));
    } catch {
        // Not found — try legacy files
    }

    // Fallback to legacy markers
    for (const legacy of LEGACY_FILES) {
        try {
            return await storage.readFile(paths.join(dirPath, legacy));
        } catch {
            // Not found — continue
        }
    }

    return null;
}

/**
 * Build the ancestor context chain from a target path up to the Foundation root.
 * Returns an array of context strings, deepest first (target → root).
 */
export async function buildContextChain(targetPath: string): Promise<string[]> {
    const root = getFoundationRoot();
    const contexts: string[] = [];
    const { paths } = getPlatform();
    let currentPath = paths.resolve(targetPath);
    const rootPath = paths.resolve(root);

    while (currentPath.startsWith(rootPath)) {
        const content = await readContextFile(currentPath);
        if (content) contexts.push(content);
        const parentPath = paths.dirname(currentPath);
        if (parentPath === currentPath) break;
        currentPath = parentPath;
    }

    return contexts;
}

/**
 * Get the full context string for a target path.
 * Returns contexts joined root → target (reversed from buildContextChain).
 */
export async function getContextString(targetPath: string): Promise<string> {
    const contexts = await buildContextChain(targetPath);
    if (contexts.length === 0) return '';
    return contexts.reverse().join('\n\n---\n\n');
}

/**
 * Get the Foundation root context (.cxms.md at the root).
 */
export async function getVaultContext(): Promise<string> {
    const root = getFoundationRoot();
    return getContextString(root);
}

/**
 * Get context for a subdirectory, including root context.
 */
export async function getSubdirectoryContext(subdirectory: string): Promise<string> {
    const root = getFoundationRoot();
    const contexts: string[] = [];
    const hierarchy = [
        root,
        getPlatform().paths.join(root, subdirectory),
    ];
    for (const dirPath of hierarchy) {
        const content = await readContextFile(dirPath);
        if (content) contexts.push(content);
    }
    return contexts.join('\n\n---\n\n');
}

export async function getNotesContext(): Promise<string> { return getSubdirectoryContext('notes'); }
export async function getTodosContext(): Promise<string> { return getSubdirectoryContext('todos'); }
export async function getEventsContext(): Promise<string> { return getSubdirectoryContext('events'); }
export async function getInboxContext(): Promise<string> { return getSubdirectoryContext('inbox'); }
export async function getPeopleContext(): Promise<string> { return getSubdirectoryContext('people'); }

export async function getEnrichedContext(subdirectory: string, entityContent: string): Promise<string> {
    const { resolveReferences } = await import('./mentions.js');
    const baseContext = await getSubdirectoryContext(subdirectory);
    const refsContext = await resolveReferences(entityContent);
    return refsContext ? `${baseContext}\n\n---\n\n${refsContext}` : baseContext;
}
