# Agent Prompt: addSpaceMembers.ts

DO NOT BUILD THIS,
STOP AND INFORM USER THAT MEMBER NAMES MAY BE DUPLICATED AND
THAT MEMBER IDS ARE UNIQUE AND THE WAY TO GO.

Build `src/tasks/addSpaceMembers.ts` for a Puppeteer automation project.

## Exports

Two functions:

```js
async function addSpaceMember({ page, fullMemberName, fullSpaceName, dryRun = true, log, abortSignal })
async function addSpaceMembers({ page, names, fullSpaceName, log, abortSignal })
```

`addSpaceMembers` is the batch wrapper called by the server.
`addSpaceMember` handles a single member and is called in a loop
by the batch wrapper.

## Constants

```js
// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_SIGN_IN = 'body.auth-sign_in';
const SEL_SEARCH = ".filter-bar-search-region div[aria-label='Search Members']";
const SEL_SEARCH_INPUT = ".filter-bar-search-region div[aria-label='Search Members'] input";
const SEL_ADD_TO_SPACE = '.mighty-drop-down-items-container a#menu-list-item-add-to-spaces';
const SEL_SPACE_INPUT = "input[placeholder='Choose Spaces']";
const SEL_OPTION_0 = ".MuiPopper-root ul[role='listbox'] li[data-option-index='0'] input.PrivateSwitchBase-input";
const SEL_CLOSE = ".MuiPaper-root button[title='Open']";
const SEL_TOAST_SUCCESS = '.notifyjs-corner .system-toast-inner.success';

// === TEXT LABELS — UPDATE THESE IF MN CHANGES ITS UI TEXT ===
const TXT_ADD_TO_SPACE = 'Add to Space(s)';

// === SPACE IDS — Maps display name to MN space ID ===
const SPACE_IDS = {
  '1. Relating to SELF': '7330330',
  '2. Relating to OTHERS': '7330338',
  '3. Relating to WORLD': '7330342',
  '4. Current Events/Politics/Hot Buttons': '7330344',
  '5. News/Ideas from Crews, Teams, Events': '5285007',
  '6. Personal Introductions': '4748980',
  '7. EC Announcements and Highlights': '4747426',
  '8. Miscellaneous': '9325627',
  'Creative Center': '5722465',
  'Marketplace': '5627234',
  'Playground': '23462808',
};
```

## Dynamic Selectors

These selectors depend on the member's name and must be constructed
per iteration. Implement as functions, not constants:

```js
function selMemberRow(fullMemberName) {
  return `.all-members-list table tbody tr:has(td a[title='${fullMemberName}'])`;
}

function selMemberDropdown(fullMemberName) {
  return `${selMemberRow(fullMemberName)} .actions-region a.mighty-drop-down-toggle`;
}
```

**Important:** The `title` attribute match is case-sensitive and must
be the member's exact display name as it appears in MN. The names
array provided by the user must match exactly.

## URLs

```
urlSpaceMembers = https://emergent-commons.mn.co/spaces/${spaceId}/admin/members/all
urlMembers = https://emergent-commons.mn.co/admin/members/all
```

Look up `spaceId` from `SPACE_IDS` using `fullSpaceName`.

## addSpaceMember — Single Member Process

### Step 1: Check if already a member

1. Navigate to `urlSpaceMembers`.
2. Wait until `SEL_READY`.
3. Call `loginIfNeeded(page, log)`.
4. If `dryRun`, log: `"DRY RUN — no members will be removed."`
5. Click `SEL_SEARCH` to focus the search region.
6. Type `fullMemberName` into `SEL_SEARCH_INPUT`.
7. Wait briefly for search results to filter (wait for network idle
   or a short settled delay — the table filters client-side).
8. Check if `selMemberRow(fullMemberName)` exists in the DOM.
   - If YES: return `{ success: false, error: 'Already a member' }`.
   - If NO: proceed to Step 2.

### Step 2: Find member in community directory

8. Navigate to `urlMembers` (community-wide member list).
9. Wait until `SEL_READY`.
10. Click `SEL_SEARCH` to focus the search region.
11. Type `fullMemberName` into `SEL_SEARCH_INPUT`.
12. Wait for search results to filter.
13. Check if `selMemberRow(fullMemberName)` exists in the DOM.
    - If NO: return `{ success: false, error: 'Member not found in community' }`.
    - If YES: proceed to Step 3.

