// Which pipelines may not be triggered from the extension, and why.
//
// Two independent sources. A pipeline can be blocked by hand, one at a time,
// from the lock beside its name; or by a pattern in settings, which covers
// pipelines you have not starred and ones that do not exist yet. Neither can
// override the other: a match from either side blocks.
//
// DOM-free and chrome-free, so the service worker can enforce the same rule the
// popup draws. The worker is the one that matters. The popup only removes the
// button; the worker refuses the request.

// Patterns are stored as written and compiled on use, so a typo in one pattern
// cannot take the rest down with it. Case-insensitive and unanchored: a pattern
// is a search over the pipeline's full path, not a whole-string match.
export function compileDeny(patterns) {
  const out = [];
  for (const source of patterns || []) {
    const text = String(source).trim();
    if (!text) continue;
    try {
      out.push({ source: text, re: new RegExp(text, "i") });
    } catch {
      // Skipped rather than thrown: settings validates on save, and a bad
      // pattern arriving from sync should not stop the good ones working.
    }
  }
  return out;
}

// Anything with a full path and an id. Falls back to the name when a search hit
// has no path, so a root-level job is still matchable.
const pathOf = (p) => String(p?.fullName || p?.name || "");

// Null when the pipeline may be triggered. Otherwise a short phrase naming the
// reason, written to be read at the end of "cannot be triggered: ...".
export function blockReason(pipeline, { blocked = [], patterns = [] } = {}) {
  if (!pipeline) return null;
  if (blocked.includes(pipeline.id)) return "blocked by hand";
  const hit = compileDeny(patterns).find((p) => p.re.test(pathOf(pipeline)));
  return hit ? `blocked by the pattern ${hit.source}` : null;
}

// True when the block came from settings, which the lock in the popup cannot
// lift. Unlocking a pattern-blocked pipeline from the card it appears on would
// make the deny-list advisory, which is the opposite of its purpose.
export const isPatternBlock = (reason) =>
  Boolean(reason) && reason !== "blocked by hand";

// One tooltip sentence, shared by every disabled control that reports a
// block (padlock, Run/Open, Trigger), so the hint to go fix the pattern shows
// up wherever a person hovers rather than only beside the lock. Empty when
// the pipeline isn't blocked, so callers can pass it straight through as a
// title attribute.
export function blockedTitle(reason, action = "") {
  if (!reason) return "";
  const trailer = action ? ` ${action}` : "";
  const hint = isPatternBlock(reason)
    ? " Edit the pattern in settings to lift it."
    : "";
  return `Cannot be triggered — ${reason}.${trailer}${hint}`;
}

// Reports the first pattern that fails to compile, for settings to show against
// the line the user typed. Null when every pattern is usable.
export function firstBadPattern(patterns) {
  for (const source of patterns || []) {
    const text = String(source).trim();
    if (!text) continue;
    try {
      new RegExp(text, "i");
    } catch (err) {
      return { source: text, message: err.message };
    }
  }
  return null;
}
