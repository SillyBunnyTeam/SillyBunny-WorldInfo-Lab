import { getContext } from '../host.js';
import { LOGIC_LABEL, POSITION_LABEL } from '../constants.js';
import { getSettings, updateSettings } from '../settings.js';
import { snapshotLorebooks } from '../sources.js';
import {
    element,
    errorMessage,
    field,
    formatValue,
    replace,
    statusRegion,
} from './dom.js';

function exported(module, names) {
    for (const name of names) {
        if (typeof module?.[name] === 'function') {
            return module[name];
        }
    }
    return null;
}

function recordsFrom(value, keys = []) {
    if (Array.isArray(value)) {
        return value;
    }
    for (const key of keys) {
        if (Array.isArray(value?.[key])) {
            return value[key];
        }
    }
    return [];
}

function tabIntroduction(title, text, kicker) {
    const header = element('header', { className: 'sbwil-panel-heading' });
    header.append(
        element('p', { className: 'sbwil-kicker', text: kicker }),
        element('h3', { text: title }),
        element('p', { className: 'sbwil-muted', text }),
    );
    return header;
}

function unavailable(title, detail) {
    const notice = element('section', {
        className: 'sbwil-unavailable',
        attributes: {
            'aria-label': title,
        },
    });
    notice.append(
        element('h4', { text: title }),
        element('p', { text: detail }),
    );
    return notice;
}

async function lorebookNames(context = getContext()) {
    if (typeof context?.getWorldInfoNames !== 'function') {
        return null;
    }
    try {
        const value = await context.getWorldInfoNames();
        return Array.isArray(value)
            ? [...new Set(value.map(String).filter(Boolean))]
            : [];
    } catch {
        return null;
    }
}

function caseKey(item, index) {
    return JSON.stringify([
        String(item?.bookName ?? ''),
        String(item?.id ?? item?.key ?? item?.name ?? index),
    ]);
}

function caseName(item, index) {
    return String(item?.name ?? item?.label ?? item?.id ?? `Test ${index + 1}`);
}

