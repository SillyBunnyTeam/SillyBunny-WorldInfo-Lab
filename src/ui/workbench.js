import {
    GENERATION_TRIGGERS,
    POSITION_LABEL,
} from '../constants.js';
import { getContext, notify } from '../host.js';
import { appendHistory } from '../history.js';
import { buildSimulationRequest } from '../scan-input.js';
import { getSettings, updateSettings } from '../settings.js';
import { simulateWorldInfo } from '../simulator/engine.js';
import { snapshotLorebooks } from '../sources.js';
import {
    element,
    errorMessage,
    field,
    formatValue,
    humanize,
    statusRegion,
} from './dom.js';
import { createBatchTab, createTestsTab } from './future-tabs.js';

const TABS = [
    { id: 'scan', label: 'Scan' },
    { id: 'trace', label: 'Trace' },
    { id: 'tests', label: 'Tests' },
    { id: 'batch', label: 'Batch Edit' },
];

function plural(count, singular, pluralForm = `${singular}s`) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

function isAbort(error) {
    return error?.name === 'AbortError';
}

function metric(label, value) {
    const node = element('div', { className: 'sbwil-metric' });
    node.append(
        element('span', { className: 'sbwil-metric-value', text: value }),
        element('span', { className: 'sbwil-metric-label', text: label }),
    );
    return node;
}

function contextLine(snapshot = null) {
    const context = getContext();
    const messages = (context?.chat ?? []).filter(message => (
        message && !message.is_system && typeof message.mes === 'string'
    )).length;
    const parts = [plural(messages, 'chat message')];
    if (snapshot) {
        parts.push(plural(snapshot.plan?.all?.length ?? 0, 'active lorebook'));
        parts.push(plural(snapshot.entries?.length ?? 0, 'entry', 'entries'));
    }
    return parts.join('; ');
}

function staleMessage(reason) {
    if (reason === 'chat-changed') {
        return 'The chat changed. This result is retained for comparison; run the simulation again to refresh it.';
    }
    if (reason === 'worldinfo-updated' || reason === 'worldinfo-settings-updated') {
        return 'World Info sources changed. This result is retained for comparison; run the simulation again to refresh it.';
    }
    if (reason === 'scan-input-changed') {
        return 'Chat, character, group, or persona scan input changed. This result is retained for comparison; run the simulation again to refresh it.';
    }
    if (reason === 'local-input-changed') {
        return 'Scan controls changed. This result is retained for comparison; run the simulation again to refresh it.';
    }
    return '';
}

function detailText(value, omitted = []) {
    const detail = Object.entries(value ?? {})
        .filter(([key, item]) => !omitted.includes(key) && item !== undefined && item !== '')
        .map(([key, item]) => `${humanize(key)}: ${formatValue(item)}`);
    return detail.join('; ');
}

function resultWarnings(result) {
    const section = element('section', {
        className: 'sbwil-warnings',
        attributes: { 'aria-labelledby': 'sbwil-warnings-title' },
    });
    section.append(element('h4', { id: 'sbwil-warnings-title', text: 'Warnings' }));
    const warnings = result?.warnings ?? [];
    if (!warnings.length) {
        section.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'No simulation warnings.',
        }));
        return section;
    }
    const list = element('ul', { className: 'sbwil-warning-list' });
    warnings.forEach((warning) => {
        list.append(element('li', { text: warning }));
    });
    section.append(list);
    return section;
}

