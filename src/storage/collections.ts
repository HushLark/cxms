// ─────────────────────────────────────────────────────────────────────────────
// CxMS — Collections
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getCollectionsDir } from '../paths.js';
import { debug } from '../debug.js';
import type { Collection } from '../types.js';

export async function listCollections(): Promise<string[]> {
    const dir = getCollectionsDir();
    try {
        const entries = await fs.readdir(dir);
        return entries
            .filter(e => e.endsWith('.md'))
            .map(e => e.replace(/\.md$/, ''))
            .sort();
    } catch {
        return [];
    }
}

export async function loadCollection(name: string): Promise<Collection | null> {
    const dir = getCollectionsDir();
    const filepath = path.join(dir, `${name}.md`);
    try {
        const raw = await fs.readFile(filepath, 'utf-8');
        const { data, content } = matter(raw);
        const items = parseCollectionBody(content);
        return {
            name,
            description: (data.description as string) || undefined,
            items,
        };
    } catch {
        return null;
    }
}

export async function getCollectionItem(collectionName: string, key: string): Promise<string | null> {
    const collection = await loadCollection(collectionName);
    if (!collection) return null;
    return collection.items[key] ?? null;
}

export async function countCollectionItems(collectionName: string): Promise<number> {
    const collection = await loadCollection(collectionName);
    if (!collection) return 0;
    return Object.keys(collection.items).length;
}

export async function saveCollection(collection: Collection): Promise<void> {
    const dir = getCollectionsDir();
    await fs.mkdir(dir, { recursive: true });
    const filepath = path.join(dir, `${collection.name}.md`);

    const meta: Record<string, unknown> = { name: collection.name };
    if (collection.description) meta.description = collection.description;

    const body = formatCollectionBody(collection.items);
    const content = matter.stringify(body, meta);
    await fs.writeFile(filepath, content);
    debug('collections', `Saved collection: ${collection.name}`);
}

export async function setCollectionItem(
    collectionName: string,
    key: string,
    value: string,
    description?: string,
): Promise<void> {
    let collection = await loadCollection(collectionName);
    if (!collection) {
        collection = { name: collectionName, description, items: {} };
    }
    collection.items[key] = value;
    await saveCollection(collection);
}

export async function removeCollectionItem(collectionName: string, key: string): Promise<boolean> {
    const collection = await loadCollection(collectionName);
    if (!collection || !(key in collection.items)) return false;
    delete collection.items[key];
    await saveCollection(collection);
    return true;
}

export async function deleteCollection(name: string): Promise<boolean> {
    const dir = getCollectionsDir();
    const filepath = path.join(dir, `${name}.md`);
    try {
        await fs.unlink(filepath);
        debug('collections', `Deleted collection: ${name}`);
        return true;
    } catch {
        return false;
    }
}

function parseCollectionBody(body: string): Record<string, string> {
    const items: Record<string, string> = {};
    for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx < 1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();
        if (key) items[key] = value;
    }
    return items;
}

function formatCollectionBody(items: Record<string, string>): string {
    const lines = Object.entries(items)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}: ${value}`);
    return lines.join('\n') + '\n';
}
