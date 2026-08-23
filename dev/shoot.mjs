// Drives headless Chrome over the DevTools protocol directly rather than
// through `chrome --screenshot`, for two things that flag cannot do:
//
// - Force prefers-color-scheme. No stable command-line switch does this
//   reliably (--force-dark-mode auto-darkens content with no dark theme of
//   its own, which is a different feature); Emulation.setEmulatedMedia is
//   the actual mechanism DevTools and Puppeteer use.
// - Wait for the page's own shotReady flag instead of a fixed virtual-time
//   budget, so a slow or fast render is timed exactly rather than guessed.
//
// Usage: node dev/shoot.mjs <url> <outFile> <width> <height> <light|dark>

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , url, out, widthArg, heightArg, scheme = 'light'] = process.argv;
const width = Number(widthArg) || 400;
const height = Number(heightArg) || 640;

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A fresh profile dir every run, so a prior shot's killed-not-quit Chrome can
// never leave a SingletonLock that blocks this one from starting.
const profileDir = mkdtempSync(join(tmpdir(), 'jq-shot-'));

let nextId = 1;
function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify(payload));
  });
}

async function waitForDevtools(port, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome DevTools endpoint never came up.');
}

const port = 9500 + Math.floor(Math.random() * 900);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${port}`,
  'about:blank',
], { stdio: 'ignore' });

try {
  const version = await waitForDevtools(port);
  const browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browserWs.addEventListener('open', resolve, { once: true });
    browserWs.addEventListener('error', reject, { once: true });
  });

  const { targetId } = await send(browserWs, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(browserWs, 'Target.attachToTarget', { targetId, flatten: true });

  await send(browserWs, 'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send(browserWs, 'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
  await send(browserWs, 'Page.navigate', { url }, sessionId);

  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    const { result } = await send(browserWs, 'Runtime.evaluate',
      { expression: 'document.documentElement.dataset.shotReady === "1"', returnByValue: true },
      sessionId);
    if (result.value) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    console.error(`  warning: ${out} — shotReady never set, screenshot may be incomplete`);
  }

  // shotReady flips the instant the DOM is right, but the compositor paints a
  // frame or two behind script execution — captureScreenshot taken right on
  // the flag caught the view mid-swap (search results in the DOM, browse
  // mode still on screen). One settle tick closes that gap.
  await new Promise((r) => setTimeout(r, 300));

  const { data } = await send(browserWs, 'Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(out, Buffer.from(data, 'base64'));

  // Asked to close rather than just closing our socket, so Chrome has let go
  // of the profile directory's lock files before rmSync below runs.
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  await send(browserWs, 'Browser.close').catch(() => {});
  browserWs.close();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
} finally {
  chrome.kill();
  // Scratch directory; a leftover lock file from a slow exit is not worth
  // failing the whole run over.
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
