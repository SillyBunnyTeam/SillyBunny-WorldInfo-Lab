import { METADATA_KEY } from './constants.js';
import { countTokens, getContext, loadHost } from './host.js';
import { buildSimulationRequest } from './scan-input.js';
import { getSettings } from './settings.js';
import { simulateWorldInfo } from './simulator/engine.js';
import { getActiveBookPlan, snapshotLorebooks } from './sources.js';

const TEST_CASE_VERSION = 1;
const MAX_CASE_BYTES = 2 * 1024 * 1024;
let writeChain = Promise.resolve();

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function checkAbort(signal) {
    if (signal?.aborted) {
        throw new DOMException('Test run cancelled.', 'AbortError');
    }
}

function makeId(context) {
    return context?.uuidv4?.()
        ?? globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function storedCases(book) {
    const cases = book?.extensions?.[METADATA_KEY]?.testCases;
    return Array.isArray(cases) ? cases : [];
}

async function discoverBooks(context) {
    const host = await loadHost();
    const active = host.ok ? getActiveBookPlan(context, host).all : [];
    const selected = getSettings().selectedBook;
    let known = [];
    if (typeof context?.getWorldInfoNames === 'function') {
        try {
            const names = await context.getWorldInfoNames();
            known = Array.isArray(names) ? names : [];
        } catch {
            known = [];
        }
    }
    return [...new Set([
        ...known,
        ...active,
        ...(selected ? [selected] : []),
    ].map(String).filter(Boolean))];
}

async function loadCasesFromBook(context, bookName) {
    try {
        const book = await context.loadWorldInfo(bookName);
        return storedCases(book).map(item => ({
            ...clone(item),
            bookName,
        }));
    } catch {
        return [];
    }
}

export async function listTestCases({ bookNames = null } = {}) {
    const context = getContext();
    if (typeof context?.loadWorldInfo !== 'function') {
        throw new Error('World Info loading is unavailable.');
    }
    const names = bookNames ?? await discoverBooks(context);
    const groups = await Promise.all(names.map(name => loadCasesFromBook(context, name)));
    return groups.flat().sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '')
        .localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
}

function expectedFrom(result) {
    return {
        fingerprint: String(result.fingerprint ?? ''),
        activated: (result.activated ?? []).map(entry => String(entry.id)),
        budget: clone(result.budget ?? {}),
        placements: (result.placements?.records ?? []).map(record => ({
            id: String(record.id),
            included: Boolean(record.included),
            position: record.position,
            renderedContent: String(record.renderedContent ?? ''),
        })),
    };
}

async function saveCaseNow(input) {
    const context = getContext();
    if (typeof context?.loadWorldInfo !== 'function' || typeof context?.saveWorldInfo !== 'function') {
        throw new Error('World Info write APIs are unavailable.');
    }
    const result = input?.result;
    if (result?.kind !== 'simulated' || !result.replay) {
        throw new TypeError('Run a replayable simulation before saving a test case.');
    }
    if (input?.confirmReplayStorage !== true) {
        throw new TypeError('Confirm portable replay storage before saving a test case.');
    }
    const name = String(input.name ?? '').trim();
    if (!name) {
        throw new TypeError('Test case name cannot be empty.');
    }
    const sourceBooks = result.replay.sourcePlan?.all ?? [];
    const preferred = String(input.bookName ?? getSettings().selectedBook ?? '');
    const bookName = preferred || sourceBooks[0];
    if (!bookName) {
        throw new Error('Choose a lorebook for this test case.');
    }
    const book = await context.loadWorldInfo(bookName);
    if (!book?.entries || typeof book.entries !== 'object') {
        throw new Error(`Lorebook ${bookName} could not be loaded.`);
    }
    const now = new Date().toISOString();
    const item = {
        id: makeId(context),
        version: TEST_CASE_VERSION,
        name: name.slice(0, 120),
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        replay: clone(result.replay),
        expected: expectedFrom(result),
    };
    if (new TextEncoder().encode(JSON.stringify(item)).length > MAX_CASE_BYTES) {
        throw new RangeError('The test case exceeds the 2 MB storage limit.');
    }
    const next = clone(book);
    if (!next.extensions || typeof next.extensions !== 'object' || Array.isArray(next.extensions)) {
        next.extensions = {};
    }
    const metadata = next.extensions[METADATA_KEY];
    next.extensions[METADATA_KEY] = {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        version: TEST_CASE_VERSION,
        testCases: [...storedCases(next), item],
    };
    await context.saveWorldInfo(bookName, next, true);
    await context.reloadWorldInfoEditor?.(bookName, true);
    return { ...clone(item), bookName };
}