function renderScanResult(container, result, stale) {
    container.replaceChildren();
    if (!result) {
        const empty = element('section', { className: 'sbwil-empty-state' });
        empty.append(
            element('p', { className: 'sbwil-kicker', text: 'NO RESULT' }),
            element('h3', { text: 'Ready to inspect activation' }),
            element('p', {
                text: 'Run a deterministic simulation to see activated entries, token use, and source warnings.',
            }),
        );
        container.append(empty);
        return;
    }

    const section = element('section', { className: 'sbwil-result' });
    const heading = element('div', { className: 'sbwil-result-heading' });
    heading.append(element('div'));
    heading.firstElementChild.append(
        element('p', { className: 'sbwil-kicker', text: 'LATEST SIMULATION' }),
        element('h3', { text: 'Activation summary' }),
    );
    heading.append(element('code', {
        className: 'sbwil-fingerprint',
        text: result.fingerprint ?? 'no fingerprint',
    }));
    section.append(heading);

    if (stale) {
        section.append(element('p', {
            className: 'sbwil-stale-notice',
            text: stale,
        }));
    }

    const budget = result.budget ?? {};
    const metrics = element('div', { className: 'sbwil-metrics' });
    metrics.append(
        metric('Activated', result.activated?.length ?? 0),
        metric('Rounds', result.rounds?.length ?? 0),
        metric('Tokens', `${budget.used ?? 0} / ${budget.limit ?? 0}`),
        metric('Seed', result.seed ?? 0),
    );
    section.append(metrics);

    const budgetBlock = element('div', { className: 'sbwil-budget' });
    const budgetLabel = element('div', { className: 'sbwil-budget-label' });
    budgetLabel.append(
        element('span', { text: 'Token budget' }),
        element('strong', {
            text: budget.overflowed
                ? `${budget.used ?? 0} used; limit reached`
                : `${budget.used ?? 0} of ${budget.limit ?? 0} used`,
        }),
    );
    const progress = element('progress', {
        className: 'sbwil-progress',
        attributes: {
            max: Math.max(1, Number(budget.limit) || 1),
            value: Math.min(Number(budget.used) || 0, Math.max(1, Number(budget.limit) || 1)),
            'aria-label': 'Token budget used',
        },
    });
    budgetBlock.append(budgetLabel, progress);
    section.append(budgetBlock);

    const activatedSection = element('section', {
        className: 'sbwil-activated',
        attributes: { 'aria-labelledby': 'sbwil-activated-title' },
    });
    activatedSection.append(element('h4', { id: 'sbwil-activated-title', text: 'Activated entries' }));
    if (!result.activated?.length) {
        activatedSection.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'No entries activated for this input.',
        }));
    } else {
        const list = element('ol', { className: 'sbwil-activated-list' });
        result.activated.forEach((entry) => {
            const item = element('li');
            const identity = element('div');
            identity.append(
                element('strong', { text: entry.label }),
                element('code', { text: entry.id }),
            );
            item.append(
                identity,
                element('span', {
                    className: 'sbwil-reason',
                    text: humanize(entry.activationReason || 'activated'),
                }),
            );
            list.append(item);
        });
        activatedSection.append(list);
    }
    section.append(activatedSection, resultWarnings(result));
    container.append(section);
}

function signalItem(title, meta, status = 'neutral') {
    const normalized = ['pass', 'fail', 'skip', 'active', 'neutral'].includes(status)
        ? status
        : 'neutral';
    const item = element('li', { className: `sbwil-signal-item sbwil-signal-${normalized}` });
    item.append(element('span', {
        className: 'sbwil-signal-node',
        attributes: { 'aria-hidden': 'true' },
    }));
    const body = element('div', { className: 'sbwil-signal-body' });
    const titleRow = element('div', { className: 'sbwil-signal-title' });
    titleRow.append(element('strong', { text: title }));
    if (normalized !== 'neutral') {
        titleRow.append(element('span', {
            className: 'sbwil-signal-status',
            text: humanize(normalized),
        }));
    }
    body.append(titleRow, element('span', { text: meta || 'No additional detail.' }));
    item.append(body);
    return item;
}

function renderRounds(result) {
    const section = element('section', {
        className: 'sbwil-trace-rounds',
        attributes: { 'aria-labelledby': 'sbwil-rounds-title' },
    });
    section.append(element('h4', { id: 'sbwil-rounds-title', text: 'Scan rounds' }));
    const rail = element('ol', { className: 'sbwil-signal-rail' });
    (result.rounds ?? []).forEach((round) => {
        const details = [
            `Depth ${round.depth ?? 0}`,
            plural(round.candidates?.length ?? 0, 'candidate'),
            plural(round.activated?.length ?? 0, 'activation'),
        ];
        if (round.activated?.length) {
            details.push(`Activated ${round.activated.join(', ')}`);
        }
        if (round.nextStateLabel) {
            details.push(`Next: ${round.nextStateLabel}`);
        }
        rail.append(signalItem(
            `Round ${round.number}: ${round.stateLabel ?? 'Unknown'}`,
            details.join('; '),
            round.stateLabel === 'Recursion' ? 'active' : 'neutral',
        ));
    });
    if (!result.rounds?.length) {
        rail.append(signalItem('No rounds recorded', 'The simulator returned no round data.', 'skip'));
    }
    section.append(rail);
    return section;
}

