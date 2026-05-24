var finalLines = [];
var wordCount = 0;
var currentTab = 'transcript';

document.querySelectorAll('.tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    document.getElementById('transcript-view').style.display = currentTab === 'transcript' ? 'block' : 'none';
    document.getElementById('summary-view').style.display = currentTab === 'summary' ? 'block' : 'none';
  });
});

document.getElementById('copy-btn').addEventListener('click', function() {
  var text = finalLines.map(function(l) {
    return '[' + (l.speaker === 'you' ? 'You' : 'Meeting') + '] ' + l.text;
  }).join('\n\n');
  if (!text) return;
  navigator.clipboard.writeText(text).then(function() {
    var btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
});

// Called from sidepanel with existing lines on open
window.replayTranscript = function(lines) {
  lines.forEach(function(l) { appendFinalLine(l.text, l.speaker); });
};

// Called from sidepanel as new lines arrive
window.receiveTranscriptLine = function(text, speaker, isFinal) {
  if (isFinal) appendFinalLine(text, speaker);
};

window.receiveSummary = function(summary) {
  document.getElementById('summary-loading').style.display = 'none';
  document.getElementById('summary-content').style.display = 'block';
  document.getElementById('summary-text').textContent = summary;
  document.getElementById('summary-timer').textContent = 'Updated ' + formatTime(new Date());
};

function appendFinalLine(text, speaker) {
  document.getElementById('listening-badge').style.display = 'flex';
  document.getElementById('empty-state').style.display = 'none';
  finalLines.push({ text: text, speaker: speaker });
  wordCount += text.split(/\s+/).length;
  document.getElementById('word-count-num').textContent = wordCount.toLocaleString();

  var container = document.getElementById('transcript-lines');
  var line = document.createElement('div');
  line.className = 'transcript-line';

  var tag = document.createElement('div');
  tag.className = 'speaker-tag speaker-' + speaker;
  tag.textContent = speaker === 'you' ? 'You' : 'Meeting';
  line.appendChild(tag);

  var body = document.createElement('div');
  body.className = 'line-body';

  var ts = document.createElement('div');
  ts.className = 'transcript-ts';
  ts.textContent = formatTime(new Date());
  body.appendChild(ts);

  var txt = document.createElement('div');
  txt.className = 'transcript-text';
  txt.textContent = text;
  body.appendChild(txt);
  line.appendChild(body);

  container.appendChild(line);
  var view = document.getElementById('transcript-view');
  view.scrollTop = view.scrollHeight;
}

function formatTime(date) {
  var h = date.getHours();
  var m = date.getMinutes().toString().padStart(2, '0');
  var ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}
