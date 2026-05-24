// ── State ────────────────────────────────────────────────────────
var active = false;
var wordCount = 0;
var startTime = null;
var timerInterval = null;
var finalLines = []; // [{text, speaker}]
var currentTab = 'transcript';
var interimYouEl = null;
var interimMeetingEl = null;
var pipRef = null;
var summarizer = null;
var summaryInterval = null;

// Whisper worker
var whisperWorker = null;
var whisperReady = false;

// Audio contexts
var micRecognition = null;
var tabAudioCtx = null;
var tabProcessor = null;

// ── Tab switching ─────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    document.getElementById('transcript-view').style.display = currentTab === 'transcript' ? 'block' : 'none';
    document.getElementById('summary-view').style.display = currentTab === 'summary' ? 'block' : 'none';
  });
});

// ── Main button ───────────────────────────────────────────────────
document.getElementById('main-btn').addEventListener('click', function() {
  if (active) {
    stopListening();
  } else {
    startListening();
  }
});

// ── PiP button ───────────────────────────────────────────────────
document.getElementById('pip-btn').addEventListener('click', openPip);

// ── Copy button ───────────────────────────────────────────────────
document.getElementById('copy-btn').addEventListener('click', function() {
  var text = finalLines.map(function(l) {
    return '[' + l.speaker + '] ' + l.text;
  }).join('\n\n');
  if (!text) return;
  navigator.clipboard.writeText(text).then(function() {
    var btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function() {
      btn.textContent = 'Copy transcript';
      btn.classList.remove('copied');
    }, 2000);
  });
});

// ── Start listening ───────────────────────────────────────────────
async function startListening() {
  showError(null);
  setBtn('loading');

  try {
    // 1. Get the active meeting tab ID
    const [tab] = await new Promise(resolve => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, resolve);
    });
    if (!tab) throw new Error('No active tab found. Click the meeting tab first, then open the side panel.');

    // 2. Ask background for a tab capture stream ID
    const resp = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_TAB_STREAM_ID', tabId: tab.id }, resolve);
    });
    if (!resp || !resp.ok) throw new Error('Could not capture tab audio: ' + (resp && resp.error || 'unknown error'));
    const streamId = resp.streamId;

    // 3. Get tab audio stream via getUserMedia with chromeMediaSourceId
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // 4. Load Whisper worker (downloads model first time)
    await loadWhisper();

    // 5. Start Whisper pipeline on tab audio
    startTabAudioPipeline(tabStream);

    // 6. Start Web Speech API on mic
    startMicRecognition();

    // 7. Mark active
    setActive(true);
    chrome.runtime.sendMessage({ type: 'SESSION_STARTED' }).catch(() => {});

  } catch(e) {
    showError(e.message);
    setBtn('idle');
  }
}

// ── Whisper worker ────────────────────────────────────────────────
function loadWhisper() {
  return new Promise(function(resolve, reject) {
    if (whisperReady) { resolve(); return; }

    document.getElementById('load-section').style.display = 'block';
    setBadge('loading', 'Loading model');

    whisperWorker = new Worker(chrome.runtime.getURL('whisper-worker.js'), { type: 'module' });

    whisperWorker.onmessage = function(e) {
      var msg = e.data;

      if (msg.type === 'LOAD_PROGRESS') {
        var p = msg.progress;
        if (p && p.progress != null) {
          var pct = Math.round(p.progress);
          document.getElementById('load-bar').style.width = pct + '%';
          document.getElementById('load-sub').textContent =
            (p.file || 'model') + ' ' + pct + '%' +
            (p.total ? ' (' + Math.round(p.total / 1024 / 1024) + ' MB)' : '');
        }
        return;
      }

      if (msg.type === 'READY') {
        whisperReady = true;
        document.getElementById('load-section').style.display = 'none';
        resolve();
        return;
      }

      if (msg.type === 'ERROR') {
        document.getElementById('load-section').style.display = 'none';
        reject(new Error('Whisper failed to load: ' + msg.error));
        return;
      }

      if (msg.type === 'TRANSCRIPT') {
        if (msg.text) {
          appendLine(msg.text, 'meeting', false);
        }
      }
    };

    whisperWorker.onerror = function(e) {
      document.getElementById('load-section').style.display = 'none';
      reject(new Error('Worker error: ' + e.message));
    };

    whisperWorker.postMessage({ type: 'LOAD' });
  });
}

