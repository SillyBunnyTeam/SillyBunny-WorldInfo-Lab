import assert from 'node:assert/strict';
import test from 'node:test';

import {
    LOGIC,
    POSITION,
    SCAN_STATE,
} from '../src/constants.js';
import { simulateWorldInfo } from '../src/simulator/engine.js';
import {
    ScanBuffer,
    evaluateKeys,
    matchKey,
    parseRegexKey,
} from '../src/simulator/matching.js';
import { buildPlacements } from '../src/simulator/placements.js';
import {
    makeEntry,
    makeSimulationRequest,
} from './helpers/fixtures.js';

test('matching handles expansion, regexes, whole words, selective logic, and short-circuit details', () => {
    assert.equal(parseRegexKey('/a\\/b/i')?.test('A/B'), true);
    assert.equal(parseRegexKey('/unterminated/['), null);

    const settings = { caseSensitive: false, matchWholeWords: true, depth: 2 };
    assert.deepEqual(
        matchKey('concatenate cat!', 'cat', {}, settings),
        { matched: true, kind: 'whole-word', index: 11, value: 'cat' },
    );
    assert.deepEqual(
        matchKey('Alpha BETA', '/beta/i', {}, settings),
        { matched: true, kind: 'regex', index: 6, value: 'BETA' },
    );

    const result = evaluateKeys({
        key: ['missing', '{{primary}}', 'unvisited'],
        selective: true,
        keysecondary: ['absent', 'beta', 'unvisited'],
        selectiveLogic: LOGIC.AND_ANY,
    }, 'alpha beta', settings, value => value === '{{primary}}' ? 'alpha' : value, parseRegexKey);
    assert.equal(result.matched, true);
    assert.equal(result.reason, 'primary-secondary');
    assert.deepEqual(result.primary.map(item => item.matched), [false, true]);
    assert.equal(result.unvisitedPrimaryCount, undefined);
    assert.deepEqual(result.secondary.map(item => item.matched), [false, true]);
    assert.equal(result.unvisitedSecondaryCount, 1);

    const cases = [
        [LOGIC.AND_ALL, ['beta', 'gamma'], 'alpha beta gamma', true],
        [LOGIC.AND_ALL, ['beta', 'missing'], 'alpha beta gamma', false],
        [LOGIC.NOT_ANY, ['missing', 'absent'], 'alpha beta', true],
        [LOGIC.NOT_ANY, ['beta', 'absent'], 'alpha beta', false],
        [LOGIC.NOT_ALL, ['beta', 'missing'], 'alpha beta', true],
        [LOGIC.NOT_ALL, ['alpha', 'beta'], 'alpha beta', false],
    ];
    for (const [logic, secondary, haystack, matched] of cases) {
        assert.equal(evaluateKeys({
            key: ['alpha'],
            selective: true,
            keysecondary: secondary,
            selectiveLogic: logic,
        }, haystack, settings, String, parseRegexKey).matched, matched);
    }

    const buffer = new ScanBuffer(
        ['newest', 'older'],
        { scenario: 'scenario text' },
        ['injected'],
        { depth: 1, caseSensitive: false, matchWholeWords: false },
    );
    buffer.addRecursion('recursive');
    const entry = { key: ['recursive'], matchScenario: true };
    assert.match(buffer.get(entry, SCAN_STATE.RECURSION), /newest/);
    assert.match(buffer.get(entry, SCAN_STATE.RECURSION), /scenario text/);
    assert.match(buffer.get(entry, SCAN_STATE.RECURSION), /injected/);
    assert.match(buffer.get(entry, SCAN_STATE.RECURSION), /recursive/);
    assert.doesNotMatch(buffer.get(entry, SCAN_STATE.MIN_ACTIVATIONS), /recursive/);
});

