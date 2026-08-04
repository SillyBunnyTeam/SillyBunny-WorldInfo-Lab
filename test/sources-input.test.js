import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_SCAN_SETTINGS,
    POSITION,
    SOURCE_STRATEGY,
} from '../src/constants.js';
import { __setHostForTests } from '../src/host.js';
import { buildSimulationRequest } from '../src/scan-input.js';
import {
    getActiveBookPlan,
    normalizeScanSettings,
    parseDecorators,
    snapshotLorebooks,
} from '../src/sources.js';
import {
    clone,
    installContext,
    makeHost,
    makeMemoryContext,
} from './helpers/fixtures.js';

test('scan settings normalize native names and decorators preserve fallback semantics', () => {
    assert.deepEqual(normalizeScanSettings({
        world_info_depth: '5',
        world_info_min_activations: '2',
        world_info_min_activations_depth_max: '9',
        world_info_budget: '30',
        world_info_budget_cap: '700',
        world_info_include_names: false,
        world_info_recursive: true,
        world_info_case_sensitive: true,
        world_info_match_whole_words: true,
        world_info_use_group_scoring: true,
        world_info_character_strategy: String(SOURCE_STRATEGY.global_first),
        world_info_max_recursion_steps: '12',
    }), {
        depth: 5,
        minActivations: 2,
        minActivationsDepthMax: 9,
        budgetPercent: 30,
        budgetCap: 700,
        includeNames: false,
        recursive: true,
        caseSensitive: true,
        matchWholeWords: true,
        useGroupScoring: true,
        characterStrategy: SOURCE_STRATEGY.global_first,
        maxRecursionSteps: 12,
    });
    assert.deepEqual(normalizeScanSettings(), DEFAULT_SCAN_SETTINGS);

    assert.deepEqual(parseDecorators('ordinary content'), {
        decorators: [],
        content: 'ordinary content',
    });
    assert.deepEqual(parseDecorators('@@activate\n@@dont_activate reason\nbody\nmore'), {
        decorators: ['@@activate', '@@dont_activate reason'],
        content: 'body\nmore',
    });
    assert.deepEqual(parseDecorators('@@unknown\n@@@activate\nfallback body'), {
        decorators: ['@@activate'],
        content: 'fallback body',
    });
    assert.deepEqual(parseDecorators('@@activate\n@@@dont_activate\nbody'), {
        decorators: ['@@activate'],
        content: 'body',
    });
});

test('active source plans deduplicate books by source precedence', () => {
    const context = {
        characterId: 0,
        characters: [{
            avatar: 'Hero.png',
            data: { extensions: { world: 'CharacterBook' } },
        }],
        chatMetadata: { world_info: 'Shared' },
        powerUserSettings: { persona_description_lorebook: 'PersonaBook' },
        worldInfoSettings: {
            globalSelect: ['GlobalBook', 'Shared'],
            charLore: [{ name: 'Hero', extraBooks: ['ExtraBook', 'GlobalBook', 'CharacterBook'] }],
        },
    };
    assert.deepEqual(getActiveBookPlan(context), {
        chat: [],
        persona: ['PersonaBook'],
        character: ['CharacterBook', 'ExtraBook'],
        global: ['GlobalBook', 'Shared'],
        all: ['PersonaBook', 'CharacterBook', 'ExtraBook', 'GlobalBook', 'Shared'],
    });

    const host = makeHost({
        worldInfo: { selected_world_info: ['LiveGlobal', 'Shared'] },
        utils: { getCharaFilename: () => 'Hero' },
    });
    assert.deepEqual(getActiveBookPlan(context, host), {
        chat: [],
        persona: ['PersonaBook'],
        character: ['CharacterBook', 'ExtraBook', 'GlobalBook'],
        global: ['LiveGlobal', 'Shared'],
        all: ['PersonaBook', 'CharacterBook', 'ExtraBook', 'GlobalBook', 'LiveGlobal', 'Shared'],
    });
});

