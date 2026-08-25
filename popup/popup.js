// Chalk — popup.
// The background worker decides which state this popup opens in by setting a
// per-tab popup URL (?state=file | ?state=restricted). No query param means
// the plain quick-reference view.

const IS_MAC = /Mac|iP/.test(navigator.platform);
const state = new URLSearchParams(location.search).get('state') || 'default';

const section = document.getElementById(
  { file: 'state-file', restricted: 'state-restricted' }[state] || 'state-default'
);
section.hidden = false;

function shortcutKeys() {
  const frag = document.createDocumentFragment();
  const alt = document.createElement('kbd');
  alt.textContent = IS_MAC ? '⌥' : 'Alt';
  const d = document.createElement('kbd');
  d.textContent = 'D';
  frag.append(alt, d);
  return frag;
}

for (const id of ['shortcut-keys', 'shortcut-inline', 'shortcut-inline-2']) {
  const el = document.getElementById(id);
  if (el) el.append(shortcutKeys());
}
const modKey = document.getElementById('mod-key');
if (modKey) modKey.textContent = IS_MAC ? '⌘' : 'Ctrl';

document.getElementById('open-settings')?.addEventListener('click', () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  window.close();
});

document.getElementById('start')?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'chalk:toggle-from-popup' }).catch(() => {});
  window.close();
});