test('simulation output, matching traces, and fingerprints are deterministic', async () => {
    const entries = [
        makeEntry(1, { key: ['ALPHA'], content: 'plain' }),
        makeEntry(2, { key: ['/b.ta/i'], content: 'regex' }),
        makeEntry(3, { key: ['missing'], content: 'never' }),
    ];
    const request = makeSimulationRequest({ entries, messages: ['alpha beta'], seed: 42 });

    const first = await simulateWorldInfo(request);
    const second = await simulateWorldInfo(request);
    assert.deepEqual(second, first);
    assert.equal(first.kind, 'simulated');
    assert.deepEqual(first.activated.map(item => item.id), ['Book.1', 'Book.2']);

    const plainTrace = first.traces.find(trace => trace.uid === 1);
    assert.equal(plainTrace.outcome, 'activated');
    assert.equal(plainTrace.match.primaryMatch.kind, 'plain');
    assert.deepEqual(plainTrace.stages.map(stage => [stage.name, stage.status]), [
        ['Enabled', 'pass'],
        ['Generation trigger', 'pass'],
        ['Character filter', 'pass'],
        ['Timed effects', 'pass'],
        ['Recursion gate', 'pass'],
        ['Decorator', 'skip'],
        ['Keys', 'pass'],
        ['Activation', 'pass'],
        ['Inclusion group', 'skip'],
        ['Probability', 'pass'],
        ['Token budget', 'pass'],
    ]);

    const regexTrace = first.traces.find(trace => trace.uid === 2);
    assert.equal(regexTrace.match.primaryMatch.kind, 'regex');
    assert.equal(regexTrace.match.primaryMatch.value, 'beta');
    const missTrace = first.traces.find(trace => trace.uid === 3);
    assert.equal(missTrace.outcome, 'primary-miss');
    assert.equal(missTrace.stages.at(-1).name, 'Keys');
    assert.equal(missTrace.stages.at(-1).reason, 'primary-miss');
});

test('probability uses seeded rolls and honors current defaults and overrides', async () => {
    const entries = [
        makeEntry(1, { constant: true, probability: 62 }),
        makeEntry(2, { constant: true, probability: 0 }),
        makeEntry(3, { constant: true }),
        makeEntry(4, { constant: true, probability: 0, useProbability: false }),
        makeEntry(5, {
            constant: true,
            extensions: { probability: 0, useProbability: false },
            probability: undefined,
            useProbability: undefined,
        }),
        makeEntry(6, { constant: true, probability: 'not-a-number' }),
    ];
    const result = await simulateWorldInfo(makeSimulationRequest({ entries, seed: 1 }));

    assert.deepEqual(result.activated.map(item => item.id), ['Book.3', 'Book.4', 'Book.5', 'Book.6']);
    const rolled = result.traces.find(trace => trace.uid === 1).stages.at(-1);
    assert.equal(rolled.name, 'Probability');
    assert.equal(rolled.reason, 'roll');
    assert.equal(rolled.threshold, 62);
    assert.ok(Math.abs(rolled.roll - 62.707394058816135) < 1e-12);
    assert.equal(result.traces.find(trace => trace.uid === 2).stages.at(-1).reason, 'zero');
    assert.equal(result.traces.find(trace => trace.uid === 3)
        .stages.find(stage => stage.name === 'Probability').reason, 'guaranteed');
    assert.equal(result.traces.find(trace => trace.uid === 4)
        .stages.find(stage => stage.name === 'Probability').reason, 'disabled');
    assert.equal(result.traces.find(trace => trace.uid === 5)
        .stages.find(stage => stage.name === 'Probability').reason, 'disabled');
    assert.equal(result.traces.find(trace => trace.uid === 6)
        .stages.find(stage => stage.name === 'Probability').threshold, 100);
});

