# MN Host Automator — Project Spec

## What This Is
A local-only Node.js webapp that automates host tasks inside a Mighty Networks
community via headless Puppeteer browser automation. Single-user, localhost,
never deployed publicly.

## System Prompt

Read `agent_prompts/system_prompt.md` at the beginning of each session.

## Stage 1 Scope: removeSpaceMembers task -- DONE
- Login + session handling
- Remove all non-admin members from a selected space
- Frontend with live log streaming, abort, and dry-run toggle

## Stage 2 Scope: deploy to server -- DONE
- prepare project for server deployment
- generate server setup instructions

## Stage 3 Scope: addSpaceMember task -- NEXT
- Modify frontend to add one member to all spaces
- Frontend with live log streaming, abort and headless toggles (no dry-run)

## Stack
- Runtime: Node.js
- Backend: Express
- Browser automation: Puppeteer
- Frontend comms: WebSockets (ws package) for live progress streaming
- Frontend: Single HTML file, vanilla JS, no framework
- Config: dotenv (.env file, already added gitignored)

## Project Structure
```
/mn-host-automator
  /src
    server.ts          # Express + WebSocket server
    auth.ts            # Login and session management
    tasks/
      removeSpaceMembers.ts
    utils/
      browser.ts       # Puppeteer launch + teardown helper
  /public
    index.html         # Single-page UI
  .env                 # Credentials — gitignored
  .env.example         # Committed template
  .cursorrules         # Agent behavior rules
  package.json
```

## Browser Lifecycle
- Puppeteer launches a new browser per task invocation.
- Browser is closed in a `finally` block regardless of success or failure.
- `headless` argument (default: true) controls visibility.
- No singleton. No browser reuse across tasks.

## Abort Mechanism
- Frontend sends `{ type: "abort" }` via WebSocket.
- Server sets a shared abort flag.
- Task checks the flag between each iteration of its loop.
- On abort: task stops, closes browser, returns partial result
  with `Aborted by user after ${count} removals`.
- Abort button is always visible and enabled while a task is running.

## Return Types
removeSpaceMembers tasks return: `{ success: boolean, removed?: number, error?: string }`

## Environment Variables
See `.env.example` for required variables. file `.env` has been configured by the user.

## More Detail
See `clarifications.md` for more detail about each task.