// background.js — service worker
// Manages tab capture, speech recognition, and PiP window coordination

let captureStream = null;
let pipWindow = null;
let recognitionPort = null;
let sessionState = {
  active: false,
  tabId: null,
  transcript: [],
  summary: null,
  startedAt: null
};

// ─── Message handler ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'START_SESSION':
      startSession(msg.tabId).then(sendResponse);
      return true; // async

    case 'STOP_SESSION':
      stopSession();
      sendResponse({ ok: true });
      break;

    case 'GET_STATE':
      sendResponse(sessionState);
      break;

    case 'TRANSCRIPT_UPDATE':
      // From the offscreen/pip window via port
      if (msg.text) {
        sessionState.transcript.push({
          text: msg.text,
          ts: Date.now(),
          isFinal: msg.isFinal
        });
        // Broadcast to PiP window
        broadcastToPip({ type: 'TRANSCRIPT_UPDATE', ...msg });
      }
      break;

    case 'SUMMARY_UPDATE':
      sessionState.summary = msg.summary;
      broadcastToPip({ type: 'SUMMARY_UPDATE', summary: msg.summary });
      break;

    case 'COPY_TRANSCRIPT':
      sendResponse({ transcript: sessionState.transcript });
      break;
  }
});

// ─── Start session ─────────────────────────────────────────────
async function startSession(tabId) {
  try {
    sessionState = {
      active: true,
      tabId,
      transcript: [],
      summary: null,
      startedAt: Date.now()
    };
    await chrome.storage.session.set({ sessionState });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Stop session ──────────────────────────────────────────────
function stopSession() {
  sessionState.active = false;
  captureStream = null;
  chrome.storage.session.set({ sessionState });
}

// ─── Broadcast to PiP ─────────────────────────────────────────
function broadcastToPip(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
