# Chalk

A screen annotation tool for live teaching. Toggle a transparent drawing layer
over any webpage — or any local HTML file — draw with a pen, highlighter,
arrows and rectangles, then save the annotated screen as a PNG. Built as a
Chrome extension (Manifest V3).

![Chalk toolbar](icons/icon-128.png)

## Install (load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder (the one
   containing `manifest.json`).
5. Optional, for teaching from local files: on Chalk's card click
   **Details** and turn on **Allow access to file URLs**.

## Use

| Action | How |
| --- | --- |
| Toggle drawing mode | Click the Chalk icon, or **Alt+D** (⌥D on Mac) |
| Tools | **V** interact · **P** pen · **H** highlighter · **A** arrow · **R** rectangle · **E** eraser |
| Colors | Click a swatch, or keys **1–5** |
| Undo / Redo | **Ctrl/⌘+Z** · **Ctrl/⌘+Shift+Z** |
| Clear all | Trash button (undoable) |
| Save snapshot | Camera button — saves a PNG to `Downloads/Chalk/` |
| Exit | **Esc** or the ✕ button |

The toolbar is a paper strip taped to the page — drag it anywhere by the tape
or any empty spot on the strip; its position is remembered. A handwritten
caption under the strip names the active tool and colour. Keyboard shortcuts
work but are not shown on the strip. The **interact** tool (V)
lets pointer events fall through to the page, so you can scroll and click
while your ink stays on screen — drawings are anchored to the page content
and scroll with it. Annotations survive toggling the mode off and on, but are
cleared automatically when you navigate to a different page (including SPA
route changes). When drawing mode is off, the page behaves completely
normally.

## Notes

- Chrome doesn't allow extensions on its own pages (`chrome://…`) or the Web
  Store; Chalk's popup explains this if you try.
- On `file://` pages without the one-time "Allow access to file URLs"
  permission, clicking the icon opens a short guide instead of failing
  silently.
- `tools/make-icons.mjs` regenerates the icon PNGs from code (no
  dependencies): `node tools/make-icons.mjs`.

## Development

Plain MV3 — no build step. `background.js` is the (stateless) service worker
handling toggling, tab capture and downloads; `content/chalk.js` owns the
overlay canvas and toolbar inside a closed shadow root; `popup/` is the
guidance popup shown only where drawing can't work.