function renderPlacements(result) {
    const section = element('section', {
        className: 'sbwil-trace-section',
        attributes: { 'aria-labelledby': 'sbwil-placements-title' },
    });
    section.append(element('h4', { id: 'sbwil-placements-title', text: 'Placements' }));
    const records = result.placements?.records ?? [];
    if (!records.length) {
        section.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'No placement records were produced.',
        }));
        return section;
    }

    const list = element('div', { className: 'sbwil-placement-list' });
    records.forEach((record) => {
        const details = element('details', { className: 'sbwil-placement' });
        const summary = element('summary');
        const identity = element('span');
        identity.append(
            element('strong', { text: record.label }),
            element('code', { text: record.id }),
        );
        const placement = POSITION_LABEL[record.position] ?? `Position ${record.position}`;
        const qualifiers = [placement];
        if (record.depth !== null && record.depth !== undefined) {
            qualifiers.push(`depth ${record.depth}`);
        }
        if (record.outlet) {
            qualifiers.push(`outlet ${record.outlet}`);
        }
        summary.append(
            identity,
            element('span', {
                className: record.included ? 'sbwil-chip' : 'sbwil-chip sbwil-chip-muted',
                text: record.included ? qualifiers.join('; ') : humanize(record.omissionReason || 'omitted'),
            }),
        );
        const content = element('pre', { className: 'sbwil-log' });
        content.textContent = record.renderedContent || record.rawContent || '(empty content)';
        details.append(summary, content);
        list.append(details);
    });
    section.append(list);
    return section;
}

function renderEntryTraces(result) {
    const section = element('section', {
        className: 'sbwil-trace-section',
        attributes: { 'aria-labelledby': 'sbwil-entry-traces-title' },
    });
    section.append(element('h4', { id: 'sbwil-entry-traces-title', text: 'Entry stages' }));
    const traces = result.traces ?? [];
    if (!traces.length) {
        section.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'No per-entry stages were recorded.',
        }));
        return section;
    }

    const byRound = new Map();
    traces.forEach((trace) => {
        if (!byRound.has(trace.round)) {
            byRound.set(trace.round, []);
        }
        byRound.get(trace.round).push(trace);
    });

    for (const [round, roundTraces] of byRound) {
        const roundDetails = element('details', { className: 'sbwil-trace-group' });
        if (round === 1) {
            roundDetails.open = true;
        }
        const activated = roundTraces.filter(trace => trace.outcome === 'activated').length;
        roundDetails.append(element('summary', {
            text: `Round ${round}: ${plural(roundTraces.length, 'entry trace')}; ${plural(activated, 'activation')}`,
        }));

        const entries = element('div', { className: 'sbwil-entry-trace-list' });
        roundTraces.forEach((trace) => {
            const details = element('details', { className: 'sbwil-entry-trace' });
            const summary = element('summary');
            const identity = element('span');
            identity.append(
                element('strong', { text: trace.label }),
                element('code', { text: trace.id }),
            );
            summary.append(
                identity,
                element('span', {
                    className: `sbwil-chip sbwil-outcome-${trace.outcome === 'activated' ? 'pass' : 'neutral'}`,
                    text: humanize(trace.outcome),
                }),
            );
            details.append(summary);

            const rail = element('ol', { className: 'sbwil-signal-rail sbwil-stage-rail' });
            (trace.stages ?? []).forEach((stage) => {
                rail.append(signalItem(
                    stage.name,
                    detailText(stage, ['name', 'status']),
                    stage.status,
                ));
            });
            if (!trace.stages?.length) {
                rail.append(signalItem('Not evaluated', 'No stages were recorded.', 'skip'));
            }
            details.append(rail);
            entries.append(details);
        });
        roundDetails.append(entries);
        section.append(roundDetails);
    }
    return section;
}