test('lorebook snapshots normalize entries, decorators, missing books, and source ordering', async (t) => {
    const host = makeHost();
    __setHostForTests(host);
    t.after(() => __setHostForTests(null));

    const context = makeMemoryContext({
        Chat: { entries: { 1: { comment: 'chat', content: 'chat', key: ['x'], order: 1, position: 999 } } },
        Persona: { entries: { 2: { comment: 'persona', content: 'persona', key: ['x'], order: 1 } } },
        Character: { entries: {
            3: { comment: 'char-low', content: 'char-low', key: ['x'], order: 2 },
            4: { comment: 'char-high', content: '@@activate\nchar-high', key: ['x'], order: 10 },
        } },
        Global: { entries: {
            alpha: { comment: 'global-high', content: 'global-high', key: ['x'], order: 9 },
            6: { uid: 'custom', comment: 'global-low', content: 'global-low', key: ['x'], order: 3 },
        } },
    });
    const sourcePlan = {
        chat: ['Chat', 'Chat'],
        persona: ['Persona'],
        character: ['Character'],
        global: ['Global', 'Missing'],
    };

    const characterFirst = await snapshotLorebooks({
        context,
        sourcePlan,
        settings: { ...DEFAULT_SCAN_SETTINGS, characterStrategy: SOURCE_STRATEGY.character_first },
    });
    assert.deepEqual(characterFirst.plan, {
        chat: ['Chat'],
        persona: ['Persona'],
        character: ['Character'],
        global: ['Global', 'Missing'],
        all: ['Chat', 'Persona', 'Character', 'Global', 'Missing'],
    });
    assert.deepEqual(characterFirst.entries.map(entry => entry.comment), [
        'chat',
        'persona',
        'char-high',
        'char-low',
        'global-high',
        'global-low',
    ]);
    assert.deepEqual(characterFirst.entries.map(entry => entry.labSource), [
        'chat',
        'persona',
        'character',
        'character',
        'global',
        'global',
    ]);
    assert.equal(characterFirst.entries[0].position, POSITION.before);
    assert.equal(characterFirst.entries[2].content, 'char-high');
    assert.deepEqual(characterFirst.entries[2].decorators, ['@@activate']);
    assert.equal(typeof characterFirst.entries[2].hash, 'number');
    assert.equal(characterFirst.entries.find(entry => entry.comment === 'global-high').uid, 'alpha');
    assert.equal(characterFirst.entries.find(entry => entry.comment === 'global-low').uid, 'custom');
    assert.deepEqual(characterFirst.missing, ['Missing']);
    assert.match(characterFirst.warnings.join('\n'), /Could not load these lorebooks: Missing/);
    assert.deepEqual(characterFirst.entryIndex.get('Character.4'), [2]);

    const globalFirst = await snapshotLorebooks({
        context,
        sourcePlan,
        settings: { ...DEFAULT_SCAN_SETTINGS, characterStrategy: SOURCE_STRATEGY.global_first },
    });
    assert.deepEqual(globalFirst.entries.map(entry => entry.comment), [
        'chat', 'persona', 'global-high', 'global-low', 'char-high', 'char-low',
    ]);

    const evenly = await snapshotLorebooks({
        context,
        sourcePlan,
        settings: { ...DEFAULT_SCAN_SETTINGS, characterStrategy: SOURCE_STRATEGY.evenly },
    });
    assert.deepEqual(evenly.entries.map(entry => entry.comment), [
        'chat', 'persona', 'char-high', 'global-high', 'global-low', 'char-low',
    ]);

    const loadedBook = characterFirst.books.get('Chat');
    loadedBook.entries[1].content = 'mutated snapshot';
    assert.equal((await context.loadWorldInfo('Chat')).entries[1].content, 'chat');
});

