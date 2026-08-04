import { expect, test } from '@playwright/test';

async function openWorkbench(page) {
    await page.goto('/');
    await expect(page.locator('#sbwil-menu-item')).toBeVisible();
    await page.locator('#sbwil-menu-item').click();
    await expect(page.locator('#sbwil-workbench')).toBeVisible();
}

test('routes the wand launcher into one native Extensions drawer session', async ({ page }) => {
    await openWorkbench(page);
    await expect(page.locator('#fixture-extension-shell')).toBeVisible();
    await expect(page.locator('.sbwil-settings-summary')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sbwil-settings-content')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#sbwil-workbench')).toHaveCount(1);

    await page.locator('#sbwil-menu-item').click();
    await expect(page.locator('#sbwil-workbench')).toHaveCount(1);
    const routing = await page.evaluate(() => globalThis.fixtureGetRouting());
    expect(routing.shellCalls).toEqual([
        ['right', 'extensions'],
        ['right', 'extensions'],
    ]);
    expect(routing.fallbackClicks).toBe(0);
    expect(routing.popupCalls).toBe(0);
    await expect(page.locator('dialog')).toHaveCount(0);
});

test('opens the same embedded workbench from the drawer button', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => globalThis.fixtureOpenShell());
    await page.locator('.sbwil-settings-summary').click();
    await expect(page.locator('#sbwil-workbench')).toHaveCount(0);
    await page.locator('.sbwil-settings-open').click();
    await expect(page.locator('#sbwil-workbench')).toBeVisible();
    const routing = await page.evaluate(() => globalThis.fixtureGetRouting());
    expect(routing.shellCalls).toEqual([['right', 'extensions']]);
    expect(routing.popupCalls).toBe(0);
});

test('falls back to the native Extensions toggle when the shell API is unavailable', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => globalThis.fixtureRemoveShellApi());
    await page.locator('#sbwil-menu-item').click();
    await expect(page.locator('#fixture-extension-shell')).toBeVisible();
    await expect(page.locator('#sbwil-workbench')).toBeVisible();
    const routing = await page.evaluate(() => globalThis.fixtureGetRouting());
    expect(routing.shellCalls).toEqual([]);
    expect(routing.fallbackClicks).toBe(1);
    expect(routing.popupCalls).toBe(0);
});

test('does not close an already-open legacy Extensions surface', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => globalThis.fixtureRemoveShellApi());
    await page.locator('#extensions-settings-button > .drawer-toggle').click();
    await page.locator('.sbwil-settings-summary').click();
    await page.locator('.sbwil-settings-open').click();
    await expect(page.locator('#fixture-extension-shell')).toBeVisible();
    await expect(page.locator('#sbwil-workbench')).toBeVisible();
    const routing = await page.evaluate(() => globalThis.fixtureGetRouting());
    expect(routing.fallbackClicks).toBe(1);
});

test('waits for drawer expansion before focusing and scrolling the workbench', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => globalThis.fixtureSetDrawerAnimation(180));
    await page.locator('#sbwil-menu-item').click();
    await expect(page.locator('#sbwil-tab-scan')).toBeFocused();
    const readBounds = () => page.evaluate(() => {
        const shell = document.getElementById('fixture-extension-shell').getBoundingClientRect();
        const workbench = document.getElementById('sbwil-workbench').getBoundingClientRect();
        return { shellTop: shell.top, shellBottom: shell.bottom, workbenchTop: workbench.top };
    });
    await expect.poll(async () => {
        const bounds = await readBounds();
        return bounds.workbenchTop >= bounds.shellTop - 1;
    }).toBe(true);
    const bounds = await readBounds();
    expect(bounds.workbenchTop).toBeLessThan(bounds.shellBottom);
});

test('preserves the embedded session while the outer shell is closed', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByText('Scan complete: 2 entries activated.')).toBeVisible();
    await page.evaluate(() => globalThis.fixtureCloseShell());
    await expect(page.locator('#sbwil-workbench')).toBeHidden();
    await expect(page.locator('#sbwil-workbench')).toHaveCount(1);

    await page.locator('#sbwil-menu-item').click();
    await expect(page.getByText('Scan complete: 2 entries activated.')).toBeVisible();
    await expect(page.locator('#sbwil-workbench')).toHaveCount(1);
});

