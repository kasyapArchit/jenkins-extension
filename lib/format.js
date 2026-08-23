// Display helpers with no DOM or chrome dependency, so the service worker can
// use them for notification text as well as the popup for rendering.

// "QA · Webmail" rather than a bare "QA". The job leads, since that is what is
// being scanned for; the immediate parent folder trails as the disambiguator
// between the several folders that each contain a job called QA. Jobs sitting at
// the controller root keep their bare name.
export function qualifiedName(fullName, name) {
  const parts = String(fullName || "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return name || parts[0] || "";
  return `${name || parts[parts.length - 1]} · ${parts[parts.length - 2]}`;
}

// What to print where the build number goes. Jenkins defaults displayName to
// "#N"; a pipeline that sets its own version overwrites it, and that version is
// more useful than the number. Falls back to #N when nothing was set.
export function buildLabel(run) {
  const number = run.build ? `#${run.build}` : "";
  const shown = String(run.displayName || "").trim();
  if (!shown || shown === number) return number;
  return shown;
}