test('budget rejects the exact boundary while ignoreBudget can cross it and survive prior overflow', async (t) => {
    await t.test('exact boundary', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [makeEntry(1, { constant: true, content: 'x' })],
            settings: { budgetPercent: 100 },
            maxContext: 2,
        }));
        assert.deepEqual(result.activated, []);
        assert.deepEqual(result.budget, { limit: 2, used: 0, overflowed: true });
        assert.deepEqual(result.traces[0].stages.at(-1), {
            name: 'Token budget',
            status: 'fail',
            ignored: false,
            before: 0,
            after: 2,
            delta: 2,
            limit: 2,
            reason: 'limit-reached',
            outcome: 'budget-rejected',
        });
    });

    await t.test('ignored exact boundary', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [makeEntry(1, { constant: true, content: 'x', ignoreBudget: true })],
            settings: { budgetPercent: 100 },
            maxContext: 2,
        }));
        assert.deepEqual(result.activated.map(item => item.id), ['Book.1']);
        assert.deepEqual(result.budget, { limit: 2, used: 2, overflowed: false });
        assert.equal(result.traces[0].stages.at(-1).ignored, true);
    });

    await t.test('ignored candidate after overflow', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [
                makeEntry(1, { constant: true, content: 'x' }),
                makeEntry(2, { constant: true, content: 'i', ignoreBudget: true }),
            ],
            settings: { budgetPercent: 100 },
            maxContext: 2,
        }));
        assert.deepEqual(result.activated.map(item => item.id), ['Book.2']);
        assert.deepEqual(result.budget, { limit: 2, used: 2, overflowed: true });
        assert.equal(result.traces.find(trace => trace.uid === 1).outcome, 'budget-rejected');
        assert.equal(result.traces.find(trace => trace.uid === 2).outcome, 'activated');
    });
});

test('recursion activates from prior content and minimum activations advances scan depth', async (t) => {
    await t.test('recursive content', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [
                makeEntry(1, { key: ['seed'], content: 'unlock' }),
                makeEntry(2, { key: ['unlock'], content: 'done', preventRecursion: true }),
            ],
            messages: ['seed'],
            settings: { recursive: true },
        }));
        assert.deepEqual(result.rounds.map(round => round.state), [SCAN_STATE.INITIAL, SCAN_STATE.RECURSION]);
        assert.deepEqual(result.rounds.map(round => round.activated), [['Book.1'], ['Book.2']]);
        const traces = result.traces.filter(trace => trace.uid === 2);
        assert.equal(traces[0].outcome, 'primary-miss');
        assert.equal(traces[1].outcome, 'activated');
        assert.equal(traces[1].match.primaryMatch.expanded, 'unlock');
        assert.equal(traces[1].match.primaryMatch.value, 'unlock');
        assert.equal('scanText' in traces[1], false);
    });

    await t.test('minimum activation depth', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [makeEntry(1, { key: ['older'], content: 'found' })],
            messages: ['newest', 'older'],
            settings: {
                depth: 1,
                minActivations: 1,
                minActivationsDepthMax: 2,
            },
        }));
        assert.deepEqual(result.rounds.map(round => round.state), [
            SCAN_STATE.INITIAL,
            SCAN_STATE.MIN_ACTIVATIONS,
        ]);
        assert.deepEqual(result.rounds.map(round => round.depth), [1, 2]);
        assert.deepEqual(result.activated.map(item => item.id), ['Book.1']);
    });
});

test('inclusion groups are seed-stable and group scoring keeps the strongest match', async (t) => {
    const weightedEntries = [
        makeEntry(1, { constant: true, group: 'choice', groupWeight: 100 }),
        makeEntry(2, { constant: true, group: 'choice', groupWeight: 100 }),
    ];
    const seedSeven = await simulateWorldInfo(makeSimulationRequest({ entries: weightedEntries, seed: 7 }));
    const seedSevenAgain = await simulateWorldInfo(makeSimulationRequest({ entries: weightedEntries, seed: 7 }));
    const seedOne = await simulateWorldInfo(makeSimulationRequest({ entries: weightedEntries, seed: 1 }));
    assert.deepEqual(seedSevenAgain, seedSeven);
    assert.deepEqual(seedSeven.activated.map(item => item.id), ['Book.1']);
    assert.deepEqual(seedOne.activated.map(item => item.id), ['Book.2']);
    assert.equal(seedSeven.traces.find(trace => trace.outcome === 'activated')
        .stages.find(stage => stage.name === 'Inclusion group').reason, 'weighted-roll');

    await t.test('scoring', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [
                makeEntry(3, { key: ['alpha'], group: 'score' }),
                makeEntry(4, { key: ['alpha', 'beta'], group: 'score' }),
            ],
            messages: ['alpha beta'],
            settings: { useGroupScoring: true },
        }));
        assert.deepEqual(result.activated.map(item => item.id), ['Book.4']);
        const loser = result.traces.find(trace => trace.uid === 3);
        assert.equal(loser.outcome, 'group-rejected');
        assert.deepEqual(loser.stages.at(-1), {
            name: 'Inclusion group',
            status: 'fail',
            group: 'score',
            reason: 'lower-score',
            score: 1,
            maximum: 2,
        });
        assert.deepEqual(result.traces.find(trace => trace.uid === 4)
            .stages.find(stage => stage.name === 'Group score'), {
            name: 'Group score',
            status: 'pass',
            group: 'score',
            score: 2,
            maximum: 2,
        });
    });
});

