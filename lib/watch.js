// What to say about a subscribed pipeline on a given poll, and whether it is
// still worth saying. DOM-free and chrome-free so it can be tested directly.
//
// A subscription watches builds the extension did not start: someone else's
// deploy, a webhook, a nightly. All we get is the job's latest build, so every
// decision comes from comparing it with what we saw last time.

// Anything that finished more than this long ago is history rather than news.
export const STALE_MS = 2 * 60 * 1000;

// Jenkins reports building:false with result:null for a moment at the end of a
// build. Treating that as a finish would announce a failure that never happened,
// so a build counts as over only once it has a verdict.
const settled = build => !build.building && build.result != null;

const finishedKind = build => (build.result === 'SUCCESS' ? 'deployed' : 'failed');

// Returns { kind, mark, build }. kind is null when there is nothing to announce,
// and the caller still stores mark: the watermark advances whether or not a
// notification goes out, so a suppressed event is not re-announced forever.
//
// At most one event per poll. If a build both started and finished inside one
// interval we report the finish and skip the start, because "it started" is not
// news about something already over. Builds skipped entirely between polls are
// not reported at all; only the newest one is.
export function nextEvent(prev, build) {
  if (!build || build.number == null) return null;
  const mark = { number: build.number, building: !settled(build) };

  // First sight of a pipeline. Recording it silently is the point: otherwise
  // subscribing would immediately announce whatever happened to run last.
  if (!prev) return { kind: null, mark };

  if (build.number > prev.number) {
    return { kind: settled(build) ? finishedKind(build) : 'started', mark, build };
  }
  if (build.number === prev.number && prev.building && settled(build)) {
    return { kind: finishedKind(build), mark, build };
  }
  return { kind: null, mark };
}

// When the thing being announced actually happened, which is not when we noticed
// it. Jenkins gives the start; the end is start plus duration.
export function eventTime(build, kind) {
  const start = build?.timestamp || 0;
  return kind === 'started' ? start : start + (build?.duration || 0);
}

// The case this exists for: Chrome was shut, or the VPN was down, and the first
// poll after coming back finds three finished builds to shout about. None of
// them are news by then.
export const isStale = (at, now = Date.now(), staleMs = STALE_MS) => now - at > staleMs;

export const NOTIFY_ON_DEFAULTS = { triggered: false, deployed: true, failed: true };

// The settings key an event answers to. 'started' reads better in code; the
// setting is worded as "triggered" because that is what the button says.
const SETTING_FOR = { started: 'triggered', deployed: 'deployed', failed: 'failed' };

export function wants(kind, notifyOn) {
  const on = { ...NOTIFY_ON_DEFAULTS, ...(notifyOn || {}) };
  return Boolean(on[SETTING_FOR[kind]]);
}

// At least one kind has to stay on, or a subscription is a thing that does
// nothing. Settings enforces it by disabling the last one still checked; this is
// the same rule where the notification is actually sent.
export const anyWanted = notifyOn =>
  ['started', 'deployed', 'failed'].some(k => wants(k, notifyOn));