function renderTrace(container, result, stale) {
    container.replaceChildren();
    if (!result) {
        const empty = element('section', { className: 'sbwil-empty-state' });
        empty.append(
            element('p', { className: 'sbwil-kicker', text: 'TRACE IDLE' }),
            element('h3', { text: 'No trace recorded' }),
            element('p', { text: 'Run a Scan simulation first. Entry stages and placements will appear here.' }),
        );
        container.append(empty);
        return;
    }

    const header = element('header', { className: 'sbwil-trace-header' });
    const title = element('div');
    title.append(
        element('p', { className: 'sbwil-kicker', text: 'DETERMINISTIC TRACE' }),
        element('h3', { text: 'Why each entry did or did not activate' }),
    );
    const budget = result.budget ?? {};
    header.append(
        title,
        element('p', {
            className: 'sbwil-trace-budget',
            text: `${budget.used ?? 0} / ${budget.limit ?? 0} tokens${budget.overflowed ? '; limit reached' : ''}`,
        }),
    );
    container.append(header);
    if (stale) {
        container.append(element('p', { className: 'sbwil-stale-notice', text: stale }));
    }

    const layout = element('div', { className: 'sbwil-trace-layout' });
    const detail = element('div', { className: 'sbwil-trace-detail' });
    detail.append(renderPlacements(result), renderEntryTraces(result));
    layout.append(renderRounds(result), detail);
    container.append(layout);
}

async function popupApi() {
    const context = getContext();
    if (context?.Popup && context?.POPUP_TYPE) {
        return { Popup: context.Popup, POPUP_TYPE: context.POPUP_TYPE };
    }
    throw new Error('The popup API is unavailable.');
}

