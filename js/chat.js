/**
 * DAIS AI Chat Widget
 * Voice input  : MediaRecorder with auto silence detection (setInterval, reliable on iOS)
 * Voice output : ElevenLabs TTS via <audio> element with playsinline (plays on iPhone speaker)
 *
 * Key iOS design decisions:
 *  - TTS uses a single reusable <audio> element (not AudioContext) so it plays through
 *    the speaker even while/after the mic is active. AudioContext routes to earpiece in
 *    iOS PlayAndRecord audio session; <audio> with playsinline stays on speaker.
 *  - Silence detection uses a SEPARATE, output-free AudioContext connected only to an
 *    AnalyserNode. It is closed immediately after recording stops.
 *  - setInterval (100ms) instead of requestAnimationFrame for the analysis loop so it
 *    keeps firing on iOS when the user is not actively touching the screen.
 *  - The <audio> element is unlocked with a silent WAV on the first user tap so
 *    subsequent async play() calls work without needing another gesture.
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
  var SILENCE_THRESHOLD = 14;   // 0-255 amplitude; below = silence
  var SILENCE_DELAY_MS  = 1400; // auto-stop 1.4s after speech ends
  var MAX_RECORD_MS     = 9000; // hard cap

  // Minimal silent WAV (44 bytes) — unlocks the <audio> element on iOS
  var SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

  // ── State ────────────────────────────────────────────────────────────────────
  var messages          = [];
  var isLoading         = false;
  var sessionId         = generateSessionId();
  var voiceEnabled      = true;
  var visitorRegistered = false;   // true once pre-chat form submitted
  var visitorInfo       = null;    // { name, email, phone }

  // TTS: single reusable <audio> element
  var ttsAudio = null;
  var blobUrl  = null;

  // Mic recording
  var mediaRecorder   = null;
  var audioChunks     = [];
  var isRecording     = false;
  var silenceTimer    = null;
  var maxRecTimer     = null;
  var silenceCtx      = null; // separate AudioContext for analysis ONLY
  var silenceInterval = null;

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

  // ── TTS: <audio> element (speaker-safe on iPhone) ────────────────────────────

  function getTtsAudio() {
    if (!ttsAudio) {
      ttsAudio = document.createElement('audio');
      ttsAudio.setAttribute('playsinline', '');         // iOS inline playback
      ttsAudio.setAttribute('webkit-playsinline', '');  // legacy iOS
      ttsAudio.preload = 'none';
      document.body.appendChild(ttsAudio);
    }
    return ttsAudio;
  }

  // Must be called synchronously inside a user tap to unlock iOS audio
  function unlockAudio() {
    var el = getTtsAudio();
    if (el._unlocked) return;
    el.src = SILENT_WAV;
    var p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(function () { el._unlocked = true; }).catch(function () {});
    }
  }

  function stopAudio() {
    if (ttsAudio) {
      ttsAudio.pause();
      ttsAudio.currentTime = 0;
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }

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
      return res.blob();
    })
    .then(function (blob) {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(blob);
      var el = getTtsAudio();
      el.onended = function () {
        if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      };
      el.src = blobUrl;
      el.load();
      return el.play();
    })
    .catch(function (e) {
      console.warn('TTS failed:', e.message || e);
    });
  }

  // ── Pre-chat validation helpers ───────────────────────────────────────────────

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function isValidName(v)  { return typeof v === 'string' && v.trim().length >= 2; }
  function isValidEmail(v) { return typeof v === 'string' && EMAIL_RE.test(v.trim()); }
  function isValidPhone(v) { return typeof v === 'string' && v.replace(/\D/g, '').length >= 7; }

  function prechatFieldValid(id) {
    var el = document.getElementById(id);
    if (!el || !el.value.trim()) return false;
    if (id === 'ai-prechat-email') return isValidEmail(el.value);
    if (id === 'ai-prechat-phone') return isValidPhone(el.value);
    return isValidName(el.value);
  }

  function updatePrechatCounter() {
    var valid = ['ai-prechat-name', 'ai-prechat-email', 'ai-prechat-phone']
      .filter(prechatFieldValid);
    var count = valid.length;

    var countEl  = document.getElementById('ai-prechat-count');
    var submitEl = document.getElementById('ai-prechat-submit');
    if (countEl)  countEl.textContent = count;
    if (submitEl) submitEl.disabled = (count < 2);

    // Mark fields
    ['ai-prechat-name', 'ai-prechat-email', 'ai-prechat-phone'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var filled = el.value.trim().length > 0;
      var ok     = prechatFieldValid(id);
      el.classList.toggle('ai-prechat-ok',      filled && ok);
      el.classList.toggle('ai-prechat-invalid',  filled && !ok);
      el.classList.remove('ai-prechat-invalid');   // only show error on submit
    });

    return count;
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

      // ── Header (always visible) ──
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

      // ── Pre-chat form ──
      '  <div id="ai-chat-prechat">',
      '    <p class="ai-prechat-intro">Before we start, please tell us a little about yourself so we can follow up if needed.</p>',
      '    <p class="ai-prechat-hint">Provide at least <strong>2 of the 3</strong> fields below.</p>',
      '    <form id="ai-prechat-form" novalidate>',
      '      <div class="ai-prechat-field">',
      '        <label for="ai-prechat-name">Full Name</label>',
      '        <input type="text" id="ai-prechat-name" placeholder="Your name" autocomplete="name" maxlength="100">',
      '      </div>',
      '      <div class="ai-prechat-field">',
      '        <label for="ai-prechat-email">Email Address</label>',
      '        <input type="email" id="ai-prechat-email" placeholder="you@example.com" autocomplete="email" maxlength="200">',
      '      </div>',
      '      <div class="ai-prechat-field">',
      '        <label for="ai-prechat-phone">Mobile Number</label>',
      '        <input type="tel" id="ai-prechat-phone" placeholder="+44 7700 000000" autocomplete="tel" maxlength="50">',
      '      </div>',
      '      <div class="ai-prechat-counter">',
      '        <span id="ai-prechat-count">0</span> of 3 fields provided',
      '        <span class="ai-prechat-req">&nbsp;(min. 2 required)</span>',
      '      </div>',
      '      <div id="ai-prechat-error" class="ai-prechat-error" aria-live="polite" hidden></div>',
      '      <button type="submit" id="ai-prechat-submit" class="ai-prechat-btn" disabled>',
      '        Start Chat',
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="width:16px;height:16px;margin-left:6px;vertical-align:middle"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
      '      </button>',
      '    </form>',
      '  </div>',

      // ── Chat body (hidden until prechat complete) ──
      '  <div id="ai-chat-body" hidden>',
      '    <div id="ai-chat-messages" aria-live="polite" aria-atomic="false">',
      '      <div class="ai-msg ai-msg-bot">',
      '        <div class="ai-msg-bubble">',
      '          Hi! I am the DAIS AI assistant. I can answer questions about our qualifications, admissions and how to apply. What would you like to know?',
      '        </div>',
      '      </div>',
      '      <div id="ai-chat-suggestions">',
             SUGGESTED_QUESTIONS.map(function (q) {
               return '<button class="ai-suggestion" tabindex="0">' + escHtml(q) + '</button>';
             }).join(''),
      '      </div>',
      '    </div>',
      '    <div id="ai-chat-status" aria-live="polite"></div>',
      '    <div id="ai-chat-input-row">',
             micBtn,
      '      <textarea id="ai-chat-input" placeholder="Ask me anything about DAIS..." rows="1" aria-label="Your message"></textarea>',
      '      <button id="ai-chat-send" aria-label="Send message">',
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
      '      </button>',
      '    </div>',
      '    <div id="ai-chat-footer">Ask me about courses, fees, admissions or how to get started.</div>',
      '  </div>',

      '</div>',
    ].join('\n');

    document.body.appendChild(overlay);

    // Header buttons
    document.getElementById('ai-chat-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    // Pre-chat form live validation
    ['ai-prechat-name', 'ai-prechat-email', 'ai-prechat-phone'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', updatePrechatCounter);
    });

    // Pre-chat form submit
    document.getElementById('ai-prechat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      submitPrechat();
    });

    // Chat controls
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

    var vBtn = document.getElementById('ai-chat-voice-toggle');
    vBtn.classList.add('ai-voice-on');
    vBtn.setAttribute('aria-label', 'Voice on (tap to turn off)');
    vBtn.addEventListener('click', toggleVoice);

    if (hasMediaRecorder) {
      document.getElementById('ai-chat-mic').addEventListener('click', toggleMic);
    }
  }

  // ── Pre-chat submit ───────────────────────────────────────────────────────────

  function submitPrechat() {
    var name  = (document.getElementById('ai-prechat-name').value  || '').trim();
    var email = (document.getElementById('ai-prechat-email').value || '').trim();
    var phone = (document.getElementById('ai-prechat-phone').value || '').trim();

    // Validate
    var errors = [];
    if (email && !isValidEmail(email)) errors.push('Email address is not valid.');
    if (phone && !isValidPhone(phone)) errors.push('Phone number must have at least 7 digits.');

    var filledCount = [name, email, phone].filter(function (v) { return v.length > 0; }).length;
    if (filledCount < 2) errors.push('Please fill in at least 2 fields.');

    var errorEl = document.getElementById('ai-prechat-error');
    if (errors.length) {
      errorEl.textContent = errors.join(' ');
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    // Disable form while POSTing
    var submitBtn = document.getElementById('ai-prechat-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting...';

    visitorInfo = { name: name, email: email, phone: phone };

    // POST visitor details to worker — wait for response before opening chat
    // so we know it saved. Show error if it fails rather than silently losing data.
    fetch(WORKER_URL + '/visitor', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sessionId: sessionId,
        name:      name,
        email:     email,
        phone:     phone,
      }),
    })
    .then(function (res) {
      if (!res.ok) throw new Error('Server error ' + res.status);
      visitorRegistered = true;
      showChatBody();
    })
    .catch(function (e) {
      console.error('Visitor registration failed:', e.message);
      // Still open chat so the visitor is not blocked, but re-enable button
      visitorRegistered = true;
      showChatBody();
      var errorEl = document.getElementById('ai-prechat-error');
      if (errorEl) {
        errorEl.textContent = 'Note: your details could not be saved. You can still chat.';
        errorEl.hidden = false;
      }
    })
    .finally(function () {
      var submitBtn = document.getElementById('ai-prechat-submit');
      if (submitBtn) submitBtn.disabled = false;
    });
  }

  function showChatBody() {
    var prechat = document.getElementById('ai-chat-prechat');
    var body    = document.getElementById('ai-chat-body');
    if (prechat) prechat.hidden = true;
    if (body)    body.hidden    = false;
    setTimeout(function () {
      var input = document.getElementById('ai-chat-input');
      if (input) input.focus();
    }, 100);
  }

  // ── Open / Close ──────────────────────────────────────────────────────────────
  function openModal() {
    var overlay = document.getElementById('ai-chat-overlay');
    if (!overlay) return;
    overlay.classList.add('ai-chat-open');
    document.body.style.overflow = 'hidden';
    unlockAudio(); // synchronous inside user gesture

    if (visitorRegistered) {
      // Already collected details, go straight to chat
      setTimeout(function () {
        var input = document.getElementById('ai-chat-input');
        if (input) input.focus();
      }, 200);
    } else {
      // Show pre-chat form, focus first empty field
      setTimeout(function () {
        var first = ['ai-prechat-name','ai-prechat-email','ai-prechat-phone'].find(function (id) {
          var el = document.getElementById(id);
          return el && !el.value.trim();
        });
        if (first) document.getElementById(first).focus();
      }, 200);
    }
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

  // displayText  — shown in the chat bubble (what the user sees)
  // apiText      — sent to Claude (may include a hidden language hint); defaults to displayText
  function sendMessageText(displayText, apiText) {
    if (!displayText || isLoading) return;
    stopAudio();
    unlockAudio(); // re-unlock on every send tap (keeps iOS happy)

    var suggestions = document.getElementById('ai-chat-suggestions');
    if (suggestions) suggestions.style.display = 'none';

    var contentForApi = apiText || displayText;
    appendMessage('user', displayText);
    messages.push({ role: 'user', content: contentForApi });

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
        'Sorry, I could not get a response. Please contact info@dataaischool.com or call +44 207 0990 956.';

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
      appendMessage('bot', 'Sorry, something went wrong. Please try again or contact info@dataaischool.com.');
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

  // ── Mic with auto silence detection ──────────────────────────────────────────

  function toggleMic() {
    if (isRecording) { stopRecording(); return; }
    startRecording();
  }

  function startRecording() {
    if (!hasMediaRecorder || isLoading) return;
    stopAudio();
    unlockAudio();

    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(function (stream) {
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
          clearTimers();
          closeSilenceCtx();
          // Brief pause lets iOS release the PlayAndRecord audio session
          // before we try to play TTS through the speaker
          setTimeout(function () { sendAudioToSTT(); }, 400);
        };

        mediaRecorder.start(100);
        isRecording = true;
        setMicState(true);
        setStatus('Listening...');

        startSilenceDetection(stream);

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

  // Separate AudioContext with NO audio output — avoids earpiece routing on iOS
  function startSilenceDetection(stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;

      silenceCtx = new AC();
      var src      = silenceCtx.createMediaStreamSource(stream);
      var analyser = silenceCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser); // analysis only — NOT connected to destination

      var dataArr       = new Uint8Array(analyser.frequencyBinCount);
      var speechStarted = false;

      // setInterval instead of requestAnimationFrame: fires reliably on iOS
      // even when the user is not actively touching the screen
      silenceInterval = setInterval(function () {
        if (!isRecording) {
          clearInterval(silenceInterval);
          silenceInterval = null;
          return;
        }

        analyser.getByteFrequencyData(dataArr);
        var peak = 0;
        for (var i = 0; i < dataArr.length; i++) {
          if (dataArr[i] > peak) peak = dataArr[i];
        }

        if (peak > SILENCE_THRESHOLD) {
          speechStarted = true;
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        } else if (speechStarted && !silenceTimer) {
          silenceTimer = setTimeout(function () {
            if (isRecording) stopRecording();
          }, SILENCE_DELAY_MS);
        }
      }, 100);

      silenceCtx.resume().catch(function () {});
    } catch (e) {
      console.warn('Silence detection not available:', e.message);
    }
  }

  function closeSilenceCtx() {
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
    if (silenceCtx) {
      try { silenceCtx.close(); } catch (e) {}
      silenceCtx = null;
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

  function clearTimers() {
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
      if (!transcript) {
        setStatus('Could not hear that clearly. Please try again.');
        setTimeout(function () { setStatus(''); }, 3000);
        return;
      }

      // If ElevenLabs detected a non-English language, prepend a hidden hint
      // so Claude knows to reply in that language even on the very first message.
      // The hint goes into apiText only — the chat bubble shows clean transcript.
      var lang = (data.language || '').toLowerCase();
      var apiText = transcript;
      if (lang && lang !== 'en') {
        apiText = '[Detected language: ' + lang + '. You must reply in this language.] ' + transcript;
      }

      sendMessageText(transcript, apiText);
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
      btn.setAttribute('aria-label', 'Recording (stops when you finish speaking)');
      btn.title = 'Recording (stops when you finish speaking)';
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
