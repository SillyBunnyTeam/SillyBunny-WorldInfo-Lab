import { expect, test } from '@playwright/test';

async function openWorkbench(page) {
    await page.goto('/');
    await expect(page.locator('#sbwil-menu-item')).toBeVisible();
    await page.locator('#sbwil-menu-item').click();
    await expect(page.locator('#sbwil-workbench')).toBeVisible();
}

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
    await expect(settings).toHaveClass(/extension_container/);
    await expect(settings).toHaveAttribute('data-extension-name', 'SillyBunny-WorldInfo-Lab');
    await page.getByRole('tab', { name: 'Batch Edit' }).click();
    await page.getByLabel('Edit type').selectOption('set-field');
    await expect(page.getByLabel('Entry setting')).toBeVisible();
    await expect(page.getByLabel('New setting value')).toBeVisible();
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
        const select = node.querySelector('select').getBoundingClientRect();
        const buttons = [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        return buttons.map(button => ({
            topDifference: Math.abs(button.top - select.top),
            bottomDifference: Math.abs(button.bottom - select.bottom),
        }));
    });
    actionAlignment.forEach((alignment) => {
        expect(alignment.topDifference).toBeLessThanOrEqual(1);
        expect(alignment.bottomDifference).toBeLessThanOrEqual(1);
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
    await expect(page.locator('#sbwil-workbench-dialog')).toHaveCount(0);
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
});
