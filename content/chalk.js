// Chalk — content script.
//
// Owns the annotation overlay for one tab: a full-viewport canvas plus a
// draggable toolbar, both inside a closed shadow root so page styles can't
// leak in (and ours can't leak out). Everything is dormant until the first
// toggle; when inactive the host is display:none and the page behaves
// exactly as if Chalk weren't installed.
//
// Toolbar design: "loud notebook" — a compact cream paper strip with a
// perforated bottom edge, navy ink line icons, the active tool lifted on a
// pastel sticker, blob-shaped swatches, and a handwritten status caption
// naming the current tool and colour. It starts compressed (cursor / pen /
// eraser only) and expands to the full kit on request.
//
// Rendering model: committed work lives as vector "ops" (strokes / shapes /
// eraser paths / clears) replayed onto an offscreen "base" canvas. The
// visible canvas is always base + the in-progress stroke, so highlighter
// strokes keep a single clean alpha while drawn, undo/redo is exact, and a
// viewport resize just replays the ops.
//
// Coordinates are CONTENT space: client + the scroll offset of whatever
// scrolls under the pen at capture time — the document, or an inner scroll
// pane (chat apps, docs sites, IDEs). Each op remembers its anchor and the
// replay transform subtracts that anchor's current scroll, so ink stays glued
// to the content it annotates however the page moves. In drawing modes the
// wheel is forwarded to the pane under the pointer, so you can scroll on and
// keep annotating past the first screenful.

