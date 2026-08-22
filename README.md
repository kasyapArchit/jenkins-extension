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
controller's job list. The job index comes from one recursive `/api/json?tree=jobs[...]`
call and is cached in `chrome.storage.session`, so typing is instant after the first load.

Rows are named the same way everywhere else in the popup: `QA · Webmail`, with the full
path on hover. Matching still runs against the full path, so typing a folder name finds the
jobs inside it.

Results can be run without starring. Every row has a Run button that triggers with the
saved values, or the job's own Jenkins defaults the first time. Clicking the row instead
expands the parameter form, fetched on demand, so values can be changed before triggering.
Arrow keys move the selection, Enter runs the highlighted result, Shift+Enter opens its
parameters, Escape clears. A successful trigger from search clears the query and drops back
to browse, because that is where the new run is visible.

Starring is a separate act: the star in the row, or the star button in the expanded panel.
Running a pipeline from search never stars it.

**Run** on a starred card fires immediately with the values from the last run, falling
back to the job's defaults the first time. This is the one-click path. Clicking the card
body opens the parameter form when you need to change something first. Drag the grip to
reorder.

**Activity** shows everything triggered from the extension. Each card is two lines: name,
build number and elapsed time on the first, the values the build ran with on the second.
Names are folder-qualified, because several folders having a job called `QA` is normal and
the bare name says nothing about which one ran. The eye button opens the build in a new tab,
and on a finished card the circular arrow beside it runs the pipeline again with exactly the
values that build used.

Where the build number sits, a version appears instead once the pipeline sets one. Every
poll re-reads the build's `displayName`, which is what `currentBuild.displayName = "9.2.1"`
writes and what Jenkins' own UI shows in place of `#N`. Until a pipeline sets it, Jenkins
returns the default `#N` and the card shows the number as before. The build number stays in
the tooltip either way.

If your pipelines publish their version somewhere else, `currentBuild.description` or a
named environment variable, that is a one-line change to the tree query in `getBuild()` and
to `buildLabel()` in `lib/format.js`.

The status word is deliberately absent. The dot already says running, succeeded or failed,
so printing SUCCESS next to a green dot spends a line on nothing. Queued is the one state a
colour cannot express, so it gets a ring instead of a filled dot, and the dot's tooltip
names the state either way, including the queue reason Jenkins gives.

Values only, not `KEY=value`: a branch name or a build command identifies itself, and the
key doubles the length of a line that has to fit in 400px. The keys are in the tooltip. Booleans are left out entirely, since they are stored as real
booleans so the type is enough to filter on, and a row of `false` says nothing about what
the build was. The starred cards still show `KEY=value`, because there you are about to
edit the values rather than read them back. Running builds tick every second and can be
aborted via `POST <build>/stop`. Finished rows are dismissed one at a time.

Re-running reads the values off the run record, not the pipeline's saved ones, so it
reproduces what that build actually used even if the saved values have been edited since.
It does not write them back either: a replay of an old build should not quietly become the
new default. Password parameters are the gap, since they are stripped before a run is
recorded; a replay omits them and Jenkins uses its own defaults.

Parameter panels slide open and shut. The wrapper is a grid whose single row animates
between `minmax(0, 0fr)` and `minmax(0, 1fr)`, so no height has to be measured and a
two-field pipeline and a ten-field one take the same 190ms. Only the render that follows a
click animates, tracked by `ui.justOpened`; a background poll re-rendering an open card
rebuilds it already expanded rather than replaying the animation. The flag is cleared when
the reveal runs rather than when the card renders, because a render can be discarded before
its animation ever starts, which is what happens when a search result's parameters arrive a
tick after the panel opens. Reduced-motion preferences cut the duration to 1ms.

**Blocking** keeps a pipeline from being started by accident. A blocked one appears exactly
where it did before, but its Run and Trigger build buttons become Open and take you to the
job in Jenkins. Clicking the name still expands the parameters, so nothing becomes
unreadable; only the build is withheld.

There are two independent sources, and either one blocks. The padlock beside a pipeline's
name blocks that one pipeline, and lives in `chrome.storage.sync` under `blocked` as a list
of ids. Patterns in settings block by name, which is how a pipeline you have not starred, or
one that does not exist yet, can be covered; they are `config.denyPatterns`, matched
case-insensitively and unanchored against the full path. A pattern block cannot be lifted
from the popup — its padlock is shown but does not open — because a deny-list you can click
away on the card it is guarding is not a deny-list. Blocks survive unstarring, since
unstarring is tidying and should not disarm a guard.

