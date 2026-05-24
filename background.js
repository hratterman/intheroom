// background.js -- service worker
// Handles tab capture stream ID handoff and message routing

let sessionState = {
  active: false,
  transcript: [],
  summary: null,
  startedAt: null
};

// Stream ID obtained during user gesture (action click) -- valid for ~5s
let pendingStreamId = null;
let pendingStreamTabId = null;
let pendingStreamAt = null;

// When extension icon is clicked, grab stream ID NOW (we're in a user gesture context)
// then open the side panel
chrome.action.onClicked.addListener((tab) => {
  // Get stream ID while we have the user gesture
  chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
    if (chrome.runtime.lastError) {
      console.warn('[intheroom] tabCapture failed on click:', chrome.runtime.lastError.message);
      pendingStreamId = null;
      pendingStreamTabId = null;
    } else {
      pendingStreamId = streamId;
      pendingStreamTabId = tab.id;
      pendingStreamAt = Date.now();
    }
  });

  // Open side panel
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // Side panel asks for the cached stream ID
    case 'GET_TAB_STREAM_ID': {
      if (!pendingStreamId) {
        sendResponse({ ok: false, error: 'No stream ID cached. Click the extension icon on the meeting tab to start.' });
        return true;
      }
      // Stream IDs expire -- Chrome docs say they're valid briefly after creation
      // If it's more than 10s old, warn but still try
      const age = Date.now() - pendingStreamAt;
      const id = pendingStreamId;
      const tabId = pendingStreamTabId;
      // Clear after handing off -- one-time use
      pendingStreamId = null;
      pendingStreamTabId = null;
      pendingStreamAt = null;
      sendResponse({ ok: true, streamId: id, tabId, age });
      return true;
    }

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
