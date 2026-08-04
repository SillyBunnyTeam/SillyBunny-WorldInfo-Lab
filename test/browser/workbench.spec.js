import { expect, test } from '@playwright/test';

async function openWorkbench(page) {
    await page.goto('/');
    await expect(page.locator('#sbwil-menu-item')).toBeVisible();
    await page.locator('#sbwil-menu-item').click();
    await expect(page.locator('#sbwil-workbench')).toBeVisible();
}

test('runs a simulation and renders trace stages', async ({ page }) => {
    await openWorkbench(page);
    await expect(page.getByLabel('Text to scan')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toBeHidden();
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByText('Simulation complete. 2 entries activated.')).toBeVisible();
    await expect(page.locator('.sbwil-activated-list').getByText('Dragon fact')).toBeVisible();
    await page.getByRole('tab', { name: 'Trace' }).click();
    await expect(page.getByRole('heading', { name: 'Why each entry did or did not activate' })).toBeVisible();
    await expect(page.getByText('Round 2: Recursion')).toBeVisible();
});

test('mounts dedupe-safe settings and exposes batch field mode', async ({ page }) => {
    await openWorkbench(page);
    const settings = page.locator('#sbwil-settings');
    await expect(settings).toHaveClass(/extension_container/);
    await expect(settings).toHaveAttribute('data-extension-name', 'SillyBunny-WorldInfo-Lab');
    await page.getByRole('tab', { name: 'Batch Edit' }).click();
    await page.getByLabel('Batch operation').selectOption('set-field');
    await expect(page.getByLabel('Activation field')).toBeVisible();
    await expect(page.getByLabel('New field value')).toBeVisible();
});

test('invalidates results on message edits and tears down through the extension lifecycle', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByText('Simulation complete. 2 entries activated.')).toBeVisible();
    await page.evaluate(() => globalThis.fixtureEmit('message-edited'));
    await expect(page.getByLabel('Simulation result').locator('.sbwil-stale-notice'))
        .toContainText('scan input changed');

    await page.evaluate(() => globalThis.fixtureDeactivate());
    await expect(page.locator('#sbwil-menu-item')).toHaveCount(0);
    await expect(page.locator('#sbwil-settings')).toHaveCount(0);
    await expect(page.locator('#sbwil-workbench-dialog')).toHaveCount(0);
});

test('invalidates results when character tag assignments change', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByText('Simulation complete. 2 entries activated.')).toBeVisible();
    await page.evaluate(async () => {
        globalThis.fixtureSetTagMap({ tester: ['tag-1'] });
        await globalThis.fixtureEmit('settings-updated');
    });
    await expect(page.getByLabel('Simulation result').locator('.sbwil-stale-notice'))
        .toContainText('scan input changed');
});

test('invalidates local control changes and cancels in-flight scans', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByText('Simulation complete. 2 entries activated.')).toBeVisible();
    await page.getByLabel('Generation trigger').selectOption('swipe');
    await expect(page.getByLabel('Simulation result').locator('.sbwil-stale-notice'))
        .toContainText('Scan controls changed');

    await page.getByRole('radio', { name: 'Pasted text' }).check();
    await page.getByLabel('Text to scan').fill('dragon');
    await page.evaluate(() => globalThis.fixtureSetLoadDelay(200));
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toBeVisible();
    await page.getByLabel('Text to scan').fill('dragon changed');
    await expect(page.getByText('Inputs changed. Run the simulation again.')).toBeVisible();
    await page.waitForTimeout(250);
    await expect(page.getByText('Simulation complete. 2 entries activated.')).toHaveCount(0);
});

test('does not publish a stored-case result after source invalidation', async ({ page }) => {
    await openWorkbench(page);
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByText('Simulation complete. 2 entries activated.')).toBeVisible();
    await page.getByRole('tab', { name: 'Tests' }).click();
    await expect(page.getByRole('heading', { name: 'Regression tests' })).toBeVisible();
    await page.getByLabel('Name').fill('Fixture replay');
    await page.getByText('Store replay data in this lorebook').click();
    await page.getByRole('button', { name: 'Save latest result' }).click();
    await expect(page.getByText('Test case saved.')).toBeVisible();

    await page.evaluate(() => globalThis.fixtureSetLoadDelay(200));
    await page.getByRole('button', { name: 'Run selected' }).click();
    await expect(page.getByText('Running Fixture replay...')).toBeVisible();
    await page.evaluate(() => globalThis.fixtureEmit('worldinfo-updated'));
    await expect(page.getByText('Stored test case run cancelled because scan inputs changed.')).toBeVisible();
    await page.waitForTimeout(250);
    await page.getByRole('tab', { name: 'Scan' }).click();
    await expect(page.getByLabel('Simulation result').locator('.sbwil-stale-notice'))
        .toContainText('World Info sources changed');
});

test('keeps primary controls usable at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkbench(page);
    await expect(page.getByRole('tab', { name: 'Scan' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Batch Edit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible();
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
