/**
 * DAIS AI Chat Widget
 * Features: text chat, voice input (Web Speech API), voice output (SpeechSynthesis)
 * Backend: Cloudflare Worker with D1 conversation logging
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
  var messages   = [];
  var isLoading  = false;
  var sessionId  = generateSessionId();
  var isSpeaking = false;
  var isListening = false;

  // Speech APIs
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var recognition       = null;
  var synth             = window.speechSynthesis || null;
  var voiceEnabled      = true; // voice replies on by default

  // ── Session ID (anonymous, not tied to any personal data) ────────────────────
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
    var hasSpeechInput  = !!SpeechRecognition;
    var hasSpeechOutput = !!synth;

    var micBtn = hasSpeechInput
      ? '<button type="button" id="ai-chat-mic" aria-label="Start voice input" title="Speak your question">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
        '<rect x="9" y="2" width="6" height="11" rx="3"/>' +
        '<path d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>' +
        '</svg></button>'
      : '';

    var voiceToggle = hasSpeechOutput
      ? '<button type="button" id="ai-chat-voice-toggle" aria-label="Toggle voice reply" title="Toggle voice replies">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
        '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
        '<path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>' +
        '</svg></button>'
      : '';

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

    // Voice input
    if (hasSpeechInput) {
      document.getElementById('ai-chat-mic').addEventListener('click', toggleListening);
    }

    // Voice output toggle — set initial state to ON
    if (hasSpeechOutput) {
      var vBtn = document.getElementById('ai-chat-voice-toggle');
      vBtn.classList.add('ai-voice-on');
      vBtn.setAttribute('aria-label', 'Voice replies on (click to turn off)');
      vBtn.title = 'Voice replies on';
      vBtn.addEventListener('click', toggleVoice);
    }
  }

  // ── Open / Close ──────────────────────────────────────────────────────────────
  function openModal() {
    var overlay = document.getElementById('ai-chat-overlay');
    if (!overlay) return;
    overlay.classList.add('ai-chat-open');
    document.body.style.overflow = 'hidden';
    setTimeout(function () {
      var input = document.getElementById('ai-chat-input');
      if (input) input.focus();
    }, 200);
  }

  function closeModal() {
    stopListening();
    stopSpeaking();
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
    stopSpeaking();

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
        var raw   = data.reply || 'Sorry, I could not get a response. Please contact us at info@dataaischool.com or call +44 207 0990 956.';
        // Strip any markdown the model sends despite instructions
        var reply = raw
          .replace(/#{1,6}\s*/g, '')          // headings: # ## ###
          .replace(/\*\*(.+?)\*\*/g, '$1')    // bold: **text**
          .replace(/\*(.+?)\*/g, '$1')        // italic: *text*
          .replace(/`(.+?)`/g, '$1')          // code: `text`
          .replace(/^\s*[-*+]\s+/gm, '')      // bullet points
          .replace(/^\s*\d+\.\s+/gm, '')      // numbered lists
          .replace(/\n{3,}/g, '\n\n')         // excess blank lines
          .trim();
        messages.push({ role: 'assistant', content: reply });
        if (voiceEnabled && synth) {
          appendMessage('bot', reply);
          speakText(reply);
        } else {
          appendMessageAnimated('bot', reply);
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

  // ── Voice Input (SpeechRecognition) ──────────────────────────────────────────
  function toggleListening() {
    if (isListening) { stopListening(); return; }
    startListening();
  }

  function startListening() {
    if (!SpeechRecognition || isLoading) return;
    stopSpeaking();

    recognition = new SpeechRecognition();
    recognition.lang        = 'en-GB';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = function () {
      isListening = true;
      setMicState(true);
      setStatus('Listening...');
    };

    recognition.onresult = function (e) {
      var transcript = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      var input = document.getElementById('ai-chat-input');
      if (input) {
        input.value = transcript;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      }
      if (e.results[e.results.length - 1].isFinal) {
        setStatus('');
        stopListening();
        sendMessageText(transcript.trim());
      }
    };

    recognition.onerror = function (e) {
      setStatus(e.error === 'not-allowed'
        ? 'Microphone access denied. Please allow microphone in your browser settings.'
        : 'Voice input error. Please try typing instead.');
      stopListening();
    };

    recognition.onend = function () {
      isListening = false;
      setMicState(false);
    };

    try {
      recognition.start();
    } catch (e) {
      setStatus('Could not start voice input. Please type instead.');
    }
  }

  function stopListening() {
    if (recognition) {
      try { recognition.stop(); } catch (e) {}
      recognition = null;
    }
    isListening = false;
    setMicState(false);
    setStatus('');
  }

  function setMicState(active) {
    var btn = document.getElementById('ai-chat-mic');
    if (!btn) return;
    if (active) {
      btn.classList.add('ai-mic-active');
      btn.setAttribute('aria-label', 'Stop voice input');
    } else {
      btn.classList.remove('ai-mic-active');
      btn.setAttribute('aria-label', 'Start voice input');
    }
  }

  // ── Voice Output (SpeechSynthesis) ────────────────────────────────────────────
  function toggleVoice() {
    voiceEnabled = !voiceEnabled;
    var btn = document.getElementById('ai-chat-voice-toggle');
    if (btn) {
      btn.classList.toggle('ai-voice-on', voiceEnabled);
      btn.setAttribute('aria-label', voiceEnabled ? 'Voice replies on (click to turn off)' : 'Toggle voice replies');
      btn.title = voiceEnabled ? 'Voice replies on' : 'Voice replies off';
    }
    setStatus(voiceEnabled ? 'Voice replies on.' : 'Voice replies off.');
    if (!voiceEnabled) stopSpeaking();
  }

  function pickVoice(utt) {
    var voices = synth.getVoices();
    // Prefer high-quality female British voices for a warm, conversational tone
    var preferred =
      voices.find(function (v) { return v.name === 'Serena'; })                    ||  // macOS premium British female
      voices.find(function (v) { return v.name === 'Google UK English Female'; })  ||  // Chrome high quality
      voices.find(function (v) { return v.name === 'Kate'; })                      ||  // Windows British female
      voices.find(function (v) { return v.name === 'Moira'; })                     ||  // macOS Irish English female
      voices.find(function (v) { return v.name === 'Google US English'; })         ||  // Chrome US female
      voices.find(function (v) { return v.name === 'Samantha'; })                  ||  // macOS US female
      voices.find(function (v) {
        return v.lang === 'en-GB' && !v.name.toLowerCase().includes('compact') &&
               (v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('serena') ||
                v.name.toLowerCase().includes('kate') || v.name.toLowerCase().includes('martha'));
      }) ||
      voices.find(function (v) { return v.lang === 'en-GB' && !v.name.toLowerCase().includes('compact'); }) ||
      voices.find(function (v) { return v.lang.startsWith('en') && !v.name.toLowerCase().includes('compact'); }) ||
      voices.find(function (v) { return v.lang.startsWith('en'); });
    if (preferred) utt.voice = preferred;
  }

  function speakText(text) {
    if (!synth) return;
    synth.cancel(); // clear queue before speaking
    var clean = text.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;

    function doSpeak() {
      var utt   = new SpeechSynthesisUtterance(clean);
      utt.lang  = 'en-GB';
      utt.rate  = 0.92;   // slightly slower = clearer and more natural
      utt.pitch = 1.05;   // very slightly warmer
      utt.volume = 1.0;
      pickVoice(utt);
      utt.onstart = function () { isSpeaking = true; };
      utt.onend   = function () { isSpeaking = false; };
      utt.onerror = function () { isSpeaking = false; };
      // Small timeout — Chrome requires a brief gap after cancel() before speak()
      setTimeout(function () { synth.speak(utt); }, 50);
    }

    if (synth.getVoices().length > 0) {
      doSpeak();
    } else {
      synth.addEventListener('voiceschanged', function handler() {
        synth.removeEventListener('voiceschanged', handler);
        doSpeak();
      });
    }
  }

  function stopSpeaking() {
    if (synth && isSpeaking) {
      synth.cancel();
      isSpeaking = false;
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

  function appendMessageAnimated(role, text, onComplete) {
    var messagesEl = document.getElementById('ai-chat-messages');
    var div = document.createElement('div');
    div.className = 'ai-msg ai-msg-' + role + ' ai-msg-new';
    var bubble = document.createElement('div');
    bubble.className = 'ai-msg-bubble';
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();

    var i = 0;
    var speed = Math.max(8, Math.min(20, Math.round(3000 / text.length)));
    function type() {
      if (i < text.length) {
        bubble.textContent += text[i];
        i++;
        scrollToBottom();
        setTimeout(type, speed);
      } else if (typeof onComplete === 'function') {
        onComplete();
      }
    }
    type();
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
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