export function saveTestCase(input) {
    const operation = writeChain.then(() => saveCaseNow(input));
    writeChain = operation.catch(() => {});
    return operation;
}

async function deleteCaseNow(id, bookName = '') {
    const context = getContext();
    const names = bookName ? [bookName] : await discoverBooks(context);
    for (const name of names) {
        const book = await context.loadWorldInfo(name);
        const cases = storedCases(book);
        const index = cases.findIndex(item => item?.id === id);
        if (index === -1) {
            continue;
        }
        const next = clone(book);
        const nextCases = [...storedCases(next)];
        nextCases.splice(index, 1);
        next.extensions[METADATA_KEY] = {
            ...next.extensions[METADATA_KEY],
            testCases: nextCases,
        };
        await context.saveWorldInfo(name, next, true);
        await context.reloadWorldInfoEditor?.(name, true);
        return true;
    }
    return false;
}

export function deleteTestCase(id, { bookName = '' } = {}) {
    const operation = writeChain.then(() => deleteCaseNow(id, bookName));
    writeChain = operation.catch(() => {});
    return operation;
}

function compare(caseItem, result) {
    const actual = expectedFrom(result);
    const expected = caseItem.expected ?? {};
    const differences = [];
    if (actual.fingerprint !== expected.fingerprint) {
        differences.push('fingerprint');
    }
    if (JSON.stringify(actual.activated) !== JSON.stringify(expected.activated ?? [])) {
        differences.push('activated entries');
    }
    if (JSON.stringify(actual.placements) !== JSON.stringify(expected.placements ?? [])) {
        differences.push('placements');
    }
    if (JSON.stringify(actual.budget) !== JSON.stringify(expected.budget ?? {})) {
        differences.push('token budget');
    }
    return { actual, expected, differences, passed: differences.length === 0 };
}

export async function runTestCase(caseItem, { signal } = {}) {
    checkAbort(signal);
    if (caseItem?.version !== TEST_CASE_VERSION || !caseItem.replay) {
        throw new TypeError('The stored test case format is unsupported.');
    }
    const replay = caseItem.replay;
    const context = getContext();
    const snapshot = await snapshotLorebooks({
        context,
        sourcePlan: replay.sourcePlan,
        settings: replay.settings,
    });
    checkAbort(signal);
    const request = await buildSimulationRequest(snapshot, {
        context,
        mode: replay.mode,
        messages: replay.messages,
        injections: replay.injections,
        settings: replay.settings,
        maxContext: replay.maxContext,
        trigger: replay.trigger,
        seed: replay.seed,
        forcedIds: replay.forcedIds,
        timedEffects: replay.timedEffects,
        character: replay.character,
        globalScanData: replay.globalScanData,
        macroSnapshot: replay.macroSnapshot,
        tokenCount: countTokens,
    });
    const result = await simulateWorldInfo(request, { signal });
    const comparison = compare(caseItem, result);
    return {
        ...comparison,
        result,
        summary: comparison.passed
            ? `${caseItem.name} passed.`
            : `${caseItem.name} changed: ${comparison.differences.join(', ')}.`,
    };
}
