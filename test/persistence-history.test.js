import assert from 'node:assert/strict';
import test from 'node:test';

import {
    HISTORY_KEY,
    METADATA_KEY,
    SETTINGS_KEY,
} from '../src/constants.js';
import {
    appendHistory,
    clearHistory,
    listHistory,
} from '../src/history.js';
import { __setHostForTests } from '../src/host.js';
import { buildSimulationRequest } from '../src/scan-input.js';
import { simulateWorldInfo } from '../src/simulator/engine.js';
import { snapshotLorebooks } from '../src/sources.js';
import {
    deleteTestCase,
    listTestCases,
    runTestCase,
    saveTestCase,
} from '../src/test-cases.js';
import {
    clone,
    installContext,
    makeHost,
    makeMemoryContext,
} from './helpers/fixtures.js';

test('test cases persist beside lorebook metadata and replay deterministically', async (t) => {
    const context = makeMemoryContext({
        Book: {
            entries: {
                1: {
                    uid: 1,
                    comment: 'Greeting',
                    key: ['hello'],
                    content: 'remembered context',
                    order: 10,
                    position: 0,
                },
            },
            extensions: {
                [METADATA_KEY]: { customMetadata: 'preserve me' },
            },
        },
        Inactive: {
            entries: {},
            extensions: {
                [METADATA_KEY]: {
                    version: 1,
                    testCases: [{
                        id: 'inactive-case-id',
                        version: 1,
                        name: 'Inactive case',
                        createdAt: '2020-01-01T00:00:00.000Z',
                    }],
                },
            },
        },
    }, {
        extensionSettings: {
            [SETTINGS_KEY]: { selectedBook: 'Book' },
        },
        uuidv4: () => 'stable-case-id',
    });
    const restore = installContext(context);
    t.after(restore);
    __setHostForTests(makeHost({ script: { getMaxPromptTokens: () => 100 } }));
    t.after(() => __setHostForTests(null));

    const sourcePlan = { chat: [], persona: [], character: [], global: ['Book'], all: ['Book'] };
    const snapshot = await snapshotLorebooks({ context, sourcePlan, settings: { budgetPercent: 100 } });
    const request = await buildSimulationRequest(snapshot, {
        context,
        mode: 'text',
        messages: ['hello'],
        maxContext: 100,
        seed: 7,
        tokenCount: context.getTokenCountAsync,
    });
    const simulation = await simulateWorldInfo(request);
    assert.deepEqual(simulation.activated.map(item => item.id), ['Book.1']);

    await assert.rejects(saveTestCase({
        name: 'missing consent',
        bookName: 'Book',
        result: simulation,
    }), /Confirm portable replay storage/);
    const savedCase = await saveTestCase({
        name: '  deterministic greeting  ',
        bookName: 'Book',
        result: simulation,
        confirmReplayStorage: true,
    });
    assert.equal(savedCase.id, 'stable-case-id');
    assert.equal(savedCase.name, 'deterministic greeting');
    assert.equal(savedCase.bookName, 'Book');
    assert.equal(savedCase.expected.fingerprint, simulation.fingerprint);
    assert.deepEqual(savedCase.expected.activated, ['Book.1']);

    const persisted = context.books.get('Book');
    assert.equal(persisted.extensions[METADATA_KEY].customMetadata, 'preserve me');
    assert.equal(persisted.extensions[METADATA_KEY].version, 1);
    assert.equal(persisted.extensions[METADATA_KEY].testCases.length, 1);

    const listed = await listTestCases({ bookNames: ['Book'] });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].bookName, 'Book');
    assert.notEqual(listed[0], persisted.extensions[METADATA_KEY].testCases[0]);
    const allCases = await listTestCases();
    assert.deepEqual(new Set(allCases.map(item => item.id)), new Set(['stable-case-id', 'inactive-case-id']));

    const replay = await runTestCase(listed[0]);
    assert.equal(replay.passed, true);
    assert.deepEqual(replay.differences, []);
    assert.equal(replay.result.fingerprint, simulation.fingerprint);
    assert.equal(replay.summary, 'deterministic greeting passed.');

    const changedExpectation = clone(listed[0]);
    changedExpectation.expected.fingerprint = 'different';
    const changed = await runTestCase(changedExpectation);
    assert.equal(changed.passed, false);
    assert.deepEqual(changed.differences, ['fingerprint']);
    assert.match(changed.summary, /changed: fingerprint/);

    assert.equal(await deleteTestCase(savedCase.id, { bookName: 'Book' }), true);
    assert.deepEqual(await listTestCases({ bookNames: ['Book'] }), []);
});

