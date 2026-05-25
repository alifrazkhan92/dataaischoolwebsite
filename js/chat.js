/**
 * DAIS AI Chat Widget
 * Voice input: MediaRecorder with auto silence detection (stops when you finish speaking)
 * Voice output: ElevenLabs TTS played via Web Audio API (works on all devices)
 * Backend: Cloudflare Worker with D1 logging, ElevenLabs TTS+STT
 */

(function () {
  'use strict';

  // ── Configuration ────────────────────────────────────────────────────────────
  var WORKER_URL = 'https://dais-chat.alifrazkhan92.workers.dev';

  var SUGGESTED_QUESTIONS = [
    'What qualifications do you offer?',
    'How do I apply?',
    'What are the entry requirements?',
    'What is an HTQ diploma?',
    'How much does it cost?',
  ];

  // Silence detection tuning
  var SILENCE_THRESHOLD = 14;    // 0-255 amplitude; below this = silence
  var SILENCE_DELAY_MS  = 1400;  // auto-stop 1.4s after speech ends
  var MAX_RECORD_MS     = 9000;  // hard cap at 9 seconds

  // ── State ────────────────────────────────────────────────────────────────────
  var messages     = [];
  var isLoading    = false;
  var sessionId    = generateSessionId();
  var voiceEnabled = true;

  // Web Audio API (single shared context for TTS playback + silence analysis)
  var audioCtx      = null;
  var currentSource = null;  // active AudioBufferSourceNode

  // Recording state
  var mediaRecorder = null;
  var audioChunks   = [];
  var isRecording   = false;
  var silenceTimer  = null;
  var maxRecTimer   = null;

  var hasMediaRecorder = (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );

  // ── Session ID ────────────────────────────────────────────────────────────────
  function generateSessionId() {
    try {
      var arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      return Array.from(arr).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    } catch (e) {
      return 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    buildModal();
    wireButtons();
  });

  function wireButtons() {
    document.querySelectorAll('.ai-chat-trigger').forEach(function (btn) {
      btn.addEventListener('click', openModal);
    });
  }

  // ── Web Audio API ─────────────────────────────────────────────────────────────

  function getAudioCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    return audioCtx;
  }

  // Call inside a user gesture to unlock iOS / autoplay-blocked browsers
  function unlockAudio() {
    var ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
    }
  }

  function stopAudio() {
    if (currentSource) {
      try { currentSource.stop(0); } catch (e) {}
      currentSource = null;
    }
  }

  // Fetch TTS from worker, decode and play via AudioContext
  function playElevenLabs(text) {
    stopAudio();
    if (!text || !text.trim()) return;

    fetch(WORKER_URL + '/tts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: text }),
    })
    .then(function (res) {
      if (!res.ok) throw new Error('TTS HTTP ' + res.status);
      return res.arrayBuffer();
    })
    .then(function (arrayBuffer) {
      var ctx = getAudioCtx();
      if (!ctx) throw new Error('AudioContext not available');
      // Resume context in case it was suspended (required after page load on some browsers)
      return ctx.resume().then(function () {
        return ctx.decodeAudioData(arrayBuffer);
      });
    })
    .then(function (decoded) {
      stopAudio(); // stop anything that started while we were fetching
      var ctx = getAudioCtx();
      var source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.onended = function () {
        if (currentSource === source) currentSource = null;
      };
      source.start(0);
      currentSource = source;
    })
    .catch(function (e) {
      console.warn('TTS playback failed:', e.message);
    });
  }

  // ── Modal ─────────────────────────────────────────────────────────────────────
  function buildModal() {
    var micBtn = hasMediaRecorder
      ? '<button type="button" id="ai-chat-mic" aria-label="Tap to speak" title="Tap to speak">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
        '<rect x="9" y="2" width="6" height="11" rx="3"/>' +
        '<path d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>' +
        '</svg></button>'
      : '';

    var voiceToggle =
      '<button type="button" id="ai-chat-voice-toggle" aria-label="Voice on" title="Voice on">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
      '<path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>' +
      '</svg></button>';

    var overlay = document.createElement('div');
    overlay.id = 'ai-chat-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Talk to DAIS AI');
    overlay.innerHTML = [
      '<div id="ai-chat-modal">',
      '  <div id="ai-chat-header">',
      '    <div id="ai-chat-header-inner">',
      '      <span id="ai-chat-avatar" aria-hidden="true">&#129302;</span>',
      '      <div>',
      '        <div id="ai-chat-title">DAIS AI Assistant</div>',
      '        <div id="ai-chat-subtitle">DAIS AI &middot; Online now</div>',
      '      </div>',
      '    </div>',
      '    <div id="ai-chat-header-actions">',
           voiceToggle,
      '      <button id="ai-chat-close" aria-label="Close chat">&times;</button>',
      '    </div>',
      '  </div>',
      '  <div id="ai-chat-messages" aria-live="polite" aria-atomic="false">',
      '    <div class="ai-msg ai-msg-bot">',
      '      <div class="ai-msg-bubble">',
      '        Hi! I am the DAIS AI assistant. I can answer questions about our qualifications, admissions and how to apply. What would you like to know?',
      '      </div>',
      '    </div>',
      '    <div id="ai-chat-suggestions">',
           SUGGESTED_QUESTIONS.map(function (q) {
             return '<button class="ai-suggestion" tabindex="0">' + escHtml(q) + '</button>';
           }).join(''),
      '    </div>',
      '  </div>',
      '  <div id="ai-chat-status" aria-live="polite"></div>',
      '  <div id="ai-chat-input-row">',
           micBtn,
      '    <textarea id="ai-chat-input" placeholder="Ask me anything about DAIS..." rows="1" aria-label="Your message"></textarea>',
      '    <button id="ai-chat-send" aria-label="Send message">',
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
      '    </button>',
      '  </div>',
      '  <div id="ai-chat-footer">Ask me about courses, fees, admissions or how to get started.</div>',
      '</div>',
    ].join('\n');

    document.body.appendChild(overlay);

    document.getElementById('ai-chat-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.getElementById('ai-chat-send').addEventListener('click', sendMessage);
    document.getElementById('ai-chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    document.getElementById('ai-chat-input').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    document.getElementById('ai-chat-suggestions').addEventListener('click', function (e) {
      var btn = e.target.closest('.ai-suggestion');
      if (btn) sendMessageText(btn.textContent.trim());
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    var vBtn = document.getElementById('ai-chat-voice-toggle');
    vBtn.classList.add('ai-voice-on');
    vBtn.setAttribute('aria-label', 'Voice on (tap to turn off)');
    vBtn.addEventListener('click', toggleVoice);

    if (hasMediaRecorder) {
      document.getElementById('ai-chat-mic').addEventListener('click', toggleMic);
    }
  }

  // ── Open / Close ──────────────────────────────────────────────────────────────
  function openModal() {
    var overlay = document.getElementById('ai-chat-overlay');
    if (!overlay) return;
    overlay.classList.add('ai-chat-open');
    document.body.style.overflow = 'hidden';
    unlockAudio(); // must happen inside user gesture
    setTimeout(function () {
      var input = document.getElementById('ai-chat-input');
      if (input) input.focus();
    }, 200);
  }

  function closeModal() {
    stopRecording();
    stopAudio();
    var overlay = document.getElementById('ai-chat-overlay');
    if (!overlay) return;
    overlay.classList.remove('ai-chat-open');
    document.body.style.overflow = '';
  }

  // ── Send ──────────────────────────────────────────────────────────────────────
  function sendMessage() {
    var input = document.getElementById('ai-chat-input');
    var text = (input.value || '').trim();
    if (!text || isLoading) return;
    input.value = '';
    input.style.height = 'auto';
    sendMessageText(text);
  }

  function sendMessageText(text) {
    if (!text || isLoading) return;
    stopAudio();
    unlockAudio(); // inside user gesture, ensures AudioContext is live for playback later

    var suggestions = document.getElementById('ai-chat-suggestions');
    if (suggestions) suggestions.style.display = 'none';

    appendMessage('user', text);
    messages.push({ role: 'user', content: text });

    var typingId = 'typing-' + Date.now();
    appendTyping(typingId);
    isLoading = true;
    setInputEnabled(false);
    setStatus('');

    fetch(WORKER_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ messages: messages, sessionId: sessionId }),
    })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      removeTyping(typingId);
      var raw = data.reply ||
        'Sorry, I could not get a response. Please contact us at info@dataaischool.com or call +44 207 0990 956.';

      // Strip any markdown the model may send despite the system prompt
      var reply = raw
        .replace(/#{1,6}\s*/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      messages.push({ role: 'assistant', content: reply });
      appendMessage('bot', reply);

      if (voiceEnabled) {
        playElevenLabs(reply);
      }
    })
    .catch(function () {
      removeTyping(typingId);
      appendMessage('bot', 'Sorry, something went wrong. Please try again or contact us at info@dataaischool.com.');
    })
    .finally(function () {
      isLoading = false;
      setInputEnabled(true);
      var input = document.getElementById('ai-chat-input');
      if (input) input.focus();
    });
  }

  // ── Voice toggle ──────────────────────────────────────────────────────────────
  function toggleVoice() {
    voiceEnabled = !voiceEnabled;
    var btn = document.getElementById('ai-chat-voice-toggle');
    if (btn) {
      btn.classList.toggle('ai-voice-on', voiceEnabled);
      btn.setAttribute('aria-label', voiceEnabled ? 'Voice on (tap to turn off)' : 'Voice off (tap to turn on)');
      btn.title = voiceEnabled ? 'Voice on' : 'Voice off';
    }
    setStatus(voiceEnabled ? 'Voice on.' : 'Voice off.');
    setTimeout(function () { setStatus(''); }, 2000);
    if (!voiceEnabled) stopAudio();
  }

  // ── Mic: MediaRecorder with auto silence detection ────────────────────────────

  function toggleMic() {
    if (isRecording) { stopRecording(); return; }
    startRecording();
  }

  function startRecording() {
    if (!hasMediaRecorder || isLoading) return;
    stopAudio();
    unlockAudio(); // ensure AudioContext is live (needed for AnalyserNode)

    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(function (stream) {
        // Pick best supported MIME type
        var mimeType = '';
        var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
        for (var i = 0; i < types.length; i++) {
          if (MediaRecorder.isTypeSupported(types[i])) { mimeType = types[i]; break; }
        }

        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : {});
        audioChunks   = [];

        mediaRecorder.ondataavailable = function (e) {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          clearAllTimers();
          sendAudioToSTT();
        };

        mediaRecorder.start(100); // collect every 100ms for stable chunks
        isRecording = true;
        setMicState(true);
        setStatus('Listening...');

        // Silence detection using the same AudioContext as TTS
        startSilenceDetection(stream);

        // Absolute max length safety net
        maxRecTimer = setTimeout(function () {
          if (isRecording) stopRecording();
        }, MAX_RECORD_MS);
      })
      .catch(function (err) {
        var msg = err.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow mic in your browser settings.'
          : 'Could not access microphone. Please type instead.';
        setStatus(msg);
        setTimeout(function () { setStatus(''); }, 4000);
      });
  }

  function startSilenceDetection(stream) {
    try {
      var ctx = getAudioCtx();
      if (!ctx) return;

      var src      = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);

      var dataArr       = new Uint8Array(analyser.frequencyBinCount);
      var speechStarted = false;
      var running       = true;

      // Stop the RAF loop when recording ends
      var origStop = stopRecording;
      // We clear running flag via clearAllTimers called from onstop

      function check() {
        if (!isRecording) { running = false; return; }

        analyser.getByteFrequencyData(dataArr);
        var peak = 0;
        for (var i = 0; i < dataArr.length; i++) {
          if (dataArr[i] > peak) peak = dataArr[i];
        }

        if (peak > SILENCE_THRESHOLD) {
          // Speech detected: clear any pending silence timer
          speechStarted = true;
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
        } else if (speechStarted && !silenceTimer) {
          // Silence after speech: schedule auto-stop
          silenceTimer = setTimeout(function () {
            if (isRecording) stopRecording();
          }, SILENCE_DELAY_MS);
        }

        requestAnimationFrame(check);
      }

      requestAnimationFrame(check);
    } catch (e) {
      // Silence detection unavailable on this browser: rely on maxRecTimer only
      console.warn('Silence detection not available:', e.message);
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (e) {}
    }
    isRecording = false;
    setMicState(false);
    setStatus('');
  }

  function clearAllTimers() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (maxRecTimer)  { clearTimeout(maxRecTimer);  maxRecTimer  = null; }
  }

  function sendAudioToSTT() {
    if (!audioChunks.length) return;

    var mimeType = (audioChunks[0] && audioChunks[0].type) || 'audio/webm';
    var blob = new Blob(audioChunks, { type: mimeType });
    audioChunks = [];

    setStatus('Thinking...');
    setInputEnabled(false);

    fetch(WORKER_URL + '/stt', {
      method:  'POST',
      headers: { 'Content-Type': mimeType },
      body:    blob,
    })
    .then(function (res) {
      if (!res.ok) throw new Error('STT HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      setStatus('');
      setInputEnabled(true);
      var transcript = (data.text || '').trim();
      if (transcript) {
        sendMessageText(transcript);
      } else {
        setStatus("Could not hear that clearly. Please try again.");
        setTimeout(function () { setStatus(''); }, 3000);
      }
    })
    .catch(function (e) {
      console.warn('STT failed:', e);
      setStatus('');
      setInputEnabled(true);
      appendMessage('bot', 'Sorry, I could not understand that. Please try typing instead.');
    });
  }

  function setMicState(active) {
    var btn = document.getElementById('ai-chat-mic');
    if (!btn) return;
    if (active) {
      btn.classList.add('ai-mic-active');
      btn.setAttribute('aria-label', 'Recording... tap to stop');
      btn.title = 'Recording... (stops automatically when you finish speaking)';
    } else {
      btn.classList.remove('ai-mic-active');
      btn.setAttribute('aria-label', 'Tap to speak');
      btn.title = 'Tap to speak';
    }
  }

  // ── UI helpers ────────────────────────────────────────────────────────────────

  function appendMessage(role, text) {
    var messagesEl = document.getElementById('ai-chat-messages');
    var div = document.createElement('div');
    div.className = 'ai-msg ai-msg-' + role;
    var bubble = document.createElement('div');
    bubble.className = 'ai-msg-bubble';
    bubble.textContent = text;
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendTyping(id) {
    var messagesEl = document.getElementById('ai-chat-messages');
    var div = document.createElement('div');
    div.className = 'ai-msg ai-msg-bot';
    div.id = id;
    div.innerHTML = '<div class="ai-msg-bubble ai-typing"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function removeTyping(id) {
    var el = document.getElementById(id);
    if (el) el.parentNode.removeChild(el);
  }

  function scrollToBottom() {
    var el = document.getElementById('ai-chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function setInputEnabled(enabled) {
    var input = document.getElementById('ai-chat-input');
    var send  = document.getElementById('ai-chat-send');
    var mic   = document.getElementById('ai-chat-mic');
    if (input) input.disabled = !enabled;
    if (send)  send.disabled  = !enabled;
    if (mic)   mic.disabled   = !enabled;
  }

  function setStatus(msg) {
    var el = document.getElementById('ai-chat-status');
    if (el) el.textContent = msg;
  }

  function escHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
