// background.js -- service worker
// Handles tab capture stream ID handoff and message routing

let sessionState = {
  active: false,
  transcript: [],
  summary: null,
  startedAt: null
};

// Open side panel when extension icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // Side panel asks: get the tab capture stream ID for a specific tab
    case 'GET_TAB_STREAM_ID': {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: msg.tabId },
        (streamId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, streamId });
          }
        }
      );
      return true; // async
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
