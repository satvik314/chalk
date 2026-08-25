// Chalk — content script.
//
// Owns the annotation overlay for one tab: a full-viewport canvas plus a
// draggable frosted-glass toolbar, both inside a closed shadow root so page
// styles can't leak in (and ours can't leak out). Everything is dormant until
// the first toggle; when inactive the host is display:none and the page
// behaves exactly as if Chalk weren't installed.
//
// Rendering model: committed work lives as vector "ops" (strokes / shapes /
// eraser paths / clears) replayed onto an offscreen "base" canvas. The visible
// canvas is always base + the in-progress stroke, so highlighter strokes keep
// a single clean alpha while drawn, undo/redo is exact, and a viewport resize
// just replays the ops.
//
// Coordinates are DOCUMENT space (client + scroll at capture time) and the
// replay transform subtracts the current scroll, so ink stays anchored to the
// content it annotates while the page scrolls — which the cursor tool allows
// without leaving Chalk.

(() => {
  'use strict';
  if (window.__chalkLoaded) return;
  window.__chalkLoaded = true;

  const ACCENT = '#7C5CFF';
  const Z_INDEX = '2147483646';
  const IS_MAC = /Mac|iP/.test(navigator.platform);
  const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';

  const COLORS = [
    { name: 'Crimson', value: '#FF4757' },
    { name: 'Amber', value: '#FFB224' },
    { name: 'Mint', value: '#2ED573' },
    { name: 'Sky', value: '#3D9DF6' },
    { name: 'Chalk', value: '#F4F4F2' },
  ];

  const PEN = { min: 2.0, max: 5.2, start: 3.4 };
  const SIZES = { highlighter: 16, eraser: 30, arrow: 3.5, rect: 3 };
  const HIGHLIGHTER_ALPHA = 0.38;

  // ---------------------------------------------------------------- state
  let built = false;
  let active = false;
  let tool = 'pen';
  let color = COLORS[0].value;
  let ops = [];
  let redoStack = [];
  let live = null; // in-progress stroke
  let raf = 0;
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let lastPage = location.pathname + location.search;

  let host, shadow, canvas, ctx, base, bctx;
  let barWrap, bar, toastEl, flashEl;
  let toastTimer = 0;

  // ------------------------------------------------------------- utilities
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension reloaded under us
    }
  }

  function savePrefs(partial) {
    try {
      chrome.storage.local.get('chalkPrefs', ({ chalkPrefs }) => {
        chrome.storage.local.set({ chalkPrefs: { ...(chalkPrefs || {}), ...partial } });
      });
    } catch {}
  }

  function loadPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('chalkPrefs', ({ chalkPrefs }) => resolve(chalkPrefs || {}));
      } catch {
        resolve({});
      }
    });
  }

  // ---------------------------------------------------------------- icons
  const svg = (paths, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

  const ICONS = {
    logo: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.7" stroke-linecap="round"><path d="M5.5 18.5c3.5-1.2 8-5.4 13-12.5"/></svg>`,
    cursor: svg(`<path d="m4 3.5 7.5 17.5 2.6-7.4 7.4-2.6Z"/>`),
    pen: svg(`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>`),
    highlighter: svg(
      `<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4l8 8Z"/>`
    ),
    arrow: svg(`<line x1="6" y1="18" x2="17" y2="7"/><polyline points="9 7 17 7 17 15"/>`),
    rect: svg(`<rect x="3.5" y="5" width="17" height="14" rx="2.2"/>`),
    eraser: svg(
      `<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>`
    ),
    undo: svg(`<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>`),
    trash: svg(
      `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`
    ),
    camera: svg(
      `<path d="M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5L14.5 4Z"/><circle cx="12" cy="13" r="3"/>`
    ),
    close: svg(`<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>`),
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="${ACCENT}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  };

  // --------------------------------------------------------------- cursors
  function cursorFor(theTool) {
    const enc = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
    if (theTool === 'cursor') return '';
    if (theTool === 'pen') {
      const s = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4.6" fill="${color}" stroke="white" stroke-width="1.6"/></svg>`;
      return `${enc(s)} 8 8, crosshair`;
    }
    if (theTool === 'highlighter') {
      const s = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect x="2" y="6" width="16" height="8" rx="3" fill="${color}" fill-opacity="0.55" stroke="white" stroke-width="1.4"/></svg>`;
      return `${enc(s)} 10 10, crosshair`;
    }
    if (theTool === 'eraser') {
      const d = SIZES.eraser + 4;
      const r = SIZES.eraser / 2;
      const c = d / 2;
      const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${c}" cy="${c}" r="${r}" fill="rgba(255,255,255,0.12)" stroke="rgba(0,0,0,0.55)" stroke-width="1"/><circle cx="${c}" cy="${c}" r="${r - 1.4}" fill="none" stroke="white" stroke-width="1.4"/></svg>`;
      return `${enc(s)} ${c} ${c}, crosshair`;
    }
    // arrow / rect — a fine crosshair with a contrast halo
    const s = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><g stroke="rgba(0,0,0,0.55)" stroke-width="3.2" stroke-linecap="round"><line x1="10" y1="2.5" x2="10" y2="17.5"/><line x1="2.5" y1="10" x2="17.5" y2="10"/></g><g stroke="white" stroke-width="1.5" stroke-linecap="round"><line x1="10" y1="2.5" x2="10" y2="17.5"/><line x1="2.5" y1="10" x2="17.5" y2="10"/></g></svg>`;
    return `${enc(s)} 10 10, crosshair`;
  }

  // ----------------------------------------------------------------- style
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }

    @property --chalk-ang {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }

    .layer {
      position: fixed; inset: 0; z-index: 1;
      touch-action: none;
      user-select: none; -webkit-user-select: none;
    }

    .bar-wrap {
      position: fixed; z-index: 3;
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, Helvetica, Arial, sans-serif;
      font-synthesis: none;
      -webkit-font-smoothing: antialiased;
    }

    .bar {
      position: relative;
      display: flex; align-items: center; gap: 1px;
      padding: 6px;
      border-radius: 20px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0) 42%),
        rgba(21, 21, 26, 0.80);
      backdrop-filter: blur(24px) saturate(1.6);
      -webkit-backdrop-filter: blur(24px) saturate(1.6);
      border: 1px solid rgba(255,255,255,0.10);
      box-shadow:
        0 16px 44px rgba(0,0,0,0.40),
        0 3px 10px rgba(0,0,0,0.28),
        0 0 34px rgba(124, 92, 255, 0.16),
        inset 0 1px 0 rgba(255,255,255,0.07);
      animation: chalk-in 420ms cubic-bezier(0.30, 1.44, 0.42, 1) both;
    }

    /* aurora ring: a slowly-orbiting gradient hairline around the pill */
    .bar::before {
      content: '';
      position: absolute; inset: -1px;
      border-radius: 21px;
      padding: 1.8px;
      background: conic-gradient(from var(--chalk-ang, 0deg),
        rgba(124, 92, 255, 0)    0%,
        rgba(139, 108, 255, 1)   12%,
        rgba(255, 110, 199, 0.95) 26%,
        rgba(255, 178, 36, 0.7)  38%,
        rgba(124, 92, 255, 0)    52%,
        rgba(61, 157, 246, 0)    68%,
        rgba(61, 157, 246, 0.55) 80%,
        rgba(124, 92, 255, 0)    94%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
      animation: chalk-orbit 7s linear infinite;
      pointer-events: none;
    }
    @keyframes chalk-orbit { to { --chalk-ang: 360deg; } }

    .bar-wrap.leaving .bar { animation: chalk-out 150ms ease-in both; }
    .bar-wrap.dragging .bar { transition: none; }
    .bar-wrap.capture-hide { visibility: hidden; }

    @keyframes chalk-in {
      from { opacity: 0; transform: translateY(16px) scale(0.90); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes chalk-out {
      to { opacity: 0; transform: translateY(8px) scale(0.96); }
    }

    /* staggered pop-in of the bar's contents on each activation */
    .bar-wrap.enter .bar > * {
      animation: chalk-item-in 360ms cubic-bezier(0.34, 1.6, 0.5, 1) both;
      animation-delay: calc(var(--i, 0) * 20ms + 60ms);
    }
    @keyframes chalk-item-in {
      from { opacity: 0; transform: translateY(7px) scale(0.6); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .logo {
      width: 29px; height: 29px;
      margin: 2px 6px 2px 3px;
      border-radius: 50%;
      display: grid; place-items: center;
      background: linear-gradient(135deg, #8D70FF 20%, #B96BF5 65%, #FF6EC7);
      box-shadow: 0 2px 12px rgba(154, 92, 255, 0.55), inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 4px rgba(0,0,0,0.15);
      cursor: grab;
      flex: none;
      transition: transform 200ms cubic-bezier(0.34, 1.8, 0.5, 1), box-shadow 200ms ease;
    }
    .logo:hover { transform: scale(1.1) rotate(-6deg); box-shadow: 0 3px 18px rgba(154,92,255,0.7), inset 0 1px 0 rgba(255,255,255,0.35); }
    .logo svg { width: 17px; height: 17px; display: block; }
    .bar-wrap.dragging .logo, .bar-wrap.dragging .bar { cursor: grabbing; }

    .bar button {
      position: relative;
      appearance: none; border: 0; background: transparent;
      width: 34px; height: 34px;
      border-radius: 11px;
      display: grid; place-items: center;
      color: rgba(238, 238, 246, 0.68);
      cursor: pointer;
      transition:
        background 150ms ease,
        color 150ms ease,
        box-shadow 200ms ease,
        transform 180ms cubic-bezier(0.34, 1.8, 0.5, 1);
    }
    .bar button:hover { background: rgba(255,255,255,0.085); color: #fff; transform: translateY(-1px); }
    .bar button:active { transform: scale(0.90); }
    .bar button svg { width: 18px; height: 18px; display: block; }

    .bar button.on {
      background: linear-gradient(180deg, #8D70FF, #6C4DF2);
      color: #fff;
      box-shadow:
        0 2px 14px rgba(124, 92, 255, 0.55),
        inset 0 1px 0 rgba(255,255,255,0.28);
    }
    .bar button.on:hover { background: linear-gradient(180deg, #9379FF, #7354F6); transform: none; }
    .bar button.on svg { animation: chalk-pop 340ms cubic-bezier(0.34, 1.8, 0.5, 1) both; }
    @keyframes chalk-pop {
      0%   { transform: scale(0.7) rotate(-8deg); }
      55%  { transform: scale(1.22) rotate(3deg); }
      100% { transform: scale(1.06) rotate(0deg); }
    }

    .divider {
      width: 1px; height: 21px;
      background: rgba(255,255,255,0.10);
      margin: 0 5px;
      flex: none;
    }

    .swatches { display: flex; align-items: center; gap: 8px; padding: 0 5px; }
    .swatch {
      appearance: none; border: 0; padding: 0;
      width: 19px !important; height: 19px !important;
      border-radius: 50% !important;
      cursor: pointer;
      position: relative;
      box-shadow: inset 0 0 0 1.2px rgba(255,255,255,0.22), inset 0 -2px 3px rgba(0,0,0,0.18);
      transition: transform 180ms cubic-bezier(0.34, 1.8, 0.5, 1), box-shadow 180ms ease;
    }
    .swatch:hover { transform: scale(1.22); }
    .swatch:active { transform: scale(1.02); }
    .swatch.on {
      animation: chalk-drop 380ms cubic-bezier(0.34, 1.7, 0.5, 1) both;
      box-shadow:
        inset 0 0 0 1.2px rgba(255,255,255,0.25),
        0 0 0 2px rgba(21,21,26,0.95),
        0 0 0 3.6px var(--sw),
        0 0 14px var(--sw);
    }
    @keyframes chalk-drop {
      0%   { transform: scale(1); }
      55%  { transform: scale(1.35); }
      100% { transform: scale(1.05); }
    }

    /* tooltips */
    .bar button::after {
      content: attr(data-tip);
      position: absolute;
      bottom: calc(100% + 11px); left: 50%;
      transform: translate(-50%, 3px);
      background: rgba(28, 28, 34, 0.97);
      border: 1px solid rgba(255,255,255,0.09);
      color: rgba(255,255,255,0.92);
      font-size: 11.5px; font-weight: 500; letter-spacing: 0.1px;
      line-height: 1; white-space: nowrap;
      padding: 6px 9px; border-radius: 8px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      opacity: 0; pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .bar button:hover::after {
      opacity: 1; transform: translate(-50%, 0);
      transition-delay: 480ms;
    }
    .bar-wrap.tips-below .bar button::after { bottom: auto; top: calc(100% + 11px); }
    .bar-wrap.dragging .bar button::after { opacity: 0 !important; }
    .swatch::after { display: none; }

    .toast {
      position: fixed; left: 50%; bottom: 30px; z-index: 4;
      transform: translate(-50%, 10px);
      display: flex; align-items: center; gap: 8px;
      padding: 10px 15px;
      border-radius: 13px;
      background: rgba(21, 21, 26, 0.85);
      backdrop-filter: blur(20px) saturate(1.5);
      -webkit-backdrop-filter: blur(20px) saturate(1.5);
      border: 1px solid rgba(255,255,255,0.11);
      box-shadow: 0 12px 34px rgba(0,0,0,0.35);
      color: rgba(255,255,255,0.94);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif;
      font-size: 12.5px; font-weight: 500; letter-spacing: 0.1px;
      opacity: 0; pointer-events: none;
      transition: opacity 220ms ease, transform 220ms cubic-bezier(0.3, 1.4, 0.5, 1);
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .toast.capture-hide { visibility: hidden; }
    .toast svg { width: 14px; height: 14px; }

    .flash {
      position: fixed; inset: 0; z-index: 2;
      background: #fff; opacity: 0; pointer-events: none;
      transition: opacity 340ms ease-out;
    }
  `;

  // ----------------------------------------------------------------- build
  function build() {
    if (built) return;
    built = true;

    // @property inside a shadow stylesheet doesn't register the custom
    // property, which would leave the aurora ring's conic-gradient invalid —
    // register it document-wide so the angle actually interpolates
    try {
      CSS.registerProperty({
        name: '--chalk-ang',
        syntax: '<angle>',
        initialValue: '0deg',
        inherits: false,
      });
    } catch {} // already registered, or unsupported — the 0deg fallback holds

    host = document.createElement('chalk-overlay');
    host.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX};display:none;pointer-events:none;`;
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    canvas = document.createElement('canvas');
    canvas.className = 'layer';
    canvas.style.pointerEvents = 'auto';
    shadow.appendChild(canvas);
    ctx = canvas.getContext('2d');

    base = document.createElement('canvas');
    bctx = base.getContext('2d');

    flashEl = document.createElement('div');
    flashEl.className = 'flash';
    shadow.appendChild(flashEl);

    barWrap = document.createElement('div');
    barWrap.className = 'bar-wrap';
    barWrap.innerHTML = `
      <div class="bar" part="bar">
        <div class="logo" title="">${ICONS.logo}</div>
        <button data-tool="cursor" data-tip="Interact · V">${ICONS.cursor}</button>
        <button data-tool="pen" data-tip="Pen · P">${ICONS.pen}</button>
        <button data-tool="highlighter" data-tip="Highlighter · H">${ICONS.highlighter}</button>
        <button data-tool="arrow" data-tip="Arrow · A">${ICONS.arrow}</button>
        <button data-tool="rect" data-tip="Rectangle · R">${ICONS.rect}</button>
        <button data-tool="eraser" data-tip="Eraser · E">${ICONS.eraser}</button>
        <div class="divider"></div>
        <div class="swatches">
          ${COLORS.map(
            (c, i) =>
              `<button class="swatch" data-color="${c.value}" data-tip="${c.name} · ${i + 1}" style="--sw:${c.value};background:${c.value}"></button>`
          ).join('')}
        </div>
        <div class="divider"></div>
        <button data-act="undo" data-tip="Undo · ${MOD_LABEL}Z">${ICONS.undo}</button>
        <button data-act="clear" data-tip="Clear all">${ICONS.trash}</button>
        <button data-act="snapshot" data-tip="Save snapshot">${ICONS.camera}</button>
        <div class="divider"></div>
        <button data-act="close" data-tip="Done · Esc">${ICONS.close}</button>
      </div>`;
    shadow.appendChild(barWrap);
    bar = barWrap.querySelector('.bar');
    // stagger indices for the entrance animation
    Array.from(bar.children).forEach((el, i) => el.style.setProperty('--i', i));

    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    shadow.appendChild(toastEl);

    (document.documentElement || document.body).appendChild(host);

    wireToolbar();
    wireCanvas();
    wireDrag();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKeyDown, true);
    watchPageChanges();
  }

  // ------------------------------------------------------------- lifecycle
  async function activate() {
    build();
    if (active) return;
    active = true;
    ensureCanvasSize();

    const prefs = await loadPrefs();
    if (prefs.tool && bar.querySelector(`[data-tool="${prefs.tool}"]`)) tool = prefs.tool;
    if (prefs.color && COLORS.some((c) => c.value === prefs.color)) color = prefs.color;
    if (tool === 'cursor') tool = 'pen'; // activation means "I want to draw"

    host.style.display = 'block';
    barWrap.classList.remove('leaving');
    // retrigger the entrance animations
    barWrap.classList.remove('enter');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
    barWrap.classList.add('enter');

    reflectTool();
    reflectColor();
    placeToolbar(prefs.barPos);
    rebuildBase();
    render();

    try {
      const el = document.activeElement;
      if (el && el !== document.body && typeof el.blur === 'function') el.blur();
    } catch {}

    send({ type: 'chalk:state', active: true });
  }

  function deactivate() {
    if (!active) return;
    active = false;
    cancelLive();
    barWrap.classList.add('leaving');
    const wrap = barWrap;
    setTimeout(() => {
      if (!active) host.style.display = 'none';
      wrap.classList.remove('leaving');
    }, 150);
    send({ type: 'chalk:state', active: false });
  }

  function toggle() {
    active ? deactivate() : activate();
    return active;
  }

  // ---------------------------------------------------- page-change watcher
  // A full navigation resets this script anyway; this catches SPA route
  // changes (history API) so drawings from one "page" never haunt the next.
  function watchPageChanges() {
    const check = () => {
      const page = location.pathname + location.search;
      if (page === lastPage) return;
      lastPage = page;
      if (ops.length || live) {
        live = null;
        ops = [];
        redoStack = [];
        rebuildBase();
        render();
        if (active) toast(`<span>New page — drawings cleared</span>`);
      }
    };
    window.addEventListener('popstate', check);
    setInterval(check, 600); // pushState from the page world is invisible here
  }

  // ------------------------------------------------------------ canvas mgmt
  function ensureCanvasSize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      base.width = pw;
      base.height = ph;
      rebuildBase();
    }
  }

  let resizeRaf = 0;
  function onResize() {
    if (!built) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      ensureCanvasSize();
      clampToolbar();
      render();
    });
  }

  let scrollRaf = 0;
  function onScroll() {
    if (!built || !active) return;
    cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(() => {
      rebuildBase();
      render();
    });
  }

  // ------------------------------------------------------------- draw ops
  // Ops are stored in document coordinates; this maps them to the viewport.
  function xform(c) {
    c.setTransform(dpr, 0, 0, dpr, -window.scrollX * dpr, -window.scrollY * dpr);
  }

  function docPoint(e) {
    return { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
  }

  function drawOp(c, op) {
    c.save();
    xform(c);
    c.lineCap = 'round';
    c.lineJoin = 'round';

    if (op.type === 'clear') {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, base.width, base.height);
    } else if (op.tool === 'pen') {
      drawPen(c, op);
    } else if (op.tool === 'highlighter') {
      drawHighlighter(c, op);
    } else if (op.tool === 'eraser') {
      drawEraserPath(c, op, 0);
    } else if (op.tool === 'arrow') {
      drawArrow(c, op);
    } else if (op.tool === 'rect') {
      drawRect(c, op);
    }
    c.restore();
  }

  function drawPen(c, op) {
    const pts = op.points;
    c.strokeStyle = op.color;
    c.fillStyle = op.color;
    if (pts.length === 1) {
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, Math.max(1, pts[0].w / 2), 0, Math.PI * 2);
      c.fill();
      return;
    }
    // midpoint quadratics, each short segment stroked at its own width for a
    // pressure-like taper driven by drawing speed
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    c.lineTo(mid(pts[0], pts[1]).x, mid(pts[0], pts[1]).y);
    c.lineWidth = pts[0].w;
    c.stroke();
    for (let i = 1; i < pts.length - 1; i++) {
      const m1 = mid(pts[i - 1], pts[i]);
      const m2 = mid(pts[i], pts[i + 1]);
      c.beginPath();
      c.moveTo(m1.x, m1.y);
      c.quadraticCurveTo(pts[i].x, pts[i].y, m2.x, m2.y);
      c.lineWidth = pts[i].w;
      c.stroke();
    }
    const last = pts[pts.length - 1];
    const m = mid(pts[pts.length - 2], last);
    c.beginPath();
    c.moveTo(m.x, m.y);
    c.lineTo(last.x, last.y);
    c.lineWidth = last.w;
    c.stroke();
  }

  function drawHighlighter(c, op) {
    const pts = op.points;
    // one path + one stroke() => a single uniform layer of alpha per stroke,
    // so a stroke never darkens itself; 'multiply' lets separate strokes
    // layer like real marker ink instead of going muddy
    c.globalAlpha = HIGHLIGHTER_ALPHA;
    c.globalCompositeOperation = 'multiply';
    c.strokeStyle = op.color;
    c.lineWidth = op.size;
    c.beginPath();
    if (pts.length === 1) {
      c.moveTo(pts[0].x, pts[0].y);
      c.lineTo(pts[0].x + 0.01, pts[0].y);
    } else {
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      c.lineTo(last.x, last.y);
    }
    c.stroke();
  }

  function drawEraserPath(c, op, fromIndex) {
    const pts = op.points;
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = '#000';
    c.fillStyle = '#000';
    c.lineWidth = op.size;
    if (pts.length === 1) {
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, op.size / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.beginPath();
    const start = Math.max(0, fromIndex - 1);
    c.moveTo(pts[start].x, pts[start].y);
    for (let i = start + 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.stroke();
  }

  function drawArrow(c, op) {
    const { x: x1, y: y1 } = op.start;
    const { x: x2, y: y2 } = op.end;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 2) return;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = clamp(op.size * 3 + len * 0.06, 11, 24);
    const spread = 0.46;

    c.strokeStyle = op.color;
    c.fillStyle = op.color;
    c.lineWidth = op.size;

    // shaft stops short of the tip so the head stays crisp
    const bx = x2 - Math.cos(angle) * head * 0.72;
    const by = y2 - Math.sin(angle) * head * 0.72;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(bx, by);
    c.stroke();

    c.beginPath();
    c.moveTo(x2, y2);
    c.lineTo(x2 - Math.cos(angle - spread) * head, y2 - Math.sin(angle - spread) * head);
    c.lineTo(x2 - Math.cos(angle + spread) * head, y2 - Math.sin(angle + spread) * head);
    c.closePath();
    c.fill();
    c.lineWidth = op.size * 0.8;
    c.stroke();
  }

  function drawRect(c, op) {
    const x = Math.min(op.start.x, op.end.x);
    const y = Math.min(op.start.y, op.end.y);
    const w = Math.abs(op.end.x - op.start.x);
    const h = Math.abs(op.end.y - op.start.y);
    if (w < 2 && h < 2) return;
    c.strokeStyle = op.color;
    c.lineWidth = op.size;
    c.beginPath();
    c.roundRect(x, y, w, h, Math.min(3, w / 2, h / 2));
    c.stroke();
  }

  function rebuildBase() {
    if (!bctx) return;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, base.width, base.height);
    for (const op of ops) drawOp(bctx, op);
    // a live eraser stroke has already hit the base; re-apply it so a
    // mid-stroke scroll or resize doesn't resurrect erased ink
    if (live && live.tool === 'eraser') drawOp(bctx, live);
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    if (live && live.tool !== 'eraser') drawOp(ctx, live);
  }

  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }

  // ------------------------------------------------------------- history
  function commit(op) {
    ops.push(op);
    redoStack = [];
    if (op.tool !== 'eraser') drawOp(bctx, op); // eraser already applied live
    render();
  }

  function undo() {
    if (live || !ops.length) return;
    redoStack.push(ops.pop());
    rebuildBase();
    render();
  }

  function redo() {
    if (live || !redoStack.length) return;
    ops.push(redoStack.pop());
    rebuildBase();
    render();
  }

  function clearAll() {
    if (live) return;
    if (!ops.length || ops[ops.length - 1].type === 'clear') return;
    ops.push({ type: 'clear' });
    redoStack = [];
    rebuildBase();
    render();
  }

  // -------------------------------------------------------------- pointer
  function wireCanvas() {
    canvas.addEventListener('pointerdown', (e) => {
      if (!active || e.button !== 0 || tool === 'cursor') return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const p = docPoint(e);

      if (tool === 'pen') {
        live = {
          tool,
          color,
          points: [{ x: p.x, y: p.y, w: PEN.start, t: e.timeStamp }],
        };
      } else if (tool === 'highlighter') {
        live = { tool, color, size: SIZES.highlighter, points: [{ ...p }] };
      } else if (tool === 'eraser') {
        live = { tool, size: SIZES.eraser, points: [{ ...p }] };
        bctx.save();
        xform(bctx);
        bctx.lineCap = 'round';
        bctx.lineJoin = 'round';
        drawEraserPath(bctx, live, 0);
        bctx.restore();
      } else {
        live = { tool, color, size: SIZES[tool], start: { ...p }, end: { ...p } };
      }
      scheduleRender();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!active || !live) return;
      e.preventDefault();
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) addLivePoint(ev);
      scheduleRender();
    });

    const finish = (e) => {
      if (!live) return;
      if (e) addLivePoint(e);
      const op = live;
      live = null;
      if (op.tool === 'eraser') {
        commit(op);
      } else if (op.points || dragMoved(op)) {
        commit(op);
      } else {
        render();
      }
    };
    const dragMoved = (op) =>
      op.start && (Math.abs(op.end.x - op.start.x) > 2 || Math.abs(op.end.y - op.start.y) > 2);

    canvas.addEventListener('pointerup', (e) => finish(e));
    canvas.addEventListener('pointercancel', () => finish(null));
  }

  function addLivePoint(e) {
    const { x, y } = docPoint(e);
    if (live.tool === 'pen') {
      const pts = live.points;
      const prev = pts[pts.length - 1];
      const dt = Math.max(1, (e.timeStamp || prev.t + 8) - prev.t);
      const dist = Math.hypot(x - prev.x, y - prev.y);
      if (dist < 0.6) return;
      // slow, deliberate strokes press wide; fast flicks thin out
      const speed = dist / dt; // px per ms
      const target = PEN.max - (PEN.max - PEN.min) * clamp(speed / 1.4, 0, 1);
      const w = prev.w + (target - prev.w) * 0.3;
      pts.push({ x, y, w, t: e.timeStamp || prev.t + dt });
    } else if (live.tool === 'highlighter') {
      const prev = live.points[live.points.length - 1];
      if (Math.hypot(x - prev.x, y - prev.y) < 1.2) return;
      live.points.push({ x, y });
    } else if (live.tool === 'eraser') {
      const prev = live.points[live.points.length - 1];
      if (Math.hypot(x - prev.x, y - prev.y) < 1.2) return;
      const from = live.points.length;
      live.points.push({ x, y });
      bctx.save();
      xform(bctx);
      bctx.lineCap = 'round';
      bctx.lineJoin = 'round';
      drawEraserPath(bctx, live, from);
      bctx.restore();
    } else {
      live.end = { x, y };
    }
  }

  function cancelLive() {
    if (!live) return;
    if (live.tool === 'eraser') {
      // the erase already hit the base; keep it honest by committing
      commit(live);
      live = null;
      return;
    }
    live = null;
    render();
  }

  // -------------------------------------------------------------- toolbar
  function reflectTool() {
    for (const b of bar.querySelectorAll('[data-tool]')) {
      b.classList.toggle('on', b.dataset.tool === tool);
    }
    // the cursor tool lets pointer events fall through to the page, so the
    // teacher can scroll and click while the ink stays on screen
    canvas.style.pointerEvents = tool === 'cursor' ? 'none' : 'auto';
    canvas.style.cursor = cursorFor(tool);
  }

  function reflectColor() {
    for (const b of bar.querySelectorAll('[data-color]')) {
      b.classList.toggle('on', b.dataset.color === color);
    }
    if (tool === 'pen' || tool === 'highlighter') canvas.style.cursor = cursorFor(tool);
  }

  function setTool(t) {
    tool = t;
    reflectTool();
    if (t !== 'cursor') savePrefs({ tool: t }); // never wake up in cursor mode
  }

  function setColor(v) {
    color = v;
    reflectColor();
    savePrefs({ color: v });
  }

  function wireToolbar() {
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.tool) setTool(btn.dataset.tool);
      else if (btn.dataset.color) setColor(btn.dataset.color);
      else if (btn.dataset.act === 'undo') undo();
      else if (btn.dataset.act === 'clear') clearAll();
      else if (btn.dataset.act === 'snapshot') snapshot();
      else if (btn.dataset.act === 'close') deactivate();
    });
    // keep clicks inside the toolbar from ever reaching the page
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // ------------------------------------------------------------- dragging
  function placeToolbar(saved) {
    requestAnimationFrame(() => {
      const bw = barWrap.offsetWidth;
      const bh = barWrap.offsetHeight;
      let x, y;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        x = saved.x;
        y = saved.y;
      } else {
        x = (window.innerWidth - bw) / 2;
        y = window.innerHeight - bh - 26;
      }
      x = clamp(x, 8, Math.max(8, window.innerWidth - bw - 8));
      y = clamp(y, 8, Math.max(8, window.innerHeight - bh - 8));
      barWrap.style.left = x + 'px';
      barWrap.style.top = y + 'px';
      barWrap.classList.toggle('tips-below', y < 64);
    });
  }

  function clampToolbar() {
    if (!barWrap.style.left) return;
    const bw = barWrap.offsetWidth;
    const bh = barWrap.offsetHeight;
    const x = clamp(parseFloat(barWrap.style.left), 8, Math.max(8, window.innerWidth - bw - 8));
    const y = clamp(parseFloat(barWrap.style.top), 8, Math.max(8, window.innerHeight - bh - 8));
    barWrap.style.left = x + 'px';
    barWrap.style.top = y + 'px';
    barWrap.classList.toggle('tips-below', y < 64);
  }

  function wireDrag() {
    let dragging = false;
    let offX = 0;
    let offY = 0;

    bar.addEventListener('pointerdown', (e) => {
      const onGrip = e.target.closest('.logo');
      const onControl = e.target.closest('button');
      if (!onGrip && (onControl || !e.target.closest('.bar'))) return;
      if (e.button !== 0) return;
      dragging = true;
      const r = barWrap.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      barWrap.classList.add('dragging');
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const bw = barWrap.offsetWidth;
      const bh = barWrap.offsetHeight;
      const x = clamp(e.clientX - offX, 8, Math.max(8, window.innerWidth - bw - 8));
      const y = clamp(e.clientY - offY, 8, Math.max(8, window.innerHeight - bh - 8));
      barWrap.style.left = x + 'px';
      barWrap.style.top = y + 'px';
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      barWrap.classList.remove('dragging');
      const x = parseFloat(barWrap.style.left);
      const y = parseFloat(barWrap.style.top);
      barWrap.classList.toggle('tips-below', y < 64);
      savePrefs({ barPos: { x, y } });
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
  }

  // ------------------------------------------------------------- keyboard
  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (!active) return;

    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      deactivate();
      return;
    }
    if (isEditable(document.activeElement)) return; // typing in the page (cursor mode)
    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.stopPropagation();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      e.stopPropagation();
      redo();
      return;
    }

    if (mod || e.altKey) return;
    const k = e.key.toLowerCase();
    const toolKeys = { v: 'cursor', p: 'pen', h: 'highlighter', a: 'arrow', r: 'rect', e: 'eraser' };
    if (toolKeys[k]) {
      e.preventDefault();
      e.stopPropagation();
      setTool(toolKeys[k]);
      return;
    }
    const idx = parseInt(e.key, 10);
    if (idx >= 1 && idx <= COLORS.length) {
      e.preventDefault();
      e.stopPropagation();
      setColor(COLORS[idx - 1].value);
    }
  }

  // -------------------------------------------------------------- snapshot
  async function snapshot() {
    if (live) return;
    barWrap.classList.add('capture-hide');
    toastEl.classList.add('capture-hide');
    // let the hide actually paint before the capture
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 60));

    const res = await send({ type: 'chalk:capture' });

    barWrap.classList.remove('capture-hide');
    toastEl.classList.remove('capture-hide');

    if (res && res.ok) {
      flashEl.style.transition = 'none';
      flashEl.style.opacity = '0.28';
      void flashEl.offsetWidth;
      flashEl.style.transition = '';
      flashEl.style.opacity = '0';
      toast(`${ICONS.check}<span>Snapshot saved to Downloads</span>`);
    } else {
      toast(`<span>Couldn’t save the snapshot</span>`);
    }
  }

  function toast(html) {
    toastEl.innerHTML = html;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  // ------------------------------------------------------------- messaging
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'chalk:toggle') {
        sendResponse({ ok: true, active: toggle() });
      } else if (msg?.type === 'chalk:ping') {
        sendResponse({ ok: true, active });
      }
      return false;
    });
  } catch {
    // extension context gone; nothing to do
  }
})();
