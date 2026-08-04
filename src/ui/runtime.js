import { getSettings, updateSettings } from '../settings.js';
import { element, field } from './dom.js';
import { createWorkbench } from './workbench.js';

let mounted = null;

function settingsHost() {
    return document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
}

export function mountRuntimeUi({ signal = null } = {}) {
    if (mounted) {
        mounted.refresh('remount');
        return mounted;
    }

    let menuItem = null;
    let settingsDrawer = null;
    let drawerStatus = null;
    let drawerResult = null;
    let historyLimitInput = null;
    let disposed = false;
    let workbench = null;

    function updateDrawer() {
        if (!settingsDrawer?.isConnected) {
            return;
        }
        const state = workbench.getState();
        if (state.availability?.ok === true) {
            drawerStatus.textContent = 'Lorebook scanning is ready.';
            drawerStatus.className = 'sbwil-settings-status sbwil-settings-ready';
            drawerStatus.removeAttribute('title');
        } else if (state.availability?.ok === false) {
            drawerStatus.textContent = 'Lorebook scanning is unavailable. Update SillyBunny or World Info Lab, then reload.';
            drawerStatus.className = 'sbwil-settings-status sbwil-settings-error';
            if (state.availability.reason) {
                drawerStatus.title = `Technical details: ${state.availability.reason}`;
            }
        } else {
            drawerStatus.textContent = 'Checking compatibility with SillyBunny...';
            drawerStatus.className = 'sbwil-settings-status';
            drawerStatus.removeAttribute('title');
        }

        const result = state.latestResult;
        drawerResult.textContent = result
            ? `Last scan: ${result.activated?.length ?? 0} entries activated; ${result.budget?.used ?? 0} lorebook tokens.`
            : 'No scans have run in this SillyBunny session yet.';
        if (state.stale) {
            drawerResult.textContent += ' The chat, lorebooks, or scan settings changed since then.';
        }

        if (document.activeElement !== historyLimitInput) {
            historyLimitInput.value = String(getSettings().historyLimit);
        }
    }

    workbench = createWorkbench({
        lifetimeSignal: signal,
        onStateChange: updateDrawer,
    });

    function ensureMenuItem() {
        if (menuItem?.isConnected) {
            return;
        }
        const host = document.getElementById('extensionsMenu');
        if (!host) {
            return;
        }
        document.getElementById('sbwil-menu-item')?.remove();

        menuItem = element('button', {
            id: 'sbwil-menu-item',
            className: 'list-group-item flex-container flexGap5 interactable sbwil-menu-item',
            attributes: {
                type: 'button',
                title: 'Open World Info Lab to test lorebook activation',
            },
        });
        const icon = element('span', {
            className: 'fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton sbwil-menu-icon',
            attributes: { 'aria-hidden': 'true' },
        });
        menuItem.append(icon, element('span', { text: 'World Info Lab' }));
        menuItem.addEventListener('click', () => {
            void workbench.open(menuItem);
        });
        host.append(menuItem);
    }

    function ensureSettingsDrawer() {
        if (settingsDrawer?.isConnected) {
            return;
        }
        const host = settingsHost();
        if (!host) {
            return;
        }
        document.getElementById('sbwil-settings')?.remove();

        settingsDrawer = element('details', {
            id: 'sbwil-settings',
            className: 'extension_container sbwil-settings',
            attributes: {
                'data-extension-name': 'SillyBunny-WorldInfo-Lab',
            },
        });
        const summary = element('summary', { className: 'sbwil-settings-summary' });
        summary.append(
            element('span', { text: 'World Info Lab' }),
            element('span', { className: 'sbwil-settings-summary-note', text: 'Test and troubleshoot lorebooks' }),
        );

        const content = element('div', { className: 'sbwil-settings-content' });
        drawerStatus = element('p', {
            className: 'sbwil-settings-status',
            attributes: {
                role: 'status',
                'aria-live': 'polite',
            },
        });
        drawerResult = element('p', { className: 'sbwil-settings-result' });
        historyLimitInput = element('input', {
            id: 'sbwil-history-limit',
            className: 'text_pole sbwil-input sbwil-history-limit',
            attributes: {
                type: 'number',
                min: '10',
                max: '500',
                step: '1',
                inputmode: 'numeric',
            },
        });
        historyLimitInput.value = String(getSettings().historyLimit);
        historyLimitInput.addEventListener('change', () => {
            const settings = updateSettings({ historyLimit: Number(historyLimitInput.value) });
            historyLimitInput.value = String(settings.historyLimit);
        });

        const openButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-primary sbwil-settings-open',
            text: 'Open World Info Lab',
            attributes: { type: 'button' },
        });
        openButton.addEventListener('click', () => {
            void workbench.open(openButton);
        });

        content.append(
            drawerStatus,
            drawerResult,
            field('Recent scan history limit', historyLimitInput, {
                hint: 'Number of summary-only scans to keep for this account (10 to 500). Chat and lorebook content are not stored.',
            }),
            openButton,
            element('p', {
                className: 'sbwil-settings-note',
                text: 'Running a scan does not send a message or edit a lorebook. Lorebooks change only when you save a test or apply a batch edit.',
            }),
            element('p', {
                className: 'sbwil-settings-note',
                text: 'Saved tests are stored inside a lorebook and may contain private chat, character, and persona data. Delete private tests before sharing the lorebook. Cleaning World Info Lab data does not delete them.',
            }),
        );
        settingsDrawer.append(summary, content);
        host.append(settingsDrawer);
        updateDrawer();
    }

    function ensureEntrypoints() {
        ensureMenuItem();
        ensureSettingsDrawer();
    }

    const controller = {
        refresh(reason = 'refresh') {
            if (disposed) {
                return;
            }
            ensureEntrypoints();
            workbench.refresh(reason);
            updateDrawer();
        },
        setAvailability(value) {
            if (disposed) {
                return;
            }
            workbench.setAvailability(value);
            updateDrawer();
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            workbench.dispose();
            menuItem?.remove();
            settingsDrawer?.remove();
            document.getElementById('sbwil-menu-item')?.remove();
            document.getElementById('sbwil-settings')?.remove();
            menuItem = null;
            settingsDrawer = null;
            drawerStatus = null;
            drawerResult = null;
            historyLimitInput = null;
        },
    };

    mounted = controller;
    ensureEntrypoints();
    updateDrawer();
    return controller;
}

export function unmountRuntimeUi() {
    mounted?.dispose();
    mounted = null;
}
