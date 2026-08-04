import { GENERATION_TRIGGERS, entryId } from './constants.js';
import { countTokens, getContext, loadHost, substitute } from './host.js';

const VOLATILE_MACRO = /{{\s*(?:random|randomPick|roll|dice|time|date|idle|pick|uuid)\b/i;

function buildMacroSnapshot(overrides = {}) {
    const cache = new Map(Object.entries(overrides));
    const volatile = new Set();
    const expand = (value) => {
        const input = String(value ?? '');
        if (cache.has(input)) {
            return cache.get(input);
        }
        if (VOLATILE_MACRO.test(input)) {
            volatile.add(input);
        }
        const output = substitute(input);
        cache.set(input, output);
        return output;
    };
    return { cache, volatile, expand };
}

function getCharacterFilename(context, host) {
    const liveFilename = host?.utils?.getCharaFilename?.(context?.characterId);
    if (liveFilename !== undefined && liveFilename !== null) {
        return String(liveFilename);
    }
    const avatar = context?.characters?.[context?.characterId]?.avatar;
    return String(avatar ?? '').replace(/\.[^/.]+$/, '');
}

async function getCharacterTags(context, host) {
    const tagKey = host.tags?.getTagKeyForEntity?.(context?.characterId);
    const tags = tagKey ? context?.tagMap?.[tagKey] : null;
    return {
        tags: Array.isArray(tags) ? [...tags] : [],
        tagsAvailable: Array.isArray(tags),
    };
}

function currentChatMessages(context, includeNames, trigger) {
    const messages = (context?.chat ?? [])
        .filter(message => message && !message.is_system && typeof message.mes === 'string')
        .map((message, index) => ({
            index,
            name: String(message.name ?? (message.is_user ? context.name1 : context.name2) ?? ''),
            mes: String(message.mes ?? ''),
        }))
        .map(message => includeNames ? `${message.name}: ${message.mes}` : message.mes);
    if (trigger === 'swipe') {
        messages.pop();
    }
    return messages.reverse();
}

function pastedMessages(text) {
    const value = String(text ?? '').trim();
    return value ? [value] : [];
}

function getScanInjections(context) {
    return Object.values(context?.extensionPrompts ?? {})
        .filter(prompt => prompt?.scan && prompt?.value)
        .map(prompt => String(prompt.value));
}

function getTimedEffects(context, entries, chatLength) {
    const metadata = context?.chatMetadata?.timedWorldInfo ?? {};
    const result = { sticky: [], cooldown: [], delay: [] };
    for (const entry of entries) {
        const id = entryId(entry);
        if (entry.delay && chatLength < Number(entry.delay)) {
            result.delay.push(id);
        }
        for (const type of ['sticky', 'cooldown']) {
            const effect = metadata?.[type]?.[id];
            if (!effect || !entry[type]) {
                continue;
            }
            const hashMatches = effect.hash === undefined || String(effect.hash) === String(entry.hash);
            const advanced = chatLength > Number(effect.start) || effect.protected;
            if (hashMatches && advanced && chatLength < Number(effect.end)) {
                result[type].push(id);
            } else if (type === 'sticky' && hashMatches && advanced
                && chatLength >= Number(effect.end) && entry.cooldown) {
                result.cooldown.push(id);
            }
        }
    }
    result.cooldown = [...new Set(result.cooldown)];
    return result;
}

export async function buildSimulationRequest(snapshot, options = {}) {
    const context = options.context ?? getContext();
    const host = await loadHost();
    if (!host.ok) {
        throw new Error(host.reason);
    }
    const mode = options.mode === 'text' ? 'text' : 'chat';
    const trigger = GENERATION_TRIGGERS.includes(options.trigger) ? options.trigger : 'normal';
    const messages = Array.isArray(options.messages)
        ? options.messages.map(value => String(value ?? ''))
        : mode === 'text'
            ? pastedMessages(options.text)
            : currentChatMessages(context, snapshot.settings.includeNames, trigger);
    const fields = context?.getCharacterCardFields?.() ?? {};
    const macros = buildMacroSnapshot(options.macroSnapshot);
    const injections = Array.isArray(options.injections)
        ? options.injections.map(value => String(value ?? ''))
        : mode === 'chat' ? getScanInjections(context) : [];
    const promptLimit = host.script.getMaxPromptTokens();
    const maxContext = Math.max(1, Number(options.maxContext ?? promptLimit ?? context?.maxContext ?? 4096));
    const warnings = [...snapshot.warnings];
    if (mode === 'chat') {
        warnings.push('Current-chat input is reconstructed and may differ from generation-time regex, OOC, attachment, reasoning, or supplemental-message processing.');
        warnings.push('The configured prompt-token ceiling is used; provider negotiation or CFG can reduce the native generation budget.');
    }
    if (injections.length) {
        warnings.push('Scan-enabled extension prompts use their visible values; generation-time prompt filtering is not available.');
    }
    if (snapshot.entries.some(entry => entry.vectorized)) {
        warnings.push('Vector similarity is not simulated. Supply explicit forced entry IDs when testing vector-selected entries.');
    }
    return {
        mode,
        entries: structuredClone(snapshot.entries),
        messages,
        injections,
        settings: { ...snapshot.settings, ...(options.settings ?? {}) },
        maxContext,
        trigger,
        seed: Number(options.seed ?? 1) >>> 0,
        forcedIds: [...new Set(options.forcedIds ?? [])],
        timedEffects: options.timedEffects ?? getTimedEffects(context, snapshot.entries, messages.length),
        character: options.character ?? {
            filename: getCharacterFilename(context, host),
            ...await getCharacterTags(context, host),
        },
        globalScanData: options.globalScanData ?? {
            personaDescription: fields.persona ?? '',
            characterDescription: fields.description ?? '',
            characterPersonality: fields.personality ?? '',
            characterDepthPrompt: fields.charDepthPrompt ?? '',
            scenario: fields.scenario ?? '',
            creatorNotes: fields.creatorNotes ?? '',
            trigger,
        },
        expand: macros.expand,
        macroSnapshot: macros.cache,
        volatileMacros: macros.volatile,
        tokenCount: options.tokenCount ?? countTokens,
        parseRegex: host.worldInfo.parseRegexFromString,
        processRegex: host.regex?.getRegexedString
            ? (content, depth) => host.regex.getRegexedString(content, host.regex.regex_placement.WORLD_INFO, {
                depth,
                isMarkdown: false,
                isPrompt: true,
            })
            : null,
        warnings,
        sourcePlan: structuredClone(snapshot.plan),
    };
}
