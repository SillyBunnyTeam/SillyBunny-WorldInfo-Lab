import { LOGIC, POSITION } from './constants.js';
import { getContext, loadHost, loadWorldInfoFresh } from './host.js';

const PREVIEW_VERSION = 1;
const ALLOWED_FIELDS = new Set([
    'characterFilter',
    'depth',
    'disable',
    'groupWeight',
    'matchWholeWords',
    'order',
    'position',
    'probability',
    'scanDepth',
    'selectiveLogic',
    'useProbability',
]);

let writeChain = Promise.resolve();

export class BatchConflictError extends Error {
    constructor(conflicts) {
        super(`Batch preview is stale for ${conflicts.length} entr${conflicts.length === 1 ? 'y' : 'ies'}.`);
        this.name = 'BatchConflictError';
        this.conflicts = conflicts;
    }
}

function checkAbort(signal) {
    if (signal?.aborted) {
        throw new DOMException('Batch operation cancelled.', 'AbortError');
    }
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function fingerprint(value) {
    const text = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function entryLabel(entry, key) {
    return String(entry.comment || `Entry ${entry.uid ?? key}`);
}

function matchesFilter(entry, key, filter) {
    const query = String(filter ?? '').trim().toLowerCase();
    if (!query) {
        return true;
    }
    return [
        key,
        entry.uid,
        entry.comment,
        entry.content,
        ...(Array.isArray(entry.key) ? entry.key : []),
        ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
    ].some(value => String(value ?? '').toLowerCase().includes(query));
}

function finiteNumber(value, field, min, max, { integer = false, nullable = false } = {}) {
    if (nullable && (value === null || value === '')) {
        return null;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
        throw new TypeError(`${field} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
    }
    return number;
}

function normalizeCharacterFilter(value) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('characterFilter must be an object.');
    }
    const strings = (items, field) => {
        if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
            throw new TypeError(`characterFilter.${field} must be an array of strings.`);
        }
        return [...new Set(items.map(item => item.trim()).filter(Boolean))];
    };
    return {
        names: strings(parsed.names ?? [], 'names'),
        tags: strings(parsed.tags ?? [], 'tags'),
        isExclude: Boolean(parsed.isExclude),
    };
}

function normalizeFieldValue(field, value) {
    switch (field) {
        case 'order':
            return finiteNumber(value, field, -1000000, 1000000);
        case 'probability':
            return finiteNumber(value, field, 0, 100);
        case 'depth':
            return finiteNumber(value, field, 0, 10000, { integer: true });
        case 'scanDepth':
            return finiteNumber(value, field, 0, 1000, { integer: true, nullable: true });
        case 'groupWeight':
            return finiteNumber(value, field, 1, 999999);
        case 'position': {
            const position = finiteNumber(value, field, 0, 7, { integer: true });
            if (!Object.values(POSITION).includes(position)) {
                throw new TypeError('position is not recognized.');
            }
            return position;
        }
        case 'selectiveLogic': {
            const logic = finiteNumber(value, field, 0, 3, { integer: true });
            if (!Object.values(LOGIC).includes(logic)) {
                throw new TypeError('selectiveLogic is not recognized.');
            }
            return logic;
        }
        case 'disable':
        case 'matchWholeWords':
        case 'useProbability': {
            if (value === true || value === 'true') {
                return true;
            }
            if (value === false || value === 'false') {
                return false;
            }
            throw new TypeError(`${field} must be true or false.`);
        }
        case 'characterFilter':
            return normalizeCharacterFilter(value);
        default:
            throw new TypeError(`Batch field ${field} is not supported.`);
    }
}

async function mirrorOriginalData(book, changes, signal) {
    if (!Array.isArray(book?.originalData?.entries)) {
        return;
    }
    const missing = changes.filter((change) => {
        const entry = book.entries[change.entryKey];
        const uid = entry?.uid ?? change.uid;
        const mappedIndex = book.originalDataUidMap?.[uid];
        if (Number.isInteger(mappedIndex) && book.originalData.entries[mappedIndex]) {
            return false;
        }
        return !book.originalData.entries.some(item => String(item.id ?? item.uid) === String(uid));
    });
    if (missing.length) {
        throw new Error(`CharacterBook source entries are missing for ${missing.length} reviewed change${missing.length === 1 ? '' : 's'}; no changes were saved.`);
    }
    const host = await loadHost();
    checkAbort(signal);
    const setOriginal = host.ok ? host.worldInfo?.setWIOriginalDataValue : null;
    const keyMap = host.ok ? host.worldInfo?.originalWIDataKeyMap : null;
    if (typeof setOriginal !== 'function' || !keyMap) {
        throw new Error('CharacterBook mirroring APIs are unavailable; no changes were saved.');
    }
    for (const change of changes) {
        const entry = book.entries[change.entryKey];
        const uid = entry?.uid ?? change.uid;
        if (change.field === 'disable') {
            setOriginal(book, uid, 'enabled', !change.after);
            continue;
        }
        if (change.field === 'characterFilter') {
            setOriginal(book, uid, 'character_filter', clone(change.after));
            continue;
        }
        if (change.field === 'position') {
            setOriginal(book, uid, 'position', change.after === POSITION.before ? 'before_char' : 'after_char');
            setOriginal(book, uid, 'extensions.position', change.after);
            continue;
        }
        const originalKey = keyMap[change.field];
        if (!originalKey) {
            throw new Error(`CharacterBook field mapping is unavailable for ${change.field}.`);
        }
        setOriginal(book, uid, originalKey, clone(change.after));
    }
}

function getBookFromSnapshot(snapshot, bookName) {
    const book = snapshot?.books instanceof Map
        ? snapshot.books.get(bookName)
        : snapshot?.books?.[bookName];
    if (!book) {
        throw new Error(`Lorebook ${bookName} is not present in the preview snapshot.`);
    }
    return book;
}

function makeChange(entry, key, field, before, after) {
    return {
        entryKey: key,
        uid: entry.uid ?? key,
        label: entryLabel(entry, key),
        field,
        before: clone(before),
        after: clone(after),
        entrySnapshot: JSON.stringify(entry),
        entryFingerprint: fingerprint(entry),
    };
}

export async function previewBatch(payload, { signal } = {}) {
    checkAbort(signal);
    const bookName = String(payload?.bookName ?? '').trim();
    if (!bookName) {
        throw new TypeError('Choose a lorebook before previewing changes.');
    }
    const book = getBookFromSnapshot(payload.snapshot, bookName);
    const entries = book?.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        throw new TypeError(`Lorebook ${bookName} has no editable entries object.`);
    }
    const operation = payload.operation === 'set-field' ? 'set-field' : 'replace-content';
    const changes = [];
    let field = 'content';
    let nextValue;

    if (operation === 'replace-content') {
        const find = String(payload.find ?? '');
        if (!find) {
            throw new TypeError('Literal find text cannot be empty.');
        }
        const replacement = String(payload.replacement ?? '');
        for (const [key, entry] of Object.entries(entries)) {
            checkAbort(signal);
            if (!entry || typeof entry !== 'object' || !matchesFilter(entry, key, payload.filter)) {
                continue;
            }
            const before = String(entry.content ?? '');
            if (!before.includes(find)) {
                continue;
            }
            const after = before.split(find).join(replacement);
            if (after !== before) {
                changes.push(makeChange(entry, key, field, before, after));
            }
        }
    } else {
        field = String(payload.field ?? '');
        if (!ALLOWED_FIELDS.has(field)) {
            throw new TypeError(`Batch field ${field || '(empty)'} is not supported.`);
        }
        nextValue = normalizeFieldValue(field, payload.value);
        for (const [key, entry] of Object.entries(entries)) {
            checkAbort(signal);
            if (!entry || typeof entry !== 'object' || !matchesFilter(entry, key, payload.filter)) {
                continue;
            }
            const before = entry[field];
            if (JSON.stringify(before) !== JSON.stringify(nextValue)) {
                changes.push(makeChange(entry, key, field, before, nextValue));
            }
        }
    }

    return {
        kind: 'batch-preview',
        version: PREVIEW_VERSION,
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        createdAt: new Date().toISOString(),
        bookName,
        operation,
        field,
        count: changes.length,
        changes,
    };
}

async function applyReviewedPreview(preview, signal) {
    checkAbort(signal);
    if (preview?.kind !== 'batch-preview' || preview.version !== PREVIEW_VERSION || !Array.isArray(preview.changes)) {
        throw new TypeError('The reviewed batch preview is invalid.');
    }
    if (!preview.changes.length) {
        return { count: 0, message: 'No changes to apply.' };
    }
    const context = getContext();
    if (typeof context?.loadWorldInfo !== 'function' || typeof context?.saveWorldInfo !== 'function') {
        throw new Error('World Info write APIs are unavailable.');
    }
    const fresh = await loadWorldInfoFresh(preview.bookName, { signal });
    checkAbort(signal);
    if (!fresh?.entries || typeof fresh.entries !== 'object' || Array.isArray(fresh.entries)) {
        throw new Error(`Lorebook ${preview.bookName} could not be reloaded.`);
    }
    const conflicts = [];
    for (const change of preview.changes) {
        const current = fresh.entries[change.entryKey];
        if (!current || JSON.stringify(current) !== change.entrySnapshot) {
            conflicts.push({
                entryKey: change.entryKey,
                uid: change.uid,
                label: change.label,
            });
        }
    }
    if (conflicts.length) {
        throw new BatchConflictError(conflicts);
    }

    const next = clone(fresh);
    for (const change of preview.changes) {
        next.entries[change.entryKey][change.field] = clone(change.after);
    }
    await mirrorOriginalData(next, preview.changes, signal);
    checkAbort(signal);
    const verifiedFresh = await loadWorldInfoFresh(preview.bookName, { signal });
    checkAbort(signal);
    if (JSON.stringify(verifiedFresh) !== JSON.stringify(fresh)) {
        throw new Error(`Lorebook ${preview.bookName} changed during batch validation; no changes were saved.`);
    }
    await context.saveWorldInfo(preview.bookName, next, true);
    await context.reloadWorldInfoEditor?.(preview.bookName, true);
    context.updateWorldInfoList?.();
    return {
        count: preview.changes.length,
        message: `${preview.changes.length} entr${preview.changes.length === 1 ? 'y' : 'ies'} updated in ${preview.bookName}.`,
    };
}

export function applyBatch(preview, { signal } = {}) {
    const operation = writeChain.then(() => applyReviewedPreview(preview, signal));
    writeChain = operation.catch(() => {});
    return operation;
}
