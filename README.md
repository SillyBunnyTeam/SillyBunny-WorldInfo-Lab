# SillyBunny World Info Lab

World Info Lab shows which lorebook entries would activate for the current chat or for text you
paste into the workbench. It explains each decision, counts tokens with the active tokenizer, and
shows where activated content would be placed.

The simulator does not start a generation or change timed World Info state. Lorebooks are only
written when you explicitly save a test case or approve a batch edit.

## Requirements

- SillyBunny 1.7.0 or newer.
- No server plugin or build step is required.

## Install

In SillyBunny, open **Extensions**, choose **Install Extension**, and paste:

```text
https://github.com/SillyBunnyTeam/SillyBunny-WorldInfo-Lab
```

Reload SillyBunny after installation.

For development, symlink the checkout into the user extension directory:

```sh
ln -s "$PWD" /path/to/SillyBunny/data/default-user/extensions/SillyBunny-WorldInfo-Lab
```

## Open the workbench

Choose **World Info Lab** from the wand menu, or open **Extensions > World Info Lab** and select
**Open workbench**.

The workbench has four tabs:

- **Scan** runs a simulation for the current chat or pasted text.
- **Trace** explains why each entry activated, failed, or was skipped.
- **Tests** saves and reruns regression cases stored in lorebooks.
- **Batch Edit** previews and applies changes to one lorebook.

## Scan

Choose **Current chat** to inspect the active conversation, or **Pasted text** to test a small input
without changing the chat. Select the generation trigger and deterministic seed, then choose
**Run simulation**.

The result includes:

- Activated entries and activation reasons.
- Recursive scan rounds.
- Primary and secondary key matches.
- Character filters, groups, probability checks, and budget decisions.
- Token use and budget overflow.
- Final position, depth, role, and rendered placement.
- Warnings about inputs the simulator cannot reproduce.

The same seed produces the same group and probability rolls for the same input and lorebook state.

## Trace

Trace lists every evaluated entry in scan order. Expand an entry to inspect each stage, including
filters, key matching, recursion, inclusion groups, probability, and token allocation.

Entries that activate also show their final placement. Empty content after World Info regex
processing is reported as omitted rather than inserted.

## Saved tests

A saved test records the simulation inputs and expected result in the selected lorebook. Rerunning
the test uses the current entries from its source lorebooks, so it can detect changes to activation,
budget use, or placement.

Before saving, the Tests tab asks for confirmation because a portable case can contain:

- Chat or pasted text.
- Scan-enabled prompt text.
- Character and persona fields.
- Frozen macro expansions.
- Trigger and World Info settings.
- Expected placements with activated rendered lorebook content.

Saved cases travel with the lorebook. Delete them from the Tests tab when they are no longer needed.
Cleaning extension settings does not remove cases from lorebooks.

Recent simulation history is different from saved tests. It stores only a small account-scoped
summary with the fingerprint, source book names, seed, activation count, and token count. It does
not store chat text, entry content, traces, or placements.

## Batch editing

Batch Edit works on one selected lorebook at a time. It can replace literal text in entry content or
set supported activation fields such as order, probability, depth, position, selective logic,
group weight, character filters, and enabled state.

The optional entry filter matches keys, UID, memo, content, and secondary keys. Every proposed
change is shown before the Apply button is enabled.

Before saving, World Info Lab reloads the lorebook directly from the server and checks the reviewed
entries again. If an entry or the book changed after the preview, the write is stopped. CharacterBook
source data is updated together with normalized World Info entries.

## Limits

- This is an independent simulator that mirrors SillyBunny 1.7.0 World Info behavior. It is not the
  native scanner, so a later host change may require a matching extension update.
- Current chat mode starts from stored chat data. It cannot recreate every generation-only change,
  including all prompt regex, attachment, reasoning, and supplemental scan processing.
- Vector similarity is not simulated. Vectorized entries are reported without invented scores.
- A standalone extension cannot make the host's lorebook save endpoint atomic. Batch Edit performs
  two server-fresh checks immediately before saving, but another writer could still change the file
  between the final check and the save request.

## Development

Install dependencies from the lockfile:

```sh
npm ci
```

Run linting and unit tests:

```sh
npm test
```

Run the Chromium workbench tests:

```sh
npx playwright install chromium
npm run test:browser
```

Run host contracts against a SillyBunny checkout:

```sh
SILLYBUNNY_ROOT=/path/to/SillyBunny npm run test:host
```

CI also runs the workbench tests in WebKit.

## License

AGPL-3.0.
