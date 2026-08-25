#!/usr/bin/env node
// Regenerates the README screenshots in assets/.
//
// Loads the unpacked extension into headless Chromium, drives the real
// toolbar with real pointer and keyboard input, and captures the result —
// so every image in the README is the actual extension running, never a
// mockup. Playwright is the only dependency and it is only needed here:
//
//   npm i playwright && node tools/shots.mjs
//
// The toolbar's position and expanded/compressed state are seeded through
// chrome.storage (the same prefs Chalk saves for you), and drawing mode is
// switched on by messaging the service worker the way the action button does.

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'chalk-')), {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const page = ctx.pages()[0] || (await ctx.newPage());

const prefs = (p) => sw.evaluate((p) => chrome.storage.local.set({ chalkPrefs: p }), p);

async function toggle() {
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'chalk:toggle' });
  });
  await page.waitForTimeout(1100);
}

async function stroke(points, steps = 10) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

const ellipse = (cx, cy, rx, ry, n = 44, from = -0.4) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = from + (i / n) * Math.PI * 2.08;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });

const key = async (k) => {
  await page.keyboard.press(k);
  await page.waitForTimeout(120);
};

// ---------------------------------------------- teaching from an article
await page.goto('https://en.wikipedia.org/wiki/Photosynthesis', { waitUntil: 'load' });
await page.waitForTimeout(1500);
await prefs({ compact: false, tool: 'pen', color: '#c8452f' });
await toggle();

await key('h'); await key('2'); // amber highlighter over the definition
await stroke([[499, 334], [604, 334]]);
await stroke([[264, 360], [556, 360]]);
await stroke([[264, 386], [318, 386]]);

await key('r'); await key('3'); // green box around the input
await stroke([[645, 424], [748, 479]]);

await key('a'); await key('4'); // blue arrow from the text to the diagram
await stroke([[624, 338], [757, 322]]);

await key('p'); await key('1'); // brick circle around the output
await stroke(ellipse(963, 410, 72, 28));

await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'hero.png') });
await key('Escape');
await page.waitForTimeout(300);

// --------------------------------------------- walking through some code
await page.goto('https://github.com/satvik314/chalk/blob/main/background.js', { waitUntil: 'load' });
await page.waitForTimeout(3500);
await prefs({ compact: true, tool: 'pen', color: '#c8452f', barPos: { x: 990, y: 690 } });
await toggle();

await key('h'); await key('2');
await stroke([[432, 512], [995, 512]]);
await key('p'); await key('1');
await stroke(ellipse(541, 572, 118, 20));
await key('r'); await key('4');
await stroke([[424, 618], [878, 782]]);

await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'code-review.png') });
await key('Escape');
await page.waitForTimeout(300);

// ------------------------------------------------ the toolbar, both modes
await page.goto('https://example.com/', { waitUntil: 'load' });
await page.waitForTimeout(700);
await prefs({ compact: false, tool: 'pen', color: '#c8452f', barPos: { x: 80, y: 260 } });
await toggle();
await page.screenshot({
  path: join(OUT, 'toolbar.png'),
  clip: { x: 72, y: 252, width: 616, height: 98 },
});
await key('Escape');
await page.waitForTimeout(400);

await prefs({ compact: true, tool: 'pen', color: '#c8452f', barPos: { x: 80, y: 260 } });
await toggle();
await page.screenshot({
  path: join(OUT, 'toolbar-compact.png'),
  clip: { x: 72, y: 252, width: 262, height: 98 },
});

console.log(`wrote hero.png, code-review.png, toolbar.png, toolbar-compact.png to ${OUT}`);
await ctx.close();
