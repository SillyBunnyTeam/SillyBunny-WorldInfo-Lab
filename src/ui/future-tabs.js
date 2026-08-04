import { getContext } from '../host.js';
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

function tabIntroduction(title, text) {
    const header = element('header', { className: 'sbwil-panel-heading' });
    header.append(
        element('p', { className: 'sbwil-kicker', text: 'EXTENSION API' }),
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
    return String(item?.name ?? item?.label ?? item?.id ?? `Case ${index + 1}`);
}

export function createTestsTab({
    panel,
    getLatestResult,
    acceptResult,
}) {
    const controller = new AbortController();
    let activated = false;
    let disposed = false;
    let refreshCases = async () => {};
    let refreshHistoryView = async () => {};
    let invalidateCaseRun = () => {};

    async function activate() {
        if (activated || disposed) {
            return;
        }
        activated = true;

        const status = statusRegion('Loading test case and history APIs...');
        replace(
            panel,
            tabIntroduction(
                'Regression tests',
                'Save a simulation as a case, rerun stored cases, and inspect recent run history.',
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
            status.textContent = 'Tests are unavailable.';
            panel.append(unavailable(
                'Test case API unavailable',
                `Could not load src/test-cases.js. ${errorMessage(caseLoad.reason)}`,
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
            text: 'Recent simulations',
        }));
        panel.append(historySection);

        if (historyLoad.status === 'rejected') {
            historySection.append(unavailable(
                'History API unavailable',
                `Could not load src/history.js. ${errorMessage(historyLoad.reason)}`,
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
            status.textContent = 'Tests are unavailable.';
            panel.append(unavailable(
                'Test case API mismatch',
                'Expected listTestCases(), getTestCases(), or loadTestCases() from src/test-cases.js.',
            ));
            return;
        }

        const section = element('section', {
            className: 'sbwil-future-section',
            attributes: {
                'aria-labelledby': 'sbwil-cases-title',
            },
        });
        const title = element('h4', { id: 'sbwil-cases-title', text: 'Stored cases' });
        const saveForm = element('form', { className: 'sbwil-inline-form' });
        const nameInput = element('input', {
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'text',
                required: 'required',
                maxlength: '120',
                autocomplete: 'off',
                placeholder: 'Case name',
            },
        });
        const bookSelect = element('select', {
            className: 'text_pole sbwil-select',
            attributes: {
                required: 'required',
                'aria-label': 'Lorebook for stored test case',
            },
        });
        const saveButton = element('button', {
            className: 'menu_button sbwil-button',
            text: 'Save latest result',
            attributes: { type: 'submit' },
        });
        const consentInput = element('input', {
            attributes: {
                type: 'checkbox',
                required: 'required',
            },
        });
        const consent = element('label', { className: 'sbwil-approval' });
        consent.append(
            consentInput,
            element('span', {
                text: 'Store replay data in this lorebook: chat or pasted text, scan prompts, character and persona fields, macro expansions, trigger, scan settings, and expected placements with activated rendered lorebook content.',
            }),
        );
        saveButton.disabled = !saveCase;
        saveForm.append(
            field('Name', nameInput),
            field('Save in lorebook', bookSelect, {
                hint: 'The case is portable and remains until deleted from Tests. Cleaning extension data does not remove it.',
            }),
            consent,
            saveButton,
        );

        const selectionRow = element('div', { className: 'sbwil-action-row' });
        const select = element('select', {
            className: 'text_pole sbwil-select',
            attributes: { 'aria-label': 'Stored test case' },
        });
        const runButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-primary',
            text: 'Run selected',
            attributes: { type: 'button' },
        });
        const deleteButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-danger',
            text: 'Delete selected',
            attributes: { type: 'button' },
        });
        const reloadButton = element('button', {
            className: 'menu_button sbwil-button',
            text: 'Reload',
            attributes: { type: 'button' },
        });
        runButton.disabled = !runCase;
        deleteButton.disabled = !removeCase;
        selectionRow.append(select, runButton, deleteButton, reloadButton);

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
        const capability = element('p', {
            className: 'sbwil-field-hint',
            text: capabilityNotes.length
                ? `Unavailable controls need: ${capabilityNotes.join(', ')}.`
                : 'Cases are provided by src/test-cases.js.',
        });
        const caseList = element('ol', { className: 'sbwil-compact-list' });
        section.append(title, saveForm, selectionRow, capability, caseList);
        panel.insertBefore(section, panel.lastElementChild?.nextSibling ?? null);

        let cases = [];
        let knownBooks = [];
        let operationBusy = false;
        let refreshBusy = false;
        let refreshSequence = 0;
        let activeCaseController = null;
        let caseRunSequence = 0;

        function updateDisabled() {
            const busy = operationBusy || refreshBusy;
            const hasSelection = Boolean(select.value) && cases.length > 0;
            saveButton.disabled = busy || !saveCase;
            bookSelect.disabled = busy || !bookSelect.options.length;
            consentInput.disabled = busy;
            runButton.disabled = busy || !runCase || !hasSelection;
            deleteButton.disabled = busy || !removeCase || !hasSelection;
            reloadButton.disabled = busy;
            select.disabled = busy || !cases.length;
        }

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

        invalidateCaseRun = (message = 'Stored test case run cancelled because scan inputs changed.') => {
            cancelCaseRun(message);
        };

        function renderCases() {
            const selected = select.value;
            select.replaceChildren();
            caseList.replaceChildren();
            if (!cases.length) {
                select.append(element('option', { text: 'No stored cases', attributes: { value: '' } }));
                caseList.append(element('li', { className: 'sbwil-empty-line', text: 'No test cases yet.' }));
                updateDisabled();
                return;
            }
            cases.forEach((item, index) => {
                const key = caseKey(item, index);
                select.append(element('option', {
                    text: `${caseName(item, index)} · ${item.bookName ?? 'unknown lorebook'}`,
                    attributes: { value: key },
                }));
                const listItem = element('li');
                listItem.append(
                    element('strong', { text: caseName(item, index) }),
                    element('span', {
                        className: 'sbwil-list-meta',
                        text: [item?.bookName, item?.updatedAt ?? item?.createdAt ?? item?.fingerprint]
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
            updateDisabled();
        }

        refreshCases = async (message = 'Test cases loaded.') => {
            const sequence = ++refreshSequence;
            refreshBusy = true;
            updateDisabled();
            if (!operationBusy) {
                status.textContent = 'Loading test cases...';
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
                    status.textContent = `Could not load test cases. ${errorMessage(error)}`;
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
                status.textContent = 'Run a simulation before saving a test case.';
                return;
            }
            syncBookOptions();
            if (!saveCase || !saveForm.reportValidity()) {
                return;
            }
            if (!bookSelect.value) {
                status.textContent = 'Choose an active lorebook before saving a test case.';
                return;
            }
            operationBusy = true;
            updateDisabled();
            status.textContent = 'Saving test case...';
            try {
                await saveCase({
                    name: nameInput.value.trim(),
                    bookName: bookSelect.value,
                    result: structuredClone(result),
                    createdAt: new Date().toISOString(),
                    confirmReplayStorage: consentInput.checked,
                });
                nameInput.value = '';
                consentInput.checked = false;
                await refreshCases('Test case saved.');
                status.textContent = 'Test case saved.';
            } catch (error) {
                status.textContent = `Could not save the test case. ${errorMessage(error)}`;
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
            status.textContent = `Running ${caseName(selected, index)}...`;
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
                    ?? (response?.passed === false ? 'Test failed.' : 'Test run complete.'),
                );
            } catch (error) {
                if (disposed || runController.signal.aborted || sequence !== caseRunSequence) {
                    return;
                }
                status.textContent = `Could not run the test case. ${errorMessage(error)}`;
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
            operationBusy = true;
            updateDisabled();
            status.textContent = `Deleting ${caseName(selected, index)}...`;
            try {
                await removeCase(selected.id ?? selected.key ?? selected.name, {
                    bookName: selected.bookName,
                });
                await refreshCases('Test case deleted.');
                status.textContent = 'Test case deleted.';
            } catch (error) {
                status.textContent = `Could not delete the test case. ${errorMessage(error)}`;
            } finally {
                operationBusy = false;
                updateDisabled();
            }
        }, { signal: controller.signal });

        reloadButton.addEventListener('click', () => {
            void refreshCases();
        }, { signal: controller.signal });

        void refreshCases();
    }

    async function renderHistory(module, section) {
        const listHistory = exported(module, ['listHistory', 'getHistory', 'loadHistory']);
        if (!listHistory) {
            section.append(unavailable(
                'History API mismatch',
                'Expected listHistory(), getHistory(), or loadHistory() from src/history.js.',
            ));
            return;
        }

        const list = element('ol', { className: 'sbwil-compact-list' });
        section.append(list);
        refreshHistoryView = async () => {
            list.replaceChildren();
            try {
                const value = await listHistory();
                if (disposed) {
                    return;
                }
                const history = recordsFrom(value, ['history', 'runs', 'entries']).slice(0, 20);
                if (!history.length) {
                    list.append(element('li', { className: 'sbwil-empty-line', text: 'No history entries yet.' }));
                    return;
                }
                history.forEach((item, index) => {
                    const row = element('li');
                    row.append(
                        element('strong', {
                            text: String(item?.name ?? item?.label ?? item?.fingerprint ?? `Run ${index + 1}`),
                        }),
                        element('span', {
                            className: 'sbwil-list-meta',
                            text: [
                                item?.createdAt ?? item?.timestamp,
                                `${item?.activated ?? 0} activated`,
                                `${item?.tokens ?? 0} tokens`,
                            ].filter(Boolean).join(' · '),
                        }),
                    );
                    list.append(row);
                });
            } catch (error) {
                list.append(element('li', {
                    className: 'sbwil-empty-line',
                    text: `Could not load history. ${errorMessage(error)}`,
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
                refreshCases('Test cases refreshed.'),
                refreshHistoryView(),
            ]);
        },
        invalidate(message) {
            invalidateCaseRun(message);
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

function renderBatchPreview(container, preview) {
    const changes = previewChanges(preview);
    const reportedCount = Number(preview?.count ?? preview?.changed ?? changes.length);
    const count = Number.isFinite(reportedCount) ? reportedCount : changes.length;
    container.replaceChildren();
    container.append(element('p', {
        className: 'sbwil-preview-count',
        text: `${count} proposed change${count === 1 ? '' : 's'}.`,
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
        details.append(element('summary', { text: changeLabel(change, index) }));
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

        const status = statusRegion('Loading batch API...');
        replace(
            panel,
            tabIntroduction(
                'Guarded batch edit',
                'Change content or activation fields across one lorebook, review every entry, then apply the accepted preview.',
            ),
            status,
        );

        let module;
        try {
            module = await import('../batch.js');
        } catch (error) {
            if (!disposed) {
                status.textContent = 'Batch editing is unavailable.';
                panel.append(unavailable(
                    'Batch API unavailable',
                    `Could not load src/batch.js. ${errorMessage(error)}`,
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
            status.textContent = 'Batch editing is unavailable.';
            panel.append(unavailable(
                'Batch API mismatch',
                'Expected previewBatch() and applyBatch() compatible exports from src/batch.js.',
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
            attributes: { 'aria-label': 'Batch operation' },
        });
        operationSelect.append(
            element('option', {
                text: 'Replace content text',
                attributes: { value: 'replace-content' },
            }),
            element('option', {
                text: 'Set activation field',
                attributes: { value: 'set-field' },
            }),
        );
        const filterInput = element('input', {
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'search',
                autocomplete: 'off',
                'aria-label': 'Entry filter',
                placeholder: 'Optional key, UID, memo, or content filter',
            },
        });
        const findInput = element('input', {
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'text',
                required: 'required',
                autocomplete: 'off',
                'aria-label': 'Content text to find',
                placeholder: 'Literal text to find',
            },
        });
        const replacementInput = element('textarea', {
            className: 'text_pole sbwil-textarea sbwil-textarea-compact',
            attributes: {
                rows: '3',
                'aria-label': 'Replacement content',
                placeholder: 'Replacement text (may be empty)',
            },
        });
        const fieldSelect = element('select', {
            className: 'text_pole sbwil-select',
            attributes: { 'aria-label': 'Activation field' },
        });
        [
            ['order', 'Order'],
            ['probability', 'Probability'],
            ['useProbability', 'Use probability'],
            ['depth', 'Insertion depth'],
            ['scanDepth', 'Scan depth'],
            ['position', 'Position (0-7)'],
            ['selectiveLogic', 'Secondary logic (0-3)'],
            ['groupWeight', 'Group weight'],
            ['disable', 'Disabled'],
            ['matchWholeWords', 'Match whole words'],
            ['characterFilter', 'Character filter JSON'],
        ].forEach(([value, label]) => {
            fieldSelect.append(element('option', {
                text: label,
                attributes: { value },
            }));
        });
        const valueInput = element('textarea', {
            className: 'text_pole sbwil-textarea sbwil-textarea-compact',
            attributes: {
                rows: '2',
                required: 'required',
                'aria-label': 'New field value',
                placeholder: 'New value',
            },
        });
        const replaceFields = element('div', { className: 'sbwil-batch-fields' });
        replaceFields.append(
            field('Find', findInput, { hint: 'Literal, case-sensitive matching.' }),
            field('Replace with', replacementInput),
        );
        const setFields = element('div', { className: 'sbwil-batch-fields' });
        setFields.append(
            field('Field', fieldSelect),
            field('New value', valueInput, {
                hint: 'Use true/false for switches. Position: 0-7. Secondary logic: 0-3. Character filters use JSON.',
            }),
        );
        const previewButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-primary',
            text: 'Preview changes',
            attributes: { type: 'submit' },
        });
        form.append(
            field('Lorebook', bookSelect),
            field('Operation', operationSelect),
            field('Entry filter', filterInput, {
                hint: 'Leave empty to target every eligible entry in the selected lorebook.',
            }),
            replaceFields,
            setFields,
            previewButton,
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
            text: 'No preview yet.',
        }));

        const approval = element('label', { className: 'sbwil-approval' });
        const approvalInput = element('input', { attributes: { type: 'checkbox' } });
        approval.append(
            approvalInput,
            element('span', { text: 'I reviewed this preview and want to apply it.' }),
        );
        const applyButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-danger',
            text: 'Apply reviewed preview',
            attributes: { type: 'button' },
        });
        applyButton.disabled = true;
        panel.append(form, previewRegion, approval, applyButton);

        let snapshot = null;
        let preview = null;
        let previewPayload = null;
        let busy = false;
        let bookRefresh = 0;

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
            valueInput.disabled = busy;
            previewButton.disabled = busy || !bookSelect.value || !snapshot;
            approvalInput.disabled = busy || !preview;
            applyButton.disabled = busy || !preview || !approvalInput.checked;
        }

        function syncOperation() {
            const replaceContent = operationSelect.value === 'replace-content';
            replaceFields.hidden = !replaceContent;
            setFields.hidden = replaceContent;
            findInput.required = replaceContent;
            valueInput.required = !replaceContent;
            invalidatePreview('Operation changed. Build a new preview.');
            updateDisabled();
        }

        async function loadBookSnapshot(name, sequence, preloaded = null) {
            snapshot = null;
            updateDisabled();
            if (!name) {
                status.textContent = 'No lorebooks are available.';
                return;
            }
            status.textContent = `Loading ${name}...`;
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
            status.textContent = `${count} entries available for preview in ${name}.`;
        }

        refreshBooks = async (announce = false) => {
            const sequence = ++bookRefresh;
            if (announce) {
                invalidatePreview('Sources changed. Build a new preview.');
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
                        text: 'No lorebooks',
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
                await loadBookSnapshot(bookSelect.value, sequence, preloaded);
            } catch (error) {
                if (disposed || sequence !== bookRefresh) {
                    return;
                }
                snapshot = null;
                bookSelect.replaceChildren(element('option', {
                    text: 'Lorebooks unavailable',
                    attributes: { value: '' },
                }));
                status.textContent = `Could not load lorebooks. ${errorMessage(error)}`;
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
            invalidatePreview('Selection changed. Build a new preview.');
            busy = true;
            snapshot = null;
            updateDisabled();
            void loadBookSnapshot(bookSelect.value, sequence).catch((error) => {
                if (!disposed && sequence === bookRefresh) {
                    status.textContent = `Could not load ${bookSelect.value}. ${errorMessage(error)}`;
                }
            }).finally(() => {
                if (sequence === bookRefresh) {
                    busy = false;
                    updateDisabled();
                }
            });
        }, { signal: controller.signal });

        operationSelect.addEventListener('change', syncOperation, { signal: controller.signal });
        fieldSelect.addEventListener('change', () => {
            const examples = {
                characterFilter: '{"names":[],"tags":[],"isExclude":false}',
                disable: 'true',
                matchWholeWords: 'true',
                useProbability: 'true',
                position: '0',
                selectiveLogic: '0',
            };
            valueInput.placeholder = examples[fieldSelect.value] ?? 'New numeric value';
            invalidatePreview('Field changed. Build a new preview.');
            updateDisabled();
        }, { signal: controller.signal });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!snapshot || !form.reportValidity()) {
                return;
            }
            busy = true;
            invalidatePreview();
            updateDisabled();
            status.textContent = 'Building guarded preview...';
            const payload = {
                operation: operationSelect.value,
                bookName: bookSelect.value,
                find: findInput.value,
                replacement: replacementInput.value,
                filter: filterInput.value,
                field: fieldSelect.value,
                value: valueInput.value,
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
                    ? 'Preview ready. Review the proposed changes before applying.'
                    : 'Preview complete. No matching entries changed.';
            } catch (error) {
                status.textContent = `Could not build the preview. ${errorMessage(error)}`;
                previewRegion.replaceChildren(element('p', {
                    className: 'sbwil-empty-line',
                    text: 'Preview failed. No changes were applied.',
                }));
            } finally {
                busy = false;
                updateDisabled();
            }
        }, { signal: controller.signal });

        approvalInput.addEventListener('change', updateDisabled, { signal: controller.signal });

        applyButton.addEventListener('click', async () => {
            if (!preview || !previewPayload || !approvalInput.checked) {
                return;
            }
            busy = true;
            updateDisabled();
            status.textContent = 'Applying reviewed preview...';
            try {
                const response = await applyBatch(preview, {
                    payload: previewPayload,
                    signal: controller.signal,
                });
                status.textContent = String(response?.message ?? 'Batch changes applied.');
                invalidatePreview('Changes applied. Build another preview to continue.');
                await refreshBooks(false);
            } catch (error) {
                status.textContent = `Could not apply the batch. ${errorMessage(error)}`;
            } finally {
                busy = false;
                updateDisabled();
            }
        }, { signal: controller.signal });

        syncOperation();
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