function formatDate(value) {
    if (!value) {
        return '';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? String(value)
        : new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(date);
}

export function createTestsTab({
    panel,
    getLatestResult,
    isLatestResultStale = () => false,
    acceptResult,
}) {
    const controller = new AbortController();
    let activated = false;
    let disposed = false;
    let refreshCases = async () => {};
    let refreshHistoryView = async () => {};
    let invalidateCaseRun = () => {};
    let refreshSaveState = () => {};

    async function activate() {
        if (activated || disposed) {
            return;
        }
        activated = true;

        const status = statusRegion('Loading saved tests and recent scans...');
        replace(
            panel,
            tabIntroduction(
                'Saved scan tests',
                'Save a scan result, run it again later, and see whether activation, token use, or insertion changed.',
                'SAVED CHECKS',
            ),
            status,
        );

        const [caseLoad, historyLoad] = await Promise.allSettled([
            import('../test-cases.js'),
            import('../history.js'),
        ]);
        if (disposed) {
            return;
        }

        if (caseLoad.status === 'rejected') {
            status.textContent = 'Saved tests could not load. Update or reinstall World Info Lab, then try again.';
            panel.append(unavailable(
                'Saved tests unavailable',
                `Technical details: could not load src/test-cases.js. ${errorMessage(caseLoad.reason)}`,
            ));
        } else {
            renderCaseControls(caseLoad.value, status);
        }

        const historySection = element('section', {
            className: 'sbwil-future-section',
            attributes: {
                'aria-labelledby': 'sbwil-history-title',
            },
        });
        historySection.append(element('h4', {
            id: 'sbwil-history-title',
            text: 'Recent scans',
        }));
        panel.append(historySection);

        if (historyLoad.status === 'rejected') {
            historySection.append(unavailable(
                'Recent scans unavailable',
                `Technical details: could not load src/history.js. ${errorMessage(historyLoad.reason)}`,
            ));
        } else {
            await renderHistory(historyLoad.value, historySection);
        }
    }

    function renderCaseControls(module, status) {
        const listCases = exported(module, ['listTestCases', 'getTestCases', 'loadTestCases']);
        const saveCase = exported(module, ['saveTestCase', 'createTestCase', 'upsertTestCase']);
        const runCase = exported(module, ['runTestCase', 'executeTestCase']);
        const removeCase = exported(module, ['deleteTestCase', 'removeTestCase']);

        if (!listCases) {
            status.textContent = 'Saved tests could not load. Update or reinstall World Info Lab, then try again.';
            panel.append(unavailable(
                'Saved tests unavailable',
                'Technical details: expected listTestCases(), getTestCases(), or loadTestCases() from src/test-cases.js.',
            ));
            return;
        }

        const section = element('section', {
            className: 'sbwil-future-section',
            attributes: {
                'aria-labelledby': 'sbwil-cases-title',
            },
        });
        const title = element('h4', { id: 'sbwil-cases-title', text: 'Saved tests' });
        const saveForm = element('form', { className: 'sbwil-saved-test-form' });
        const nameInput = element('input', {
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'text',
                required: 'required',
                maxlength: '120',
                autocomplete: 'off',
                placeholder: 'For example, Dragon activation',
            },
        });
        const bookSelect = element('select', {
            className: 'text_pole sbwil-select',
            attributes: {
                required: 'required',
                'aria-label': 'Lorebook for saved test',
            },
        });
        const saveButton = element('button', {
            className: 'menu_button sbwil-button',
            text: 'Save displayed scan as test',
            attributes: { type: 'submit' },
        });
        const consentInput = element('input', {
            attributes: {
                type: 'checkbox',
                required: 'required',
            },
        });
        const consent = element('label', { className: 'sbwil-approval sbwil-test-consent' });
        const consentText = element('span');
        consent.append(
            consentInput,
            consentText,
        );
        const privacyDetails = element('details', { className: 'sbwil-privacy-details' });
        const privacyList = element('ul');
        [
            'Chat messages or pasted text',
            'Scan-enabled extension prompts',
            'Character, persona, scenario, creator-note, filename, and tag data',
            'Expanded macro values, lorebook names, scan settings, and random seed',
            'Timed or forced entry IDs',
            'Expected activated IDs, token use, insertion locations, and rendered activated content',
        ].forEach(text => privacyList.append(element('li', { text })));
        privacyDetails.append(
            element('summary', { text: 'What this test stores' }),
            privacyList,
            element('p', {
                text: 'Delete the test here before sharing the lorebook. Cleaning World Info Lab does not delete saved tests.',
            }),
        );
        const saveAvailability = element('p', { className: 'sbwil-field-hint sbwil-save-availability' });
        const saveActions = element('div', { className: 'sbwil-form-actions' });
        saveActions.append(saveButton);
        saveButton.disabled = !saveCase;
        saveForm.append(
            field('Test name', nameInput, { className: 'sbwil-field sbwil-test-name' }),
            field('Store inside lorebook', bookSelect, {
                className: 'sbwil-field sbwil-test-book',
                hint: 'Saved tests travel with this lorebook and remain until you delete them here.',
            }),
            privacyDetails,
            consent,
            saveAvailability,
            saveActions,
        );

        const selectionRow = element('div', { className: 'sbwil-action-row sbwil-case-actions' });
        const select = element('select', {
            className: 'text_pole sbwil-select',
            attributes: { 'aria-label': 'Saved test' },
        });
        const runButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-primary',
            text: 'Run selected test',
            attributes: { type: 'button' },
        });
        const deleteButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-danger',
            text: 'Delete selected test',
            attributes: { type: 'button' },
        });
        const reloadButton = element('button', {
            className: 'menu_button sbwil-button',
            text: 'Reload saved tests',
            attributes: { type: 'button' },
        });
        runButton.disabled = !runCase;
        deleteButton.disabled = !removeCase;
        selectionRow.append(
            field('Saved test', select, { className: 'sbwil-field sbwil-case-select' }),
            runButton,
            deleteButton,
            reloadButton,
        );

        const capabilityNotes = [];
        if (!saveCase) {
            capabilityNotes.push('saveTestCase');
        }
        if (!runCase) {
            capabilityNotes.push('runTestCase');
        }
        if (!removeCase) {
            capabilityNotes.push('deleteTestCase');
        }
        const capability = capabilityNotes.length
            ? element('p', {
                className: 'sbwil-field-hint',
                text: `Some saved-test actions are unavailable because this installation is incomplete. Technical details: missing ${capabilityNotes.join(', ')}.`,
            })
            : null;
        const caseList = element('ol', { className: 'sbwil-compact-list' });
        section.append(title, saveForm, selectionRow);
        if (capability) {
            section.append(capability);
        }
        section.append(caseList);
        panel.insertBefore(section, panel.lastElementChild?.nextSibling ?? null);

        let cases = [];
        let knownBooks = [];
        let operationBusy = false;
        let refreshBusy = false;
        let refreshSequence = 0;
        let activeCaseController = null;
        let caseRunSequence = 0;

        function updateConsentText() {
            const name = bookSelect.value || 'the selected lorebook';
            consentText.textContent = `I understand that this test will be stored inside "${name}" and shared with that lorebook.`;
        }

        function updateDisabled() {
            const busy = operationBusy || refreshBusy;
            const hasSelection = Boolean(select.value) && cases.length > 0;
            const hasResult = Boolean(getLatestResult());
            const resultStale = hasResult && isLatestResultStale();
            saveButton.disabled = busy || !saveCase || !hasResult || resultStale;
            bookSelect.disabled = busy || !bookSelect.options.length;
            consentInput.disabled = busy;
            runButton.disabled = busy || !runCase || !hasSelection;
            deleteButton.disabled = busy || !removeCase || !hasSelection;
            reloadButton.disabled = busy;
            select.disabled = busy || !cases.length;
            saveAvailability.textContent = resultStale
                ? 'This scan is out of date. Run it again before saving a test.'
                : hasResult
                    ? 'The displayed scan is ready to save as a test.'
                    : 'Run a scan before saving it as a test.';
        }
        refreshSaveState = updateDisabled;

        function cancelCaseRun(message = '') {
            if (!activeCaseController) {
                return;
            }
            caseRunSequence++;
            activeCaseController.abort();
            activeCaseController = null;
            operationBusy = false;
            updateDisabled();
            if (message) {
                status.textContent = message;
            }
        }

        invalidateCaseRun = (message = 'Saved test canceled because the chat or lorebooks changed. Run it again.') => {
            cancelCaseRun(message);
        };

        function renderCases() {
            const selected = select.value;
            select.replaceChildren();
            caseList.replaceChildren();
            if (!cases.length) {
                select.append(element('option', { text: 'No saved tests', attributes: { value: '' } }));
                caseList.append(element('li', {
                    className: 'sbwil-empty-line',
                    text: 'No saved tests yet. Run a scan, name it above, and save it to a lorebook.',
                }));
                updateDisabled();
                return;
            }
            cases.forEach((item, index) => {
                const key = caseKey(item, index);
                select.append(element('option', {
                    text: `${caseName(item, index)} · ${item.bookName ?? 'lorebook unknown'}`,
                    attributes: { value: key },
                }));
                const listItem = element('li');
                listItem.append(
                    element('strong', { text: caseName(item, index) }),
                    element('span', {
                        className: 'sbwil-list-meta',
                        text: [item?.bookName, formatDate(item?.updatedAt ?? item?.createdAt), item?.fingerprint]
                            .filter(Boolean)
                            .join(' · '),
                    }),
                );
                caseList.append(listItem);
            });
            if ([...select.options].some(option => option.value === selected)) {
                select.value = selected;
            }
            updateDisabled();
        }

        function syncBookOptions() {
            const selected = bookSelect.value || getSettings().selectedBook;
            const sourceBooks = getLatestResult()?.replay?.sourcePlan?.all ?? [];
            const names = [...new Set([
                ...sourceBooks,
                ...knownBooks,
                ...cases.map(item => item?.bookName).filter(Boolean),
                ...(selected ? [selected] : []),
            ])];
            bookSelect.replaceChildren();
            names.forEach((name) => {
                bookSelect.append(element('option', {
                    text: name,
                    attributes: { value: name },
                }));
            });
            if (names.includes(selected)) {
                bookSelect.value = selected;
            }
            updateConsentText();
            updateDisabled();
        }

        refreshCases = async (message = 'Saved tests loaded.') => {
            const sequence = ++refreshSequence;
            refreshBusy = true;
            updateDisabled();
            if (!operationBusy) {
                status.textContent = 'Loading saved tests...';
            }
            try {
                const [value, names] = await Promise.all([
                    listCases(),
                    lorebookNames(),
                ]);
                if (disposed || sequence !== refreshSequence) {
                    return;
                }
                cases = recordsFrom(value, ['cases', 'items']);
                knownBooks = names ?? [];
                renderCases();
                syncBookOptions();
                if (!operationBusy) {
                    status.textContent = message;
                }
            } catch (error) {
                if (!disposed && sequence === refreshSequence && !operationBusy) {
                    status.textContent = `Saved tests could not be loaded. Try again. Technical details: ${errorMessage(error)}`;
                }
            } finally {
                if (sequence === refreshSequence) {
                    refreshBusy = false;
                    updateDisabled();
                }
            }
        };

        saveForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const result = getLatestResult();
            if (!result) {
                status.textContent = 'Run a scan before saving it as a test.';
                return;
            }
            if (isLatestResultStale()) {
                status.textContent = 'This scan is out of date. Run it again before saving a test.';
                return;
            }
            syncBookOptions();
            if (!saveCase || !saveForm.reportValidity()) {
                return;
            }
            if (!bookSelect.value) {
                status.textContent = 'Choose a lorebook in which to store this test.';
                return;
            }
            const testName = nameInput.value.trim();
            const bookName = bookSelect.value;
            operationBusy = true;
            updateDisabled();
            status.textContent = `Saving test "${testName}" to "${bookName}"...`;
            try {
                const saved = await saveCase({
                    name: testName,
                    bookName,
                    result: structuredClone(result),
                    createdAt: new Date().toISOString(),
                    confirmReplayStorage: consentInput.checked,
                });
                nameInput.value = '';
                consentInput.checked = false;
                await refreshCases(`Saved test "${testName}" to "${bookName}".`);
                status.textContent = saved?.refreshWarning
                    ? String(saved.refreshWarning)
                    : `Saved test "${testName}" to "${bookName}".`;
            } catch (error) {
                status.textContent = `The test could not be saved. Nothing was changed. Technical details: ${errorMessage(error)}`;
            } finally {
                operationBusy = false;
                updateDisabled();
            }
        }, { signal: controller.signal });

        runButton.addEventListener('click', async () => {
            const index = select.selectedIndex;
            const selected = cases[index];
            if (!runCase || !selected) {
                return;
            }
            cancelCaseRun();
            const sequence = ++caseRunSequence;
            const runController = new AbortController();
            activeCaseController = runController;
            operationBusy = true;
            updateDisabled();
            status.textContent = `Running saved test "${caseName(selected, index)}"...`;
            try {
                const response = await runCase(selected, { signal: runController.signal });
                if (disposed || runController.signal.aborted || sequence !== caseRunSequence) {
                    return;
                }
                const result = response?.result ?? response;
                if (result?.kind === 'simulated') {
                    acceptResult(result);
                }
                status.textContent = String(
                    response?.summary
                    ?? response?.message
                    ?? (response?.passed === false
                        ? 'The saved test did not match. Open Scan and Trace to inspect the new result.'
                        : 'Saved test complete.'),
                );
            } catch (error) {
                if (disposed || runController.signal.aborted || sequence !== caseRunSequence) {
                    return;
                }
                status.textContent = `The saved test could not run. Technical details: ${errorMessage(error)}`;
            } finally {
                if (sequence === caseRunSequence) {
                    activeCaseController = null;
                    operationBusy = false;
                    updateDisabled();
                }
            }
        }, { signal: controller.signal });

        deleteButton.addEventListener('click', async () => {
            const index = select.selectedIndex;
            const selected = cases[index];
            if (!removeCase || !selected) {
                return;
            }
            const name = caseName(selected, index);
            const book = selected.bookName ?? 'its lorebook';
            if (typeof globalThis.confirm === 'function'
                && !globalThis.confirm(`Delete "${name}" from "${book}"? This cannot be undone.`)) {
                return;
            }
            operationBusy = true;
            updateDisabled();
            status.textContent = `Deleting saved test "${name}"...`;
            try {
                const removed = await removeCase(selected.id ?? selected.key ?? selected.name, {
                    bookName: selected.bookName,
                });
                if (removed === false) {
                    status.textContent = 'The test was not found. It may already have been deleted; reload saved tests.';
                    return;
                }
                await refreshCases('Saved test deleted.');
                status.textContent = 'Saved test deleted.';
            } catch (error) {
                status.textContent = `The saved test could not be deleted. Technical details: ${errorMessage(error)}`;
            } finally {
                operationBusy = false;
                updateDisabled();
            }
        }, { signal: controller.signal });

        reloadButton.addEventListener('click', () => {
            void refreshCases();
        }, { signal: controller.signal });
        bookSelect.addEventListener('change', updateConsentText, { signal: controller.signal });

        void refreshCases();
    }

    async function renderHistory(module, section) {
        const listHistory = exported(module, ['listHistory', 'getHistory', 'loadHistory']);
        if (!listHistory) {
            section.append(unavailable(
                'Recent scans unavailable',
                'Technical details: expected listHistory(), getHistory(), or loadHistory() from src/history.js.',
            ));
            return;
        }

        const list = element('ol', { className: 'sbwil-compact-list' });
        section.append(
            element('p', {
                className: 'sbwil-field-hint',
                text: 'Recent scans are summary-only. They do not contain chat text, entry content, Trace details, or inserted content.',
            }),
            list,
        );
        refreshHistoryView = async () => {
            list.replaceChildren();
            try {
                const value = await listHistory();
                if (disposed) {
                    return;
                }
                const history = recordsFrom(value, ['history', 'runs', 'entries']).slice(0, 20);
                if (!history.length) {
                    list.append(element('li', {
                        className: 'sbwil-empty-line',
                        text: 'No recent scans yet. Completed scans will appear here.',
                    }));
                    return;
                }
                history.forEach((item, index) => {
                    const row = element('li');
                    const timestamp = item?.createdAt ?? item?.timestamp;
                    row.append(
                        element('strong', {
                            text: String(item?.name ?? item?.label ?? (timestamp
                                ? `Scan on ${formatDate(timestamp)}`
                                : `Scan ${index + 1}`)),
                        }),
                        element('span', {
                            className: 'sbwil-list-meta',
                            text: [
                                `${item?.activated ?? 0} entries activated`,
                                `${item?.tokens ?? 0} lorebook tokens`,
                                item?.fingerprint ? `Result ID ${item.fingerprint}` : '',
                            ].filter(Boolean).join(' · '),
                        }),
                    );
                    list.append(row);
                });
            } catch (error) {
                list.append(element('li', {
                    className: 'sbwil-empty-line',
                    text: `Recent scans could not be loaded. Try again. Technical details: ${errorMessage(error)}`,
                }));
            }
        };
        await refreshHistoryView();
    }

    return {
        activate,
        async refresh() {
            if (!activated || disposed) {
                return;
            }
            await Promise.allSettled([
                refreshCases('Saved tests refreshed.'),
                refreshHistoryView(),
            ]);
        },
        invalidate(message) {
            invalidateCaseRun(message);
        },
        syncResultState() {
            refreshSaveState();
        },
        dispose() {
            invalidateCaseRun();
            disposed = true;
            controller.abort();
        },
    };
}