test('runs a scan and renders clear trace stages', async ({ page }) => {
    await openWorkbench(page);
    await expect(page.getByLabel('Text to scan')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Cancel scan' })).toBeHidden();
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByText('Scan complete: 2 entries activated.')).toBeVisible();
    await expect(page.locator('.sbwil-activated-list').getByText('Dragon fact')).toBeVisible();
    await page.getByRole('tab', { name: 'Trace' }).click();
    await expect(page.getByRole('heading', { name: 'Why each entry did or did not activate' })).toBeVisible();
    await expect(page.getByText('Round 2: Recursive scan')).toBeVisible();
});

test('mounts dedupe-safe settings and exposes batch field mode', async ({ page }) => {
    await openWorkbench(page);
    const settings = page.locator('#sbwil-settings');
    await expect(settings).toHaveClass(/inline-drawer/);
    await expect(settings).toHaveAttribute('data-extension-name', 'SillyBunny-WorldInfo-Lab');
    await expect(settings.locator('xpath=..')).toHaveClass(/extension_container/);
    await expect(settings.locator(':scope > .inline-drawer-toggle.inline-drawer-header')).toHaveCount(1);
    await expect(settings.locator(':scope > .inline-drawer-content')).toHaveCount(1);
    await expect(settings.locator('.inline-drawer-icon')).toHaveClass(/not_focusable/);
    await page.getByRole('tab', { name: 'Batch Edit' }).click();
    await page.getByLabel('Edit type').selectOption('set-field');
    await expect(page.getByLabel('Entry setting')).toBeVisible();
    await expect(page.getByLabel('New setting value')).toBeVisible();
});

test('recovers if host deduplication removes the owned inline drawer', async ({ page }) => {
    await openWorkbench(page);
    await page.evaluate(async () => {
        document.getElementById('sbwil-settings').remove();
        await globalThis.fixtureEmit('worldinfo-updated');
    });
    await expect(page.locator('#sbwil-settings')).toHaveCount(1);
    await expect(page.locator('.sbwil-settings-container')).toHaveCount(1);
    await expect(page.locator('#sbwil-workbench')).toHaveCount(1);
    await page.locator('#sbwil-menu-item').click();
    await expect(page.locator('#sbwil-workbench')).toBeVisible();
});

test('aligns the saved-test form as one clear action flow', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('tab', { name: 'Saved Tests' }).click();
    const form = page.locator('.sbwil-saved-test-form');
    await expect(form).toBeVisible();

    const layout = await form.evaluate((node) => {
        const box = (selector) => node.querySelector(selector).getBoundingClientRect();
        const name = box('.sbwil-test-name');
        const book = box('.sbwil-test-book');
        const consent = box('.sbwil-test-consent');
        const details = box('.sbwil-privacy-details');
        const actions = box('.sbwil-form-actions');
        const formBox = node.getBoundingClientRect();
        return {
            fieldTopDifference: Math.abs(name.top - book.top),
            consentStartsAtForm: Math.abs(consent.left - formBox.left),
            detailsStartsAtForm: Math.abs(details.left - formBox.left),
            actionStartsAtForm: Math.abs(actions.left - formBox.left),
            detailsEndsAtForm: Math.abs(details.right - formBox.right),
            consentEndsAtForm: Math.abs(consent.right - formBox.right),
            consentBelowFields: consent.top >= Math.max(name.bottom, book.bottom),
            consentGap: consent.top - details.bottom,
        };
    });
    expect(layout.fieldTopDifference).toBeLessThanOrEqual(1);
    expect(layout.consentStartsAtForm).toBeLessThanOrEqual(1);
    expect(layout.detailsStartsAtForm).toBeLessThanOrEqual(1);
    expect(layout.actionStartsAtForm).toBeLessThanOrEqual(1);
    expect(layout.detailsEndsAtForm).toBeLessThanOrEqual(1);
    expect(layout.consentEndsAtForm).toBeLessThanOrEqual(1);
    expect(layout.consentBelowFields).toBe(true);
    expect(layout.consentGap).toBeLessThanOrEqual(16);

    const actionAlignment = await page.locator('.sbwil-case-actions').evaluate((node) => {
        const selectNode = node.querySelector('select');
        const select = selectNode.getBoundingClientRect();
        const selectStyle = getComputedStyle(selectNode);
        const buttons = [...node.querySelectorAll('button')].map((button) => {
            const box = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return {
                box,
                marginTop: Number.parseFloat(style.marginTop),
                marginBottom: Number.parseFloat(style.marginBottom),
            };
        });
        const firstButton = buttons[0].box;
        return buttons.map(button => ({
            topDifference: Math.abs(button.box.top - firstButton.top),
            bottomDifference: Math.abs(button.box.bottom - firstButton.bottom),
            belowSelect: button.box.top >= select.bottom,
            buttonMarginTop: button.marginTop,
            buttonMarginBottom: button.marginBottom,
            selectMarginTop: Number.parseFloat(selectStyle.marginTop),
            selectMarginBottom: Number.parseFloat(selectStyle.marginBottom),
        }));
    });
    actionAlignment.forEach((alignment) => {
        expect(alignment.topDifference).toBeLessThan(0.1);
        expect(alignment.bottomDifference).toBeLessThan(0.1);
        expect(alignment.belowSelect).toBe(true);
        expect(alignment.buttonMarginTop).toBe(0);
        expect(alignment.buttonMarginBottom).toBe(0);
        expect(alignment.selectMarginTop).toBe(0);
        expect(alignment.selectMarginBottom).toBe(0);
    });
});

