// popup.js

let active = false;
let tabId = null;
let startTime = null;
let wordCount = 0;
let timerInterval = null;
let pipWindowRef = null;

const mainBtn = document.getElementById('main-btn');
const statusDot = document.getElementById('status-dot');
const tabNameEl = document.getElementById('tab-name');
const statsEl = document.getElementById('stats');
const statWords = document.getElementById('stat-words');
const statTime = document.getElementById('stat-time');
const pipBtn = document.getElementById('pip-btn');
const idleNotice = document.getElementById('idle-notice');
const errorMsg = document.getElementById('error-msg');

// ─── Init ──────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  tabNameEl.textContent = tab.title || tab.url || 'Unknown tab';

  const { sessionState } = await chrome.storage.session.get('sessionState');
  if (sessionState && sessionState.active && sessionState.tabId === tabId) {
    setActive(true, sessionState.startedAt);
    wordCount = 0;
    updateStats();
  }
}

// ─── Button handlers ───────────────────────────────────────────
mainBtn.addEventListener('click', async () => {
  if (active) {
    await stopSession();
  } else {
    await startSession();
  }
});

pipBtn.addEventListener('click', () => {
  openPip(null);
});

// ─── Start ─────────────────────────────────────────────────────
async function startSession() {
  showError(null);
  mainBtn.disabled = true;
  mainBtn.textContent = 'Starting...';

  try {
    // Request tab audio capture
    const stream = await captureTabAudio();

    // Notify background
    const result = await chrome.runtime.sendMessage({ type: 'START_SESSION', tabId });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || 'Failed to start session');
    }

    // Open PiP window with the stream
    await openPip(stream);
    setActive(true, Date.now());

  } catch (e) {
    showError(e.message);
    mainBtn.disabled = false;
    mainBtn.textContent = 'Join Room';
  }
}

function captureTabAudio() {
  return new Promise(function(resolve, reject) {
    chrome.tabCapture.capture({ audio: true, video: false }, function(stream) {
      if (chrome.runtime.lastError || !stream) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not capture tab audio. Make sure audio is playing in the tab.'));
      } else {
        resolve(stream);
      }
    });
  });
}

// ─── Stop ──────────────────────────────────────────────────────
async function stopSession() {
  await chrome.runtime.sendMessage({ type: 'STOP_SESSION' });
  setActive(false);
  if (pipWindowRef && !pipWindowRef.closed) {
    pipWindowRef.close();
  }
  pipWindowRef = null;
}

// ─── PiP window ────────────────────────────────────────────────
async function openPip(stream) {
  if (typeof window.documentPictureInPicture === 'undefined') {
    showError('Document Picture-in-Picture requires Chrome 116+.');
    return;
  }

  try {
    // Close existing PiP if open
    if (pipWindowRef && !pipWindowRef.closed) {
      pipWindowRef.close();
    }

    pipWindowRef = await window.documentPictureInPicture.requestWindow({
      width: 380,
      height: 540,
      disallowReturnToOpener: false
    });

    // Inject CSS and HTML into the PiP window
    const pipResponse = await fetch(chrome.runtime.getURL('pip.html'));
    const pipHtml = await pipResponse.text();
    pipWindowRef.document.open();
    pipWindowRef.document.write(pipHtml);
    pipWindowRef.document.close();

    // Once pip is ready, hand off the audio stream
    if (stream) {
      // Poll until startTranscription is available
      const pollReady = setInterval(function() {
        if (typeof pipWindowRef.startTranscription === 'function') {
          clearInterval(pollReady);
          pipWindowRef.startTranscription(stream);
        }
      }, 50);
    }

    pipWindowRef.addEventListener('pagehide', function() {
      if (active) pipBtn.style.display = 'block';
    });

    pipBtn.style.display = 'none';

  } catch (e) {
    showError('Could not open floating panel: ' + e.message);
    if (active) pipBtn.style.display = 'block';
  }
}

// ─── UI state ──────────────────────────────────────────────────
function setActive(isActive, start) {
  active = isActive;

  if (isActive) {
    startTime = start || Date.now();
    mainBtn.textContent = 'Leave Room';
    mainBtn.className = 'btn btn-danger';
    statusDot.className = 'status-dot active';
    statsEl.style.display = 'flex';
    pipBtn.style.display = 'block';
    idleNotice.style.display = 'none';
    mainBtn.disabled = false;
    startTimer();
  } else {
    startTime = null;
    wordCount = 0;
    mainBtn.textContent = 'Join Room';
    mainBtn.className = 'btn btn-primary';
    statusDot.className = 'status-dot';
    statsEl.style.display = 'none';
    pipBtn.style.display = 'none';
    idleNotice.style.display = 'block';
    mainBtn.disabled = false;
    clearInterval(timerInterval);
  }
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(updateStats, 1000);
}

function updateStats() {
  if (!startTime) return;
  var elapsed = Math.floor((Date.now() - startTime) / 1000);
  var m = Math.floor(elapsed / 60);
  var s = elapsed % 60;
  statTime.textContent = m + ':' + (s < 10 ? '0' : '') + s;
  statWords.textContent = wordCount.toLocaleString();
}

function showError(msg) {
  errorMsg.style.display = msg ? 'block' : 'none';
  errorMsg.textContent = msg || '';
  if (msg) statusDot.className = 'status-dot error';
  else if (!active) statusDot.className = 'status-dot';
}

// Listen for word count updates broadcast from pip window
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'WORD_COUNT_UPDATE') {
    wordCount = msg.count;
  }
});

init();
