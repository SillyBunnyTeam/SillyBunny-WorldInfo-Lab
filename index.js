import { getContext, loadHost } from './src/host.js';
import { getSettings } from './src/settings.js';
import { clearExtensionData } from './src/ui/data.js';
import { mountRuntimeUi, unmountRuntimeUi } from './src/ui/runtime.js';

let initialized = false;
let activationEpoch = 0;
let activationController = null;
let runtimeUi = null;
const subscriptions = [];

function subscribe(source, eventType, handler) {
    if (!source?.on || !eventType) {
        return;
    }
    source.on(eventType, handler);
    subscriptions.push({ source, eventType, handler });
}

async function mountOnReady(epoch, signal) {
    if (signal.aborted || epoch !== activationEpoch) {
        return;
    }
    runtimeUi = mountRuntimeUi({ signal });
    runtimeUi.refresh('app-ready');

    const host = await loadHost();
    if (signal.aborted || epoch !== activationEpoch) {
        return;
    }
    runtimeUi?.setAvailability(host);
}

export function init() {
    if (initialized) {
        runtimeUi?.refresh('init');
        return;
    }

    initialized = true;
    const epoch = ++activationEpoch;
    activationController = new AbortController();
    const { signal } = activationController;
    getSettings();

    const context = getContext();
    const source = context?.eventSource;
    const events = context?.eventTypes;
    if (!source || !events) {
        initialized = false;
        activationController.abort();
        activationController = null;
        return;
    }

    subscribe(source, events.APP_READY, () => {
        void mountOnReady(epoch, signal).catch((error) => {
            if (!signal.aborted && epoch === activationEpoch) {
                console.error('World Info Lab could not mount.', error);
            }
        });
    });

    const refresh = reason => () => {
        if (!signal.aborted && epoch === activationEpoch) {
            runtimeUi?.refresh(reason);
        }
    };
    subscribe(source, events.WORLDINFO_UPDATED, refresh('worldinfo-updated'));
    subscribe(source, events.WORLDINFO_SETTINGS_UPDATED, refresh('worldinfo-settings-updated'));
    subscribe(source, events.CHAT_CHANGED, refresh('chat-changed'));
    let tagMapSnapshot = JSON.stringify(context?.tagMap ?? null);
    subscribe(source, events.SETTINGS_UPDATED, () => {
        const nextTagMapSnapshot = JSON.stringify(getContext()?.tagMap ?? null);
        if (nextTagMapSnapshot !== tagMapSnapshot) {
            tagMapSnapshot = nextTagMapSnapshot;
            runtimeUi?.refresh('scan-input-changed');
        }
    });
    const scanInputEvents = [
        'MESSAGE_SWIPED',
        'MESSAGE_SENT',
        'MESSAGE_RECEIVED',
        'MESSAGE_EDITED',
        'MESSAGE_DELETED',
        'MESSAGE_UPDATED',
        'MESSAGE_FILE_EMBEDDED',
        'MESSAGE_REASONING_EDITED',
        'MESSAGE_REASONING_DELETED',
        'MESSAGE_SWIPE_DELETED',
        'MORE_MESSAGES_LOADED',
        'FILE_ATTACHMENT_DELETED',
        'MEDIA_ATTACHMENT_DELETED',
        'CHARACTER_EDITED',
        'CHARACTER_FIRST_MESSAGE_SELECTED',
        'GROUP_UPDATED',
        'PERSONA_CHANGED',
        'PERSONA_CREATED',
        'PERSONA_UPDATED',
        'PERSONA_RENAMED',
        'PERSONA_DELETED',
    ];
    const eventValues = new Set(scanInputEvents.map(name => events[name]).filter(Boolean));
    for (const eventType of eventValues) {
        subscribe(source, eventType, refresh('scan-input-changed'));
    }
}

export function deactivate() {
    initialized = false;
    activationEpoch++;
    activationController?.abort();
    activationController = null;

    while (subscriptions.length) {
        const { source, eventType, handler } = subscriptions.pop();
        source?.removeListener?.(eventType, handler);
    }

    runtimeUi = null;
    unmountRuntimeUi();
}

export async function clean() {
    deactivate();
    await clearExtensionData();
}
