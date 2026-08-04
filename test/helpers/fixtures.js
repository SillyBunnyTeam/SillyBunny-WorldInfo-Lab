import {
    DEFAULT_SCAN_SETTINGS,
    POSITION,
} from '../../src/constants.js';
import { parseRegexKey } from '../../src/simulator/matching.js';

export function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

export function makeEntry(uid, overrides = {}) {
    return {
        uid,
        world: 'Book',
        comment: `Entry ${uid}`,
        key: ['match'],
        keysecondary: [],
        content: `content-${uid}`,
        order: Number(uid) || 0,
        position: POSITION.before,
        ...overrides,
    };
}

export function makeSimulationRequest(overrides = {}) {
    return {
        mode: 'text',
        entries: [],
        messages: ['match'],
        injections: [],
        settings: { ...DEFAULT_SCAN_SETTINGS },
        maxContext: 10000,
        trigger: 'normal',
        seed: 1,
        forcedIds: [],
        timedEffects: { sticky: [], cooldown: [], delay: [] },
        character: { filename: 'Character', tags: [], tagsAvailable: true },
        globalScanData: {},
        expand: value => String(value ?? ''),
        macroSnapshot: new Map(),
        volatileMacros: new Set(),
        tokenCount: async value => String(value ?? '').length,
        parseRegex: parseRegexKey,
        processRegex: null,
        warnings: [],
        sourcePlan: { chat: [], persona: [], character: [], global: ['Book'], all: ['Book'] },
        ...overrides,
        settings: { ...DEFAULT_SCAN_SETTINGS, ...(overrides.settings ?? {}) },
    };
}

function stringHash(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function setPath(target, path, value) {
    const parts = String(path).split('.');
    let current = target;
    for (const part of parts.slice(0, -1)) {
        if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
            current[part] = {};
        }
        current = current[part];
    }
    current[parts.at(-1)] = clone(value);
}

const originalWIDataKeyMap = {
    content: 'content',
    depth: 'extensions.depth',
    groupWeight: 'extensions.group_weight',
    matchWholeWords: 'extensions.match_whole_words',
    order: 'insertion_order',
    position: 'extensions.position',
    probability: 'extensions.probability',
    scanDepth: 'extensions.scan_depth',
    selectiveLogic: 'extensions.selectiveLogic',
    useProbability: 'extensions.useProbability',
};

export function makeHost(overrides = {}) {
    const base = {
        ok: true,
        worldInfo: {
            getWorldInfoSettings: () => ({}),
            originalWIDataKeyMap,
            parseRegexFromString: parseRegexKey,
            selected_world_info: [],
            setWIOriginalDataValue(data, uid, path, value) {
                const mappedIndex = data.originalDataUidMap?.[uid];
                const entry = Number.isInteger(mappedIndex) && data.originalData?.entries?.[mappedIndex]
                    ? data.originalData.entries[mappedIndex]
                    : data.originalData?.entries?.find(item => String(item.id ?? item.uid) === String(uid));
                if (entry) {
                    setPath(entry, path, value);
                }
            },
            world_info_position: POSITION,
        },
        scanCore: {
            normalizeWorldInfoProbability(entry) {
                const value = Number(entry.probability ?? entry.extensions?.probability ?? 100);
                return {
                    ...entry,
                    probability: Number.isFinite(value) ? value : 100,
                    useProbability: entry.useProbability ?? entry.extensions?.useProbability ?? true,
                };
            },
            getWorldInfoGroupNames: () => [],
        },
        scanChat: {
            buildWorldInfoScanChat: () => [],
        },
        characterBook: {
            normalizeWorldInfoPosition(value) {
                const position = Number(value);
                return Object.values(POSITION).includes(position) ? position : POSITION.before;
            },
        },
        regex: null,
        utils: {
            getStringHash: stringHash,
            getCharaFilename: () => 'Character',
        },
        tags: {
            getTagKeyForEntity: () => null,
        },
        script: {
            getMaxPromptTokens: () => 4096,
        },
        warnings: [],
    };

    return {
        ...base,
        ...overrides,
        worldInfo: { ...base.worldInfo, ...(overrides.worldInfo ?? {}) },
        scanCore: { ...base.scanCore, ...(overrides.scanCore ?? {}) },
        scanChat: { ...base.scanChat, ...(overrides.scanChat ?? {}) },
        characterBook: { ...base.characterBook, ...(overrides.characterBook ?? {}) },
        utils: { ...base.utils, ...(overrides.utils ?? {}) },
        script: { ...base.script, ...(overrides.script ?? {}) },
    };
}

export function installContext(context) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SillyTavern');
    Object.defineProperty(globalThis, 'SillyTavern', {
        configurable: true,
        writable: true,
        value: { getContext: () => context },
    });
    return () => {
        if (descriptor) {
            Object.defineProperty(globalThis, 'SillyTavern', descriptor);
        } else {
            delete globalThis.SillyTavern;
        }
    };
}

export function makeMemoryContext(initialBooks = {}, overrides = {}) {
    const books = new Map(Object.entries(initialBooks).map(([name, book]) => [name, clone(book)]));
    const context = {
        books,
        extensionSettings: {},
        characterId: 0,
        characters: [{ avatar: 'Character.png', data: { extensions: {} } }],
        chat: [],
        chatMetadata: {},
        worldInfoSettings: {},
        powerUserSettings: {},
        tagMap: {},
        async loadWorldInfo(name) {
            if (!books.has(name)) {
                throw new Error(`Missing book: ${name}`);
            }
            return clone(books.get(name));
        },
        async saveWorldInfo(name, book) {
            books.set(name, clone(book));
        },
        getWorldInfoNames: () => [...books.keys()],
        getTokenCountAsync: async value => String(value ?? '').length,
        substituteParams: value => String(value ?? ''),
        getCharacterCardFields: () => ({}),
        uuidv4: () => 'case-id',
        ...overrides,
    };
    return context;
}