test('simulation requests reconstruct chat, freeze macros, expose regex depth, and report tag availability', async (t) => {
    let substitutions = 0;
    const regexCalls = [];
    const host = makeHost({
        regex: {
            regex_placement: { WORLD_INFO: 'world-info' },
            getRegexedString(content, placement, options) {
                regexCalls.push({ content, placement, options: clone(options) });
                return `${content}:${options.depth}`;
            },
        },
        tags: { getTagKeyForEntity: () => 'character:0' },
        utils: { getCharaFilename: () => 'HeroFile' },
        script: { getMaxPromptTokens: () => 2048 },
    });
    __setHostForTests(host);
    t.after(() => __setHostForTests(null));

    const context = makeMemoryContext({}, {
        characterId: 0,
        chat: [
            { is_user: true, name: 'Alice', mes: 'hello' },
            { is_system: true, mes: 'hidden' },
            { is_user: false, name: 'Bunny', mes: 'last swipe' },
        ],
        name1: 'User',
        name2: 'Character',
        extensionPrompts: {
            included: { scan: true, value: 'scan injection' },
            excluded: { scan: false, value: 'not scanned' },
        },
        tagMap: { 'character:0': ['mage', 'friend'] },
        getCharacterCardFields: () => ({
            persona: 'persona',
            description: 'description',
            personality: 'personality',
            charDepthPrompt: 'depth prompt',
            scenario: 'scenario',
            creatorNotes: 'notes',
        }),
        substituteParams(value) {
            substitutions++;
            return `${value}:expanded-${substitutions}`;
        },
    });
    const restore = installContext(context);
    t.after(restore);

    const snapshot = {
        entries: [{ uid: 1, world: 'Book', vectorized: true }],
        settings: { ...DEFAULT_SCAN_SETTINGS, includeNames: true },
        warnings: ['snapshot warning'],
        plan: { chat: [], persona: [], character: [], global: ['Book'], all: ['Book'] },
    };
    const request = await buildSimulationRequest(snapshot, {
        context,
        mode: 'chat',
        trigger: 'swipe',
        seed: -1,
        forcedIds: ['Book.1', 'Book.1'],
    });
    assert.deepEqual(request.messages, ['Alice: hello']);
    assert.deepEqual(request.injections, ['scan injection']);
    assert.equal(request.maxContext, 2048);
    assert.equal(request.seed, 0xffffffff);
    assert.deepEqual(request.forcedIds, ['Book.1']);
    assert.deepEqual(request.character, {
        filename: 'HeroFile',
        tags: ['mage', 'friend'],
        tagsAvailable: true,
    });
    assert.equal(request.globalScanData.scenario, 'scenario');
    assert.equal(request.globalScanData.trigger, 'swipe');
    assert.match(request.warnings.join('\n'), /Vector matching is not simulated/);
    assert.match(request.warnings.join('\n'), /This scan uses the saved chat/);

    const volatile = '{{random}}';
    assert.equal(request.expand(volatile), '{{random}}:expanded-1');
    assert.equal(request.expand(volatile), '{{random}}:expanded-1');
    assert.equal(substitutions, 1);
    assert.equal(request.volatileMacros.has(volatile), true);
    assert.equal(request.processRegex('entry', 7), 'entry:7');
    assert.deepEqual(regexCalls, [{
        content: 'entry',
        placement: 'world-info',
        options: { depth: 7, isMarkdown: false, isPrompt: true },
    }]);

    __setHostForTests(makeHost({ tags: null }));
    const textRequest = await buildSimulationRequest(snapshot, {
        context,
        mode: 'text',
        text: '  pasted text  ',
        trigger: 'invalid-trigger',
    });
    assert.deepEqual(textRequest.messages, ['pasted text']);
    assert.equal(textRequest.trigger, 'normal');
    assert.deepEqual(textRequest.character.tags, []);
    assert.equal(textRequest.character.tagsAvailable, false);
});
