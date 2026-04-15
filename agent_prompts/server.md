# Agent Prompt: server.js

Build `src/server.js` for a local Express + WebSocket automation tool.

## Dependencies

- express
- ws
- dotenv (loaded at top of file)
- Puppeteer (launched per-task)

## Server Setup

- Express serves `/public/index.html` on `GET /`.
- Express also serves all static files from `/public`.
- WebSocket server (ws package) runs on the same HTTP server using
  the upgrade pattern (not a separate port).
- Port: `process.env.PORT || 3000`.

## Endpoints (Stage 1)

### POST /run/remove-space-members

Body:
```json
{
  "fullSpaceName": "string",
  "headless": true,
  "dryRun": true
}
```

Validation:
- `fullSpaceName` is a required non-empty string.
- `headless` is optional boolean, defaults to `true`.
- `dryRun` is optional boolean, defaults to `true`.

Behavior:
1. If a task is already running, return `409` with
   `{ error: "A task is already running" }`.
2. Set the task-running mutex.
3. Launch Puppeteer with `headless` option. Use `headless: 'new'`
   when headless is true, `headless: false` when false.
4. Create a new page.
5. Call `loginIfNeeded(page, log)`.
6. Call `removeSpaceMembers(page, { fullSpaceName, dryRun }, log, abortSignal)`.
7. Send result to WebSocket as `{ type: "done", result }`.
8. Return `200` with result JSON.
9. In `finally`: close browser, clear mutex, clear abort signal.

## Mutex

- Only one task may run at a time.
- Use a simple boolean flag: `let taskRunning = false`.
- Set to `true` before launching, `false` in `finally`.
- Return `409` if a request arrives while `taskRunning === true`.

## Abort Signal

- Maintain a shared object: `let abortSignal = { aborted: false }`.
- Reset to `{ aborted: false }` at the start of each task.
- When a WebSocket client sends `{ type: "abort" }`, set
  `abortSignal.aborted = true`.
- Pass `abortSignal` to the task function. The task checks it
  between iterations.

## WebSocket Messages

### Server → Client
```json
{ "type": "log", "message": "string" }
{ "type": "done", "result": { ... } }
{ "type": "error", "message": "string" }
```

### Client → Server
```json
{ "type": "abort" }
```

## Log Function

Create a `log(message)` function for each task run that:
1. Sends `{ type: "log", message }` to all connected WebSocket clients.
2. Also writes to `console.log` for server-side debugging.

Pass this function to `loginIfNeeded()` and to the task function.

## Browser Cleanup

The browser MUST be closed in a `finally` block:
```js
let browser;
try {
  browser = await puppeteer.launch({ ... });
  // ... run task ...
} catch (err) {
  // send error to WebSocket
} finally {
  if (browser) await browser.close();
  taskRunning = false;
  abortSignal = { aborted: false };
}
```

## Error Handling

- If the task throws, send `{ type: "error", message }` via WebSocket
  and return `500` with `{ error: message }`.
- If Puppeteer fails to launch, send an error and return `500`.
- The `finally` block runs regardless.
