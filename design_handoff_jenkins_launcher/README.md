# Handoff: Jenkins Launcher — Chrome extension popup redesign

## Overview
A redesign of the popup for a personal Chrome extension that triggers Jenkins pipelines
without opening the Jenkins UI. The popup lets the user:

- see connection status to the Jenkins controller (VPN / auth),
- search **all** pipelines on the controller and star/unstar from results,
- see the status of builds triggered from the extension (running + finished),
- abort a running build, copy a build URL, dismiss a finished run,
- expand a starred pipeline inline, edit its parameters, and trigger a build,
- drag to reorder starred pipelines,
- add a pipeline by pasting its Jenkins job URL.

## About the design files
`Jenkins Launcher Popup.dc.html` (plus its runtime `support.js`) is a **design reference
prototype written in HTML** — it demonstrates the intended look, layout, states, and
interactions. It is **not production code to copy**. All data in it is mock data and no
network calls are made.

The task is to **recreate this design inside the existing Chrome extension codebase**
(`popup.html` / popup script, MV3 service worker, `chrome.storage`), using that project's
existing patterns. If the popup is plain HTML+JS today, keep it plain HTML+JS — do not
introduce a framework just to match the prototype's structure.

## Fidelity
**High fidelity.** Colors, type sizes, spacing, radii, and states below are final and should
be matched closely. The prototype uses CSS custom properties for theming — copy those
verbatim.

---

## Screen: Popup

