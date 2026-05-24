// background.js -- service worker
// Routes messages between side panel and PiP window

let sessionState = {
  active: false,
  transcript: [],
  summary: null,
  startedAt: null
};

// Open side panel on extension icon click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// Message router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

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
      // From side panel -- store and broadcast to PiP
      const entry = { text: msg.text, ts: Date.now(), isFinal: msg.isFinal };
      if (msg.isFinal) {
        sessionState.transcript.push(entry);
        chrome.storage.session.set({ sessionState });
      }
      // Broadcast to any open PiP window
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

  return true; // keep sendResponse alive for async
});