test('uses named batch choices and invalidates an edited preview', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('tab', { name: 'Batch Edit' }).click();
    await page.getByLabel('Edit type').selectOption('set-field');
    await page.getByLabel('Entry setting').selectOption('position');
    const value = page.getByLabel('New setting value');
    await expect(value.locator('option[value="4"]')).toHaveText('At chat depth');
    await value.selectOption('4');
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await expect(page.getByText(/entry would change/)).toBeVisible();
    await page.locator('.sbwil-approval input').check();
    await expect(page.getByRole('button', { name: 'Save these changes to the lorebook' })).toBeEnabled();

    await value.selectOption('0');
    await expect(page.getByText('Edit settings changed. Select Preview changes again before saving.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save these changes to the lorebook' })).toBeDisabled();
});

test('invalidates results on message edits and tears down through the extension lifecycle', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByText('Scan complete: 2 entries activated.')).toBeVisible();
    await page.evaluate(() => globalThis.fixtureEmit('message-edited'));
    await expect(page.getByLabel('Scan results').locator('.sbwil-stale-notice'))
        .toContainText('chat, character, group, persona, or character tags changed');

    await page.evaluate(() => globalThis.fixtureDeactivate());
    await expect(page.locator('#sbwil-menu-item')).toHaveCount(0);
    await expect(page.locator('#sbwil-settings')).toHaveCount(0);
    await expect(page.locator('.sbwil-settings-container')).toHaveCount(0);
    await expect(page.locator('#sbwil-workbench')).toHaveCount(0);
    await expect(page.locator('dialog')).toHaveCount(0);
});

test('invalidates results when character tag assignments change', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByText('Scan complete: 2 entries activated.')).toBeVisible();
    await page.evaluate(async () => {
        globalThis.fixtureSetTagMap({ tester: ['tag-1'] });
        await globalThis.fixtureEmit('settings-updated');
    });
    await expect(page.getByLabel('Scan results').locator('.sbwil-stale-notice'))
        .toContainText('chat, character, group, persona, or character tags changed');
});

test('invalidates local control changes and cancels in-flight scans', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByText('Scan complete: 2 entries activated.')).toBeVisible();
    await page.getByLabel('Reply action to simulate').selectOption('swipe');
    await expect(page.getByLabel('Scan results').locator('.sbwil-stale-notice'))
        .toContainText('scan option changed');

    await page.getByRole('radio', { name: 'Pasted text' }).check();
    await page.getByLabel('Text to scan').fill('dragon');
    await page.evaluate(() => globalThis.fixtureSetLoadDelay(200));
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByRole('button', { name: 'Cancel scan' })).toBeVisible();
    await page.getByLabel('Text to scan').fill('dragon changed');
    await expect(page.getByText('Scan input changed. Run the scan again.')).toBeVisible();
    await page.waitForTimeout(250);
    await expect(page.getByText('Scan complete: 2 entries activated.')).toHaveCount(0);
});

test('aborts an in-flight scan during extension teardown', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('radio', { name: 'Pasted text' }).check();
    await page.getByLabel('Text to scan').fill('dragon');
    await page.evaluate(() => globalThis.fixtureSetLoadDelay(500));
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByRole('button', { name: 'Cancel scan' })).toBeVisible();
    await page.evaluate(() => globalThis.fixtureDeactivate());
    await expect(page.locator('#sbwil-workbench')).toHaveCount(0);
    await expect(page.locator('#sbwil-settings')).toHaveCount(0);
    await page.waitForTimeout(550);
    await expect(page.locator('#sbwil-workbench')).toHaveCount(0);
});

