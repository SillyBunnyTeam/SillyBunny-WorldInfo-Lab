import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const hostRoot = process.env.SILLYBUNNY_ROOT || '/home/platinum/SillyBunny';

async function available() {
    try {
        await access(path.join(hostRoot, 'public/scripts/world-info.js'));
        return true;
    } catch {
        return false;
    }
}

test('SillyBunny exposes the host contracts used by World Info Lab', {
    skip: !(await available()) && !process.env.WI_LAB_REQUIRE_HOST,
}, async () => {
    assert.equal(await available(), true, `SillyBunny checkout not found at ${hostRoot}`);
    const [worldInfo, scanCore, scanChat, characterBook, utils, context, script, tabs, keyboard, indexHtml, events] = await Promise.all([
        readFile(path.join(hostRoot, 'public/scripts/world-info.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/world-info-scan-core.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/world-info-scan-chat.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/world-info-character-book.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/utils.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/st-context.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/script.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/sillybunny-tabs.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/keyboard.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/index.html'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/events.js'), 'utf8'),
    ]);

    for (const symbol of [
        'getWorldInfoSettings',
        'originalWIDataKeyMap',
        'parseRegexFromString',
        'selected_world_info',
        'setWIOriginalDataValue',
        'world_info_position',
    ]) {
        assert.match(worldInfo, new RegExp(`export[^;\\n]*\\b${symbol}\\b|export\\s+(?:async\\s+)?function\\s+${symbol}\\b`));
    }
    for (const [source, symbols] of [
        [scanCore, ['normalizeWorldInfoProbability', 'getWorldInfoGroupNames']],
        [scanChat, ['buildWorldInfoScanChat']],
        [characterBook, ['normalizeWorldInfoPosition']],
        [utils, ['getStringHash', 'getCharaFilename']],
    ]) {
        for (const symbol of symbols) {
            assert.match(source, new RegExp(`export[^;\\n]*\\b${symbol}\\b|export\\s+(?:async\\s+)?function\\s+${symbol}\\b`));
        }
    }
    assert.match(script, /export\s+function\s+getMaxPromptTokens\b/);
    for (const api of ['getRequestHeaders', 'getWorldInfoNames', 'loadWorldInfo', 'saveWorldInfo', 'reloadWorldInfoEditor', 'updateWorldInfoList']) {
        assert.match(context, new RegExp(`\\b${api}\\b`));
    }
    assert.match(indexHtml, /id="extensions-settings-button"/);
    assert.match(indexHtml, /id="extensions_settings2"/);
    assert.match(script, /\.inline-drawer-toggle/);
    assert.match(script, /\.inline-drawer-content/);
    assert.match(script, /inline-drawer-toggle', \{ bubbles: true \}/);
    assert.match(tabs, /globalThis\.SillyBunnyShell/);
    assert.match(tabs, /openTab\(shellKey, tabId\)/);
    assert.match(keyboard, /'\.inline-drawer-icon'/);
    assert.match(keyboard, /NOT_FOCUSABLE_CONTROL_CLASS\s*=\s*'not_focusable'/);
    for (const event of [
        'APP_READY',
        'WORLDINFO_UPDATED',
        'WORLDINFO_SETTINGS_UPDATED',
        'SETTINGS_UPDATED',
        'CHAT_CHANGED',
        'MESSAGE_SWIPED',
        'MESSAGE_EDITED',
        'MESSAGE_REASONING_EDITED',
        'MORE_MESSAGES_LOADED',
        'CHARACTER_EDITED',
        'GROUP_UPDATED',
        'PERSONA_CHANGED',
    ]) {
        assert.match(events, new RegExp(`\\b${event}\\b`));
    }
});
