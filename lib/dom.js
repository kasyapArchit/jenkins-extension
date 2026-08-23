export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style") node.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node[k] = v;
  }
  for (const c of [].concat(children))
    if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

export function clear(node) {
  node.textContent = "";
  return node;
}

/* ---------- time formatting ---------- */

export function elapsed(sinceMs) {
  const t = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  const m = Math.floor(t / 60);
  if (m < 60) return m > 0 ? `${m}m ${t % 60}s` : `${t}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