export function createWorkbench({
    lifetimeSignal = null,
    onStateChange = () => {},
} = {}) {
    let popup = null;
    let openPromise = null;
    let session = null;
    let destroyed = false;
    let latestResult = null;
    let latestSnapshot = null;
    let stale = '';
    let availability = null;

    function state() {
        return {
            availability,
            latestResult,
            latestSnapshot,
            stale,
            open: Boolean(popup),
        };
    }

    function emitState() {
        onStateChange(state());
    }

    function acceptResult(result) {
        latestResult = result;
        stale = '';
        session?.renderResult();
        emitState();
    }

    function buildSession() {
        const sessionController = new AbortController();
        const { signal } = sessionController;
        let disposed = false;
        let runController = null;
        let runSequence = 0;

        const root = element('div', { id: 'sbwil-workbench' });
        const header = element('header', { className: 'sbwil-workbench-header' });
        const heading = element('div', { className: 'sbwil-title-block' });
        heading.append(
            element('p', { className: 'sbwil-kicker', text: 'SIMULATION WORKBENCH' }),
            element('h2', { text: 'World Info Lab' }),
            element('p', {
                className: 'sbwil-muted',
                text: 'Inspect deterministic activation without invoking generation.',
            }),
        );
        const headerMeta = element('div', { className: 'sbwil-header-meta' });
        const hostStatus = element('span', { className: 'sbwil-host-status' });
        const sourceStatus = element('span', { className: 'sbwil-source-status' });
        headerMeta.append(hostStatus, sourceStatus);
        header.append(heading, headerMeta);

        const tabList = element('div', {
            className: 'sbwil-tabs',
            attributes: {
                role: 'tablist',
                'aria-label': 'World Info Lab tools',
            },
        });
        const panels = new Map();
        const tabButtons = [];
        TABS.forEach((tab) => {
            const button = element('button', {
                id: `sbwil-tab-${tab.id}`,
                className: 'sbwil-tab',
                text: tab.label,
                attributes: {
                    type: 'button',
                    role: 'tab',
                    'aria-controls': `sbwil-panel-${tab.id}`,
                    'aria-selected': 'false',
                    tabindex: '-1',
                },
            });
            const panel = element('section', {
                id: `sbwil-panel-${tab.id}`,
                className: `sbwil-panel sbwil-panel-${tab.id}`,
                attributes: {
                    role: 'tabpanel',
                    'aria-labelledby': button.id,
                    tabindex: '0',
                },
            });
            panel.hidden = true;
            tabList.append(button);
            tabButtons.push(button);
            panels.set(tab.id, panel);
        });

        const panelHost = element('div', { className: 'sbwil-panel-host' });
        TABS.forEach(tab => panelHost.append(panels.get(tab.id)));
        root.append(header, tabList, panelHost);

        const scanPanel = panels.get('scan');
        const scanLayout = element('div', { className: 'sbwil-scan-layout' });
        const controls = element('section', {
            className: 'sbwil-scan-controls',
            attributes: { 'aria-labelledby': 'sbwil-scan-controls-title' },
        });
        controls.append(
            element('p', { className: 'sbwil-kicker', text: 'INPUT' }),
            element('h3', { id: 'sbwil-scan-controls-title', text: 'Build a scan' }),
        );
        const form = element('form', { className: 'sbwil-scan-form' });
        const modeGroup = element('fieldset', { className: 'sbwil-mode-group' });
        modeGroup.append(element('legend', { text: 'Input mode' }));
        const settings = getSettings();
        const modeInputs = [];
        [
            { value: 'chat', label: 'Current chat' },
            { value: 'text', label: 'Pasted text' },
        ].forEach((option) => {
            const label = element('label', { className: 'sbwil-mode-option' });
            const input = element('input', {
                attributes: {
                    type: 'radio',
                    name: 'sbwil-input-mode',
                    value: option.value,
                },
            });
            input.checked = settings.inputMode === option.value;
            modeInputs.push(input);
            label.append(input, element('span', { text: option.label }));
            modeGroup.append(label);
        });

        const textInput = element('textarea', {
            id: 'sbwil-pasted-text',
            className: 'text_pole sbwil-textarea',
            attributes: {
                rows: '10',
                placeholder: 'Paste the exact text to scan...',
                spellcheck: 'true',
            },
        });
        const textField = field('Text to scan', textInput, {
            hint: 'Pasted text is not saved in extension settings.',
        });

        const triggerSelect = element('select', {
            id: 'sbwil-trigger',
            className: 'text_pole sbwil-select',
        });
        GENERATION_TRIGGERS.forEach((trigger) => {
            triggerSelect.append(element('option', {
                text: humanize(trigger),
                attributes: { value: trigger },
            }));
        });
        triggerSelect.value = GENERATION_TRIGGERS.includes(settings.trigger)
            ? settings.trigger
            : 'normal';

        const seedInput = element('input', {
            id: 'sbwil-seed',
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'number',
                min: '0',
                max: '4294967295',
                step: '1',
                required: 'required',
                inputmode: 'numeric',
            },
        });
        seedInput.value = String(settings.seed);

        const parameterGrid = element('div', { className: 'sbwil-parameter-grid' });
        parameterGrid.append(
            field('Generation trigger', triggerSelect),
            field('Deterministic seed', seedInput),
        );

        const sourceLine = element('p', { className: 'sbwil-context-line' });
        const actions = element('div', { className: 'sbwil-run-actions' });
        const runButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-primary sbwil-run-button',
            text: 'Run simulation',
            attributes: { type: 'submit' },
        });
        const cancelButton = element('button', {
            className: 'menu_button sbwil-button',
            text: 'Cancel run',
            attributes: { type: 'button' },
        });
        cancelButton.hidden = true;
        actions.append(runButton, cancelButton);
        const runStatus = statusRegion('Ready to simulate.');
        form.append(
            modeGroup,
            textField,
            parameterGrid,
            sourceLine,
            actions,
            runStatus,
        );
        controls.append(form);

        const scanOutput = element('div', {
            className: 'sbwil-scan-output',
            attributes: {
                'aria-label': 'Simulation result',
            },
        });
        scanLayout.append(controls, scanOutput);
        scanPanel.append(scanLayout);

        const tracePanel = panels.get('trace');
        const testsTab = createTestsTab({
            panel: panels.get('tests'),
            getLatestResult: () => latestResult,
            acceptResult,
        });
        const batchTab = createBatchTab({ panel: panels.get('batch') });
        const futureTabs = { tests: testsTab, batch: batchTab };

        function currentMode() {
            return modeInputs.find(input => input.checked)?.value ?? 'chat';
        }

        function syncMode(focusText = false) {
            const pasted = currentMode() === 'text';
            textField.hidden = !pasted;
            textInput.disabled = !pasted;
            textInput.required = pasted;
            updateSettings({ inputMode: pasted ? 'text' : 'chat' });
            if (pasted && focusText) {
                textInput.focus();
            }
        }

        function setRunning(running) {
            form.setAttribute('aria-busy', String(running));
            runButton.textContent = running ? 'Restart simulation' : 'Run simulation';
            cancelButton.hidden = !running;
        }

        function updateHeader() {
            if (availability?.ok === true) {
                hostStatus.textContent = 'Host ready';
                hostStatus.className = 'sbwil-host-status sbwil-host-ready';
            } else if (availability?.ok === false) {
                hostStatus.textContent = 'Host unavailable';
                hostStatus.className = 'sbwil-host-status sbwil-host-error';
            } else {
                hostStatus.textContent = 'Checking host';
                hostStatus.className = 'sbwil-host-status';
            }
            sourceStatus.textContent = contextLine(latestSnapshot);
            sourceLine.textContent = currentMode() === 'chat'
                ? `Current source: ${contextLine(latestSnapshot)}`
                : 'Current source: pasted text';
            runButton.disabled = availability?.ok === false;
            if (availability?.ok === false) {
                runButton.title = availability.reason ?? 'World Info host modules are unavailable.';
            } else {
                runButton.removeAttribute('title');
            }
        }

        function renderResult() {
            renderScanResult(scanOutput, latestResult, stale);
            renderTrace(tracePanel, latestResult, stale);
            updateHeader();
        }

        function abortRun(message = '') {
            if (!runController) {
                return;
            }
            runSequence++;
            runController.abort();
            runController = null;
            setRunning(false);
            if (message) {
                runStatus.textContent = message;
            }
        }

        function invalidateLocalInput() {
            const wasRunning = Boolean(runController);
            if (wasRunning) {
                abortRun('Inputs changed. Run the simulation again.');
            }
            if (latestResult) {
                stale = staleMessage('local-input-changed');
                if (!wasRunning) {
                    runStatus.textContent = 'Inputs changed. Run the simulation again.';
                }
                renderResult();
                emitState();
            }
        }

        async function runSimulation() {
            textInput.setCustomValidity(
                currentMode() === 'text' && !textInput.value.trim()
                    ? 'Enter text to scan.'
                    : '',
            );
            if (!form.reportValidity()) {
                return;
            }
            abortRun();
            const sequence = ++runSequence;
            const controller = new AbortController();
            runController = controller;
            setRunning(true);

            const mode = currentMode();
            const trigger = triggerSelect.value;
            const seed = Number(seedInput.value) >>> 0;
            const text = textInput.value;
            updateSettings({ inputMode: mode, trigger, seed });
            runStatus.textContent = 'Loading active lorebooks...';

            try {
                const snapshot = await snapshotLorebooks({ context: getContext() });
                if (disposed || controller.signal.aborted || sequence !== runSequence) {
                    return;
                }
                latestSnapshot = snapshot;
                updateHeader();
                runStatus.textContent = 'Building deterministic scan input...';
                const request = await buildSimulationRequest(snapshot, {
                    context: getContext(),
                    mode,
                    text,
                    trigger,
                    seed,
                });
                if (disposed || controller.signal.aborted || sequence !== runSequence) {
                    return;
                }
                runStatus.textContent = `Simulating ${plural(snapshot.entries.length, 'entry', 'entries')}...`;
                const result = await simulateWorldInfo(request, { signal: controller.signal });
                if (disposed || controller.signal.aborted || sequence !== runSequence) {
                    return;
                }
                try {
                    appendHistory(result);
                } catch (error) {
                    result.warnings.push(`Run history could not be saved. ${errorMessage(error)}`);
                }
                acceptResult(result);
                void testsTab.refresh();
                runStatus.textContent = `Simulation complete. ${plural(result.activated?.length ?? 0, 'entry', 'entries')} activated.`;
            } catch (error) {
                if (disposed || sequence !== runSequence) {
                    return;
                }
                if (isAbort(error) || controller.signal.aborted) {
                    runStatus.textContent = 'Simulation cancelled.';
                } else {
                    const message = `Simulation failed. ${errorMessage(error)}`;
                    runStatus.textContent = message;
                    notify('error', message);
                }
            } finally {
                if (sequence === runSequence) {
                    runController = null;
                    setRunning(false);
                    emitState();
                }
            }
        }

        let activeTab = '';
        function setTab(tabId, { focus = false, persist = true } = {}) {
            const next = TABS.some(tab => tab.id === tabId) ? tabId : 'scan';
            activeTab = next;
            tabButtons.forEach((button, index) => {
                const selected = TABS[index].id === next;
                button.setAttribute('aria-selected', String(selected));
                button.tabIndex = selected ? 0 : -1;
                button.removeAttribute('autofocus');
                panels.get(TABS[index].id).hidden = !selected;
                if (selected) {
                    button.setAttribute('autofocus', '');
                    if (focus) {
                        button.focus();
                    }
                }
            });
            if (persist) {
                updateSettings({ lastTab: next });
            }
            void futureTabs[next]?.activate();
        }

        tabButtons.forEach((button, index) => {
            button.addEventListener('click', () => {
                setTab(TABS[index].id);
            }, { signal });
            button.addEventListener('keydown', (event) => {
                let nextIndex = index;
                if (event.key === 'ArrowRight') {
                    nextIndex = (index + 1) % tabButtons.length;
                } else if (event.key === 'ArrowLeft') {
                    nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
                } else if (event.key === 'Home') {
                    nextIndex = 0;
                } else if (event.key === 'End') {
                    nextIndex = tabButtons.length - 1;
                } else {
                    return;
                }
                event.preventDefault();
                setTab(TABS[nextIndex].id, { focus: true });
            }, { signal });
        });

        modeInputs.forEach((input) => {
            input.addEventListener('change', () => {
                syncMode(input.value === 'text');
                updateHeader();
                invalidateLocalInput();
            }, { signal });
        });
        triggerSelect.addEventListener('change', () => {
            updateSettings({ trigger: triggerSelect.value });
            invalidateLocalInput();
        }, { signal });
        seedInput.addEventListener('input', () => {
            if (seedInput.checkValidity()) {
                updateSettings({ seed: Number(seedInput.value) >>> 0 });
            }
            invalidateLocalInput();
        }, { signal });
        textInput.addEventListener('input', () => {
            textInput.setCustomValidity('');
            invalidateLocalInput();
        }, { signal });
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void runSimulation();
        }, { signal });
        cancelButton.addEventListener('click', () => {
            abortRun('Simulation cancelled.');
        }, { signal });

        syncMode(false);
        setTab(settings.lastTab, { persist: false });
        renderResult();

        return {
            root,
            get activeTab() {
                return activeTab;
            },
            renderResult,
            refresh(reason) {
                const message = staleMessage(reason);
                if (message) {
                    abortRun('Inputs changed. Run the simulation again.');
                    testsTab.invalidate('Stored test case run cancelled because scan inputs changed.');
                    void batchTab.refresh();
                }
                renderResult();
            },
            focusActiveTab() {
                tabButtons.find(button => button.getAttribute('aria-selected') === 'true')?.focus();
            },
            dispose() {
                if (disposed) {
                    return;
                }
                disposed = true;
                abortRun();
                testsTab.dispose();
                batchTab.dispose();
                sessionController.abort();
            },
        };
    }

    async function openOnce(opener) {
        const restoreTarget = opener instanceof HTMLElement
            ? opener
            : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        let api;
        try {
            api = await popupApi();
        } catch (error) {
            notify('error', `Could not open World Info Lab. ${errorMessage(error)}`);
            return;
        }
        if (destroyed) {
            return;
        }

        session = buildSession();
        const type = api.POPUP_TYPE.TEXT ?? api.POPUP_TYPE.DISPLAY;
        try {
            popup = new api.Popup(session.root, type, '', {
                wide: true,
                large: true,
                leftAlign: true,
                allowVerticalScrolling: false,
                okButton: 'Close',
                cancelButton: false,
                animation: false,
                onClosing: () => {
                    session?.dispose();
                    return true;
                },
            });
            popup.dlg.id = 'sbwil-workbench-dialog';
            popup.dlg.classList.add('sbwil-popup');
            popup.dlg.setAttribute('aria-label', 'World Info Lab workbench');
            emitState();
            const shown = popup.show();
            queueMicrotask(() => session?.focusActiveTab());
            await shown;
        } catch (error) {
            if (!destroyed) {
                notify('error', `Could not open World Info Lab. ${errorMessage(error)}`);
            }
        } finally {
            session?.dispose();
            session = null;
            popup = null;
            emitState();
            if (restoreTarget?.isConnected) {
                queueMicrotask(() => restoreTarget.focus({ preventScroll: true }));
            }
        }
    }

    function open(opener = null) {
        if (openPromise) {
            session?.focusActiveTab();
            return openPromise;
        }
        const promise = openOnce(opener).finally(() => {
            if (openPromise === promise) {
                openPromise = null;
            }
        });
        openPromise = promise;
        return promise;
    }

    function close() {
        session?.dispose();
        void popup?.completeCancelled?.();
    }

    if (lifetimeSignal) {
        lifetimeSignal.addEventListener('abort', close, { once: true });
    }

    return {
        open,
        close,
        refresh(reason) {
            const message = staleMessage(reason);
            if (message && latestResult) {
                stale = message;
            }
            if (message) {
                latestSnapshot = null;
            }
            session?.refresh(reason);
            emitState();
        },
        setAvailability(value) {
            availability = value;
            session?.renderResult();
            emitState();
        },
        getState: state,
        dispose() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            close();
        },
    };
}
