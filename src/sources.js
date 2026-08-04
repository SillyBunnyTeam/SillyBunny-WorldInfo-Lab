import {
    DEFAULT_SCAN_SETTINGS,
    POSITION,
    SOURCE_STRATEGY,
    entryId,
} from './constants.js';
import { getContext, loadHost } from './host.js';

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function stripExtension(value) {
    return String(value ?? '').replace(/\.[^/.]+$/, '');
}

export function parseDecorators(value) {
    const content = String(value ?? '');
    if (!content.startsWith('@@')) {
        return { decorators: [], content };
    }
    const lines = content.split(/\r?\n/);
    const decorators = [];
    let fallback = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.startsWith('@@')) {
            return { decorators, content: lines.slice(index).join('\n') };
        }
        if (line.startsWith('@@@') && !fallback) {
            continue;
        }
        const normalized = line.startsWith('@@@') ? line.slice(1) : line;
        if (normalized.startsWith('@@activate') || normalized.startsWith('@@dont_activate')) {
            decorators.push(normalized);
            fallback = false;
        } else {
            fallback = true;
        }
    }
    return { decorators, content: '' };
}

export function normalizeScanSettings(raw = {}) {
    return {
        depth: Number(raw.world_info_depth ?? raw.depth ?? DEFAULT_SCAN_SETTINGS.depth),
        minActivations: Number(raw.world_info_min_activations ?? raw.minActivations ?? DEFAULT_SCAN_SETTINGS.minActivations),
        minActivationsDepthMax: Number(raw.world_info_min_activations_depth_max ?? raw.minActivationsDepthMax ?? DEFAULT_SCAN_SETTINGS.minActivationsDepthMax),
        budgetPercent: Number(raw.world_info_budget ?? raw.budgetPercent ?? DEFAULT_SCAN_SETTINGS.budgetPercent),
        budgetCap: Number(raw.world_info_budget_cap ?? raw.budgetCap ?? DEFAULT_SCAN_SETTINGS.budgetCap),
        includeNames: Boolean(raw.world_info_include_names ?? raw.includeNames ?? DEFAULT_SCAN_SETTINGS.includeNames),
        recursive: Boolean(raw.world_info_recursive ?? raw.recursive ?? DEFAULT_SCAN_SETTINGS.recursive),
        caseSensitive: Boolean(raw.world_info_case_sensitive ?? raw.caseSensitive ?? DEFAULT_SCAN_SETTINGS.caseSensitive),
        matchWholeWords: Boolean(raw.world_info_match_whole_words ?? raw.matchWholeWords ?? DEFAULT_SCAN_SETTINGS.matchWholeWords),
        useGroupScoring: Boolean(raw.world_info_use_group_scoring ?? raw.useGroupScoring ?? DEFAULT_SCAN_SETTINGS.useGroupScoring),
        characterStrategy: Number(raw.world_info_character_strategy ?? raw.characterStrategy ?? DEFAULT_SCAN_SETTINGS.characterStrategy),
        maxRecursionSteps: Number(raw.world_info_max_recursion_steps ?? raw.maxRecursionSteps ?? DEFAULT_SCAN_SETTINGS.maxRecursionSteps),
    };
}

export function getActiveBookPlan(context = getContext(), host = null) {
    const liveGlobal = host?.worldInfo?.selected_world_info;
    const global = [...(
        Array.isArray(liveGlobal)
            ? liveGlobal
            : (context?.worldInfoSettings?.globalSelect ?? [])
    )].filter(Boolean);
    const chat = context?.chatMetadata?.world_info;
    const persona = context?.powerUserSettings?.persona_description_lorebook;
    const character = context?.characters?.[context?.characterId];
    const filename = host?.utils?.getCharaFilename?.(context?.characterId)
        ?? stripExtension(character?.avatar);
    const characterBooks = [];
    const addCharacter = (name) => {
        if (name && !characterBooks.includes(name)) {
            characterBooks.push(name);
        }
    };
    addCharacter(character?.data?.extensions?.world);
    const extras = context?.worldInfoSettings?.charLore?.find(item => item?.name === filename)?.extraBooks ?? [];
    extras.forEach(addCharacter);

    const globalSet = new Set(global);
    const chatName = chat && !globalSet.has(chat) ? chat : '';
    const personaName = persona && persona !== chatName && !globalSet.has(persona) ? persona : '';
    const characterFiltered = characterBooks.filter(name => (
        !globalSet.has(name) && name !== chatName && name !== personaName
    ));

    return {
        chat: chatName ? [chatName] : [],
        persona: personaName ? [personaName] : [],
        character: characterFiltered,
        global,
        all: [...new Set([
            ...(chatName ? [chatName] : []),
            ...(personaName ? [personaName] : []),
            ...characterFiltered,
            ...global,
        ])],
    };
}