test('does not publish a stored-case result after source invalidation', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByText('Scan complete: 2 entries activated.')).toBeVisible();
    await page.getByRole('tab', { name: 'Saved Tests' }).click();
    await expect(page.getByRole('heading', { name: 'Saved scan tests' })).toBeVisible();
    await page.getByLabel('Test name').fill('Fixture replay');
    await page.locator('.sbwil-test-consent input').check();
    await page.getByRole('button', { name: 'Save displayed scan as test' }).click();
    await expect(page.getByText('Saved test "Fixture replay" to "Fixture Book".')).toBeVisible();

    await page.evaluate(() => globalThis.fixtureSetLoadDelay(200));
    await page.getByRole('button', { name: 'Run selected test' }).click();
    await expect(page.getByText('Running saved test "Fixture replay"...')).toBeVisible();
    await page.evaluate(() => globalThis.fixtureEmit('worldinfo-updated'));
    await expect(page.getByText('Saved test canceled because the chat or lorebooks changed. Run it again.')).toBeVisible();
    await page.waitForTimeout(250);
    await page.getByRole('tab', { name: 'Scan' }).click();
    await expect(page.getByLabel('Scan results').locator('.sbwil-stale-notice'))
        .toContainText('lorebook or its settings changed');
});

test('keeps primary controls usable at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkbench(page);
    await expect(page.getByRole('tab', { name: 'Scan' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Batch Edit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run scan' })).toBeVisible();
    await page.getByRole('radio', { name: 'Pasted text' }).check();
    await expect(page.locator('#sbwil-pasted-text')).toBeVisible();
    await page.getByRole('radio', { name: 'Current chat' }).check();
    await expect(page.locator('#sbwil-pasted-text')).toBeHidden();
    const headerBottom = await page.locator('.sbwil-workbench-header').evaluate(node => node.getBoundingClientRect().bottom);
    const tabsTop = await page.locator('.sbwil-tabs').evaluate(node => node.getBoundingClientRect().top);
    expect(headerBottom).toBeLessThanOrEqual(tabsTop + 1);
    const overflow = await page.locator('#sbwil-workbench').evaluate(node => (
        node.scrollWidth > node.clientWidth + 1
    ));
    expect(overflow).toBe(false);
    const tabs = await page.locator('.sbwil-tabs').evaluate((strip) => {
        const bounds = strip.getBoundingClientRect();
        return {
            scrollsSideways: strip.scrollWidth > strip.clientWidth + 1,
            clipped: [...strip.querySelectorAll('.sbwil-tab')].filter((tab) => {
                const rect = tab.getBoundingClientRect();
                return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
            }).length,
        };
    });
    expect(tabs.scrollsSideways).toBe(false);
    expect(tabs.clipped).toBe(0);
    const scrolling = await page.locator('#fixture-extension-shell').evaluate((shell) => {
        const workbench = shell.querySelector('#sbwil-workbench');
        const panel = shell.querySelector('.sbwil-panel:not([hidden])');
        return {
            shellOverflow: getComputedStyle(shell).overflowY,
            shellScrollable: shell.scrollHeight > shell.clientHeight,
            workbenchOverflow: getComputedStyle(workbench).overflowY,
            panelOverflow: getComputedStyle(panel).overflowY,
        };
    });
    expect(scrolling.shellOverflow).toBe('auto');
    expect(scrolling.shellScrollable).toBe(true);
    expect(scrolling.workbenchOverflow).toBe('visible');
    expect(scrolling.panelOverflow).toBe('visible');
});

test('uses the split workbench layout when the Extensions container is wide', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.locator('#fixture-extension-shell').evaluate(node => { node.style.width = '1000px'; });
    await page.locator('#sbwil-menu-item').click();
    await expect(page.locator('#sbwil-workbench')).toBeVisible();
    await expect(page.locator('.sbwil-scan-layout')).toHaveCSS('display', 'grid');
    await page.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByText('Scan complete: 2 entries activated.')).toBeVisible();
    await page.getByRole('tab', { name: 'Trace' }).click();
    await expect(page.locator('.sbwil-trace-layout')).toHaveCSS('display', 'grid');
    const overflow = await page.locator('#sbwil-workbench').evaluate(node => node.scrollWidth > node.clientWidth + 1);
    expect(overflow).toBe(false);
});
