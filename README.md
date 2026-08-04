# SillyBunny World Info Lab

**See why your lorebook entries did or did not activate.**

World Info Lab checks the current chat, or text you paste, and shows what SillyBunny would take from
your lorebooks for its next reply.

It can help when:

- An entry should activate, but does not.
- The wrong entries keep activating.
- Your lorebook is using too much prompt space.
- You want to check a large lorebook after making changes.
- You need to update the same setting on many entries.

Running a scan never sends a message, edits a lorebook, or changes timed World Info state. It saves
only a summary to recent scan history. That summary does not contain chat or lorebook content. A
lorebook changes only when you save a test or approve a batch edit.

## Install

World Info Lab requires SillyBunny 1.7.0 or newer.

1. Open **Extensions** in SillyBunny.
2. Choose **Install Extension**.
3. Paste this URL:

```text
https://github.com/SillyBunnyTeam/SillyBunny-WorldInfo-Lab
```

4. Finish the installation and reload SillyBunny.

No server plugin or build step is needed.

## First scan

1. Open the wand menu and choose **World Info Lab**.
2. Leave **Current chat** selected.
3. Choose **Run scan**.
4. Look at **Activated entries** to see which entries passed their scan rules.
5. Open **Trace** to see why every other entry was skipped.

You can also choose **Pasted text** to test a sentence without adding it to your chat.

For example, if an entry with the key `dragon` does not activate, Trace may show that the key was
found but a character filter blocked the entry, its probability check failed, or earlier entries used
the available token budget.

## What the results mean

- **Activated** means the entry passed its matching and activation rules.
- **Skipped** means the entry was checked but did not pass one of its rules.
- **Token use** shows how much prompt space the activated lorebook content uses.
- **Budget overflow** means there was not enough allowed space for another full entry.
- **Insertion result** shows where activated content would be inserted, including its depth and role.
- **Scan rounds** show when one activated entry caused another entry to activate.

An activated entry can still produce no prompt content. A regex script may remove its content, or a
named outlet may be missing. Open **Insertion results** in Trace to check what would actually be added.

The seed controls random probability and group choices. Using the same seed with the same chat and
lorebooks produces the same random choices, which makes results easier to compare.

## The four tabs

### Scan

Run a check against the current chat or pasted text. The summary shows activated entries, token use,
budget limits, and any important warnings.

### Trace

See each lorebook entry in the order it was checked. Expand an entry to see its keys, filters,
probability, groups, recursion, and token decision.

### Saved Tests

Save a result in a lorebook and run it again later. This is useful for checking whether an edit changed
which entries activate, how many tokens they use, or where they are inserted.

> **Before saving a test:** the test travels inside the lorebook. It can contain chat or pasted text;
> scan-enabled prompt text; character, persona, scenario, creator-note, filename, and tag data; frozen
> macro results; lorebook names; scan settings; the random-choice seed; timed or forced entry IDs; and
> expected insertion results with rendered activated content. Anyone you share the lorebook with may
> receive this information.

Delete saved tests from the Saved Tests tab before sharing a lorebook if they contain private information.
Cleaning the extension's settings does not remove tests stored in lorebooks.

The recent history list is separate. It stores only a small summary for the current SillyBunny account.
It does not store chat text, entry content, traces, or insertion results.

### Batch Edit

Change several entries in one lorebook at the same time. You can replace text or update supported
settings such as order, probability, depth, position, group weight, character filters, and enabled
state.

Every proposed change is shown before **Save these changes to the lorebook** becomes available. World
Info Lab reloads the lorebook and checks it again before saving. If the reviewed entries changed in the
meantime, the edit stops instead of overwriting them.

## Limits

- World Info Lab copies SillyBunny's World Info rules in an independent simulator. A future SillyBunny
  update may change those rules before this extension is updated.
- Current chat scans start from the stored conversation. Some last-minute prompt processing used for
  an actual reply cannot be recreated exactly.
- Vector similarity is not simulated. The Lab will not invent similarity scores for vectorized entries.
- Batch Edit checks the latest saved lorebook before writing, but SillyBunny does not provide an atomic
  lorebook update API. A very small race remains if another writer saves at exactly the same time.

## Development

```sh
npm ci
npm test
npm run test:browser
```

Set `SILLYBUNNY_ROOT` to run host contract tests against a different SillyBunny checkout:

```sh
SILLYBUNNY_ROOT=/path/to/SillyBunny npm run test:host
```

## License

AGPL-3.0.
