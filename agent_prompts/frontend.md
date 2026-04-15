# Agent Prompt: index.html

Build `public/index.html` — a single-file vanilla HTML/CSS/JS frontend.

## Stage 1 Scope

Only the "Remove Space Members" section. The "Add Members" section
will be added in Stage 2.

## Layout

### Header
- Title: "MN Host Automator"
- Subtitle: "Mighty Networks Space Management"

### Remove Space Members Section

**Space selector:**
- A `<select>` dropdown populated with these space names (hardcoded):
  - 1. Relating to SELF
  - 2. Relating to OTHERS
  - 3. Relating to WORLD
  - 4. Current Events/Politics/Hot Buttons
  - 5. News/Ideas from Crews, Teams, Events
  - 6. Personal Introductions
  - 7. EC Announcements and Highlights
  - 8. Miscellaneous
  - Creative Center
  - Marketplace

**Options:**
- Checkbox: "Headless mode" — default CHECKED (true).
- Checkbox: "Dry run" — default CHECKED (true).
  When checked, show a visible indicator: "(no members will be removed)"

**Action button:**
- Label: "Remove All Non-Admin Members"
- Disabled while any task is running.
- Clicking it sends POST `/run/remove-space-members` with body:
  ```json
  {
    "fullSpaceName": "<selected value>",
    "headless": <checkbox state>,
    "dryRun": <checkbox state>
  }
  ```

**Abort button:**
- Label: "Abort"
- ONLY visible/enabled while a task is running.
- Clicking it sends `{ type: "abort" }` via WebSocket.
- Must remain visible and accessible at all times during task
  execution — it must NOT scroll out of view. Pin it to the top
  of the control section or use `position: sticky`.

### Live Log Panel

- Connects to WebSocket on page load using:
  `new WebSocket('ws://' + location.host)`
- Displays each incoming `{ type: "log" }` message as a new line.
- Auto-scrolls to bottom after each new message.
- Visual distinction:
  - Normal log lines: default text color.
  - Lines containing "ERROR" or "STALE GUARD" or "HALT": red text.
  - Lines starting with "WOULD REMOVE": muted/grey (dry-run indicator).
  - Lines starting with "Removed": green text.
- `{ type: "done" }` message: display final result prominently
  (e.g., bordered box with summary). Re-enable all buttons.
- `{ type: "error" }` message: display in red, re-enable all buttons.
- Include a "Clear Log" button above the log panel.

### State Management

- All action buttons disabled while any task is running.
- Abort button enabled ONLY while a task is running.
- On WebSocket disconnect: show a status indicator ("Disconnected")
  and attempt reconnect every 3 seconds.
- On reconnect: clear the disconnected indicator.

## Style

- No external CSS frameworks.
- Functional appearance. Dark background, light text, monospace font
  for the log panel.
- Log panel should have a fixed height with overflow-y scroll.
- Responsive enough to not break on a laptop screen. Do not optimize
  for mobile.
- Do not optimize for beauty. Optimize for clarity and function.
