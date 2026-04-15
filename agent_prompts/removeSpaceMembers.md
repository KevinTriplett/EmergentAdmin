# Agent Prompt: removeSpaceMembers.js

Build `src/tasks/removeSpaceMembers.js` for a Puppeteer automation project.

## Exports

```js
async function removeSpaceMembers({ page, fullSpaceName, dryRun = true, log, abortSignal })
```

## Constants

```js
// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_READY = 'body.pace-done #community-app';
const SEL_SIGN_IN = 'body.auth-sign_in';
const SEL_FLYOUT = '#flyout-main-content';
const SEL_TABLE_MEMBERS = '.all-members-list-items';
const SEL_MEMBER_ROW = 'tr[data-member-item]';
const SEL_MEMBER_DROPDOWN = '.actions-region a.mighty-drop-down-toggle';
const SEL_MEMBER_DROPDOWN_MORE = '.actions-region .mighty-drop-down-menu-region .menu-list-item-more-host-FlexSpace-actions .toggle-child-expanded-button';

// === TEXT LABELS — UPDATE THESE IF MN CHANGES ITS UI TEXT ===
const TXT_REMOVE_MEMBER = 'Remove from Space';
const TXT_REMOVE_CONFIRM = 'Remove This Member';
const TXT_REMOVE_CANCEL = 'Cancel';
const TXT_REMOVE_OKAY = 'Okay';

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
  'Marketplace': '5627234'
};

// === ADMIN IDS — Never remove these members ===
const ADMIN_IDS = ['7698608'];
```

## URL Construction

```
https://emergent-commons.mn.co/spaces/${spaceId}/admin/members/all
```

Look up `spaceId` from `SPACE_IDS` using `fullSpaceName`. If the name
is not found, return immediately with:
```js
{ success: false, removed: 0, error: `Unknown space: "${fullSpaceName}"` }
```

## Process

1. Navigate to the space members URL.
2. Wait until `SEL_READY` is present.
3. Call `loginIfNeeded(page, log)` from auth.js.
4. Wait until `SEL_TABLE_MEMBERS` is present inside `SEL_FLYOUT`.
5. Log: `"Loaded member list for: ${fullSpaceName}"`
6. If `dryRun`, log: `"DRY RUN — no members will be removed."`
7. Enter the removal loop (see below).
8. Return `{ success: true, removed: N }` where N is the count of
   actual removals (0 in dry-run mode).

## Removal Loop

The member list is inside an infinite-scroll container (`SEL_FLYOUT`).
Members may exist below the fold that haven't loaded yet.

```
LOOP:
  a. Query all SEL_MEMBER_ROW elements currently in the DOM.
  b. Filter out rows whose `data-member-item` attribute value is in ADMIN_IDS.
  c. If no non-admin rows remain:
       - Scroll SEL_FLYOUT to the bottom to trigger infinite scroll loading.
       - Wait 2 seconds for new rows to load.
       - Re-query SEL_MEMBER_ROW.
       - Filter out admin rows again.
       - If still no non-admin rows: list is fully exhausted. Exit loop.
  d. Select the FIRST non-admin row.
  e. Extract the member's display name and profile link href from the row.
     Store as: { name: string, profileUrl: string }
  f. Log: "[dryRun ? 'WOULD REMOVE' : 'Removing']: ${name} (${profileUrl})"
  g. CHECK ABORT: if abortSignal.aborted is true, exit loop immediately.
  h. If dryRun: skip to step (n) — do not click anything.

  --- Actual removal (non-dryRun only) ---
  i. Within the selected row, click SEL_MEMBER_DROPDOWN.
  j. Wait for the dropdown menu to appear.
  k. Click SEL_MEMBER_DROPDOWN_MORE (the nested "more" submenu toggle).
  l. Wait for the submenu to expand.
  m. Click the element whose visible text is TXT_REMOVE_MEMBER.
  n. A confirmation modal appears. Click the element whose visible
     text is TXT_REMOVE_CONFIRM.
  o. A success/acknowledgment modal appears. Click the element whose
     visible text is TXT_REMOVE_OKAY.
  p. Wait for the DOM to update (the row should disappear).

  --- Stale Guard ---
  q. Re-query SEL_MEMBER_ROW elements.
  r. Filter out admin rows.
  s. If no non-admin rows remain: check for infinite scroll
     (same as step c). If truly empty, exit loop.
  t. Read the profile link href of the new first non-admin row.
  u. If the profileUrl matches the member just removed:
     HALT immediately. Log error:
     "STALE GUARD: ${name} (${profileUrl}) is still at index 0
      after confirmed removal. MN may have rejected the removal
      or re-rendered unexpectedly. Halting."
     Return { success: false, removed: N, error: <stale guard msg> }.
  v. Removal succeeded. Increment count.
  w. Log: "Removed ${count}: ${name}"

  n (dryRun path). Increment dryRun counter. Continue to next iteration.

  REPEAT from (a).
```

## Admin Row Identification

IMPORTANT: `data-member-item` has been verified to contain a non-empty
attribute VALUE on each `<tr>` which is the member's numeric ID string
(e.g., "7698608"). The attribute `data-member-item` is NOT a
presence-only attribute.

## Abort Handling

`abortSignal` is an object with a boolean `.aborted` property. The
server sets it to true when it receives an abort WebSocket message.

Check `abortSignal.aborted` BEFORE each removal attempt (step g).
On abort:
- Log: `"Abort requested. Stopped after ${count} removals."`
- Return `{ success: true, removed: count, error: "Aborted by user" }`

## Error Handling

- Wrap ALL DOM interactions in try/catch.
- On error: log the error message, close any open modals/dropdowns
  if possible, and return with:
  `{ success: false, removed: count, error: <message> }`
- Do not let an error in one removal crash the entire task without
  reporting how many were already removed.

## Return

```js
{ success: boolean, removed: number, error?: string }
```
