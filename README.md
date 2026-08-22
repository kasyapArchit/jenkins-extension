# Jenkins Launcher

A Manifest V3 Chrome extension that searches every pipeline on a Jenkins controller,
triggers starred ones from the toolbar, and tracks the resulting builds. No build step,
no bundler. Load it unpacked and edit the files directly.

## Install

1. Open `chrome://extensions`, turn on Developer mode.
2. Load unpacked, pick this directory.
3. Click the toolbar icon, then the gear, and fill in:
   - Jenkins base URL (include the context path if Jenkins is behind a proxy)
   - your Jenkins user ID
   - an API token from `<jenkins>/me/security`
4. Hit Test connection. It reports the account it authenticated as and how many
   pipelines it can see.

Chrome asks for permission to talk to your Jenkins host. That grant is why the manifest
only declares `optional_host_permissions` instead of a blanket origin.

## Using it

**Search** any non-empty query switches the popup into search mode and filters the whole
controller's job list. Star a result to pin it, or press Enter to run it. The job index
comes from one recursive `/api/json?tree=jobs[...]` call and is cached in
`chrome.storage.session`, so typing is instant after the first load. Arrow keys move the
selection, Enter runs a starred pipeline (or stars and opens an unstarred one, so a stray
keypress never fires a build you have not seen the parameters for), Escape clears.

**Run** on a starred card fires immediately with the values from the last run, falling
back to the job's defaults the first time. This is the one-click path. Clicking the card
body opens the parameter form when you need to change something first. Drag the grip to
reorder.

**Activity** shows everything triggered from the extension. Running builds tick every
second, can be aborted via `POST <build>/stop`, and every row can copy its build URL.
Finished rows are dismissed one at a time.

**Add by URL** at the bottom takes any Jenkins URL containing the job (build page, console,
job page) and trims it down to the job path.

## Connection states

The header dot reports what the last probe of `/me/api/json` found.

| State | Dot | Meaning |
|---|---|---|
| Connected | green | reachable and authenticated |
| No VPN | grey | the controller did not answer; cached data is dimmed with a retry |
| Auth failed | red | 401 or 403, with a link into settings |

## Status tracking

Triggering records the queue item URL from the `Location` response header. A
`chrome.alarms` job polls `queue/item/<id>/api/json` until Jenkins assigns a build number,
then polls the build until `building` goes false. Network errors during polling are
ignored rather than failing the run, since a dropped VPN should not lose a build you are
watching. The toolbar badge counts in-flight builds and a desktop notification fires on
completion.

Chrome will not run alarms more often than every 30 seconds, so that is the floor for the
poll interval. Elapsed times still tick every second while the popup is open.

## Where state lives

| Data | Area | Why |
|---|---|---|
| `config` (base URL, user ID, poll interval, notify, search depth) | `sync` | follows your Chrome profile |
| `starred` (ordered), `paramValues` | `sync` | same |
| `token` | `local` | see below |
| `runs` | `local` | machine-specific, and noisy for sync quota |
| `jobIndex` | `session` | rebuilt once per browser session |

The design handoff put the API token in `sync`. It is in `local` here instead: `sync`
uploads to Google and propagates the credential to every Chrome profile signed into the
same account, which is the wrong place for a Jenkins token. Flip it in `lib/store.js` if
you disagree. Password build parameters are sent to Jenkins but never written to storage
at all.

## Auth modes

**API token** (default) sends HTTP basic auth. Jenkins exempts API-token requests from
CSRF, so no crumb is needed.

**Browser session** reuses your Jenkins cookies with `credentials: include` and fetches a
crumb from `/crumbIssuer/api/json` before each POST. Use it if your Jenkins is behind SSO
that blocks token auth. It breaks whenever your session expires.

## Working on the design

`dev/preview.html` opens the popup in a normal browser tab with `dev/mock-chrome.js`
stubbing the extension APIs and a fake Jenkins. No extension reload, no VPN.

```
python3 -m http.server 8731
open http://localhost:8731/dev/preview.html
```

Resize the window to 400×600 to match the real popup. Nothing in `dev/` ships.

The source design lives in `design_handoff_jenkins_launcher/`. Tokens in `popup.css` are
copied from it verbatim; icons are inlined Lucide paths in `lib/icons.js` rather than the
prototype's Unicode placeholders.

## Reloading during development

Chrome does not always replace a running service worker when you hit Reload on an unpacked
extension, so the popup can be new while the background script is still old code. Symptom:
the popup looks right, Test connection is green, and triggering a build fails with an error
message that no longer exists in the source.

Test connection detects this. It runs two checks. The first uses the values currently in
the options form. The second asks the service worker, which is what actually runs a build:
stored config, its own loaded copy of the Jenkins client. If the worker reports a different
`CLIENT_BUILD` than the options page, the test says so and tells you to toggle the extension
off and on, which is the reliable way to replace the worker.

The same test also catches settings you typed but never saved, since only the second check
reads storage.

## Tests

```
node test/normalize.test.mjs
node test/auth.test.mjs
```

`normalize` covers URL and root handling: reverse-proxy context paths, view segments, build
and console suffixes, encoded branch names.

`auth` covers the credential path against a stubbed fetch: basic auth is sent when a token
exists, missing credentials throw before any request goes out, cookie mode sends no auth
header, `probe()` maps every failure to one of the three header states, and `triggerBuild`
picks the right endpoint and returns the queue URL.

## Known gaps

- File parameters are not supported. `buildWithParameters` needs multipart for those.
- Multibranch jobs must be starred at the branch level, since the top level is a folder.
- Credentials and Run parameter types render as plain text inputs.
- Search indexes to `searchDepth` folder levels (default 3). Deeper jobs are invisible to
  search but can still be added by URL.
- Untested against a live Jenkins controller.

## VPN

Chrome has no VPN API, and an extension cannot bind its own traffic to a tunnel. The
workable fix is split tunnelling at the OS level: with OpenVPN, add `route-nopull` plus an
explicit `route` for the Jenkins subnet, so the tunnel can stay up all day while carrying
only Jenkins traffic. Note that `route-nopull` also drops the pushed DNS.
