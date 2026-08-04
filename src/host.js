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
                    return { ok: false, reason: `World Info host exports missing: ${required.join(', ')}` };
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
                    warnings: regex ? [] : ['World Info regex processing is unavailable.'],
                };
                return loaded;
            } catch (error) {
                return { ok: false, reason: `Could not load World Info host modules (${error?.message ?? error})` };
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
        throw new Error('The active tokenizer is unavailable.');
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
        throw new Error('Server-fresh World Info reads are unavailable; no changes were saved.');
    }
    const response = await globalThis.fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
        signal,
    });
    if (!response.ok) {
        throw new Error(`Lorebook ${name} could not be reloaded from the server (${response.status}).`);
    }
    return response.json();
}

export function notify(level, message) {
    const method = globalThis.toastr?.[level];
    if (typeof method === 'function') {
        method(message, 'World Info Lab');
    }
}

export function __setHostForTests(value) {
    loaded = value;
    loading = null;
}