function previewChanges(value) {
    return recordsFrom(value, ['changes', 'entries', 'preview']);
}

function changeLabel(change, index) {
    return String(change?.label ?? change?.comment ?? change?.id ?? change?.uid ?? `Change ${index + 1}`);
}

const BATCH_FIELD_LABEL = Object.freeze({
    order: 'Order',
    probability: 'Probability',
    useProbability: 'Probability check',
    depth: 'Insertion depth',
    scanDepth: 'Scan depth',
    position: 'Insertion position',
    selectiveLogic: 'Secondary-key rule',
    groupWeight: 'Group weight',
    disable: 'Entry state',
    matchWholeWords: 'Whole-word matching',
    characterFilter: 'Character filter',
});

function humanFieldName(fieldName) {
    return BATCH_FIELD_LABEL[fieldName] ?? '';
}

function renderBatchPreview(container, preview) {
    const changes = previewChanges(preview);
    const reportedCount = Number(preview?.count ?? preview?.changed ?? changes.length);
    const count = Number.isFinite(reportedCount) ? reportedCount : changes.length;
    container.replaceChildren();
    container.append(element('p', {
        className: 'sbwil-preview-count',
        text: `${count} ${count === 1 ? 'entry would' : 'entries would'} change.`,
    }));

    if (!changes.length) {
        if (preview && typeof preview === 'object') {
            const output = element('pre', { className: 'sbwil-log' });
            output.textContent = formatValue(preview);
            container.append(output);
        }
        return count;
    }

    changes.forEach((change, index) => {
        const details = element('details', { className: 'sbwil-change' });
        const setting = change?.field === 'content' ? 'Content' : humanFieldName(change?.field);
        details.append(element('summary', {
            text: setting ? `${changeLabel(change, index)}: ${setting}` : changeLabel(change, index),
        }));
        const before = change?.before ?? change?.oldValue ?? change?.previous;
        const after = change?.after ?? change?.newValue ?? change?.next;
        if (before !== undefined) {
            details.append(
                element('span', { className: 'sbwil-field-label', text: 'Before' }),
                element('pre', { className: 'sbwil-log', text: formatValue(before) }),
            );
        }
        if (after !== undefined) {
            details.append(
                element('span', { className: 'sbwil-field-label', text: 'After' }),
                element('pre', { className: 'sbwil-log', text: formatValue(after) }),
            );
        }
        if (before === undefined && after === undefined) {
            details.append(element('pre', { className: 'sbwil-log', text: formatValue(change) }));
        }
        container.append(details);
    });
    return count;
}

