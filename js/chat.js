/**
 * DAIS AI Chat Widget
 * Connects to the Cloudflare Worker backend for AI-powered Q&A about DAIS.
 *
 * To configure: replace WORKER_URL below with your deployed Cloudflare Worker URL.
 * Example: https://dais-chat.your-subdomain.workers.dev
 */

(function () {
  'use strict';

  // ---- CONFIGURATION ----
  var WORKER_URL = 'https://dais-chat.alifrazkhan92.workers.dev';
  var SUGGESTED_QUESTIONS = [
    'What qualifications do you offer?',
    'How do I apply?',
    'What are the entry requirements?',
    'What is an HTQ diploma?',
    'How much does it cost?',
  ];

  // ---- STATE ----
  var messages = []; // { role: 'user'|'assistant', content: string }
  var isLoading = false;

  // ---- INIT ----
  document.addEventListener('DOMContentLoaded', function () {
    buildModal();
    wireButtons();
  });

  function wireButtons() {
    document.querySelectorAll('.ai-chat-trigger').forEach(function (btn) {
      btn.addEventListener('click', openModal);
    });
  }

  // ---- MODAL BUILD ----
  function buildModal() {
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
      '        <div id="ai-chat-subtitle">Powered by Claude &middot; Online now</div>',
      '      </div>',
      '    </div>',
      '    <button id="ai-chat-close" aria-label="Close chat">&times;</button>',
      '  </div>',
      '  <div id="ai-chat-messages" aria-live="polite" aria-atomic="false">',
      '    <div class="ai-msg ai-msg-bot">',
      '      <div class="ai-msg-bubble">',
      '        Hi! I am the DAIS AI assistant. I can answer questions about our qualifications, admissions and how to apply. What would you like to know?',
      '      </div>',
      '    </div>',
      '    <div id="ai-chat-suggestions">',
      SUGGESTED_QUESTIONS.map(function (q) {
        return '      <button class="ai-suggestion" tabindex="0">' + escHtml(q) + '</button>';
      }).join('\n'),
      '    </div>',
      '  </div>',
      '  <div id="ai-chat-input-row">',
      '    <textarea id="ai-chat-input" placeholder="Ask me anything about DAIS..." rows="1" aria-label="Your message"></textarea>',
      '    <button id="ai-chat-send" aria-label="Send message">',
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
      '    </button>',
      '  </div>',
      '  <div id="ai-chat-footer">Ask me about courses, fees, admissions or how to get started.</div>',
      '</div>',
    ].join('\n');

    document.body.appendChild(overlay);

    // Events
    document.getElementById('ai-chat-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    document.getElementById('ai-chat-send').addEventListener('click', sendMessage);
    document.getElementById('ai-chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    // Auto-resize textarea
    document.getElementById('ai-chat-input').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    // Suggestion chips
    document.getElementById('ai-chat-suggestions').addEventListener('click', function (e) {
      var btn = e.target.closest('.ai-suggestion');
      if (!btn) return;
      sendMessageText(btn.textContent.trim());
    });
    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });
  }

  // ---- OPEN / CLOSE ----
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
    var overlay = document.getElementById('ai-chat-overlay');
    if (!overlay) return;
    overlay.classList.remove('ai-chat-open');
    document.body.style.overflow = '';
  }

  // ---- SEND ----
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

    // Hide suggestion chips after first user message
    var suggestions = document.getElementById('ai-chat-suggestions');
    if (suggestions) suggestions.style.display = 'none';

    // Show user message
    appendMessage('user', text);
    messages.push({ role: 'user', content: text });

    // Show typing indicator
    var typingId = 'typing-' + Date.now();
    appendTyping(typingId);
    isLoading = true;
    setInputEnabled(false);

    // Call worker
    fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        removeTyping(typingId);
        var reply = data.reply || 'Sorry, I could not get a response. Please contact us at info@dataaischool.com or call +44 207 0990 956.';
        messages.push({ role: 'assistant', content: reply });
        appendMessageAnimated('bot', reply);
      })
      .catch(function () {
        removeTyping(typingId);
        var err = 'Sorry, something went wrong. Please try again or contact us directly at info@dataaischool.com.';
        appendMessage('bot', err);
      })
      .finally(function () {
        isLoading = false;
        setInputEnabled(true);
        var input = document.getElementById('ai-chat-input');
        if (input) input.focus();
      });
  }

  // ---- UI HELPERS ----
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

  function appendMessageAnimated(role, text) {
    var messagesEl = document.getElementById('ai-chat-messages');
    var div = document.createElement('div');
    div.className = 'ai-msg ai-msg-' + role + ' ai-msg-new';
    var bubble = document.createElement('div');
    bubble.className = 'ai-msg-bubble';
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();

    // Typewriter effect
    var i = 0;
    var speed = Math.max(8, Math.min(20, Math.round(3000 / text.length)));
    function type() {
      if (i < text.length) {
        bubble.textContent += text[i];
        i++;
        scrollToBottom();
        setTimeout(type, speed);
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
    var send = document.getElementById('ai-chat-send');
    if (input) input.disabled = !enabled;
    if (send) send.disabled = !enabled;
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
