/**
 * DAIS AI Chat Widget
 * Features: text chat, voice input (MediaRecorder), voice output (ElevenLabs TTS)
 * Backend: Cloudflare Worker with D1 conversation logging, ElevenLabs TTS+STT
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

  // ── State ────────────────────────────────────────────────────────────────────
  var messages      = [];
  var isLoading     = false;
  var sessionId     = generateSessionId();
  var voiceEnabled  = true;
  var currentAudio  = null;   // current Audio element for TTS playback
  var mediaRecorder = null;   // MediaRecorder for mic input
  var audioChunks   = [];     // recorded audio chunks
  var isRecording   = false;
  var audioUnlocked = false;  // tracks whether iOS audio has been unlocked

  // Check MediaRecorder support (works on iOS Safari 14.5+, all modern browsers)
  var hasMediaRecorder = (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );

  // ── Session ID (anonymous) ────────────────────────────────────────────────────
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

  // ── Modal ─────────────────────────────────────────────────────────────────────
  function buildModal() {
    var micBtn = hasMediaRecorder
      ? '<button type="button" id="ai-chat-mic" aria-label="Hold to record voice message" title="Tap to record">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
        '<rect x="9" y="2" width="6" height="11" rx="3"/>' +
        '<path d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>' +
        '</svg></button>'
      : '';

    var voiceToggle =
      '<button type="button" id="ai-chat-voice-toggle" aria-label="Voice replies on (click to turn off)" title="Voice replies on">' +
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

    // Core events
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

    // Voice toggle — start ON
    var vBtn = document.getElementById('ai-chat-voice-toggle');
    vBtn.classList.add('ai-voice-on');
    vBtn.addEventListener('click', toggleVoice);

    // Mic button
    if (hasMediaRecorder) {
      document.getElementById('ai-chat-mic').addEventListener('click', toggleMic);
    }
  }

  // ── Open / Close ──────────────────────────────────────────────────────────────

  // Play a completely silent audio file to unlock iOS audio autoplay.
  // Must be called synchronously inside a user gesture handler.
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      // Minimal valid silent MP3 (44 bytes) — enough to satisfy iOS
      var silent = new Audio(
        'data:audio/mpeg;base64,SUQzBAAAAAAA' +
        'AFRTQ08AAAAPAAADTGF2ZjU4LjI5LjEwMAD/+0DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      );
      silent.volume = 0;
      var p = silent.play();
      if (p && typeof p.then === 'function') {
        p.then(function () { audioUnlocked = true; }).catch(function () {});
      }
    } catch (e) {}
  }

  function openModal() {
    var overlay = document.getElementById('ai-chat-overlay');
    if (!overlay) return;
    overlay.classList.add('ai-chat-open');
    document.body.style.overflow = 'hidden';
    // Unlock iOS audio on modal open (direct user gesture)
    unlockAudio();
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

    // Unlock iOS audio synchronously (we are still inside the tap handler)
    unlockAudio();

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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages, sessionId: sessionId }),
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

  // ── ElevenLabs TTS ────────────────────────────────────────────────────────────

  function playElevenLabs(text) {
    stopAudio();
    if (!text.trim()) return;

    fetch(WORKER_URL + '/tts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: text }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('TTS ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var audio = new Audio(url);
        currentAudio = audio;
        audio.onended = function () {
          URL.revokeObjectURL(url);
          if (currentAudio === audio) currentAudio = null;
        };
        audio.onerror = function () {
          URL.revokeObjectURL(url);
          if (currentAudio === audio) currentAudio = null;
        };
        return audio.play().catch(function (e) {
          // Autoplay was blocked (older iOS / strict browser). Message is still visible.
          console.warn('Audio autoplay blocked:', e.message);
          URL.revokeObjectURL(url);
          currentAudio = null;
        });
      })
      .catch(function (e) {
        console.warn('ElevenLabs TTS failed:', e.message);
      });
  }

  function stopAudio() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch (e) {}
      currentAudio = null;
    }
  }

  // ── Voice toggle ──────────────────────────────────────────────────────────────

  function toggleVoice() {
    voiceEnabled = !voiceEnabled;
    var btn = document.getElementById('ai-chat-voice-toggle');
    if (btn) {
      btn.classList.toggle('ai-voice-on', voiceEnabled);
      btn.setAttribute('aria-label',
        voiceEnabled ? 'Voice replies on (click to turn off)' : 'Toggle voice replies');
      btn.title = voiceEnabled ? 'Voice replies on' : 'Voice replies off';
    }
    setStatus(voiceEnabled ? 'Voice on.' : 'Voice off.');
    if (!voiceEnabled) stopAudio();
  }

  // ── ElevenLabs STT (MediaRecorder) ────────────────────────────────────────────

  function toggleMic() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  function startRecording() {
    if (!hasMediaRecorder || isLoading) return;
    stopAudio();

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        // Pick the best supported MIME type
        var mimeType = '';
        var types = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg;codecs=opus',
        ];
        for (var i = 0; i < types.length; i++) {
          if (MediaRecorder.isTypeSupported(types[i])) {
            mimeType = types[i];
            break;
          }
        }

        var options = mimeType ? { mimeType: mimeType } : {};
        mediaRecorder = new MediaRecorder(stream, options);
        audioChunks   = [];

        mediaRecorder.ondataavailable = function (e) {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = function () {
          // Stop all mic tracks
          stream.getTracks().forEach(function (t) { t.stop(); });
          sendAudioToSTT();
        };

        mediaRecorder.start();
        isRecording = true;
        setMicState(true);
        setStatus('Recording... tap mic to send.');
      })
      .catch(function (err) {
        console.warn('Mic error:', err);
        setStatus(
          err.name === 'NotAllowedError'
            ? 'Microphone access denied. Please allow mic access in your browser settings.'
            : 'Could not access microphone. Please type instead.'
        );
      });
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (e) {}
    }
    isRecording = false;
    setMicState(false);
    setStatus('');
  }

  function sendAudioToSTT() {
    if (!audioChunks.length) return;

    var mimeType = (audioChunks[0] && audioChunks[0].type) || 'audio/webm';
    var blob = new Blob(audioChunks, { type: mimeType });
    audioChunks = [];

    setStatus('Transcribing...');
    setInputEnabled(false);

    fetch(WORKER_URL + '/stt', {
      method:  'POST',
      headers: { 'Content-Type': mimeType },
      body:    blob,
    })
      .then(function (res) {
        if (!res.ok) throw new Error('STT ' + res.status);
        return res.json();
      })
      .then(function (data) {
        setStatus('');
        setInputEnabled(true);
        var transcript = (data.text || '').trim();
        if (transcript) {
          sendMessageText(transcript);
        } else {
          setStatus('Could not hear anything. Please try again.');
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
      btn.setAttribute('aria-label', 'Stop recording');
      btn.title = 'Tap to stop and send';
    } else {
      btn.classList.remove('ai-mic-active');
      btn.setAttribute('aria-label', 'Hold to record voice message');
      btn.title = 'Tap to record';
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
