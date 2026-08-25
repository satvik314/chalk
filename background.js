// Chalk — MV3 service worker.
//
// The worker is stateless by design: it can be killed and restarted at any
// time, so nothing here relies on in-memory state surviving between events.
// Per-tab "active" state lives in the content script (which owns the overlay)
// and is mirrored to the action badge on every change.

const ACCENT = '#C8452F'; // notebook brick — matches the toolbar's ink accents

// Pages Chrome will never let us touch.
function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://') ||
    url.startsWith('view-source:') ||
    url.startsWith('about:') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com')
  );
}

function isFileUrl(url) {
  return typeof url === 'string' && url.startsWith('file://');
}

function fileAccessAllowed() {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(Boolean(allowed)));
    } catch {
      resolve(false);
    }
  });
}

// The action has no default popup, so a plain click toggles drawing.
// On pages where toggling can never work (restricted pages, or file:// URLs
// before the user grants file access) we attach an explanatory popup to that
// tab instead, so the click opens guidance rather than failing silently.
async function updateActionForTab(tab) {
  if (!tab || tab.id === undefined || tab.id < 0) return;
  let popup = '';
  if (isRestrictedUrl(tab.url)) {
    popup = 'popup/popup.html?state=restricted';
  } else if (isFileUrl(tab.url) && !(await fileAccessAllowed())) {
    popup = 'popup/popup.html?state=file';
  }
  try {
    await chrome.action.setPopup({ tabId: tab.id, popup });
  } catch {
    // Tab may have closed between the event and this call.
  }
}

async function refreshActiveTabAction() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await updateActionForTab(tab);
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateActionForTab(tab);
  } catch {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete') {
    updateActionForTab(tab);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.action.setBadgeBackgroundColor({ color: ACCENT });
  try {
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  } catch {}
  refreshActiveTabAction();

  // Make already-open tabs work without a reload.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  for (const tab of tabs) {
    if (!tab.id || isRestrictedUrl(tab.url)) continue;
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ['content/chalk.js'] })
      .catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: ACCENT });
  refreshActiveTabAction();
});

async function toggleOnTab(tab) {
  if (!tab || !tab.id || tab.id < 0) return;

  if (isRestrictedUrl(tab.url) || isFileUrl(tab.url)) {
    // For file:// URLs, only bail out when access hasn't been granted —
    // with access granted the content script is injected like anywhere else.
    if (isRestrictedUrl(tab.url) || !(await fileAccessAllowed())) {
      await updateActionForTab(tab);
      try {
        await chrome.action.openPopup();
      } catch {
        // openPopup needs a user gesture and a focused window; if it fails,
        // the per-tab popup is still set, so the next click shows guidance.
      }
      return;
    }
  }

  const send = () => chrome.tabs.sendMessage(tab.id, { type: 'chalk:toggle' });
  try {
    await send();
  } catch {
    // Content script not there yet (tab predates install, or slow load).
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/chalk.js'],
      });
      await send();
    } catch {
      await updateActionForTab(tab);
    }
  }
}

chrome.action.onClicked.addListener((tab) => {
  toggleOnTab(tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-annotation') return;
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  toggleOnTab(tab);
});

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'chalk:state' && sender.tab?.id) {
    chrome.action.setBadgeText({
      tabId: sender.tab.id,
      text: msg.active ? 'ON' : '',
    });
    return false;
  }

  if (msg?.type === 'chalk:capture' && sender.tab) {
    (async () => {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
          format: 'png',
        });
        await chrome.downloads.download({
          url: dataUrl,
          filename: `Chalk/Chalk ${timestamp()}.png`,
          saveAs: false,
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // async response
  }

  if (msg?.type === 'chalk:toggle-from-popup') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) await toggleOnTab(tab);
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
