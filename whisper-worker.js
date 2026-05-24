// whisper-worker.js -- runs Transformers.js Whisper in a Web Worker
// Receives raw Float32Array audio chunks, returns transcript segments

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let isLoading = false;

self.onmessage = async function(e) {
  const { type, payload } = e.data;

  if (type === 'LOAD') {
    if (isLoading || transcriber) return;
    isLoading = true;
    try {
      transcriber = await pipeline(
        'automatic-speech-recognition',
        'onnx-community/whisper-tiny.en',
        {
          dtype: 'q8',
          progress_callback: (progress) => {
            self.postMessage({ type: 'LOAD_PROGRESS', progress });
          }
        }
      );
      isLoading = false;
      self.postMessage({ type: 'READY' });
    } catch(err) {
      isLoading = false;
      self.postMessage({ type: 'ERROR', error: err.message });
    }
    return;
  }

  if (type === 'TRANSCRIBE') {
    if (!transcriber) return;
    try {
      // payload.audio = Float32Array, payload.sampleRate = number
      const audio = payload.audio;
      const result = await transcriber(audio, {
        sampling_rate: payload.sampleRate,
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false
      });
      const text = (result.text || '').trim();
      if (text && text.length > 1) {
        self.postMessage({ type: 'TRANSCRIPT', text, speaker: payload.speaker });
      }
    } catch(err) {
      // Silently skip bad chunks
    }
    return;
  }
};
