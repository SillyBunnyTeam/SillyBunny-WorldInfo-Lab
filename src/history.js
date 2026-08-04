import { HISTORY_KEY } from './constants.js';
import { getContext } from './host.js';
import { getSettings } from './settings.js';

const HISTORY_VERSION = 1;
const contextHistory = new WeakMap();
let orphanHistory = [];

function clone(value) {
    return structuredClone(value);
}

function storage() {
    const target = getContext()?.accountStorage;
    return typeof target?.getItem === 'function'
        && typeof target?.setItem === 'function'
        && typeof target?.removeItem === 'function'
        ? target
        : null;
}

function readMemoryHistory() {
    const context = getContext();
    return context && typeof context === 'object'
        ? (contextHistory.get(context) ?? [])
        : orphanHistory;
}

function writeMemoryHistory(items) {
    const context = getContext();
    if (context && typeof context === 'object') {
        contextHistory.set(context, clone(items));
    } else {
        orphanHistory = clone(items);
    }
}

function readHistory() {
    const target = storage();
    if (!target) {
        return readMemoryHistory();
    }
    try {
        const parsed = JSON.parse(target.getItem(HISTORY_KEY) ?? 'null');
        return parsed?.version === HISTORY_VERSION && Array.isArray(parsed.items)
            ? parsed.items
            : [];
    } catch {
        return [];
    }
}

function writeHistory(items) {
    const target = storage();
    if (!target) {
        writeMemoryHistory(items);
        return;
    }
    target.setItem(HISTORY_KEY, JSON.stringify({
        version: HISTORY_VERSION,
        items,
    }));
}

function makeId() {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function appendHistory(result, { name = '' } = {}) {
    if (result?.kind !== 'simulated') {
        throw new TypeError('Only completed simulations can be added to history.');
    }
    const item = {
        id: makeId(),
        name: String(name || result.fingerprint || 'Simulation'),
        fingerprint: String(result.fingerprint ?? ''),
        createdAt: new Date().toISOString(),
        mode: result.input?.mode ?? '',
        trigger: result.input?.trigger ?? '',
        seed: result.seed ?? 0,
        activated: result.activated?.length ?? 0,
        tokens: result.budget?.used ?? 0,
        limit: result.budget?.limit ?? 0,
        books: [...(result.replay?.sourcePlan?.all ?? [])],
    };
    const limit = getSettings().historyLimit;
    writeHistory([item, ...readHistory()].slice(0, limit));
    return clone(item);
}

export function listHistory() {
    return clone(readHistory());
}

export function clearHistory() {
    const context = getContext();
    if (context && typeof context === 'object') {
        contextHistory.delete(context);
    } else {
        orphanHistory = [];
    }
    try {
        storage()?.removeItem(HISTORY_KEY);
    } catch {
        // Browser storage may reject writes in private or sandboxed contexts.
    }
}