The rule lives in `lib/guard.js`, which has no DOM or chrome dependency so the service
worker enforces exactly what the popup draws. The popup swapping the button is an
affordance; `trigger()` in `background.js` checking again is the guard. A stale popup, a
replay of an old run, or a message from anywhere else all hit the same refusal.

The padlock only appears on a search row that is already blocked, so blocking a pipeline
from search before starring it means writing a pattern. The bell is always there, since
subscribing has no other route.

**Subscribing** notifies you whenever a pipeline runs, whoever started it, which the run
list cannot do: it only knows about builds this extension asked for. The bell sits beside the
padlock on starred cards and on search rows, so the two things that change what a pipeline
does without opening it are in one place, and a pipeline can be subscribed without being
starred. Filled means subscribed. Both sit at the far end of the row so the caret stays
attached to the name.

The footer counts them next to the starred count, and that count is a button: a subscription
is otherwise invisible unless you happen to be looking at the pipeline carrying it, so the
list under the footer is the only place the whole set can be seen and unpicked.

Each poll asks every subscription for `lastBuild[number,building,result,timestamp,duration]`
and compares it with a watermark. A higher number is a start, a verdict on the number we were
watching is a finish. Deciding that lives in `lib/watch.js`, pure and tested. Three details it
gets right that a first attempt would not:

- The first sight of a pipeline is recorded silently. Otherwise subscribing announces
  whatever happened to run last.
- Jenkins reports `building: false` with `result: null` for a moment at the end of a build.
  A build counts as over only once it has a verdict, or every finish would announce a
  failure that never happened.
- A build that starts and finishes inside one poll reports the finish only, and builds
  skipped entirely between polls are not reported at all.

Watermarks are in `chrome.storage.local`, not sync: they are rewritten on every state change
and sync refuses more than 1800 writes an hour. Builds the extension triggered itself are
skipped, since the run list already announces those.

Which moments are worth a notification is a setting, with at least one kind always on — the
last box still ticked is disabled rather than validated on save. Notifications only arrive
while Chrome is running and the controller is reachable, so a reconnect after the VPN drops
finds a pile of finished builds at once; anything that happened more than two minutes ago is
dropped unless the missed-builds setting says otherwise.

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
| `config` (base URL, user ID, poll interval, notify, search depth, deny patterns) | `sync` | follows your Chrome profile |
| `blocked` (pipeline ids blocked by hand) | `sync` | follows your Chrome profile |
| `subscriptions` (pipelines to watch) | `sync` | follows your Chrome profile |
| `watch` (last build seen per subscription) | `local` | written per build; sync would hit its write quota |
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

## Icons

`python3 dev/make-icons.py` regenerates every PNG in `icons/` from geometry measured off
the source artwork. Edit the constants at the top of that script rather than the PNGs.

`TRI_SCALE` sizes the play triangle relative to the source. It is 1.35 rather than 1.0
because at the artwork's own proportion the mark read as a notch beside other toolbar
icons. At 1.35 the triangle is 0.45 of the disc diameter, which is normal for a play
button, and its corners sit 0.29 from the centre against a 0.46 radius, so there is still
clearance. Past about 1.6 it starts to crowd the disc edge.

Three variants come out of it:

| Variant | Square | Used for |
|---|---|---|
| `-mark` | transparent | the toolbar action icon, and notifications |
| `-dark` | `#16181d` | the `icons` key: chrome://extensions, the store |
| `-light` | `#ffffff` | unused; kept for the light tile if it is ever wanted |

Chrome has no way to pick an icon by colour scheme. `icon_variants` is not in the manifest
reference, and per the W3C WebExtensions issue only Safari implemented it. Firefox has
`theme_icons`; Chrome does not. The only Chrome option is calling `chrome.action.setIcon()`
at runtime, which needs a theme signal the service worker does not have.

That does not cost anything here, because the toolbar uses the transparent mark. The tile
was never going to disappear into the toolbar anyway: Chrome's dark toolbar is `#35363a`,
lighter than the artwork's `#16181d`, so a dark tile stays visible as a tile in both themes.
At 16px it also spends about 40% of the canvas on the tile and shrinks the disc to a dot.
Dropping it lets the disc fill the icon and punches the play triangle straight through, so
whatever the toolbar colour is shows in it. One file, correct on every theme, custom ones
included.