test('duplicate IDs retain object identity across recursive rounds', async () => {
    const result = await simulateWorldInfo(makeSimulationRequest({
        entries: [
            makeEntry(9, { constant: true, content: 'unlock' }),
            makeEntry(9, {
                constant: false,
                key: ['unlock'],
                content: 'second',
                delayUntilRecursion: true,
                preventRecursion: true,
            }),
        ],
        settings: { recursive: true },
    }));
    assert.deepEqual(result.activated.map(item => item.id), ['Book.9', 'Book.9']);
    assert.deepEqual(result.rounds.map(round => round.activated), [['Book.9'], ['Book.9']]);
    assert.equal(result.traces.find(trace => trace.entryIndex === 0 && trace.round === 2).outcome, 'already-activated');
    assert.equal(result.traces.find(trace => trace.entryIndex === 1 && trace.round === 2).outcome, 'activated');
    assert.equal(result.placements.records.filter(record => record.id === 'Book.9').length, 2);
});

test('forced candidates are evaluated ahead of earlier ordinary candidates', async () => {
    const result = await simulateWorldInfo(makeSimulationRequest({
        entries: [
            makeEntry(1, { constant: true, content: 'R' }),
            makeEntry(2, { key: ['does-not-match'], content: 'F' }),
        ],
        forcedIds: ['Book.2'],
        settings: { budgetPercent: 100 },
        maxContext: 3,
    }));
    assert.deepEqual(result.rounds[0].candidates, ['Book.2', 'Book.1']);
    assert.deepEqual(result.activated.map(item => item.id), ['Book.2']);
    assert.equal(result.activated[0].activationReason, 'forced');
    assert.equal(result.traces.find(trace => trace.uid === 1).outcome, 'budget-rejected');
});

test('reserved JavaScript property names are safe inclusion groups', async () => {
    const names = ['__proto__', 'constructor', 'toString'];
    const result = await simulateWorldInfo(makeSimulationRequest({
        entries: names.map((group, index) => makeEntry(index + 1, { constant: true, group })),
    }));
    assert.deepEqual(result.activated.map(item => item.id), ['Book.1', 'Book.2', 'Book.3']);
    for (const name of names) {
        const trace = result.traces.find(item => item.uid === names.indexOf(name) + 1);
        assert.equal(trace.stages.find(stage => stage.name === 'Inclusion group').group, name);
    }
});

