// background.js -- service worker
// Handles tab capture stream ID handoff and message routing

let sessionState = {
  active: false,
  transcript: [],
  summary: null,
  startedAt: null
};

// Track the last tab the user was on when they opened the side panel
let lastActiveTabId = null;

// When extension icon is clicked, record which tab was active, then open side panel
chrome.action.onClicked.addListener((tab) => {
  lastActiveTabId = tab.id;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// Also track tab activation so we always know the last real tab
chrome.tabs.onActivated.addListener((info) => {
  // Don't track the side panel itself (extension pages)
  chrome.tabs.get(info.tabId, (tab) => {
    if (tab && tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('chrome://')) {
      lastActiveTabId = info.tabId;
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // Side panel asks: get the tab capture stream ID for a specific tab
    case 'GET_TAB_STREAM_ID': {
      const targetTabId = msg.tabId || lastActiveTabId;
      if (!targetTabId) {
        sendResponse({ ok: false, error: 'No target tab identified. Click the extension icon on the meeting tab first.' });
        return true;
      }
      chrome.tabCapture.getMediaStreamId(
        { targetTabId },
        (streamId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, streamId, tabId: targetTabId });
          }
        }
      );
      return true;
    }

    case 'GET_ACTIVE_TAB':
      sendResponse({ tabId: lastActiveTabId });
      break;

    case 'SESSION_STARTED':
      sessionState = {
        active: true,
        transcript: [],
        summary: null,
        startedAt: Date.now()
      };
      chrome.storage.session.set({ sessionState });
      sendResponse({ ok: true });
      break;

    case 'SESSION_STOPPED':
      sessionState.active = false;
      chrome.storage.session.set({ sessionState });
      sendResponse({ ok: true });
      break;

    case 'TRANSCRIPT_LINE': {
      const entry = { text: msg.text, speaker: msg.speaker, ts: Date.now(), isFinal: msg.isFinal };
      if (msg.isFinal) {
        sessionState.transcript.push(entry);
        chrome.storage.session.set({ sessionState });
      }
      // Broadcast to PiP window (sidepanel forwards directly, but belt-and-suspenders)
      chrome.runtime.sendMessage({ type: 'TRANSCRIPT_LINE', ...msg }).catch(() => {});
      sendResponse({ ok: true });
      break;
    }

    case 'SUMMARY_UPDATE':
      sessionState.summary = msg.summary;
      chrome.storage.session.set({ sessionState });
      chrome.runtime.sendMessage({ type: 'SUMMARY_UPDATE', summary: msg.summary }).catch(() => {});
      sendResponse({ ok: true });
      break;

    case 'GET_STATE':
      sendResponse(sessionState);
      break;

    case 'GET_TRANSCRIPT':
      sendResponse({ transcript: sessionState.transcript });
      break;
  }

  return true;
});
