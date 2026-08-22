// Display helpers with no DOM or chrome dependency, so the service worker can
// use them for notification text as well as the popup for rendering.

// "Webmail/QA" rather than a bare "QA". Uses the immediate parent folder, which
// is the part that tells apart the several folders that each contain a job
// called QA. Jobs sitting at the controller root keep their bare name.
export function qualifiedName(fullName, name) {
  const parts = String(fullName || '').split('/').filter(Boolean);
  if (parts.length < 2) return name || parts[0] || '';
  return `${parts[parts.length - 2]}/${name || parts[parts.length - 1]}`;
}