test('history stores only private-safe summaries and enforces normalized limits', (t) => {
    const values = new Map();
    const accountStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
    };

    const context = {
        accountStorage,
        extensionSettings: {
            [SETTINGS_KEY]: { historyLimit: 2 },
        },
    };
    const restore = installContext(context);
    t.after(restore);
    clearHistory();

    const privateText = 'PRIVATE_CHAT_TRANSCRIPT_SHOULD_NOT_PERSIST';
    for (let index = 0; index < 12; index++) {
        const result = {
            kind: 'simulated',
            fingerprint: `fingerprint-${index}`,
            seed: index,
            input: { mode: 'text', trigger: 'normal', messages: [privateText] },
            activated: [{ id: 'Book.1', secretContent: privateText }],
            budget: { used: index, limit: 100 },
            placements: { records: [{ renderedContent: privateText }] },
            traces: [{ scanText: privateText }],
            replay: {
                sourcePlan: { all: ['Book'] },
                messages: [privateText],
                macroSnapshot: { secret: privateText },
            },
        };
        appendHistory(result, { name: `run-${index}` });
    }

    const history = listHistory();
    assert.equal(context.extensionSettings[SETTINGS_KEY].historyLimit, 10);
    assert.equal(history.length, 10);
    assert.equal(history[0].name, 'run-11');
    assert.equal(history.at(-1).name, 'run-2');
    assert.deepEqual(Object.keys(history[0]).sort(), [
        'activated',
        'books',
        'createdAt',
        'fingerprint',
        'id',
        'limit',
        'mode',
        'name',
        'seed',
        'tokens',
        'trigger',
    ]);
    const raw = values.get(HISTORY_KEY);
    assert.doesNotMatch(raw, /PRIVATE_CHAT_TRANSCRIPT_SHOULD_NOT_PERSIST/);
    assert.doesNotMatch(raw, /scanText|renderedContent|macroSnapshot|messages/);

    history[0].name = 'mutated copy';
    assert.equal(listHistory()[0].name, 'run-11');

    const otherValues = new Map();
    context.accountStorage = {
        getItem: key => otherValues.get(key) ?? null,
        setItem: (key, value) => otherValues.set(key, String(value)),
        removeItem: key => otherValues.delete(key),
    };
    assert.deepEqual(listHistory(), []);
    context.accountStorage = accountStorage;
    assert.equal(listHistory()[0].name, 'run-11');

    clearHistory();
    assert.deepEqual(listHistory(), []);
    assert.equal(values.has(HISTORY_KEY), false);
});

test('history fallback is isolated by host context identity', (t) => {
    const first = { extensionSettings: { [SETTINGS_KEY]: { historyLimit: 10 } } };
    const second = { extensionSettings: { [SETTINGS_KEY]: { historyLimit: 10 } } };
    let active = first;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SillyTavern');
    Object.defineProperty(globalThis, 'SillyTavern', {
        configurable: true,
        value: { getContext: () => active },
    });
    t.after(() => {
        active = first;
        clearHistory();
        active = second;
        clearHistory();
        if (descriptor) {
            Object.defineProperty(globalThis, 'SillyTavern', descriptor);
        } else {
            delete globalThis.SillyTavern;
        }
    });

    appendHistory({
        kind: 'simulated',
        fingerprint: 'first-account',
        input: {},
        activated: [],
        budget: {},
        replay: { sourcePlan: { all: [] } },
    });
    assert.equal(listHistory()[0].fingerprint, 'first-account');
    active = second;
    assert.deepEqual(listHistory(), []);
    active = first;
    assert.equal(listHistory()[0].fingerprint, 'first-account');
});
