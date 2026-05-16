## What you'll get next time space 5 fails on prod:

* `data/diagnostics/<timestamp>-add-space-member-failed-<memberId>-5-News-Ideas-from-Crews-Teams-Events.png` — the screenshot at the moment of failure.
* The matching `.json` next to it with at minimum:
    * `page.url` — exact URL in the address bar
    * `page.title` — `"Just a moment..."` is the Cloudflare giveaway
    * `page.bodyClass` — `cf-challenge`, `auth-sign_in`, `communities-landing`, etc.
    * `page.inputCount` — `document.querySelectorAll('input').length`. Discriminates a "form not yet mounted" race (`inputCount === 0` while `bodyClass='auth-sign_in'`) from a markup change (`inputCount > 0` but the task's selectors miss).
    * `error.message` and `error.stack` — the original failure
* A `[diag] dumped failure context: <png path> | <json path>` line appears in the run log so you can find the dump easily.

## How to use it on prod:

1. Pull the latest code and restart the server (no migrations).
1. Click Enqueue reconcile with the headless box however you ran it before (so you reproduce the same failure shape — leave it checked).
1. After the failure, scp the two new files in `~/EmergentAdmin/data/diagnostics/` over to your dev box.
1. Open the PNG. If it shows a Cloudflare "Just a moment..." or "Verify you are human" page → root cause #1 confirmed; we'll add a stealth-mode launch profile or retry-on-challenge path. If it shows a sign-in page that visibly differs from what dev sees → root cause #3 (MN form change), and the JSON's `page.title` / `bodyClass` will tell us which selectors to update.

## Two operational notes worth remembering:

* No automatic rotation. Each dump is small (a screenshot is typically a few hundred KB), but if you do a long debugging push you may want to `rm` the dir occasionally. I can add rotation later if it becomes a problem.
* The dumper does not redact. Screenshots will contain whatever's on the page at failure time, which on prod could be a partial member list, names, etc. Treat dump files like the DB itself — keep them off public channels and clean up after debugging.