// ── Tab audio pipeline (Whisper) ──────────────────────────────────
function startTabAudioPipeline(stream) {
  const SAMPLE_RATE = 16000;
  const CHUNK_SECONDS = 4; // process every 4s
  const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_SECONDS;

  tabAudioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = tabAudioCtx.createMediaStreamSource(stream);

  // ScriptProcessorNode to collect samples (deprecated but works everywhere)
  // AudioWorklet would be better but requires extra file; ScriptProcessor is fine for 4s chunks
  tabProcessor = tabAudioCtx.createScriptProcessor(4096, 1, 1);

  var buffer = [];
  var isSending = false;

  tabProcessor.onaudioprocess = function(e) {
    var input = e.inputBuffer.getChannelData(0);
    for (var i = 0; i < input.length; i++) {
      buffer.push(input[i]);
    }

    if (buffer.length >= CHUNK_SAMPLES && !isSending) {
      var chunk = new Float32Array(buffer.splice(0, CHUNK_SAMPLES));
      isSending = true;
      // Check chunk has actual audio (not silence)
      var rms = 0;
      for (var j = 0; j < chunk.length; j++) rms += chunk[j] * chunk[j];
      rms = Math.sqrt(rms / chunk.length);

      if (rms > 0.005) { // silence threshold
        whisperWorker.postMessage({
          type: 'TRANSCRIBE',
          payload: { audio: chunk, sampleRate: SAMPLE_RATE, speaker: 'meeting' }
        }, [chunk.buffer]);
      }
      isSending = false;
    }
  };

  source.connect(tabProcessor);
  tabProcessor.connect(tabAudioCtx.destination);
}

// ── Mic pipeline (Web Speech API) ─────────────────────────────────
function startMicRecognition() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  micRecognition = new SR();
  micRecognition.continuous = true;
  micRecognition.interimResults = true;
  micRecognition.lang = 'en-US';

  micRecognition.onresult = function(event) {
    var interim = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var r = event.results[i];
      if (r.isFinal) {
        var text = r[0].transcript.trim();
        if (text) appendLine(text, 'you', false);
      } else {
        interim += r[0].transcript;
      }
    }
    if (interim) updateInterimLine(interim, 'you');
    else clearInterim('you');
  };

  micRecognition.onerror = function(e) {
    if (e.error === 'no-speech') return;
    if (e.error === 'not-allowed') { showError('Mic access denied.'); return; }
  };

  micRecognition.onend = function() {
    if (active) { try { micRecognition.start(); } catch(e) {} }
  };

  micRecognition.start();
}

// ── Stop ─────────────────────────────────────────────────────────
function stopListening() {
  if (micRecognition) { micRecognition.onend = null; micRecognition.stop(); micRecognition = null; }
  if (tabProcessor) { tabProcessor.disconnect(); tabProcessor = null; }
  if (tabAudioCtx) { tabAudioCtx.close(); tabAudioCtx = null; }
  if (summaryInterval) { clearInterval(summaryInterval); summaryInterval = null; }
  setActive(false);
  chrome.runtime.sendMessage({ type: 'SESSION_STOPPED' }).catch(() => {});
}

// ── Append transcript line ────────────────────────────────────────
function appendLine(text, speaker, isInterim) {
  // Clear interim for this speaker
  clearInterim(speaker);

  // Store
  if (!isInterim) {
    var entry = { text: text, speaker: speaker };
    finalLines.push(entry);
    wordCount += text.split(/\s+/).length;
    document.getElementById('word-count-num').textContent = wordCount.toLocaleString();
    document.getElementById('empty-state').style.display = 'none';

    // Notify background + PiP
    chrome.runtime.sendMessage({ type: 'TRANSCRIPT_LINE', text: text, speaker: speaker, isFinal: true }).catch(() => {});
    if (pipRef && !pipRef.closed && typeof pipRef.receiveTranscriptLine === 'function') {
      pipRef.receiveTranscriptLine(text, speaker, true);
    }
  }

  var container = document.getElementById('transcript-lines');
  var line = document.createElement('div');
  line.className = 'transcript-line' + (isInterim ? ' interim' : '');
  if (isInterim) {
    line.dataset.interimSpeaker = speaker;
    if (speaker === 'you') interimYouEl = line;
    else interimMeetingEl = line;
  }

  var tag = document.createElement('div');
  tag.className = 'speaker-tag speaker-' + speaker;
  tag.textContent = speaker === 'you' ? 'You' : 'Meeting';
  line.appendChild(tag);

  var body = document.createElement('div');
  body.className = 'line-body';

  if (!isInterim) {
    var ts = document.createElement('div');
    ts.className = 'transcript-ts';
    ts.textContent = formatTime(new Date());
    body.appendChild(ts);
  }

  var txt = document.createElement('div');
  txt.className = 'transcript-text';
  txt.textContent = text;
  body.appendChild(txt);
  line.appendChild(body);

  container.appendChild(line);
  var view = document.getElementById('transcript-view');
  view.scrollTop = view.scrollHeight;
}

function updateInterimLine(text, speaker) {
  var existing = speaker === 'you' ? interimYouEl : interimMeetingEl;
  if (existing && existing.parentNode) {
    existing.querySelector('.transcript-text').textContent = text;
  } else {
    appendLine(text, speaker, true);
  }
}

