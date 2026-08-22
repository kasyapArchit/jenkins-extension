// Lucide (ISC) path data, inlined so the popup ships no network requests and
// no icon font. Default 16px at stroke 1.75 as the handoff specifies.

const PATHS = {
  'refresh-cw': ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5',
                 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'],
  search: ['M21 21l-4.34-4.34'],
  star: ['M11.53 2.3a.53.53 0 0 1 .95 0l2.42 4.9 5.41.79a.53.53 0 0 1 .29.9l-3.91 3.82.92 5.39a.53.53 0 0 1-.76.56L12 16.11l-4.84 2.55a.53.53 0 0 1-.77-.56l.93-5.39-3.92-3.82a.53.53 0 0 1 .3-.9l5.4-.79z'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  copy: ['M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  check: ['M20 6 9 17l-5-5'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'external-link': ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  'alert-triangle': ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z',
                     'M12 9v4', 'M12 17h.01']
};

// Shapes that are not plain paths.
const EXTRAS = {
  search: '<circle cx="11" cy="11" r="8"/>',
  settings: '<circle cx="12" cy="12" r="3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>',
  grip: [1, 2].flatMap(c => [5, 12, 19].map(y =>
    `<circle cx="${c === 1 ? 9 : 15}" cy="${y}" r="1"/>`)).join('')
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 16, stroke = 1.75, fill = false, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', fill ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', stroke);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);

  const inner = (PATHS[name] || []).map(d => `<path d="${d}"/>`).join('') + (EXTRAS[name] || '');
  svg.innerHTML = name === 'grip' ? EXTRAS.grip : inner;
  if (name === 'grip') svg.setAttribute('fill', 'currentColor');
  return svg;
}