(() => {
  'use strict';
  if (window.__chalkLoaded) return;
  window.__chalkLoaded = true;

  const INK = '#10162e'; // notebook navy — icons, borders, badge
  const PAPER = '#fffdf2';
  const Z_INDEX = '2147483646';

  const COLORS = [
    { name: 'brick', value: '#c8452f' },
    { name: 'amber', value: '#f0a92e' },
    { name: 'green', value: '#2fb672' },
    { name: 'blue', value: '#3b7ff2' },
    { name: 'ink', value: '#10162e' },
  ];
  // each swatch gets its own wonky, hand-cut blob shape
  const BLOBS = [
    '60% 40% 55% 45%/50% 55% 45% 50%',
    '45% 55% 40% 60%/55% 45% 55% 45%',
    '55% 45% 50% 50%/45% 55% 45% 55%',
    '50% 50% 45% 55%/55% 45% 55% 45%',
    '48% 52% 55% 45%/52% 48% 52% 48%',
  ];

  const TOOL_NAMES = {
    cursor: 'interact',
    laser: 'observe',
    pen: 'pen',
    highlighter: 'highlighter',
    arrow: 'arrow',
    rect: 'rectangle',
    eraser: 'eraser',
  };

  const LASER = { color: '#c8452f', trailMs: 1200, dotR: 6.5 };

  const PEN = { min: 2.0, max: 5.2, start: 3.4 };
  const SIZES = { highlighter: 16, eraser: 30, arrow: 3.5, rect: 3 };
  const HIGHLIGHTER_ALPHA = 0.38;
  // stroke width levels — one setting, scaled per tool (the sizes above are
  // "regular"); picked from the size dots or with [ and ]
  const SIZE_LEVELS = [
    { name: 'thin', scale: 0.55, dot: 4 },
    { name: 'regular', scale: 1, dot: 7 },
    { name: 'thick', scale: 1.8, dot: 11 },
    { name: 'heavy', scale: 2.8, dot: 15 },
  ];
  // scroll panes smaller than this share of the viewport (list boxes, code
  // blocks) are not worth anchoring ink to — the next pane up wins
  const MIN_ANCHOR_AREA = 0.2;

  // ---------------------------------------------------------------- state
  let built = false;
  let active = false;
  let tool = 'pen';
  let compact = true; // start compressed — cursor / pen / eraser only
  let color = COLORS[0].value;
  let size = 'regular';
  let ops = [];
  let redoStack = [];
  let live = null; // in-progress stroke
  let raf = 0;
  let laserTrail = []; // recent pointer positions while observing
  let laserPos = null;
  let laserBurstT = 0;
  let laserRaf = 0;
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let lastPage = location.pathname + location.search;

  let host, shadow, canvas, ctx, base, bctx;
  let barWrap, paper, strip, statusEl, toastEl, flashEl;
  let toastTimer = 0;

  // ------------------------------------------------------------- utilities
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sizeScale = () => (SIZE_LEVELS.find((l) => l.name === size) || SIZE_LEVELS[1]).scale;
  const toolSize = (t) => SIZES[t] * sizeScale();

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

  // ------------------------------------------------------- icons (1a set)
  const svg = (paths, w = 1.7) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

  const ICONS = {
    cursor: svg(`<path d="M6 3.5 19 12.5 12.6 13.4 10.2 20.5Z"/>`),
    pen: svg(`<path d="M4.5 19.5 7.5 18.8 19 7.3 16.7 5 5.2 16.5Z"/><path d="M14.9 6.8 17.2 9.1"/>`),
    highlighter: svg(
      `<path d="M5 17.2 9.4 17.2 18.6 8 15.8 5.2 6.6 14.4Z"/><path d="M4 20.5h9" stroke-width="2.6"/>`
    ),
    arrow: svg(`<path d="M5 19 18.5 5.5"/><path d="M11.5 5.5h7v7"/>`, 1.8),
    rect: svg(`<rect x="4.5" y="6" width="15" height="12.5" rx="2"/>`),
    eraser: svg(`<path d="M8.5 19.5 4 15 13 6l4.5 4.5-9 9Z"/><path d="M8.5 19.5H19"/>`),
    laser: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.2" stroke-width="1.5" stroke-dasharray="2.6 3.2"/></svg>`,
    undo: svg(
      `<path d="M8.5 9H15a4.2 4.2 0 0 1 0 8.4H9"/><path d="M11.5 5.6 7.6 9l3.9 3.4"/>`,
      1.8
    ),
    trash: svg(`<path d="M6 7.5h12M9.5 7.5V5.5h5v2M7.5 7.5 8.4 19h7.2l.9-11.5"/>`),
    camera: svg(
      `<path d="M3.5 8.5h4l1.4-2h6.2l1.4 2h4v10h-17Z"/><circle cx="12" cy="13" r="3.3"/>`,
      1.6
    ),
    close: svg(`<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>`, 1.9),
    more: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18" cy="12" r="1.7"/></svg>`,
    less: svg(`<path d="M14.5 6.5 9 12l5.5 5.5"/><path d="M20 6.5 14.5 12 20 17.5"/>`, 1.8),
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="#2fb672" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  };

  // --------------------------------------------------------------- cursors
  function cursorFor(theTool) {
    const enc = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
    if (theTool === 'cursor') return '';
    if (theTool === 'laser') return 'none'; // the glowing dot IS the cursor
    if (theTool === 'pen') {
      // the dot previews the current width
      const r = clamp(PEN.start * sizeScale() * 1.35, 2.6, 14);
      const c = Math.ceil(r + 2);
      const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${c * 2}" height="${c * 2}"><circle cx="${c}" cy="${c}" r="${r}" fill="${color}" stroke="white" stroke-width="1.6"/></svg>`;
      return `${enc(s)} ${c} ${c}, crosshair`;
    }
    if (theTool === 'highlighter') {
      const h = clamp(8 * sizeScale(), 5, 22);
      const d = Math.ceil(h + 12);
      const c = d / 2;
      const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><rect x="2" y="${(c - h / 2).toFixed(1)}" width="${d - 4}" height="${h.toFixed(1)}" rx="3" fill="${color}" fill-opacity="0.55" stroke="white" stroke-width="1.4"/></svg>`;
      return `${enc(s)} ${c} ${c}, crosshair`;
    }
    if (theTool === 'eraser') {
      const d = toolSize('eraser') + 4;
      const r = toolSize('eraser') / 2;
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

    .layer {
      position: fixed; inset: 0; z-index: 1;
      touch-action: none;
      user-select: none; -webkit-user-select: none;
    }

    .bar-wrap {
      position: fixed; z-index: 3;
      pointer-events: none;
      display: flex; flex-direction: column; align-items: center;
      font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;
      -webkit-font-smoothing: antialiased;
    }
    .bar-wrap.capture-hide { visibility: hidden; }

    .paper {
      position: relative;
      pointer-events: auto;
      filter: drop-shadow(0 8px 14px rgba(16,22,46,.20));
      cursor: grab;
      animation: chalk-in 420ms cubic-bezier(0.30, 1.35, 0.45, 1) both;
    }
    .bar-wrap.dragging .paper { cursor: grabbing; }
    .bar-wrap.leaving .paper { animation: chalk-out 150ms ease-in both; }

    @keyframes chalk-in {
      from { opacity: 0; transform: translateY(18px) rotate(1.2deg) scale(0.95); }
      to   { opacity: 1; transform: translateY(0) rotate(0deg) scale(1); }
    }
    @keyframes chalk-out {
      to { opacity: 0; transform: translateY(10px) scale(0.97); }
    }

    /* the paper strip itself, with a perforated bottom edge */
    .strip {
      position: relative;
      display: flex; align-items: flex-end; gap: 2px;
      padding: 10px 12px 12px;
      background: ${PAPER};
      border: 2px solid ${INK};
      border-radius: 5px;
      mask-image: radial-gradient(4px 4px at 50% 100%, rgba(0,0,0,0) 98%, #000 100%), linear-gradient(#000,#000);
      mask-size: 11px 8px, 100% calc(100% - 7px);
      mask-repeat: repeat-x, no-repeat;
      mask-position: bottom, top;
      mask-composite: add;
      -webkit-mask-image: radial-gradient(4px 4px at 50% 100%, rgba(0,0,0,0) 98%, #000 100%), linear-gradient(#000,#000);
      -webkit-mask-size: 11px 8px, 100% calc(100% - 7px);
      -webkit-mask-repeat: repeat-x, no-repeat;
      -webkit-mask-position: bottom, top;
      -webkit-mask-composite: source-over;
    }

    .bar-wrap.enter .strip > * {
      animation: chalk-item-in 340ms cubic-bezier(0.34, 1.6, 0.5, 1) both;
      animation-delay: calc(var(--i, 0) * 18ms + 80ms);
    }
    @keyframes chalk-item-in {
      from { opacity: 0; transform: translateY(7px) scale(0.6); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* direct children only — swatches live inside .swatches and style themselves */
    .strip > button {
      position: relative;
      appearance: none; border: 0; background: transparent;
      width: 32px; height: 32px;
      border-radius: 6px;
      display: grid; place-items: center;
      color: rgba(16,22,46,.62);
      cursor: pointer;
      transition:
        background 150ms ease,
        color 150ms ease,
        transform 180ms cubic-bezier(0.34, 1.8, 0.5, 1),
        box-shadow 180ms ease;
    }
    .strip > button:hover { background: rgba(16,22,46,.07); color: ${INK}; transform: translateY(-1px); }
    .strip > button:active { transform: scale(0.9); }
    .strip > button svg { width: 20px; height: 20px; display: block; }

    /* active tool: lifted pastel sticker, tinted by the current ink colour */
    .strip > button.on {
      background: color-mix(in srgb, var(--ink-color, #c8452f) 26%, ${PAPER});
      border: 2px solid ${INK};
      color: ${INK};
      transform: translateY(-6px) rotate(-2.5deg);
      box-shadow: 2px 2.5px 0 rgba(16,22,46,.9);
      width: 35px; height: 35px; border-radius: 7px;
    }
    .strip > button.on:hover { transform: translateY(-7px) rotate(-2.5deg); }
    .strip > button.on svg { animation: chalk-pop 320ms cubic-bezier(0.34, 1.8, 0.5, 1) both; width: 21px; height: 21px; }
    .strip > button.on[data-tool="cursor"] { background: #fdf07f; }
    .strip > button.on[data-tool="laser"] { background: #f7c9c0; }
    @keyframes chalk-pop {
      0%   { transform: scale(0.7) rotate(-8deg); }
      55%  { transform: scale(1.2) rotate(3deg); }
      100% { transform: scale(1) rotate(0deg); }
    }

    .divider {
      align-self: stretch; width: 0;
      margin: 3px 6px;
      border-left: 2px dotted rgba(16,22,46,.35);
      flex: none;
    }

    .swatches { display: flex; align-items: center; gap: 7px; padding: 0 2px 6px; }
    .swatch {
      appearance: none; border: 0; padding: 0;
      width: 19px; height: 19px; flex: none;
      cursor: pointer;
      box-shadow: inset 0 -2px 3px rgba(0,0,0,.18);
      transition: transform 180ms cubic-bezier(0.34, 1.8, 0.5, 1), box-shadow 180ms ease;
    }
    .swatch:hover { transform: scale(1.2); }
    .swatch:active { transform: scale(1); }
    .swatch.on {
      animation: chalk-drop 360ms cubic-bezier(0.34, 1.7, 0.5, 1) both;
      box-shadow: inset 0 -2px 3px rgba(0,0,0,.18), 0 0 0 2px ${INK};
    }
    @keyframes chalk-drop {
      0%   { transform: scale(1); }
      55%  { transform: scale(1.35); }
      100% { transform: scale(1.15); }
    }
    .swatch.on { transform: scale(1.15); }

    /* stroke width — a row of growing dots, the active one inked */
    .sizes { display: flex; align-items: center; gap: 1px; padding: 0 2px 4px; }
    .sizes > button {
      position: relative;
      appearance: none; border: 0; background: transparent; padding: 0;
      width: 22px; height: 24px; flex: none;
      display: grid; place-items: center;
      border-radius: 6px;
      cursor: pointer;
      transition: background 150ms ease, transform 180ms cubic-bezier(0.34, 1.8, 0.5, 1);
    }
    .sizes > button i {
      display: block;
      width: var(--dot); height: var(--dot);
      border-radius: 50%;
      background: rgba(16,22,46,.42);
      transition: background 150ms ease, transform 180ms cubic-bezier(0.34, 1.8, 0.5, 1);
    }
    .sizes > button:hover { background: rgba(16,22,46,.07); transform: translateY(-1px); }
    .sizes > button:hover i { background: ${INK}; }
    .sizes > button:active { transform: scale(0.9); }
    .sizes > button.on i {
      background: var(--ink-color, #c8452f);
      box-shadow: 0 0 0 2px ${INK};
      transform: scale(1.1);
    }

    /* compressed mode — only cursor / pen / eraser (plus the active tool,
       whichever it is, so keyboard shortcuts never point at a hidden button) */
    .bar-wrap.compact .strip > [data-full] { display: none; }
    .bar-wrap.compact .strip > button[data-full].on { display: grid; }
    .bar-wrap.compact [data-act="expand"] .icon-less,
    .bar-wrap:not(.compact) [data-act="expand"] .icon-more { display: none; }

    /* tooltips — names only, paper style */
    .strip > button::after,
    .sizes > button::after {
      content: attr(data-tip);
      position: absolute;
      bottom: calc(100% + 10px); left: 50%;
      transform: translate(-50%, 3px) rotate(-1deg);
      background: ${PAPER};
      border: 2px solid ${INK};
      color: ${INK};
      font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      font-size: 9.5px; font-weight: 600; letter-spacing: .04em;
      line-height: 1; white-space: nowrap;
      padding: 5px 8px; border-radius: 5px;
      box-shadow: 2px 2.5px 0 rgba(16,22,46,.85);
      opacity: 0; pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
      z-index: 5;
    }
    .strip > button:hover::after,
    .sizes > button:hover::after {
      opacity: 1; transform: translate(-50%, 0) rotate(-1deg);
      transition-delay: 480ms;
    }
    .bar-wrap.tips-below .strip > button::after,
    .bar-wrap.tips-below .sizes > button::after { bottom: auto; top: calc(100% + 10px); }
    .bar-wrap.dragging .strip > button::after,
    .bar-wrap.dragging .sizes > button::after { opacity: 0 !important; }

    /* handwritten caption naming the active tool + colour */
    .status {
      margin-top: 7px;
      pointer-events: none;
      font-family: 'Segoe Print', 'Bradley Hand', 'Marker Felt', 'Comic Sans MS', cursive;
      font-size: 11.5px; font-weight: 700;
      color: rgba(16,22,46,.55);
      text-shadow: 0 1px 0 rgba(255,253,242,.7);
      transition: opacity 200ms ease;
    }

    .toast {
      position: fixed; left: 50%; bottom: 30px; z-index: 4;
      transform: translate(-50%, 10px) rotate(-1deg);
      display: flex; align-items: center; gap: 9px;
      padding: 10px 16px;
      background: ${PAPER};
      border: 2px solid ${INK};
      border-radius: 8px;
      box-shadow: 3px 4px 0 rgba(16,22,46,.85), 0 12px 24px rgba(16,22,46,.18);
      color: ${INK};
      font-family: 'Segoe Print', 'Bradley Hand', 'Marker Felt', 'Comic Sans MS', cursive;
      font-size: 13.5px; font-weight: 700;
      opacity: 0; pointer-events: none;
      transition: opacity 220ms ease, transform 220ms cubic-bezier(0.3, 1.4, 0.5, 1);
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0) rotate(-1deg); }
    .toast.capture-hide { visibility: hidden; }
    .toast svg { width: 15px; height: 15px; }

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
      <div class="paper">
        <div class="strip">
          <button data-tool="cursor" data-tip="interact">${ICONS.cursor}</button>
          <button data-tool="pen" data-tip="pen">${ICONS.pen}</button>
          <button data-tool="highlighter" data-tip="highlighter" data-full>${ICONS.highlighter}</button>
          <button data-tool="arrow" data-tip="arrow" data-full>${ICONS.arrow}</button>
          <button data-tool="rect" data-tip="rectangle" data-full>${ICONS.rect}</button>
          <button data-tool="eraser" data-tip="eraser">${ICONS.eraser}</button>
          <button data-tool="laser" data-tip="observe" data-full>${ICONS.laser}</button>
          <div class="divider" data-full></div>
          <div class="swatches" data-full>
            ${COLORS.map(
              (c, i) =>
                `<button class="swatch" data-color="${c.value}" style="background:${c.value};border-radius:${BLOBS[i]}"></button>`
            ).join('')}
          </div>
          <div class="divider" data-full></div>
          <div class="sizes" data-full>
            ${SIZE_LEVELS.map(
              (l) =>
                `<button class="size" data-size="${l.name}" data-tip="${l.name}" style="--dot:${l.dot}px"><i></i></button>`
            ).join('')}
          </div>
          <div class="divider"></div>
          <button data-act="undo" data-tip="undo" data-full>${ICONS.undo}</button>
          <button data-act="clear" data-tip="clear all" data-full>${ICONS.trash}</button>
          <button data-act="snapshot" data-tip="save snapshot" data-full>${ICONS.camera}</button>
          <button data-act="expand" data-tip="more tools"><span class="icon-more">${ICONS.more}</span><span class="icon-less">${ICONS.less}</span></button>
          <button data-act="close" data-tip="done">${ICONS.close}</button>
        </div>
      </div>
      <div class="status"></div>`;
    shadow.appendChild(barWrap);
    paper = barWrap.querySelector('.paper');
    strip = barWrap.querySelector('.strip');
    statusEl = barWrap.querySelector('.status');
    // stagger indices for the entrance animation
    Array.from(strip.children).forEach((el, i) => el.style.setProperty('--i', i));

    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    shadow.appendChild(toastEl);

    (document.documentElement || document.body).appendChild(host);

    wireToolbar();
    wireCanvas();
    wireDrag();
    window.addEventListener('resize', onResize);
    // capture phase: scroll events don't bubble, and inner panes scroll too
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
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
    if (prefs.tool && strip.querySelector(`[data-tool="${prefs.tool}"]`)) tool = prefs.tool;
    if (prefs.color && COLORS.some((c) => c.value === prefs.color)) color = prefs.color;
    if (prefs.size && SIZE_LEVELS.some((l) => l.name === prefs.size)) size = prefs.size;
    if (tool === 'cursor') tool = 'pen'; // activation means "I want to draw"
    setCompact(prefs.compact !== false, false);

    host.style.display = 'block';
    barWrap.classList.remove('leaving');
    // retrigger the entrance animations
    barWrap.classList.remove('enter');
    paper.style.animation = 'none';
    void paper.offsetWidth;
    paper.style.animation = '';
    barWrap.classList.add('enter');

    reflectTool();
    reflectColor();
    reflectSize();
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
        if (active) toast(`<span>new page — drawings cleared</span>`);
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

  // --------------------------------------------------------- scroll anchors
  // An anchor is whatever scrolls under the ink: null for the document, or
  // an inner scroll pane. Each op keeps its own, so a note on a chat pane
  // follows the chat while a note on the header stays on the header.
  const anchors = new WeakMap(); // element → anchor, so ops share one per pane

  function anchorFor(el) {
    if (!el) return null;
    let a = anchors.get(el);
    if (!a) {
      a = { el, last: { x: 0, y: 0 } };
      anchors.set(el, a);
    }
    return a;
  }

  // the vector that turns a client point into a content point for an anchor
  function scrollShift(anchor) {
    if (!anchor) return { x: window.scrollX, y: window.scrollY };
    const el = anchor.el;
    if (!el.isConnected) return anchor.last; // pane is gone — freeze the ink where it was
    const r = el.getBoundingClientRect();
    anchor.last = { x: el.scrollLeft - r.left, y: el.scrollTop - r.top };
    return anchor.last;
  }

  // hit-test the page beneath the canvas
  function pageElementAt(x, y) {
    const was = canvas.style.pointerEvents;
    canvas.style.pointerEvents = 'none';
    let el = null;
    try {
      el = document.elementFromPoint(x, y);
      // descend through open shadow roots so a pane inside a web component counts
      while (el && el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
    } catch {}
    canvas.style.pointerEvents = was;
    return el;
  }

  const parentOf = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const OVERFLOW_SCROLLS = /auto|scroll|overlay/;

  function scrollsInside(el) {
    if (el === document.scrollingElement || el === document.documentElement) return false;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return false;
    }
    const y = OVERFLOW_SCROLLS.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const x = OVERFLOW_SCROLLS.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    return { x, y };
  }

  // the pane ink drawn at (x, y) should follow: the nearest vertically
  // scrolling ancestor big enough to matter; null means the document
  function anchorAt(x, y) {
    const minArea = MIN_ANCHOR_AREA * window.innerWidth * window.innerHeight;
    for (let el = pageElementAt(x, y); el; el = parentOf(el)) {
      const can = scrollsInside(el);
      if (can && can.y && el.clientWidth * el.clientHeight >= minArea) return anchorFor(el);
    }
    return null;
  }

  // the pane a wheel event over (x, y) should move, mirroring the browser's
  // own scroll chaining; null means let the document handle it natively
  function scrollerFor(x, y, dx, dy) {
    for (let el = pageElementAt(x, y); el; el = parentOf(el)) {
      const can = scrollsInside(el);
      if (!can) continue;
      if (can.y && dy) {
        if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return el;
      }
      if (can.x && dx) {
        if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return el;
      }
    }
    return null;
  }

  // ------------------------------------------------------------- draw ops
  // Ops are stored in content coordinates; this maps them to the viewport,
  // clipped to the pane they belong to so ink scrolled out of a chat pane
  // doesn't wander over the header.
  function xform(c, anchor) {
    const s = scrollShift(anchor);
    c.setTransform(dpr, 0, 0, dpr, -s.x * dpr, -s.y * dpr);
    if (anchor && anchor.el.isConnected) {
      const el = anchor.el;
      c.beginPath();
      c.rect(el.scrollLeft + el.clientLeft, el.scrollTop + el.clientTop, el.clientWidth, el.clientHeight);
      c.clip();
    }
  }

  function docPoint(e, anchor) {
    const s = scrollShift(anchor);
    return { x: e.clientX + s.x, y: e.clientY + s.y };
  }

  function drawOp(c, op) {
    c.save();
    xform(c, op.anchor);
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
    if (active && tool === 'laser') drawLaser();
  }

  // ------------------------------------------------------- observe (laser)
  // Ephemeral by design: a glowing dot with a fading trail, and a pulsing
  // ring when parked. Never committed to ops — it points, it doesn't draw.
  function drawLaser() {
    const now = performance.now();
    laserTrail = laserTrail.filter((p) => now - p.t < LASER.trailMs);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < laserTrail.length; i++) {
      const p = laserTrail[i];
      const q = laserTrail[i - 1];
      const life = 1 - (now - p.t) / LASER.trailMs;
      ctx.strokeStyle = `rgba(200,69,47,${(0.55 * life).toFixed(3)})`;
      ctx.lineWidth = 1.5 + 6 * life;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    if (laserPos) {
      // parked pulse, mirroring the design's 1.6s laser ring
      const t = (now % 1600) / 1600;
      const s = (1 - Math.cos(t * Math.PI * 2)) / 2; // 0 → 1 → 0
      ctx.strokeStyle = `rgba(200,69,47,${(0.85 - 0.5 * s).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(laserPos.x, laserPos.y, 15 + 7 * s, 0, Math.PI * 2);
      ctx.stroke();

      const burstAge = now - laserBurstT;
      if (burstAge < 450) {
        const k = burstAge / 450;
        ctx.strokeStyle = `rgba(200,69,47,${(0.65 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(laserPos.x, laserPos.y, 12 + 46 * k, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.shadowColor = 'rgba(200,69,47,0.85)';
      ctx.shadowBlur = 16;
      ctx.fillStyle = LASER.color;
      ctx.beginPath();
      ctx.arc(laserPos.x, laserPos.y, LASER.dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function startLaserLoop() {
    if (laserRaf) return;
    const loop = () => {
      if (!active || tool !== 'laser') {
        laserRaf = 0;
        laserTrail = [];
        laserPos = null;
        render(); // wipe the leftover dot/trail
        return;
      }
      render();
      laserRaf = requestAnimationFrame(loop);
    };
    laserRaf = requestAnimationFrame(loop);
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
      if (tool === 'laser') {
        // a click "taps" the laser — quick expanding ring for emphasis
        e.preventDefault();
        laserBurstT = performance.now();
        laserPos = { x: e.clientX, y: e.clientY };
        return;
      }
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const anchor = anchorAt(e.clientX, e.clientY);
      const p = docPoint(e, anchor);
      const k = sizeScale();

      if (tool === 'pen') {
        live = {
          tool,
          color,
          anchor,
          points: [{ x: p.x, y: p.y, w: PEN.start * k, t: e.timeStamp }],
        };
      } else if (tool === 'highlighter') {
        live = { tool, color, anchor, size: toolSize('highlighter'), points: [{ ...p }] };
      } else if (tool === 'eraser') {
        live = { tool, anchor, size: toolSize('eraser'), points: [{ ...p }] };
        bctx.save();
        xform(bctx, anchor);
        bctx.lineCap = 'round';
        bctx.lineJoin = 'round';
        drawEraserPath(bctx, live, 0);
        bctx.restore();
      } else {
        live = { tool, color, anchor, size: toolSize(tool), start: { ...p }, end: { ...p } };
      }
      scheduleRender();
    });

    // In a drawing tool the canvas covers the page, so a wheel would only
    // ever reach the document — and on chat apps, docs sites and IDEs the
    // document doesn't scroll, an inner pane does. Find the pane under the
    // pointer and scroll it ourselves; when it's the document, or the pane
    // has run out, the native default takes over.
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!active || tool === 'cursor' || e.ctrlKey) return; // ctrl+wheel is zoom
        let dx = e.deltaX;
        let dy = e.deltaY;
        if (e.deltaMode === 1) {
          dx *= 16;
          dy *= 16;
        } else if (e.deltaMode === 2) {
          dx *= window.innerWidth;
          dy *= window.innerHeight;
        }
        if (e.shiftKey && !dx) {
          dx = dy;
          dy = 0;
        }
        const el = scrollerFor(e.clientX, e.clientY, dx, dy);
        if (!el) return;
        e.preventDefault();
        el.scrollBy(dx, dy);
      },
      { passive: false }
    );

    canvas.addEventListener('pointermove', (e) => {
      if (!active) return;
      if (tool === 'laser') {
        const now = performance.now();
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          laserTrail.push({ x: ev.clientX, y: ev.clientY, t: now });
        }
        laserPos = { x: e.clientX, y: e.clientY };
        return; // the laser loop repaints every frame
      }
      if (!live) return;
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
    const { x, y } = docPoint(e, live.anchor);
    if (live.tool === 'pen') {
      const pts = live.points;
      const prev = pts[pts.length - 1];
      const dt = Math.max(1, (e.timeStamp || prev.t + 8) - prev.t);
      const dist = Math.hypot(x - prev.x, y - prev.y);
      if (dist < 0.6) return;
      // slow, deliberate strokes press wide; fast flicks thin out
      const speed = dist / dt; // px per ms
      const k = sizeScale();
      const target = (PEN.max - (PEN.max - PEN.min) * clamp(speed / 1.4, 0, 1)) * k;
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
      xform(bctx, live.anchor);
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
  function statusText() {
    const name = TOOL_NAMES[tool] || tool;
    if (tool === 'cursor') return 'interacting — ink stays put';
    if (tool === 'laser') return 'observe — point at things';
    const sz = size === 'regular' ? '' : ` · ${size}`;
    if (tool === 'eraser') return `eraser${sz}`;
    const c = COLORS.find((c) => c.value === color);
    return `${name} · ${c ? c.name : ''}${sz}`;
  }

  function reflectTool() {
    for (const b of strip.querySelectorAll('[data-tool]')) {
      b.classList.toggle('on', b.dataset.tool === tool);
    }
    // the observe tool lets pointer events fall through to the page, so the
    // teacher can scroll and click while the ink stays on screen
    canvas.style.pointerEvents = tool === 'cursor' ? 'none' : 'auto';
    canvas.style.cursor = cursorFor(tool);
    statusEl.textContent = statusText();
    if (tool === 'laser') startLaserLoop();
  }

  function reflectColor() {
    for (const b of strip.querySelectorAll('[data-color]')) {
      b.classList.toggle('on', b.dataset.color === color);
    }
    barWrap.style.setProperty('--ink-color', color);
    if (tool === 'pen' || tool === 'highlighter') canvas.style.cursor = cursorFor(tool);
    statusEl.textContent = statusText();
  }

  function setTool(t) {
    tool = t;
    reflectTool();
    if (t !== 'cursor') savePrefs({ tool: t }); // never wake up in observe mode
  }

  function setColor(v) {
    color = v;
    reflectColor();
    savePrefs({ color: v });
  }

  function reflectSize() {
    for (const b of strip.querySelectorAll('[data-size]')) {
      b.classList.toggle('on', b.dataset.size === size);
    }
    if (tool !== 'cursor' && tool !== 'laser') canvas.style.cursor = cursorFor(tool);
    statusEl.textContent = statusText();
  }

  function setSize(name) {
    if (!SIZE_LEVELS.some((l) => l.name === name)) return;
    size = name;
    reflectSize();
    savePrefs({ size: name });
  }

  function stepSize(delta) {
    const i = SIZE_LEVELS.findIndex((l) => l.name === size);
    setSize(SIZE_LEVELS[clamp(i + delta, 0, SIZE_LEVELS.length - 1)].name);
  }

  function setCompact(v, save = true) {
    // growing/shrinking from the left edge would slide the bar out from under
    // the pointer, so pin the midpoint and let it change width around that
    const midBefore = barWrap.style.left
      ? parseFloat(barWrap.style.left) + barWrap.offsetWidth / 2
      : null;
    compact = v;
    barWrap.classList.toggle('compact', compact);
    const btn = strip.querySelector('[data-act="expand"]');
    if (btn) btn.dataset.tip = compact ? 'more tools' : 'fewer tools';
    if (midBefore !== null) {
      barWrap.style.left = midBefore - barWrap.offsetWidth / 2 + 'px';
      clampToolbar(); // the strip just changed width — keep it on screen
    }
    if (save) savePrefs({ compact });
  }

  function wireToolbar() {
    strip.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.tool) setTool(btn.dataset.tool);
      else if (btn.dataset.color) setColor(btn.dataset.color);
      else if (btn.dataset.size) setSize(btn.dataset.size);
      else if (btn.dataset.act === 'undo') undo();
      else if (btn.dataset.act === 'clear') clearAll();
      else if (btn.dataset.act === 'snapshot') snapshot();
      else if (btn.dataset.act === 'expand') setCompact(!compact);
      else if (btn.dataset.act === 'close') deactivate();
    });
    // keep clicks inside the toolbar from ever reaching the page
    paper.addEventListener('pointerdown', (e) => e.stopPropagation());
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
        y = window.innerHeight - bh - 24;
      }
      x = clamp(x, 8, Math.max(8, window.innerWidth - bw - 8));
      y = clamp(y, 8, Math.max(8, window.innerHeight - bh - 8));
      barWrap.style.left = x + 'px';
      barWrap.style.top = y + 'px';
      barWrap.classList.toggle('tips-below', y < 60);
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
    barWrap.classList.toggle('tips-below', y < 60);
  }

  function wireDrag() {
    let dragging = false;
    let offX = 0;
    let offY = 0;

    // drag by any empty spot on the paper (padding, gaps, dividers) — buttons
    // and swatches keep their own behaviour
    paper.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || e.button !== 0) return;
      dragging = true;
      const r = barWrap.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      barWrap.classList.add('dragging');
      paper.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    paper.addEventListener('pointermove', (e) => {
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
      barWrap.classList.toggle('tips-below', y < 60);
      savePrefs({ barPos: { x, y } });
    };
    paper.addEventListener('pointerup', endDrag);
    paper.addEventListener('pointercancel', endDrag);
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
    if (isEditable(document.activeElement)) return; // typing in the page (observe mode)
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
    const toolKeys = { v: 'cursor', o: 'laser', l: 'laser', p: 'pen', h: 'highlighter', a: 'arrow', r: 'rect', e: 'eraser' };
    if (toolKeys[k]) {
      e.preventDefault();
      e.stopPropagation();
      setTool(toolKeys[k]);
      return;
    }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      e.stopPropagation();
      stepSize(e.key === '[' ? -1 : 1);
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
      toast(`${ICONS.check}<span>saved to Downloads</span>`);
    } else {
      toast(`<span>couldn’t save the snapshot</span>`);
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