function clearInterim(speaker) {
  var el = speaker === 'you' ? interimYouEl : interimMeetingEl;
  if (el && el.parentNode) { el.parentNode.removeChild(el); }
  if (speaker === 'you') interimYouEl = null;
  else interimMeetingEl = null;
}

// ── PiP ──────────────────────────────────────────────────────────
function openPip() {
  if (typeof window.documentPictureInPicture === 'undefined') {
    showError('Document PiP requires Chrome 116+.');
    return;
  }
  if (pipRef && !pipRef.closed) { pipRef.focus(); return; }

  window.documentPictureInPicture.requestWindow({
    width: 380,
    height: 520,
    disallowReturnToOpener: false
  }).then(function(pipWin) {
    pipRef = pipWin;
    fetch(chrome.runtime.getURL('pip.html'))
      .then(function(r) { return r.text(); })
      .then(function(html) {
        pipWin.document.open();
        pipWin.document.write(html);
        pipWin.document.close();
        setTimeout(function() {
          if (typeof pipWin.replayTranscript === 'function') {
            pipWin.replayTranscript(finalLines);
          }
        }, 200);
      });
    pipWin.addEventListener('pagehide', function() { pipRef = null; });
  }).catch(function(e) {
    showError('Could not open floating panel: ' + e.message);
  });
}

// ── Summarizer ────────────────────────────────────────────────────
async function initSummarizer() {
  try {
    if (window.ai && window.ai.summarizer) {
      var cap = await window.ai.summarizer.capabilities();
      if (cap.available !== 'no') {
        summarizer = await window.ai.summarizer.create({
          type: 'tl;dr', format: 'plain-text', length: 'medium'
        });
      }
    }
  } catch(e) { summarizer = null; }

  summaryInterval = setInterval(runSummary, 120000);
}

async function runSummary() {
  if (finalLines.length < 5) return;
  var text = finalLines.map(function(l) { return '[' + l.speaker + '] ' + l.text; }).join(' ');
  if (text.split(' ').length < 30) return;
  try {
    var summary = summarizer ? await summarizer.summarize(text) : extractiveSummary(text);
    chrome.runtime.sendMessage({ type: 'SUMMARY_UPDATE', summary: summary }).catch(() => {});
    if (pipRef && !pipRef.closed && typeof pipRef.receiveSummary === 'function') {
      pipRef.receiveSummary(summary);
    }
    document.getElementById('summary-loading').style.display = 'none';
    document.getElementById('summary-content').style.display = 'block';
    document.getElementById('summary-text').textContent = summary;
    document.getElementById('summary-timer').textContent = 'Last updated ' + formatTime(new Date());
  } catch(e) {}
}

function extractiveSummary(text) {
  var sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  if (sentences.length <= 3) return sentences.join(' ');
  return [sentences[0], sentences[Math.floor(sentences.length / 2)], sentences[sentences.length - 1]].join(' ');
}

// ── UI helpers ────────────────────────────────────────────────────
function setActive(isActive) {
  active = isActive;
  if (isActive) {
    setBtn('active');
    setBadge('listening', 'Listening');
    document.getElementById('stats').style.display = 'flex';
    document.getElementById('tabs').style.display = 'flex';
    document.getElementById('legend').style.display = 'flex';
    document.getElementById('empty-state').style.display = 'none';
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
    initSummarizer();
  } else {
    setBtn('idle');
    setBadge('idle', 'Idle');
    clearInterval(timerInterval);
    startTime = null;
  }
}

function setBtn(state) {
  var btn = document.getElementById('main-btn');
  if (state === 'active') {
    btn.textContent = 'Stop';
    btn.className = 'btn btn-danger';
    btn.disabled = false;
  } else if (state === 'loading') {
    btn.textContent = 'Starting...';
    btn.className = 'btn btn-primary';
    btn.disabled = true;
  } else {
    btn.textContent = 'Start Listening';
    btn.className = 'btn btn-primary';
    btn.disabled = false;
  }
}

function setBadge(cls, text) {
  var badge = document.getElementById('status-badge');
  badge.className = 'status-badge' + (cls !== 'idle' ? ' ' + cls : '');
  var dot = badge.querySelector('.dot');
  dot.className = 'dot' + (cls === 'listening' ? ' pulse' : '');
  document.getElementById('status-text').textContent = text;
}

function updateTimer() {
  if (!startTime) return;
  var elapsed = Math.floor((Date.now() - startTime) / 1000);
  var m = Math.floor(elapsed / 60);
  var s = elapsed % 60;
  document.getElementById('stat-time').textContent = m + ':' + (s < 10 ? '0' : '') + s;
  document.getElementById('stat-words').textContent = wordCount.toLocaleString();
}

function formatTime(date) {
  var h = date.getHours();
  var m = date.getMinutes().toString().padStart(2, '0');
  var ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}

function showError(msg) {
  var el = document.getElementById('error-msg');
  el.style.display = msg ? 'block' : 'none';
  el.textContent = msg || '';
}