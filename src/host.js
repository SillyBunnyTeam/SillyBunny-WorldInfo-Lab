const WORLD_INFO_URL = '/scripts/world-info.js';
const SCAN_CORE_URL = '/scripts/world-info-scan-core.js';
const SCAN_CHAT_URL = '/scripts/world-info-scan-chat.js';
const CHARACTER_BOOK_URL = '/scripts/world-info-character-book.js';
const REGEX_ENGINE_URL = '/scripts/extensions/regex/engine.js';
const UTILS_URL = '/scripts/utils.js';
const TAGS_URL = '/scripts/tags.js';
const SCRIPT_URL = '/script.js';

let loaded = null;
let loading = null;

export function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function missing(module, exports) {
    return exports.filter(name => module?.[name] === undefined);
}

export async function loadHost() {
    if (loaded?.ok) {
        return loaded;
    }
    if (!loading) {
        loading = (async () => {
            try {
                const [worldInfo, scanCore, scanChat, characterBook, regex, utils, tags, script] = await Promise.all([
                    import(WORLD_INFO_URL),
                    import(SCAN_CORE_URL),
                    import(SCAN_CHAT_URL),
                    import(CHARACTER_BOOK_URL),
                    import(REGEX_ENGINE_URL).catch(() => null),
                    import(UTILS_URL),
                    import(TAGS_URL).catch(() => null),
                    import(SCRIPT_URL),
                ]);
                const required = [
                    ...missing(worldInfo, [
                        'getWorldInfoSettings',
                        'parseRegexFromString',
                        'selected_world_info',
                        'world_info_position',
                    ]),
                    ...missing(scanCore, [
                        'normalizeWorldInfoProbability',
                        'getWorldInfoGroupNames',
                    ]),
                    ...missing(scanChat, ['buildWorldInfoScanChat']),
                    ...missing(characterBook, ['normalizeWorldInfoPosition']),
                    ...missing(utils, ['getStringHash', 'getCharaFilename']),
                    ...missing(script, ['getMaxPromptTokens']),
                ];
                if (required.length) {
                    return {
                        ok: false,
                        reason: `World Info Lab is incompatible with this SillyBunny build. Missing tools: ${required.join(', ')}.`,
                    };
                }
                loaded = {
                    ok: true,
                    worldInfo,
                    scanCore,
                    scanChat,
                    characterBook,
                    regex,
                    utils,
                    tags,
                    script,
                    warnings: regex ? [] : ['Lorebook regex scripts could not be applied, so inserted content may differ from an actual reply.'],
                };
                return loaded;
            } catch (error) {
                return {
                    ok: false,
                    reason: `World Info Lab could not load SillyBunny's lorebook tools. Technical details: ${error?.message ?? error}`,
                };
            }
        })();
    }
    try {
        return await loading;
    } finally {
        loading = null;
    }
}

export async function countTokens(text) {
    const context = getContext();
    if (typeof context?.getTokenCountAsync !== 'function') {
        throw new Error('The scan could not count lorebook tokens because no tokenizer is available. Load or select a model tokenizer, then try again.');
    }
    return context.getTokenCountAsync(String(text ?? ''));
}

export function substitute(text) {
    const context = getContext();
    const input = String(text ?? '');
    return typeof context?.substituteParams === 'function'
        ? String(context.substituteParams(input) ?? '')
        : input;
}

export async function loadWorldInfoFresh(name, { signal } = {}) {
    const context = getContext();
    if (typeof context?.getRequestHeaders !== 'function' || typeof globalThis.fetch !== 'function') {
        throw new Error('Batch Edit could not verify the latest saved lorebook, so nothing was saved. Reload SillyBunny and try again.');
    }
    const response = await globalThis.fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
        signal,
    });
    if (!response.ok) {
        throw new Error(`"${name}" could not be reloaded from the server (HTTP ${response.status}). Nothing was saved; check the server and preview again.`);
    }
    return response.json();
}

export function notify(level, message) {
    const method = globalThis.toastr?.[level];
    if (typeof method === 'function') {
        method(message, 'World Info Lab');
    } else if (typeof globalThis.alert === 'function') {
        globalThis.alert(`World Info Lab\n\n${message}`);
    }
}

export function __setHostForTests(value) {
    loaded = value;
    loading = null;
}