function getWorldEntries(data, world, source) {
    if (!data?.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        return [];
    }
    return Object.entries(data.entries)
        .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map(([key, entry]) => {
            const { uid = Number.isNaN(Number(key)) ? key : Number(key), ...rest } = entry;
            return { uid, world, ...clone(rest), labSource: source };
        });
}

function sortDescending(entries) {
    return entries.sort((a, b) => b.order - a.order);
}

function sortByStrategy(groups, strategy) {
    const character = [...groups.character];
    const global = [...groups.global];
    let remainder;
    switch (Number(strategy)) {
        case SOURCE_STRATEGY.character_first:
            remainder = [...sortDescending(character), ...sortDescending(global)];
            break;
        case SOURCE_STRATEGY.global_first:
            remainder = [...sortDescending(global), ...sortDescending(character)];
            break;
        case SOURCE_STRATEGY.evenly:
        default:
            remainder = sortDescending([...global, ...character]);
            break;
    }
    return [
        ...sortDescending([...groups.chat]),
        ...sortDescending([...groups.persona]),
        ...remainder,
    ];
}

function normalizePlan(value) {
    const plan = {};
    for (const source of ['chat', 'persona', 'character', 'global']) {
        plan[source] = Array.isArray(value?.[source])
            ? [...new Set(value[source].filter(name => typeof name === 'string' && name))]
            : [];
    }
    plan.all = [...new Set([
        ...plan.chat,
        ...plan.persona,
        ...plan.character,
        ...plan.global,
    ])];
    return plan;
}

export async function snapshotLorebooks({
    context = getContext(),
    bookNames = null,
    sourcePlan = null,
    settings: settingsOverride = null,
} = {}) {
    if (!context || typeof context.loadWorldInfo !== 'function') {
        throw new Error('World Info loading is unavailable.');
    }
    const host = await loadHost();
    if (!host.ok) {
        throw new Error(host.reason);
    }
    const rawSettings = host.worldInfo.getWorldInfoSettings();
    const settings = settingsOverride
        ? normalizeScanSettings(settingsOverride)
        : normalizeScanSettings(rawSettings);
    const plan = sourcePlan
        ? normalizePlan(sourcePlan)
        : bookNames
            ? normalizePlan({ global: bookNames })
            : getActiveBookPlan(context, host);
    const results = await Promise.allSettled(plan.all.map(async name => [name, await context.loadWorldInfo(name)]));
    const loaded = results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
    const books = new Map(loaded.filter(([, data]) => data).map(([name, data]) => [name, clone(data)]));
    const missing = plan.all.filter(name => !books.has(name));
    const groups = { chat: [], persona: [], character: [], global: [] };
    for (const source of Object.keys(groups)) {
        for (const name of plan[source]) {
            groups[source].push(...getWorldEntries(books.get(name), name, source));
        }
    }
    const entries = sortByStrategy(groups, settings.characterStrategy).map((raw) => {
        const { labSource, ...entryWithoutSource } = raw;
        const decorated = parseDecorators(entryWithoutSource.content);
        const decoratedEntry = { ...entryWithoutSource, ...decorated };
        const hash = host.utils.getStringHash(JSON.stringify(decoratedEntry));
        const position = host.characterBook.normalizeWorldInfoPosition(
            decoratedEntry.position,
            host.worldInfo.world_info_position,
        ) ?? POSITION.before;
        return {
            ...host.scanCore.normalizeWorldInfoProbability({ ...decoratedEntry, position }),
            hash,
            labSource,
        };
    });
    return {
        plan,
        books,
        entries: clone(entries),
        settings,
        missing,
        warnings: [
            ...(host.warnings ?? []),
            ...(missing.length ? [`Could not load: ${missing.join(', ')}`] : []),
            'The simulation does not invoke WORLDINFO_ENTRIES_LOADED listeners that can mutate native scan entries.',
        ],
        entryIndex: entries.reduce((index, entry, position) => {
            const id = entryId(entry);
            const positions = index.get(id) ?? [];
            positions.push(position);
            index.set(id, positions);
            return index;
        }, new Map()),
    };
}
