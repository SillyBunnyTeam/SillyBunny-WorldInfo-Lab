import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyBatch,
    BatchConflictError,
    previewBatch,
} from '../src/batch.js';
import { __setHostForTests } from '../src/host.js';
import {
    clone,
    installContext,
    makeHost,
} from './helpers/fixtures.js';

function snapshotOf(book) {
    return { books: new Map([['Book', clone(book)]]) };
}

function fingerprint(value) {
    const text = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function mockFreshReads(t, getBook) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/worldinfo/get');
        assert.deepEqual(JSON.parse(options.body), { name: 'Book' });
        return {
            ok: true,
            status: 200,
            json: async () => clone(getBook()),
        };
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    return () => ({ 'Content-Type': 'application/json' });
}

test('batch previews are literal, filtered, normalized, and leave snapshots untouched', async () => {
    const book = {
        entries: {
            a: { uid: 1, comment: 'Alpha', content: 'foo foo', probability: 100 },
            b: { uid: 2, comment: 'Beta', content: 'foo', probability: 100 },
        },
    };
    const snapshot = snapshotOf(book);
    const preview = await previewBatch({
        bookName: 'Book',
        snapshot,
        operation: 'replace-content',
        filter: 'ALPHA',
        find: 'foo',
        replacement: '$& bar',
    });
    assert.equal(preview.kind, 'batch-preview');
    assert.equal(preview.version, 1);
    assert.equal(preview.count, 1);
    assert.deepEqual(preview.changes[0], {
        entryKey: 'a',
        uid: 1,
        label: 'Alpha',
        field: 'content',
        before: 'foo foo',
        after: '$& bar $& bar',
        entrySnapshot: JSON.stringify(book.entries.a),
        entryFingerprint: preview.changes[0].entryFingerprint,
    });
    assert.match(preview.changes[0].entryFingerprint, /^[0-9a-f]{8}$/);
    assert.equal(snapshot.books.get('Book').entries.a.content, 'foo foo');

    const fieldPreview = await previewBatch({
        bookName: 'Book',
        snapshot,
        operation: 'set-field',
        field: 'characterFilter',
        value: JSON.stringify({ names: [' Hero ', 'Hero'], tags: ['mage', ''], isExclude: 1 }),
        filter: 'Beta',
    });
    assert.deepEqual(fieldPreview.changes[0].after, {
        names: ['Hero'],
        tags: ['mage'],
        isExclude: true,
    });
    await assert.rejects(previewBatch({
        bookName: 'Book',
        snapshot,
        operation: 'set-field',
        field: 'content',
        value: 'not allowed',
    }), /entry setting cannot be changed/);
    await assert.rejects(previewBatch({
        bookName: 'Book',
        snapshot,
        operation: 'set-field',
        field: 'disable',
        value: 'tru',
    }), /Choose On or Off/);
});

test('batch apply reloads fresh data and merges reviewed fields without clobbering unrelated changes', async (t) => {
    const previewBook = {
        entries: {
            a: { uid: 1, comment: 'Alpha', content: 'alpha', probability: 100 },
            b: { uid: 2, comment: 'Beta', content: 'beta', probability: 100 },
        },
        extensions: { previewOnly: true },
        originalData: {
            entries: [
                { id: 1, extensions: { probability: 100 } },
                { id: 2, extensions: { probability: 100 } },
            ],
        },
        originalDataUidMap: { 1: 0, 2: 1 },
    };
    const preview = await previewBatch({
        bookName: 'Book',
        snapshot: snapshotOf(previewBook),
        operation: 'set-field',
        field: 'probability',
        value: '45',
        filter: 'Alpha',
    });
    const fresh = clone(previewBook);
    fresh.entries.b.content = 'fresh beta edit';
    fresh.entries.c = { uid: 3, comment: 'New', content: 'fresh entry', probability: 100 };
    fresh.extensions = { serverFresh: true };
    let saved = null;
    let reloads = 0;
    let listUpdates = 0;
    const context = {
        getRequestHeaders: mockFreshReads(t, () => fresh),
        loadWorldInfo: async () => clone(fresh),
        async saveWorldInfo(name, value, immediately) {
            assert.equal(name, 'Book');
            assert.equal(immediately, true);
            saved = clone(value);
        },
        reloadWorldInfoEditor: async () => { reloads++; },
        updateWorldInfoList: () => { listUpdates++; },
    };
    const restore = installContext(context);
    t.after(restore);
    __setHostForTests(makeHost());
    t.after(() => __setHostForTests(null));

    const result = await applyBatch(preview);
    assert.deepEqual(result, {
        count: 1,
        message: 'Saved changes to 1 entry in "Book".',
        refreshWarning: '',
    });
    assert.equal(saved.entries.a.probability, 45);
    assert.equal(saved.entries.b.content, 'fresh beta edit');
    assert.equal(saved.entries.c.content, 'fresh entry');
    assert.deepEqual(saved.extensions, { serverFresh: true });
    assert.equal(saved.originalData.entries[0].extensions.probability, 45);
    assert.equal(reloads, 1);
    assert.equal(listUpdates, 1);
});