Fixed size **400 × 600 px** (Chrome's popup maximum height is 600). Root is
`display:flex; flex-direction:column; overflow:hidden`, `border-radius:14px`
(the radius is only for the design canvas — in the real popup Chrome clips it; keep
`border-radius:0` or leave as-is, it is invisible).

Vertical structure, top to bottom:

### 1. Header — `padding: 12px 14px 10px`
Flex row, `gap:10px`, `align-items:center`.

- **Title** — "Jenkins Launcher", 13px / weight 650 / `letter-spacing:-0.01em` / `line-height:1.2`, `--text`.
- **Status line** (directly under the title, flex row `gap:5px`, `margin-top:1px`):
  - **Connection dot** — 7×7 circle. `--ok` when reachable, `--faint` when the controller is
    unreachable (no VPN), `--fail` on 401/403.
  - **Connection label** — 11px / weight 600 / `--dim`: `Connected` · `No VPN` · `Auth failed`.
  - **Context** — 11px / `--faint`, ellipsised: `· <controller host> · polling every <n>s`.
  - The dot carries a `title` tooltip explaining the state, e.g.
    "Controller unreachable. Are you on the VPN?" / "401 from Jenkins — check your API token in settings".
- **Refresh button** and **Settings button** — 32×32, `border-radius:8px`, transparent
  background, `1px solid transparent` border, icon `--dim`.
  Hover: `background:var(--hover)`, `border-color:var(--line)`, `color:var(--text)`.
  The prototype uses the glyphs `↻` (16px) and `⚙` (19px) — the gear needs the larger size to
  match optically. **In production use real icons** (e.g. Lucide `refresh-cw` and `settings`,
  16px stroke 1.75) rather than text glyphs.
  Settings opens `options.html` via `chrome.runtime.openOptionsPage()`.

### 2. Search field — `padding: 0 12px 10px`
Height 34px, `background:var(--sunk)`, `1px solid var(--line-soft)`, `border-radius:9px`,
inner `padding:0 10px`, flex row `gap:8px`.
Leading search icon `--faint`. Input is borderless/transparent, 13px, placeholder
"Search pipelines…". A `✕` clear button appears at the right only while the query is non-empty.

**Behavior:** any non-empty query switches the body to *search mode*; empty query returns to
*browse mode*. Search hits the controller's job index
(`/api/json?tree=jobs[fullName,url,lastBuild[timestamp,result]]` recursively, or
`/search/suggest?query=`), debounce ~200ms, cache the job list in `chrome.storage.session`
for the popup's lifetime so typing is instant.

### 3a. Body — search mode — `padding: 0 12px 12px`
- Section head row: left `ALL PIPELINES · <count>` (10.5px / weight 650 / `letter-spacing:0.08em` / `--faint`),
  right hint `↑↓ to move · ⏎ to run` (11px / `--faint`).
- Result rows: flex `gap:10px`, `padding:8px`, `border-radius:9px`; hover `background:var(--hover)`.
  - **Star toggle** — 20px wide, `★` in `--accent` when starred, `☆` in `--faint` when not.
    Clicking stars/unstars immediately (persist to `chrome.storage.sync`).
  - **Name** — 13px / weight 550, ellipsised.
  - **Folder path** — 11px monospace `--faint`, ellipsised (e.g. `Frontend/QA`).
  - **Last run** — 11px `--faint`, right aligned (e.g. `17m ago`).
- Max 7 results shown.
- Empty state: centred 12px `--faint` — `No pipeline matches “<query>”.`
- Keyboard: ↑/↓ move a highlighted row, ⏎ triggers that pipeline with its saved params
  (or opens it if it has none saved), Esc clears the query. **Not implemented in the
  prototype — implement it in the extension.**

### 3b. Body — browse mode
Scrollable (`flex:1; min-height:0; overflow-y:auto`).

**Activity list** — `padding: 2px 12px 12px`. No section header (deliberate — the content is
self-evident). Rows, `gap:6px`:
- Card: `1px solid var(--line-soft)`, `border-radius:10px`, `padding:9px 10px`,
  `background:var(--sunk)`, flex row `gap:10px`.
- **Status dot** 8×8: running `--run` with `pulse 1.4s ease-in-out infinite`
  (`50% { opacity:.35 }`); success `--ok`; failed/aborted `--fail`.
- **Name** 12.5px / weight 600 + **`#build`** 11.5px monospace `--faint`.
- **Meta** 11px `--dim`, `margin-top:2px`:
  running → `Running · 1m 59s` (elapsed, ticking every second);
  finished → `SUCCESS · 17m ago`.
- **Abort** button — running rows only. 11px / weight 600, `--fail` text, `1px solid var(--line)`,
  `background:var(--panel)`, `padding:4px 9px`, `border-radius:7px`.
  Calls `POST <buildUrl>/stop`.
- **Copy build URL** — 26×26 icon button, `1px solid var(--line)`, `border-radius:7px`.
  Swaps to `✓` for 1.2s after clicking.
- **Dismiss ✕** — 26×26, same chrome, **finished rows only**. Removes that run from the
  tracked list. (There is intentionally no global "clear finished".)
- Empty state: dashed `1px var(--line)` box, `border-radius:10px`, `padding:18px`, centred
  12px `--faint` — "Nothing triggered from here yet."

**Starred list** — `padding: 0 12px 12px`.
- Section head row: `STARRED` (same 10.5px caps style) + right hint `drag to reorder` (11px `--faint`).
- Cards, `gap:6px`, `1px solid var(--line)` (→ `var(--accent)` when expanded),
  `border-radius:11px`, `background:var(--panel)`. Dragging card: `opacity:.5`.
- **Collapsed row** — `padding:9px 10px`, flex `gap:8px`:
  - Drag handle `⋮⋮`, `--faint`, `cursor:grab`.
  - Clickable name block (toggles expand): name 13.5px / weight 650 / `-0.01em` + caret `▸`/`▾`
    (10px, `--faint`); under it the **param summary** 11px monospace `--dim`, ellipsised —
    first two params as `KEY=value, KEY=value` plus `  +N` for the rest.
  - **Run** button — `background:var(--accent)`, `--accent-fg` text, 12px / weight 650,
    `padding:6px 14px`, `border-radius:8px`; hover `filter:brightness(1.08)`.
    Triggers with the currently saved params without expanding (`stopPropagation`).
- **Expanded panel** — `border-top:1px solid var(--line-soft)`, `padding:10px 12px 12px`,
  flex column `gap:10px`:
  - **Boolean param** — label row, 15px checkbox (`accent-color:var(--accent)`), key in
    12px monospace.
  - **String param** — key 11px monospace weight 650 + description 10.5px `--faint` on one
    baseline row (`gap:8px`), then a 30px input: `1px solid var(--line)`, `border-radius:8px`,
    `background:var(--sunk)`, `padding:0 9px`, 12.5px monospace; focus `border-color:var(--accent)`.
  - **Choice param** — same label row, then a 30px native `<select>` with the same chrome.
  - **Action row** (`gap:8px`): **Trigger build** (flex:1, accent, 32px, 12.5px / weight 650),
    **Sync params** (outline, 32px, re-reads the job's `/api/json` parameter definitions; label
    becomes `Synced ✓` for 1.4s), **★** (32×32 outline, unstars; hover text `--fail`).
  - **Footer row** (`gap:12px`): `open in Jenkins ↗` link (11px `--accent`) and
    `last run <n> ago` (11px `--faint`).

### 4. Footer — `border-top:1px solid var(--line-soft)`, `padding:8px 12px`
- Collapsed by default: left `+ Add pipeline by URL` (11.5px `--dim` text button, becomes
  `− Hide URL field` when open), right status `3 starred · 1 running` (11px `--faint`).
- Expanded: 30px URL input (placeholder `https://jenkins/job/Folder/job/My-Job/`) + `Add`
  outline button. On add, parse the job path out of the URL, fetch its parameter definitions,
  and star it.

---

## Interactions & behavior
| Trigger | Result |
|---|---|
| Type in search | Debounced live search of all jobs; body switches to results |
| `✕` in search / Esc | Clears query, back to browse mode |
| Star in results | Adds/removes from starred, persists immediately |
| Click starred row body | Expand/collapse; only one expanded at a time |
| `Run` / `Trigger build` | `POST /job/…/buildWithParameters` → new run prepended to activity as RUNNING |
| `Abort` | `POST <build>/stop` → row becomes ABORTED |
| Copy icon | Copies build URL, glyph → `✓` for 1.2s |
| `✕` on finished run | Removes that run from tracking |
| Drag handle | Reorder starred (dragover reorders live, persists on drop) |
| `Sync params` | Re-reads param definitions from Jenkins, keeps current values where keys match |
| Refresh | Force-polls all tracked runs now |

**Polling:** `chrome.alarms` at the configured interval (30s default; Chrome will not fire
faster than 30s — for sub-30s the popup itself can poll while open). While the popup is open,
elapsed times tick every 1s locally. Optional desktop notification when a build finishes.

**Error states to implement (not in the prototype):**
- Controller unreachable → connection chip `No VPN`, body shows last cached data dimmed with a
  retry affordance.
- 401/403 → `Auth failed`, with a link into options.
- Trigger failure → inline red 11px message under the Trigger button with the Jenkins response.

## State
```
config      { baseUrl, authMode, userId, token, pollSeconds, notify }   chrome.storage.sync
starred     [ { id, fullName, name, folder, url, params[] } ]           chrome.storage.sync (ordered)
paramValues { [jobId]: { KEY: value } }                                 chrome.storage.sync
runs        [ { id, jobId, name, build, url, status, startedAt, finishedAt } ]  chrome.storage.local
uiState     { query, openId, addOpen }                                  in-memory
connection  'online' | 'offline' | 'unauthorized'                       in-memory, from last probe
```

## Design tokens
Defined as CSS custom properties on `:root`, with a `@media (prefers-color-scheme: dark)`
override (the design follows the system theme).

**Light**
```
--page #e9eaee   --panel #ffffff  --sunk #f6f7f9   --line #e4e6ea  --line-soft #eef0f3
--text #16181d   --dim #6b7280    --faint #9aa1ad  --hover #f3f4f6
--accent oklch(0.55 0.16 255)     --accent-soft oklch(0.96 0.03 255)  --accent-fg #fff
--ok oklch(0.62 0.14 150)  --run oklch(0.72 0.15 75)  --fail oklch(0.58 0.19 25)
--shadow 0 12px 40px rgba(16,18,24,.18)
```
**Dark**
```
--page #15171b   --panel #1c1f24  --sunk #22262c   --line #2c3138  --line-soft #262a30
--text #e8eaee   --dim #9aa2ae    --faint #6d7580  --hover #262a31
--accent oklch(0.62 0.15 255)     --accent-soft oklch(0.32 0.06 255)  --accent-fg #fff
--ok oklch(0.7 0.14 150)   --run oklch(0.78 0.14 75)  --fail oklch(0.68 0.17 25)
--shadow 0 12px 40px rgba(0,0,0,.5)
```

**Type** — UI: `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif`.
Values/params/paths: `ui-monospace, SFMono-Regular, Menlo, monospace`.
Scale: 13.5 / 13 / 12.5 / 12 / 11.5 / 11 / 10.5 px. Section caps: 10.5px, weight 650,
`letter-spacing:.08em`, `--faint`.

**Radii** — 14 card shell · 11 pipeline card · 10 run card · 9 search + result row · 8 buttons/inputs · 7 icon buttons.
**Spacing** — page gutter 12px, card padding 9–12px, row gap 6px, control gap 8–10px.
**Control heights** — 34 search · 32 header icons + action buttons · 30 inputs/selects · 26 run icon buttons.
**Keyframes** — `pulse` (running dot), `spin` (available for a refresh spinner).

## Assets
None. All glyphs in the prototype are Unicode placeholders (`↻ ⚙ ⌕ ★ ☆ ✕ ⧉ ⋮⋮ ▸ ▾`) — replace
with a real 16px icon set in production.

## Files in this bundle
- `Jenkins Launcher Popup.dc.html` — the design prototype. Open it directly in a browser.
- `support.js` — runtime required by the prototype. Not part of the deliverable.