### Step 3: Add member to space

14. Click `selMemberDropdown(fullMemberName)` — the action dropdown
    for the matched member row.
15. Wait for dropdown menu to appear.
16. Click `SEL_ADD_TO_SPACE`.
17. Wait for the space selection dialog to appear (contains
    `SEL_SPACE_INPUT`).
18. Type `fullSpaceName` into `SEL_SPACE_INPUT`.
19. Wait for the MUI autocomplete listbox to appear with results.
20. Click `SEL_OPTION_0` — the first matching space checkbox.
21. Click `SEL_CLOSE` to close the space selector popover.
22. Log: "[dryRun ? 'WOULD ADD' : 'Adding']: ${name} (${profileUrl})"
23. If dryRun: return `{ success: true }`. Do not go further
22. Click the element whose visible text is `TXT_ADD_TO_SPACE` to
    confirm the addition.
23. Wait for `SEL_TOAST_SUCCESS` to appear in the DOM.
24. Verify the toast's text content contains the string fragment
    `'will be added'`.
    - If verified: return `{ success: true }`.
    - If toast does not appear within 10 seconds or text doesn't
      match: return `{ success: false, error: 'Add confirmation toast not received' }`.

### Search Input Cleanup

Before typing into any search input (steps 5 and 11), clear any
existing value first. Select all text in the input and overwrite it,
or triple-click to select then type. Do not assume the input is empty
from a previous iteration.

## addSpaceMembers — Batch Wrapper

```js
async function addSpaceMembers(page, { names, fullSpaceName }, log, abortSignal)
```

1. Validate `fullSpaceName` exists in `SPACE_IDS`. If not, return
   immediately with:
   `{ success: false, added: 0, failed: [], error: 'Unknown space' }`

2. Initialize counters:
   ```js
   let added = 0;
   const failed = [];  // { name: string, error: string }
   ```

3. Log: `"Adding ${names.length} members to: ${fullSpaceName}"`

4. For each `name` in the `names` array:
   a. CHECK ABORT: if `abortSignal.aborted`, exit loop.
   b. Log: `"[${i+1}/${names.length}] Processing: ${name}"`
   c. Call `addSpaceMember(page, { fullMemberName: name, fullSpaceName }, log, abortSignal)`.
   d. If result.success:
      - Increment `added`.
      - Log: `"ADDED: ${name}"`
   e. If !result.success:
      - Push `{ name, error: result.error }` to `failed`.
      - Log: `"SKIPPED: ${name} — ${result.error}"`
   f. Continue to next name.

5. Log summary:
   `"Complete. Added: ${added}. Skipped: ${failed.length}."`

6. Return:
   ```js
   {
     success: failed.length === 0,
     added,
     failed,
     error: failed.length > 0
       ? `${failed.length} member(s) could not be added`
       : undefined
   }
   ```

## Abort Handling

Check `abortSignal.aborted` BEFORE each iteration in the batch loop.
On abort:
- Log: `"Abort requested. Stopped after processing ${i} of ${names.length} members."`
- Return current results (partial `added` count, accumulated `failed`),
  with `error: "Aborted by user"` for addSpaceMember and
  `error: "Aborted by user after ${count} removals"` for removeSpaceMembers.

## Error Handling

- Wrap ALL DOM interactions in try/catch.
- If a single member's addition throws unexpectedly (not a known
  skip reason), catch it, push to `failed` with the error message,
  log it, and continue to the next name. Do not let one failure
  crash the entire batch.
- If a page navigation itself fails (network error, MN down),
  that is unrecoverable — let it propagate up to the server's
  try/catch for browser cleanup.

## Performance Note

This process navigates to two separate pages per member (space
members page for the already-a-member check, then community members
page for the actual addition). For large lists this will be slow.
This is acceptable — correctness over speed. Do not attempt to
optimize by batching or caching member lists; the DOM-based approach
requires fresh page state per operation.

## Return Types

Single member:
```js
{ success: boolean, error?: string }
```

Batch:
```js
{ success: boolean, added: number, failed: { name: string, error: string }[], error?: string }
```