## Working on the design

`dev/preview.html` opens the popup in a normal browser tab with `dev/mock-chrome.js`
stubbing the extension APIs and a fake Jenkins. No extension reload, no VPN.

`dev/options-preview.html` does the same for the settings page. Rather than copying its
markup, which is how the popup harness drifted from the worker once already, it lifts the
real `options.html`'s style and sheet out of the file and imports `options.js` over them, so
it cannot go stale.

```
python3 -m http.server 8731
open http://localhost:8731/dev/preview.html
open http://localhost:8731/dev/options-preview.html
```

Resize the window to 400×600 to match the real popup. Nothing in `dev/` ships.

`mock-chrome.js` replaces `fetch`, but only answers URLs on the fake Jenkins host and passes
everything else to the real one; without that a harness page cannot load its own files.

The source design lives in `design_handoff_jenkins_launcher/`. Tokens in `popup.css` are
copied from it verbatim; icons are inlined Lucide paths in `lib/icons.js` rather than the
prototype's Unicode placeholders.

## Reloading during development

Chrome does not always replace a running service worker when you hit Reload on an unpacked
extension, so the popup can be new while the background script is still old code. Symptom:
the popup looks right, Test connection is green, and triggering a build fails with an error
message that no longer exists in the source.

The popup checks for this every time it opens. `lib/build.js` exports a `BUILD` stamp that
the popup and the worker each report from their own loaded copy. On a mismatch the popup
shows a banner with a Reload button that calls `chrome.runtime.reload()`, which replaces the
worker properly. Bump `BUILD` whenever you change `background.js` or anything it imports;
if you forget, the check silently passes and you are back to guessing.

Test connection makes the same comparison, and additionally catches settings you typed but
never saved, since only its second check reads storage.

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
- Re-running a finished run leaves out its password parameters. They are stripped before a
  run is recorded, so there is nothing to replay and Jenkins falls back to its own defaults.
- Subscription notifications need Chrome running and the controller reachable. There is no
  push from Jenkins, only the 30-second alarm poll, which is Chrome's floor.
- Untested against a live Jenkins controller.

## Roadmap

Checked items are already implemented; the rest are not started. In the order they were
asked for.

- [x] **A toggle that blocks triggering.** The padlock beside a pipeline's name. With it
      shut, Run and Trigger build open the job in a new tab instead of starting a build.

- [x] **Regex deny-list for triggering.** Patterns in settings, matched against the full
      path. Covers pipelines that are not starred and ones that do not exist yet.

- [x] **Track a version number that changes mid-run.** The poller re-reads the build's
      `displayName` on every tick, so a version the pipeline sets partway through appears on
      the card. See the note under Activity if your pipelines publish the version somewhere
      other than `displayName`.

- [x] **Icon in the notification.** `announce()` passes `iconUrl: 'icons/128-mark.png'`.

- [x] **Notify on failure.** A notification fires on every completion, and non-SUCCESS
      results go out at `priority: 2`.

- [ ] **Notify when a build fails to start.** The gap left by the item above: `pollAll()`
      marks these `ERROR` without calling `announce()`, so a build that never begins is
      silent.

- [x] **Clicking the notification opens the run.** Handled in the
      `chrome.notifications.onClicked` listener.

- [x] **An eye button that opens the build.** It replaced the copy button rather than
      joining it, since copying a URL was only ever a means of opening it.

- [x] **Show the parent folder in the pipeline name.** `QA · Webmail` rather than bare
      `QA`, on run cards, starred cards and notification titles. The job leads and the
      folder trails, so the eye scans job names down the column. `qualifiedName()` in
      `lib/format.js`; the full path is in the tooltip.

- [x] **Re-run a finished run with the same parameters.** The circular-arrow button on a
      finished run card, between the eye and dismiss buttons. It reads the values off the run
      record rather than the pipeline's saved ones, so it reproduces what that build actually
      used even if the saved values have been edited since, and for the same reason it does
      not write them back as the new saved values. `rerun()` in `popup.js`, carried to the
      worker as `remember: false` on the trigger message.

## VPN

Chrome has no VPN API, and an extension cannot bind its own traffic to a tunnel. The
workable fix is split tunnelling at the OS level: with OpenVPN, add `route-nopull` plus an
explicit `route` for the Jenkins subnet, so the tunnel can stay up all day while carrying
only Jenkins traffic. Note that `route-nopull` also drops the pushed DNS.