test('placements preserve order, all position buckets, reserved outlets, and regex depth', () => {
    const regexCalls = [];
    const processRegex = (content, depth) => {
        regexCalls.push([content, depth]);
        return content === 'drop' ? '' : `${content}@${depth ?? 'none'}`;
    };
    const entries = [
        makeEntry(1, { order: 20, position: POSITION.before, content: 'before-high' }),
        makeEntry(2, { order: 10, position: POSITION.before, content: 'before-low' }),
        makeEntry(3, { order: 30, position: POSITION.after, content: 'after' }),
        makeEntry(4, { order: 40, position: POSITION.EMTop, content: 'example-top' }),
        makeEntry(5, { order: 50, position: POSITION.EMBottom, content: 'example-bottom' }),
        makeEntry(6, { order: 60, position: POSITION.ANTop, content: 'note-top' }),
        makeEntry(7, { order: 70, position: POSITION.ANBottom, content: 'note-bottom' }),
        makeEntry(8, { order: 90, position: POSITION.atDepth, content: 'depth-high', role: 1, depth: 2 }),
        makeEntry(9, { order: 80, position: POSITION.atDepth, content: 'depth-low', role: 1, depth: 2 }),
        makeEntry(10, { order: 100, position: POSITION.atDepth, content: 'default-depth' }),
        makeEntry(11, { order: 110, position: POSITION.outlet, outletName: '__proto__', content: 'proto' }),
        makeEntry(12, { order: 120, position: POSITION.outlet, outletName: 'constructor', content: 'ctor' }),
        makeEntry(13, { order: 130, position: POSITION.outlet, outletName: 'toString', content: 'stringer' }),
        makeEntry(14, { order: 140, position: POSITION.outlet, outletName: '', content: 'unnamed' }),
        makeEntry(15, { order: 150, position: 999, content: 'fallback' }),
        makeEntry(16, { order: 160, position: POSITION.after, content: 'drop' }),
    ];
    const placements = buildPlacements(entries, processRegex);

    assert.equal(placements.worldInfoBefore, 'before-low@none\nbefore-high@none\nfallback@none');
    assert.equal(placements.worldInfoAfter, 'after@none');
    assert.deepEqual(placements.examples, [
        { position: 0, content: 'example-top@none' },
        { position: 1, content: 'example-bottom@none' },
    ]);
    assert.deepEqual(placements.authorNoteBefore, ['note-top@none']);
    assert.deepEqual(placements.authorNoteAfter, ['note-bottom@none']);
    assert.deepEqual(placements.atDepth, [
        { depth: 4, role: 0, entries: ['default-depth@4'] },
        { depth: 2, role: 1, entries: ['depth-low@2', 'depth-high@2'] },
    ]);
    assert.equal(Object.getPrototypeOf(placements.outlets), null);
    assert.deepEqual(placements.outlets.__proto__, ['proto@none']);
    assert.deepEqual(placements.outlets.constructor, ['ctor@none']);
    assert.deepEqual(placements.outlets.toString, ['stringer@none']);
    assert.ok(regexCalls.some(([content, depth]) => content === 'default-depth' && depth === 4));
    assert.ok(regexCalls.some(([content, depth]) => content === 'before-high' && depth === null));
    assert.equal(placements.records.find(record => record.uid === 14).omissionReason, 'missing-outlet-name');
    assert.equal(placements.records.find(record => record.uid === 16).omissionReason, 'empty-after-regex');
    assert.deepEqual(placements.records.map(record => record.order), entries.map(entry => entry.order).sort((a, b) => a - b));
});

test('character tag filters are skipped only when tags are unavailable', async (t) => {
    const entry = makeEntry(1, {
        constant: true,
        characterFilter: { names: [], tags: ['mage'], isExclude: false },
    });

    await t.test('unavailable', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [entry],
            character: { filename: 'Character', tags: [], tagsAvailable: false },
        }));
        assert.deepEqual(result.activated.map(item => item.id), ['Book.1']);
    });

    await t.test('available but missing', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [entry],
            character: { filename: 'Character', tags: [], tagsAvailable: true },
        }));
        assert.deepEqual(result.activated, []);
        assert.equal(result.traces[0].outcome, 'character-filtered');
        assert.equal(result.traces[0].stages.at(-1).kind, 'character-tag');
    });

    await t.test('available and matching', async () => {
        const result = await simulateWorldInfo(makeSimulationRequest({
            entries: [entry],
            character: { filename: 'Character', tags: ['mage'], tagsAvailable: true },
        }));
        assert.deepEqual(result.activated.map(item => item.id), ['Book.1']);
    });
});
