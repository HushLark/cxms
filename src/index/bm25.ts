// ─────────────────────────────────────────────────────────────────────────────
// BM25 Inverted Index
// ─────────────────────────────────────────────────────────────────────────────
// Full-text search with BM25 scoring over tokenized + stemmed content.
// Indexes title, summary, body, and custom field values.
// Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import { stem } from './stemmer.js';

// ── Stop Words ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
    'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
    'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
    'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs',
    'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
    'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
    'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above',
    'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
    'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
    'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'can', 'will', 'just', 'should', 'now', 'could', 'would', 'might', 'must',
    'shall',
]);

// ── Types ───────────────────────────────────────────────────────────────────

/** A posting: which document, how many times the term appears, and the field boost */
interface Posting {
    key: string;            // document key (type:id)
    tf: number;             // term frequency in this document
    fieldBoost: number;     // accumulated field-weight boost
}

/** Per-document metadata stored for length normalization */
interface DocEntry {
    key: string;
    type: string;
    termCount: number;      // total tokens in document (for length normalization)
}

export interface BM25SearchResult {
    key: string;
    type: string;
    score: number;
}

// ── BM25 Parameters ────────────────────────────────────────────────────────

const K1 = 1.2;        // term frequency saturation
const B = 0.75;         // length normalization

// Field weight multipliers — title matches matter more than body
const FIELD_WEIGHTS = {
    title: 5.0,
    summary: 2.0,
    fields: 1.5,
    body: 1.0,
};

// ── Tokenization ────────────────────────────────────────────────────────────

export function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1 && !STOP_WORDS.has(t))
        .map(stem);
}

// ── Index Class ─────────────────────────────────────────────────────────────

export class BM25Index {
    /** term → list of postings */
    private invertedIndex = new Map<string, Posting[]>();
    /** document key → doc entry */
    private docs = new Map<string, DocEntry>();
    /** running total for avgdl calculation */
    private totalTermCount = 0;

    /** Number of indexed documents */
    get size(): number { return this.docs.size; }

    /** Average document length */
    private get avgdl(): number {
        return this.docs.size > 0 ? this.totalTermCount / this.docs.size : 1;
    }

    /**
     * Add or update a document in the index.
     */
    addDocument(
        key: string,
        type: string,
        fields: {
            title: string;
            summary: string;
            body: string;
            customFields?: Record<string, unknown>;
        },
    ): void {
        // Remove old version first
        this.removeDocument(key);

        // Build term → {count, boost} map for this document
        const termMap = new Map<string, { count: number; boost: number }>();
        let totalTokens = 0;

        const addTokens = (text: string, weight: number) => {
            const tokens = tokenize(text);
            totalTokens += tokens.length;
            for (const term of tokens) {
                const entry = termMap.get(term);
                if (entry) {
                    entry.count++;
                    entry.boost = Math.max(entry.boost, weight);
                } else {
                    termMap.set(term, { count: 1, boost: weight });
                }
            }
        };

        addTokens(fields.title, FIELD_WEIGHTS.title);
        addTokens(fields.summary, FIELD_WEIGHTS.summary);
        addTokens(fields.body, FIELD_WEIGHTS.body);

        // Index custom field values as text
        if (fields.customFields) {
            for (const val of Object.values(fields.customFields)) {
                if (val == null) continue;
                if (typeof val === 'string') {
                    addTokens(val, FIELD_WEIGHTS.fields);
                } else if (Array.isArray(val)) {
                    for (const v of val) {
                        if (typeof v === 'string') addTokens(v, FIELD_WEIGHTS.fields);
                    }
                }
            }
        }

        // Store doc entry
        this.docs.set(key, { key, type, termCount: totalTokens });
        this.totalTermCount += totalTokens;

        // Add postings to inverted index
        for (const [term, { count, boost }] of termMap) {
            let postings = this.invertedIndex.get(term);
            if (!postings) {
                postings = [];
                this.invertedIndex.set(term, postings);
            }
            postings.push({ key, tf: count, fieldBoost: boost });
        }
    }

    /**
     * Remove a document from the index.
     */
    removeDocument(key: string): void {
        const existing = this.docs.get(key);
        if (!existing) return;

        this.totalTermCount -= existing.termCount;
        this.docs.delete(key);

        // Remove postings — iterate terms and filter
        for (const [term, postings] of this.invertedIndex) {
            const filtered = postings.filter(p => p.key !== key);
            if (filtered.length === 0) {
                this.invertedIndex.delete(term);
            } else {
                this.invertedIndex.set(term, filtered);
            }
        }
    }

    /**
     * Search the index with BM25 scoring.
     * Returns results sorted by score descending.
     */
    search(query: string, entityType?: string): BM25SearchResult[] {
        const queryTerms = tokenize(query);
        if (queryTerms.length === 0) return [];

        const N = this.docs.size;
        const avgdl = this.avgdl;
        const scores = new Map<string, number>();

        for (const term of queryTerms) {
            const postings = this.invertedIndex.get(term);
            if (!postings) continue;

            // IDF: log((N - n + 0.5) / (n + 0.5) + 1)
            const n = postings.length;
            const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);

            for (const { key, tf, fieldBoost } of postings) {
                if (entityType) {
                    const doc = this.docs.get(key);
                    if (doc && doc.type !== entityType) continue;
                }

                const doc = this.docs.get(key);
                if (!doc) continue;
                const dl = doc.termCount;

                // BM25 score with field boost
                const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / avgdl));
                const termScore = idf * tfNorm * fieldBoost;

                scores.set(key, (scores.get(key) || 0) + termScore);
            }
        }

        // Build results
        const results: BM25SearchResult[] = [];
        for (const [key, score] of scores) {
            const doc = this.docs.get(key)!;
            results.push({ key, type: doc.type, score });
        }

        results.sort((a, b) => b.score - a.score);
        return results;
    }

    /**
     * Clear the entire index.
     */
    clear(): void {
        this.invertedIndex.clear();
        this.docs.clear();
        this.totalTermCount = 0;
    }
}
