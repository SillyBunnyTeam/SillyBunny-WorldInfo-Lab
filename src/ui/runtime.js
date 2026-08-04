import { getSettings, updateSettings } from '../settings.js';
import { element, field } from './dom.js';
import { createWorkbench } from './workbench.js';

let mounted = null;

function settingsHost() {
    return document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
}

function openExtensionsSurface() {
    if (typeof globalThis.SillyBunnyShell?.openTab === 'function') {
        globalThis.SillyBunnyShell.openTab('right', 'extensions');
        return;
    }
    const toggle = document.querySelector('#extensions-settings-button > .drawer-toggle');
    const host = settingsHost();
    const hostIsVisible = host instanceof HTMLElement && host.getClientRects().length > 0;
    if (!hostIsVisible && toggle instanceof HTMLElement) {
        toggle.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
        }));
    }
}

export function mountRuntimeUi({ signal = null } = {}) {
    if (mounted) {
        mounted.refresh('remount');
        return mounted;
    }

    let menuItem = null;
    let settingsRoot = null;
    let settingsDrawer = null;
    let drawerToggle = null;
    let drawerIcon = null;
    let drawerContent = null;
    let drawerObserver = null;
    let drawerStatus = null;
    let drawerResult = null;
    let historyLimitInput = null;
    let workbenchMount = null;
    let revealSequence = 0;
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

    function syncDrawerAccessibility() {
        const expanded = Boolean(drawerIcon && !drawerIcon.classList.contains('down'));
        drawerToggle?.setAttribute('aria-expanded', String(expanded));
        drawerContent?.setAttribute('aria-hidden', String(!expanded));
    }

    function alignWorkbench(root) {
        const scroller = root.closest('.sb-shell-panel-scroller, .scrollableInner, .scrollableInnerFull');
        if (scroller && typeof scroller.scrollTo === 'function') {
            const offset = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            scroller.scrollTo({
                top: Math.max(0, scroller.scrollTop + offset - 8),
                behavior: 'auto',
            });
        } else {
            root.scrollIntoView({ block: 'start', inline: 'nearest' });
        }
    }

    function revealWorkbench() {
        if (disposed) {
            return;
        }
        ensureSettingsDrawer();
        openExtensionsSurface();
        if (!settingsDrawer?.isConnected || !workbenchMount) {
            return;
        }
        const root = workbench.mount(workbenchMount);
        if (!root) {
            return;
        }
        if (drawerIcon?.classList.contains('down')) {
            drawerToggle?.click();
        }
        syncDrawerAccessibility();
        const sequence = ++revealSequence;
        const startedAt = performance.now();
        let previousHeight = -1;
        let stableFrames = 0;
        const focusWhenSettled = () => {
            if (disposed || sequence !== revealSequence || !root.isConnected) {
                return;
            }
            const height = drawerContent?.getBoundingClientRect().height ?? 0;
            stableFrames = Math.abs(height - previousHeight) < 0.5 ? stableFrames + 1 : 0;
            previousHeight = height;
            if ((height <= 0 || stableFrames < 2) && performance.now() - startedAt < 650) {
                requestAnimationFrame(focusWhenSettled);
                return;
            }
            workbench.focus();
            alignWorkbench(root);
            let corrections = 2;
            const correct = () => {
                if (disposed || sequence !== revealSequence || !root.isConnected || corrections-- <= 0) {
                    return;
                }
                alignWorkbench(root);
                requestAnimationFrame(correct);
            };
            requestAnimationFrame(correct);
        };
        requestAnimationFrame(focusWhenSettled);
    }

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
        menuItem.addEventListener('click', revealWorkbench);
        host.append(menuItem);
    }

    function ensureSettingsDrawer() {
        if (settingsRoot?.isConnected && settingsDrawer?.isConnected && settingsRoot.contains(settingsDrawer)) {
            return;
        }
        const host = settingsHost();
        if (!host) {
            return;
        }
        drawerObserver?.disconnect();
        settingsRoot?.remove();
        const staleDrawer = document.getElementById('sbwil-settings');
        (staleDrawer?.closest('.extension_container') ?? staleDrawer)?.remove();

        settingsRoot = element('div', {
            className: 'extension_container sbwil-settings-container',
        });
        settingsDrawer = element('div', {
            id: 'sbwil-settings',
            className: 'inline-drawer sbwil-settings',
            attributes: {
                'data-extension-name': 'SillyBunny-WorldInfo-Lab',
                'data-sb-drawer-persistence': 'off',
            },
        });
        drawerToggle = element('button', {
            className: 'inline-drawer-toggle inline-drawer-header sbwil-settings-summary',
            attributes: {
                type: 'button',
                'aria-controls': 'sbwil-settings-content',
                'aria-expanded': 'false',
            },
        });
        const summaryCopy = element('span', { className: 'sbwil-settings-summary-copy' });
        summaryCopy.append(
            element('strong', { text: 'World Info Lab' }),
            element('span', { className: 'sbwil-settings-summary-note', text: 'Test and troubleshoot lorebooks' }),
        );
        drawerIcon = element('span', {
            className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down not_focusable',
            attributes: { 'aria-hidden': 'true' },
        });
        drawerToggle.append(summaryCopy, drawerIcon);

        drawerContent = element('div', {
            id: 'sbwil-settings-content',
            className: 'inline-drawer-content sbwil-settings-content',
            attributes: { 'aria-hidden': 'true' },
        });
        drawerContent.style.display = 'none';
        const settingsBody = element('div', { className: 'sbwil-settings-body' });
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
        openButton.addEventListener('click', revealWorkbench);

        settingsBody.append(
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
        workbenchMount = element('div', { className: 'sbwil-workbench-mount' });
        drawerContent.append(settingsBody, workbenchMount);
        settingsDrawer.append(drawerToggle, drawerContent);
        settingsRoot.append(settingsDrawer);
        host.append(settingsRoot);
        drawerObserver = new MutationObserver(syncDrawerAccessibility);
        drawerObserver.observe(drawerIcon, {
            attributes: true,
            attributeFilter: ['class'],
        });
        if (workbench.getState().open) {
            workbench.mount(workbenchMount);
        }
        syncDrawerAccessibility();
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
            revealSequence += 1;
            drawerObserver?.disconnect();
            workbench.dispose();
            menuItem?.remove();
            settingsRoot?.remove();
            document.getElementById('sbwil-menu-item')?.remove();
            const staleDrawer = document.getElementById('sbwil-settings');
            (staleDrawer?.closest('.extension_container') ?? staleDrawer)?.remove();
            menuItem = null;
            settingsRoot = null;
            settingsDrawer = null;
            drawerToggle = null;
            drawerIcon = null;
            drawerContent = null;
            drawerObserver = null;
            drawerStatus = null;
            drawerResult = null;
            historyLimitInput = null;
            workbenchMount = null;
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