export function createBatchTab({ panel }) {
    const controller = new AbortController();
    let activated = false;
    let disposed = false;
    let refreshBooks = async () => {};

    async function activate() {
        if (activated || disposed) {
            return;
        }
        activated = true;

        const status = statusRegion('Loading batch editing...');
        replace(
            panel,
            tabIntroduction(
                'Edit many lorebook entries',
                'Change content or settings in one lorebook, review every proposed change, then save only the reviewed preview.',
                'LOREBOOK MAINTENANCE',
            ),
            status,
        );

        let module;
        try {
            module = await import('../batch.js');
        } catch (error) {
            if (!disposed) {
                status.textContent = 'Batch editing could not load. Update or reinstall World Info Lab, then try again.';
                panel.append(unavailable(
                    'Batch editing unavailable',
                    `Technical details: could not load src/batch.js. ${errorMessage(error)}`,
                ));
            }
            return;
        }
        if (disposed) {
            return;
        }

        const previewBatch = exported(module, ['previewBatch', 'buildBatchPreview', 'previewChanges']);
        const applyBatch = exported(module, ['applyBatch', 'commitBatch', 'applyChanges']);
        if (!previewBatch || !applyBatch) {
            status.textContent = 'Batch editing could not load. Update or reinstall World Info Lab, then try again.';
            panel.append(unavailable(
                'Batch editing unavailable',
                'Technical details: expected previewBatch() and applyBatch() from src/batch.js.',
            ));
            return;
        }

        const form = element('form', { className: 'sbwil-batch-form' });
        const bookSelect = element('select', {
            className: 'text_pole sbwil-select',
            attributes: {
                required: 'required',
                'aria-label': 'Lorebook',
            },
        });
        const operationSelect = element('select', {
            className: 'text_pole sbwil-select',
            attributes: { 'aria-label': 'Edit type' },
        });
        operationSelect.append(
            element('option', {
                text: 'Find and replace in entry content',
                attributes: { value: 'replace-content' },
            }),
            element('option', {
                text: 'Change an entry setting',
                attributes: { value: 'set-field' },
            }),
        );
        const filterInput = element('input', {
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'search',
                autocomplete: 'off',
                'aria-label': 'Entries to include',
                placeholder: 'Search keys, entry ID, comment, or content',
            },
        });
        const findInput = element('input', {
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'text',
                required: 'required',
                autocomplete: 'off',
                'aria-label': 'Exact text to find',
                placeholder: 'Exact text to find',
            },
        });
        const replacementInput = element('textarea', {
            className: 'text_pole sbwil-textarea sbwil-textarea-compact',
            attributes: {
                rows: '3',
                'aria-label': 'Replacement content',
                placeholder: 'Leave blank to delete each match',
            },
        });
        const fieldSelect = element('select', {
            className: 'text_pole sbwil-select',
            attributes: { 'aria-label': 'Entry setting' },
        });
        Object.entries(BATCH_FIELD_LABEL).forEach(([value, label]) => {
            fieldSelect.append(element('option', {
                text: label,
                attributes: { value },
            }));
        });
        const numberValueInput = element('input', {
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'number',
                required: 'required',
                inputmode: 'decimal',
                'aria-label': 'New setting value',
            },
        });
        const choiceValueSelect = element('select', {
            className: 'text_pole sbwil-select',
            attributes: {
                required: 'required',
                'aria-label': 'New setting value',
            },
        });
        const jsonValueInput = element('textarea', {
            className: 'text_pole sbwil-textarea sbwil-textarea-compact',
            attributes: {
                rows: '4',
                required: 'required',
                'aria-label': 'New setting value',
                placeholder: '{"names":[],"tags":[],"isExclude":false}',
            },
        });
        const valueField = element('label', { className: 'sbwil-field' });
        const valueFieldLabel = element('span', {
            className: 'sbwil-field-label',
            text: 'New setting value',
        });
        const valueFieldHint = element('span', { className: 'sbwil-field-hint' });
        let activeValueControl = numberValueInput;
        const replaceFields = element('div', { className: 'sbwil-batch-fields' });
        replaceFields.append(
            field('Find exact text', findInput, {
                hint: 'Replaces every exact, case-sensitive occurrence. Special characters are treated as text, not patterns.',
            }),
            field('Replace with', replacementInput, {
                hint: 'Leave blank to delete each matching piece of text.',
            }),
        );
        const setFields = element('div', { className: 'sbwil-batch-fields' });
        setFields.append(
            field('Entry setting', fieldSelect),
            valueField,
        );
        const previewButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-primary',
            text: 'Preview changes',
            attributes: { type: 'submit' },
        });
        const reloadBooksButton = element('button', {
            className: 'menu_button sbwil-button',
            text: 'Reload lorebooks',
            attributes: { type: 'button' },
        });
        const batchActions = element('div', { className: 'sbwil-action-row' });
        batchActions.append(previewButton, reloadBooksButton);
        form.append(
            field('Lorebook', bookSelect),
            field('What do you want to change?', operationSelect),
            field('Which entries?', filterInput, {
                hint: 'Only matching entries are checked. Leave blank to check every entry in this lorebook.',
            }),
            replaceFields,
            setFields,
            batchActions,
        );

        const previewRegion = element('section', {
            className: 'sbwil-preview',
            attributes: {
                'aria-label': 'Batch preview',
                'aria-live': 'polite',
            },
        });
        previewRegion.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'Choose an edit above, then select Preview changes. Nothing will be saved yet.',
        }));

        const approval = element('label', { className: 'sbwil-approval' });
        const approvalInput = element('input', { attributes: { type: 'checkbox' } });
        const approvalText = element('span', {
            text: 'I reviewed every proposed change and want to save it to this lorebook.',
        });
        approval.append(
            approvalInput,
            approvalText,
        );
        const applyButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-danger',
            text: 'Save these changes to the lorebook',
            attributes: { type: 'button' },
        });
        applyButton.disabled = true;
        panel.append(form, previewRegion, approval, applyButton);

        let snapshot = null;
        let preview = null;
        let previewPayload = null;
        let busy = false;
        let bookRefresh = 0;

        function updateApprovalText() {
            approvalText.textContent = bookSelect.value
                ? `I reviewed every proposed change and want to save it to "${bookSelect.value}".`
                : 'I reviewed every proposed change and want to save it to this lorebook.';
        }

        function setChoiceOptions(options) {
            choiceValueSelect.replaceChildren();
            options.forEach(([value, label]) => {
                choiceValueSelect.append(element('option', {
                    text: label,
                    attributes: { value },
                }));
            });
        }

        function configureValueControl(announce = true) {
            const fieldName = fieldSelect.value;
            let hint = '';
            if (fieldName === 'position') {
                activeValueControl = choiceValueSelect;
                setChoiceOptions(Object.entries(POSITION_LABEL));
                hint = 'Choose where the activated entry content should be inserted.';
            } else if (fieldName === 'selectiveLogic') {
                activeValueControl = choiceValueSelect;
                setChoiceOptions([
                    ['0', `${LOGIC_LABEL[0]}: at least one secondary key must match`],
                    ['1', `${LOGIC_LABEL[1]}: not every secondary key may match`],
                    ['2', `${LOGIC_LABEL[2]}: no secondary key may match`],
                    ['3', `${LOGIC_LABEL[3]}: every secondary key must match`],
                ]);
                hint = 'This rule is checked after a primary key matches.';
            } else if (['disable', 'matchWholeWords', 'useProbability'].includes(fieldName)) {
                activeValueControl = choiceValueSelect;
                const labels = {
                    disable: [
                        ['false', 'Entry enabled'],
                        ['true', 'Entry disabled'],
                    ],
                    matchWholeWords: [
                        ['false', 'Off: allow partial-word matches'],
                        ['true', 'On: require whole-word matches'],
                    ],
                    useProbability: [
                        ['true', 'On: use the entry probability'],
                        ['false', 'Off: skip the probability check'],
                    ],
                };
                setChoiceOptions(labels[fieldName]);
                hint = 'Choose the state to apply to every matching entry.';
            } else if (fieldName === 'characterFilter') {
                activeValueControl = jsonValueInput;
                jsonValueInput.value = '';
                hint = 'Advanced: enter a JSON object with names, tags, and isExclude.';
            } else {
                activeValueControl = numberValueInput;
                numberValueInput.value = '';
                const config = {
                    order: { min: '-1000000', max: '1000000', step: 'any', placeholder: 'For example, 100', hint: 'Higher values are checked earlier.' },
                    probability: { min: '0', max: '100', step: 'any', placeholder: '0 to 100', hint: 'Chance to activate after all other checks pass.' },
                    depth: { min: '0', max: '10000', step: '1', placeholder: '0 to 10000', hint: 'Chat depth used when the insertion position is At chat depth.' },
                    scanDepth: { min: '0', max: '1000', step: '1', placeholder: 'Leave blank to use the global scan depth', hint: 'Number of recent messages this entry checks. Leave blank to use the lorebook setting.' },
                    groupWeight: { min: '1', max: '999999', step: 'any', placeholder: '1 or more', hint: 'Relative chance of being chosen from an inclusion group.' },
                }[fieldName];
                numberValueInput.min = config.min;
                numberValueInput.max = config.max;
                numberValueInput.step = config.step;
                numberValueInput.placeholder = config.placeholder;
                numberValueInput.required = fieldName !== 'scanDepth';
                hint = config.hint;
            }
            valueFieldHint.textContent = hint;
            valueField.replaceChildren(valueFieldLabel, activeValueControl, valueFieldHint);
            if (announce && preview) {
                invalidatePreview('Edit settings changed. Select Preview changes again before saving.');
            }
            updateDisabled();
        }

        function invalidatePreview(message = '') {
            preview = null;
            previewPayload = null;
            approvalInput.checked = false;
            applyButton.disabled = true;
            if (message) {
                previewRegion.replaceChildren(element('p', {
                    className: 'sbwil-empty-line',
                    text: message,
                }));
            }
        }

        function updateDisabled() {
            bookSelect.disabled = busy || !bookSelect.options.length;
            operationSelect.disabled = busy;
            filterInput.disabled = busy;
            findInput.disabled = busy;
            replacementInput.disabled = busy;
            fieldSelect.disabled = busy;
            activeValueControl.disabled = busy;
            previewButton.disabled = busy || !bookSelect.value || !snapshot;
            reloadBooksButton.disabled = busy;
            approvalInput.disabled = busy || !preview;
            applyButton.disabled = busy || !preview || !approvalInput.checked;
        }

        function syncOperation(announce = true) {
            const replaceContent = operationSelect.value === 'replace-content';
            replaceFields.hidden = !replaceContent;
            setFields.hidden = replaceContent;
            findInput.required = replaceContent;
            if (announce && preview) {
                invalidatePreview('Edit type changed. Select Preview changes again before saving.');
            }
            updateDisabled();
        }

        async function loadBookSnapshot(name, sequence, preloaded = null) {
            snapshot = null;
            updateDisabled();
            if (!name) {
                status.textContent = 'No lorebooks were found. Create or import a lorebook, then reload this tab.';
                return;
            }
            status.textContent = `Loading "${name}"...`;
            const nextSnapshot = preloaded?.books?.has(name)
                ? preloaded
                : await snapshotLorebooks({ context: getContext(), bookNames: [name] });
            if (disposed || sequence !== bookRefresh) {
                return;
            }
            snapshot = nextSnapshot;
            const book = nextSnapshot.books.get(name);
            const count = book?.entries && typeof book.entries === 'object'
                ? Object.keys(book.entries).length
                : 0;
            status.textContent = `Loaded "${name}": ${count} ${count === 1 ? 'entry' : 'entries'} ready to review.`;
        }

        refreshBooks = async (announce = false) => {
            const sequence = ++bookRefresh;
            if (announce) {
                invalidatePreview('Lorebooks changed. Select Preview changes again before saving.');
            }
            busy = true;
            snapshot = null;
            updateDisabled();
            status.textContent = 'Loading lorebooks...';
            try {
                const context = getContext();
                const known = await lorebookNames(context);
                let activeSnapshot = null;
                let names = known;
                if (names === null) {
                    activeSnapshot = await snapshotLorebooks({ context });
                    names = activeSnapshot.plan.all;
                }
                if (disposed || sequence !== bookRefresh) {
                    return;
                }
                const saved = getSettings().selectedBook;
                if (known === null && saved) {
                    names = [...new Set([...names, saved])];
                }
                bookSelect.replaceChildren();
                if (!names.length) {
                    bookSelect.append(element('option', {
                        text: 'No lorebooks found',
                        attributes: { value: '' },
                    }));
                } else {
                    names.forEach((name) => {
                        bookSelect.append(element('option', {
                            text: name,
                            attributes: { value: name },
                        }));
                    });
                    bookSelect.value = names.includes(saved) ? saved : names[0];
                }
                const preloaded = activeSnapshot?.books?.has(bookSelect.value) ? activeSnapshot : null;
                updateApprovalText();
                await loadBookSnapshot(bookSelect.value, sequence, preloaded);
            } catch (error) {
                if (disposed || sequence !== bookRefresh) {
                    return;
                }
                snapshot = null;
                bookSelect.replaceChildren(element('option', {
                    text: 'Could not load lorebooks',
                    attributes: { value: '' },
                }));
                status.textContent = `Lorebooks could not be loaded. Try again. Technical details: ${errorMessage(error)}`;
            } finally {
                if (sequence === bookRefresh) {
                    busy = false;
                    updateDisabled();
                }
            }
        };

        bookSelect.addEventListener('change', () => {
            const sequence = ++bookRefresh;
            updateSettings({ selectedBook: bookSelect.value });
            updateApprovalText();
            invalidatePreview('The selected lorebook changed. Select Preview changes again before saving.');
            busy = true;
            snapshot = null;
            updateDisabled();
            void loadBookSnapshot(bookSelect.value, sequence).catch((error) => {
                if (!disposed && sequence === bookRefresh) {
                    status.textContent = `"${bookSelect.value}" could not be loaded. Try again. Technical details: ${errorMessage(error)}`;
                }
            }).finally(() => {
                if (sequence === bookRefresh) {
                    busy = false;
                    updateDisabled();
                }
            });
        }, { signal: controller.signal });

        operationSelect.addEventListener('change', syncOperation, { signal: controller.signal });
        fieldSelect.addEventListener('change', configureValueControl, { signal: controller.signal });
        [filterInput, findInput, replacementInput, numberValueInput, jsonValueInput].forEach((control) => {
            control.addEventListener('input', () => {
                if (preview) {
                    invalidatePreview('Edit settings changed. Select Preview changes again before saving.');
                    updateDisabled();
                }
            }, { signal: controller.signal });
        });
        choiceValueSelect.addEventListener('change', () => {
            if (preview) {
                invalidatePreview('Edit settings changed. Select Preview changes again before saving.');
                updateDisabled();
            }
        }, { signal: controller.signal });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!snapshot || !form.reportValidity()) {
                return;
            }
            busy = true;
            invalidatePreview();
            updateDisabled();
            status.textContent = 'Checking entries and building a preview...';
            const payload = {
                operation: operationSelect.value,
                bookName: bookSelect.value,
                find: findInput.value,
                replacement: replacementInput.value,
                filter: filterInput.value,
                field: fieldSelect.value,
                value: activeValueControl.value,
                snapshot,
            };
            try {
                const result = await previewBatch(payload, { signal: controller.signal });
                if (disposed) {
                    return;
                }
                const count = renderBatchPreview(previewRegion, result);
                preview = count > 0 ? result : null;
                previewPayload = count > 0 ? payload : null;
                status.textContent = count > 0
                    ? 'Preview ready. Review every proposed change before saving.'
                    : 'No entries would change. No entries matched, or matching entries already had the requested value.';
            } catch (error) {
                status.textContent = `The preview could not be built. Nothing was saved. Technical details: ${errorMessage(error)}`;
                previewRegion.replaceChildren(element('p', {
                    className: 'sbwil-empty-line',
                    text: 'Preview failed. Nothing was saved.',
                }));
            } finally {
                busy = false;
                updateDisabled();
            }
        }, { signal: controller.signal });

        approvalInput.addEventListener('change', updateDisabled, { signal: controller.signal });
        reloadBooksButton.addEventListener('click', () => {
            void refreshBooks(true);
        }, { signal: controller.signal });

        applyButton.addEventListener('click', async () => {
            if (!preview || !previewPayload || !approvalInput.checked) {
                return;
            }
            busy = true;
            updateDisabled();
            const bookName = previewPayload.bookName;
            const changeCount = previewChanges(preview).length;
            status.textContent = `Saving ${changeCount} reviewed ${changeCount === 1 ? 'change' : 'changes'} to "${bookName}"...`;
            try {
                const response = await applyBatch(preview, {
                    payload: previewPayload,
                    signal: controller.signal,
                });
                await refreshBooks(false);
                invalidatePreview(`Changes saved to "${bookName}". Select Preview changes to make another edit.`);
                status.textContent = response?.refreshWarning
                    ? String(response.refreshWarning)
                    : `Changes saved to "${bookName}".`;
            } catch (error) {
                if (error?.name === 'BatchConflictError' || Array.isArray(error?.conflicts)) {
                    const count = error?.conflicts?.length ?? 1;
                    const message = `Nothing was saved because ${count} reviewed ${count === 1 ? 'entry changed' : 'entries changed'} after this preview was created. Build and review a new preview.`;
                    status.textContent = message;
                    invalidatePreview(message);
                } else {
                    status.textContent = `The changes could not be saved. Nothing was changed. Technical details: ${errorMessage(error)}`;
                }
            } finally {
                busy = false;
                updateDisabled();
            }
        }, { signal: controller.signal });

        configureValueControl(false);
        syncOperation(false);
        await refreshBooks(false);
    }

    return {
        activate,
        refresh() {
            if (activated && !disposed) {
                void refreshBooks(true);
            }
        },
        dispose() {
            disposed = true;
            controller.abort();
        },
    };
}
