// ─────────────────────────────────────────────────────────────────────────────
// Lightweight Porter Stemmer
// ─────────────────────────────────────────────────────────────────────────────
// Simplified Porter stemmer for English. Handles the most common suffixes
// without external dependencies. Not perfect, but good enough for search.
// ─────────────────────────────────────────────────────────────────────────────

const STEP2: [string, string][] = [
    ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
    ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
    ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
    ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
    ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
];

const STEP3: [string, string][] = [
    ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'],
    ['ical', 'ic'], ['ful', ''], ['ness', ''],
];

function measure(stem: string): number {
    // Count VC sequences (consonant-vowel groups)
    const m = stem.replace(/[^aeiouy]+/g, 'C').replace(/[aeiouy]+/g, 'V');
    const match = m.match(/VC/g);
    return match ? match.length : 0;
}

function hasVowel(stem: string): boolean {
    return /[aeiouy]/.test(stem);
}

function endsDoubleConsonant(stem: string): boolean {
    const len = stem.length;
    return len >= 2 && stem[len - 1] === stem[len - 2] && !/[aeiouy]/.test(stem[len - 1]);
}

function endsCvc(stem: string): boolean {
    const len = stem.length;
    if (len < 3) return false;
    const c1 = !/[aeiouy]/.test(stem[len - 3]);
    const v = /[aeiouy]/.test(stem[len - 2]);
    const c2 = !/[aeiouy]/.test(stem[len - 1]);
    if (!c1 || !v || !c2) return false;
    return !/[wxy]/.test(stem[len - 1]);
}

export function stem(word: string): string {
    if (word.length <= 2) return word;

    let w = word.toLowerCase();

    // Step 1a: plurals
    if (w.endsWith('sses')) w = w.slice(0, -2);
    else if (w.endsWith('ies')) w = w.slice(0, -2);
    else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

    // Step 1b: -eed, -ed, -ing
    if (w.endsWith('eed')) {
        if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
    } else if (w.endsWith('ed') && hasVowel(w.slice(0, -2))) {
        w = w.slice(0, -2);
        if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
        else if (endsDoubleConsonant(w) && !/[lsz]/.test(w[w.length - 1])) w = w.slice(0, -1);
        else if (measure(w) === 1 && endsCvc(w)) w += 'e';
    } else if (w.endsWith('ing') && hasVowel(w.slice(0, -3))) {
        w = w.slice(0, -3);
        if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
        else if (endsDoubleConsonant(w) && !/[lsz]/.test(w[w.length - 1])) w = w.slice(0, -1);
        else if (measure(w) === 1 && endsCvc(w)) w += 'e';
    }

    // Step 1c: y → i
    if (w.endsWith('y') && hasVowel(w.slice(0, -1))) {
        w = w.slice(0, -1) + 'i';
    }

    // Step 2: suffix mapping
    for (const [suffix, replacement] of STEP2) {
        if (w.endsWith(suffix)) {
            const base = w.slice(0, -suffix.length);
            if (measure(base) > 0) w = base + replacement;
            break;
        }
    }

    // Step 3: suffix mapping
    for (const [suffix, replacement] of STEP3) {
        if (w.endsWith(suffix)) {
            const base = w.slice(0, -suffix.length);
            if (measure(base) > 0) w = base + replacement;
            break;
        }
    }

    // Step 4: remove known suffixes when m > 1
    const step4suffixes = [
        'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement',
        'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
    ];
    for (const suffix of step4suffixes) {
        if (w.endsWith(suffix)) {
            const base = w.slice(0, -suffix.length);
            if (measure(base) > 1) {
                if (suffix === 'ion') {
                    if (base.endsWith('s') || base.endsWith('t')) w = base;
                } else {
                    w = base;
                }
            }
            break;
        }
    }

    // Step 5a: remove trailing 'e'
    if (w.endsWith('e')) {
        const base = w.slice(0, -1);
        if (measure(base) > 1 || (measure(base) === 1 && !endsCvc(base))) {
            w = base;
        }
    }

    // Step 5b: -ll
    if (w.endsWith('ll') && measure(w.slice(0, -1)) > 1) {
        w = w.slice(0, -1);
    }

    return w;
}