test('batch apply rejects stale target entries with conflict details and does not save', async (t) => {
    const original = {
        entries: {
            a: { uid: 1, comment: 'Alpha', content: 'alpha', probability: 100 },
        },
    };
    const preview = await previewBatch({
        bookName: 'Book',
        snapshot: snapshotOf(original),
        operation: 'set-field',
        field: 'disable',
        value: true,
    });
    const changed = clone(original);
    changed.entries.a.content = 'changed after preview';
    preview.changes[0].entryFingerprint = fingerprint(changed.entries.a);
    let saves = 0;
    const restore = installContext({
        getRequestHeaders: mockFreshReads(t, () => changed),
        loadWorldInfo: async () => clone(changed),
        saveWorldInfo: async () => { saves++; },
    });
    t.after(restore);

    await assert.rejects(applyBatch(preview), (error) => {
        assert.equal(error instanceof BatchConflictError, true);
        assert.equal(error.message, '1 reviewed entry changed after this preview was created.');
        assert.deepEqual(error.conflicts, [{ entryKey: 'a', uid: 1, label: 'Alpha' }]);
        return true;
    });
    assert.equal(saves, 0);
});

test('batch apply validates against a server-fresh lorebook when the host supports it', async (t) => {
    const cached = {
        entries: {
            a: { uid: 1, comment: 'Alpha', content: 'cached', probability: 100 },
        },
    };
    const preview = await previewBatch({
        bookName: 'Book',
        snapshot: snapshotOf(cached),
        operation: 'set-field',
        field: 'probability',
        value: 25,
    });
    const serverFresh = clone(cached);
    serverFresh.entries.a.content = 'changed in another tab';
    let saves = 0;
    let cachedLoads = 0;
    const context = {
        loadWorldInfo: async () => {
            cachedLoads++;
            return clone(cached);
        },
        saveWorldInfo: async () => { saves++; },
    };
    context.getRequestHeaders = mockFreshReads(t, () => serverFresh);
    const restore = installContext(context);
    t.after(restore);

    await assert.rejects(applyBatch(preview), BatchConflictError);
    assert.equal(cachedLoads, 0);
    assert.equal(saves, 0);
});

test('batch apply aborts when a CharacterBook source entry is missing', async (t) => {
    const book = {
        entries: {
            a: { uid: 1, comment: 'Alpha', content: 'alpha', probability: 100 },
        },
        originalData: {
            entries: [{ id: 2, extensions: { probability: 100 } }],
        },
    };
    const preview = await previewBatch({
        bookName: 'Book',
        snapshot: snapshotOf(book),
        operation: 'set-field',
        field: 'probability',
        value: 25,
    });
    let saves = 0;
    const restore = installContext({
        getRequestHeaders: mockFreshReads(t, () => book),
        loadWorldInfo: async () => clone(book),
        saveWorldInfo: async () => { saves++; },
    });
    t.after(restore);
    __setHostForTests(makeHost());
    t.after(() => __setHostForTests(null));

    await assert.rejects(applyBatch(preview), /could not be matched to the lorebook's CharacterBook data/);
    assert.equal(saves, 0);
});

test('batch apply mirrors special CharacterBook fields', async (t) => {
    let current = {
        entries: {
            a: { uid: 1, comment: 'Alpha', content: 'alpha', disable: false, position: 1 },
        },
        originalData: {
            entries: [{ id: 1, enabled: true, position: 'after_char', extensions: { position: 1 } }],
        },
    };
    const restore = installContext({
        getRequestHeaders: mockFreshReads(t, () => current),
        loadWorldInfo: async () => clone(current),
        saveWorldInfo: async (name, value) => { current = clone(value); },
    });
    t.after(restore);
    __setHostForTests(makeHost());
    t.after(() => __setHostForTests(null));

    const positionPreview = await previewBatch({
        bookName: 'Book',
        snapshot: snapshotOf(current),
        operation: 'set-field',
        field: 'position',
        value: 0,
    });
    await applyBatch(positionPreview);
    assert.equal(current.originalData.entries[0].position, 'before_char');
    assert.equal(current.originalData.entries[0].extensions.position, 0);

    const disablePreview = await previewBatch({
        bookName: 'Book',
        snapshot: snapshotOf(current),
        operation: 'set-field',
        field: 'disable',
        value: true,
    });
    await applyBatch(disablePreview);
    assert.equal(current.originalData.entries[0].enabled, false);
});

test('batch save failures do not attempt a stale full-book rollback', async (t) => {
    const book = {
        entries: {
            a: { uid: 1, comment: 'Alpha', content: 'alpha', probability: 100 },
        },
    };
    const preview = await previewBatch({
        bookName: 'Book',
        snapshot: snapshotOf(book),
        operation: 'set-field',
        field: 'probability',
        value: 50,
    });
    let saves = 0;
    const restore = installContext({
        getRequestHeaders: mockFreshReads(t, () => book),
        loadWorldInfo: async () => clone(book),
        async saveWorldInfo() {
            saves++;
            throw new Error('save failed');
        },
    });
    t.after(restore);

    await assert.rejects(applyBatch(preview), /save failed/);
    assert.equal(saves, 1);
});
