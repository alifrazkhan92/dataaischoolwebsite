/**
 * DAIS AI Chat - Cloudflare Worker
 *
 * POST /          — chat endpoint (AI response + D1 logging)
 * POST /visitor   — register visitor details before chat starts
 * POST /tts       — text-to-speech via ElevenLabs
 * POST /stt       — speech-to-text via ElevenLabs
 * GET  /?action=logs&key=ADMIN_KEY  — admin log viewer
 *
 * Secrets (set via wrangler secret put):
 *   ANTHROPIC_API_KEY
 *   ELEVENLABS_API_KEY
 *   ADMIN_KEY
 *
 * Env vars (wrangler.toml [vars]):
 *   KNOWLEDGE_BASE_URL    — raw GitHub URL to ai-knowledge-base.txt
 *   ALLOWED_ORIGIN        — your site origin
 *   ELEVENLABS_VOICE_ID   — ElevenLabs voice ID (optional, default: Rachel)
 *
 * D1 binding: dais_chat_logs
 */

const MODEL           = 'claude-haiku-4-5';
const MAX_TOKENS      = 800;
const KB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_VOICE   = '21m00Tcm4TlvDq8ikWAM'; // ElevenLabs "Rachel" — warm professional female
const EL_TTS_MODEL    = 'eleven_multilingual_v2'; // 29 languages, natural accent per language

// Security limits
const STT_MAX_BYTES   = 5 * 1024 * 1024; // 5 MB audio upload cap
const TTS_MAX_CHARS   = 1000;            // max chars forwarded to ElevenLabs per request
const KB_MAX_BYTES    = 512 * 1024;      // 512 KB knowledge-base response cap (SEC-005)
const POST_MAX_BYTES  = 32 * 1024;       // 32 KB max POST body for chat/visitor (SEC-018)

// In-memory rate limiter (best-effort; resets per isolate restart)
// For strict distributed limiting add a Cloudflare Rate Limiting rule in the dashboard.
const rateLimiter = new Map(); // IP -> { count, windowStart }
const RATE_WINDOWS = {
  '/':        { max: 20,  windowMs: 60_000 },  // chat: 20 req/min
  '/visitor': { max: 5,   windowMs: 60_000 },  // visitor reg: 5 req/min
  '/tts':     { max: 15,  windowMs: 60_000 },  // TTS: 15 req/min
  '/stt':     { max: 10,  windowMs: 60_000 },  // STT: 10 req/min
  '/enquiry': { max: 10,  windowMs: 60_000 },  // enquiry: 10 req/min
};

function checkRateLimit(path, ip) {
  const rule = RATE_WINDOWS[path] || RATE_WINDOWS['/'];
  const key  = path + ':' + ip;
  const now  = Date.now();
  const rec  = rateLimiter.get(key) || { count: 0, windowStart: now };
  if (now - rec.windowStart > rule.windowMs) {
    rec.count = 0; rec.windowStart = now;
  }
  rec.count++;
  rateLimiter.set(key, rec);
  return rec.count <= rule.max;
}

// Data retention: rows older than 90 days are purged (runs on every chat request, 1% probability)
async function maybePurgeOldLogs(env) {
  if (Math.random() > 0.01) return; // run ~1% of requests to avoid overhead
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    await env.dais_chat_logs.prepare(
      'DELETE FROM chat_logs WHERE created_at < ?'
    ).bind(cutoff).run();
    await env.dais_chat_logs.prepare(
      'DELETE FROM visitor_sessions WHERE created_at < ?'
    ).bind(cutoff).run();
    // Enquiries kept for 2 years (business records)
    const enqCutoff = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
    await env.dais_chat_logs.prepare(
      'DELETE FROM wa_messages WHERE created_at < ?'
    ).bind(enqCutoff).run();
    await env.dais_chat_logs.prepare(
      'DELETE FROM enquiries WHERE created_at < ?'
    ).bind(enqCutoff).run();
  } catch (e) {
    console.error('Purge error:', e.message);
  }
}

let cachedKB       = null;
let cacheTimestamp = 0;

// ── Knowledge base ────────────────────────────────────────────────────────────

async function getKnowledgeBase(env) {
  const now = Date.now();
  if (cachedKB && (now - cacheTimestamp) < KB_CACHE_TTL_MS) return cachedKB;
  try {
    const url = env.KNOWLEDGE_BASE_URL ||
      'https://raw.githubusercontent.com/alifrazkhan92/dataaischoolwebsite/main/ai-knowledge-base.txt';
    const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) throw new Error('KB fetch failed: ' + res.status);

    // SEC-005: enforce a hard 512 KB cap on the knowledge base to prevent memory exhaustion
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > KB_MAX_BYTES) throw new Error('KB response too large');

    // Read with byte limit enforced during streaming
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > KB_MAX_BYTES) throw new Error('KB response exceeded size limit');
      chunks.push(value);
    }
    cachedKB       = new TextDecoder().decode(
      chunks.reduce((acc, c) => { const m = new Uint8Array(acc.length + c.length); m.set(acc); m.set(c, acc.length); return m; }, new Uint8Array(0))
    );
    cacheTimestamp = now;
    return cachedKB;
  } catch (e) {
    console.error('KB fetch error:', e.message);
    return cachedKB || 'You are an AI assistant for The Data and AI School of London (DAIS). Answer questions about DAIS qualifications, admissions and contact. If unsure, direct visitors to www.dataaischool.com or +44 207 0990 956.';
  }
}

function buildSystemPrompt(kb) {
  return `You are the friendly admissions assistant for The Data and AI School of London (DAIS). You speak in a warm, conversational tone, as if you are chatting with someone face to face.

LANGUAGE RULE - this is the most important rule:
Detect the language of the user's message and reply in exactly that same language every time. If the user writes or speaks in Urdu, reply in Urdu. If in Arabic, reply in Arabic. If in French, reply in French. If in Spanish, reply in Spanish. Never switch to English unless the user writes to you in English. Match the user's language on every single reply without exception.

STRICT FORMATTING RULES - you must follow these without exception:
- Write in plain sentences only. No bullet points, no numbered lists, no headers.
- Never use markdown of any kind: no asterisks, no hash symbols, no underscores, no backticks.
- Never use em dashes or en dashes. Use commas or short sentences instead.
- Keep answers to 2 to 4 short conversational sentences. If the answer needs more detail, offer to explain further rather than listing everything at once.
- End with a natural follow-up question or offer to help further, as a real person would.

Example of the right tone (English):
"Great question! Our Level 4 Data Analyst diploma is a Higher Technical Qualification, which means it is nationally recognised and sits just below degree level. Entry normally requires a Level 3 qualification or equivalent experience, though we assess everyone individually. Would you like to know more about what the course covers?"

If a question falls outside the knowledge base, direct the visitor to info@dataaischool.com or call +44 207 0990 956. Never invent information.

KNOWLEDGE BASE:
${kb}`;
}

// ── Security response headers ─────────────────────────────────────────────────
// Applied to every response (API + admin). Varies per response type.

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',          // SEC-009: prevent MIME sniffing
  'X-Frame-Options':        'DENY',             // SEC-009: block iframe embedding
  'Referrer-Policy':        'strict-origin-when-cross-origin',
};

const ADMIN_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  'Cache-Control':           'no-store, no-cache, private',  // SEC-006: never cache PII
  'Pragma':                  'no-cache',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none';",  // SEC-007
};

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || 'https://www.dataaischool.com';
  const isAllowed = origin === allowed;
  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',   // SEC-008: prevent CORS cache poisoning
    ...SECURITY_HEADERS,
  };
}

// Server-side origin gate: reject requests from disallowed origins outright.
// Browser callers that pass a wrong Origin are blocked; direct API callers
// with no Origin header (curl, server-to-server) are also rejected so that
// only the DAIS website can use the endpoints.
function originAllowed(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || 'https://www.dataaischool.com';
  // Require an Origin header — block headless/direct callers
  if (!origin) return false;
  return origin === allowed;
}

// ── Shared error helper ───────────────────────────────────────────────────────

function jsonError(status, message, headers) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// ── D1 logging ────────────────────────────────────────────────────────────────

async function logConversation(env, sessionId, turn, visitorMsg, aiReply) {
  if (!env.dais_chat_logs) return;
  try {
    const now = new Date().toISOString();
    await env.dais_chat_logs.prepare(
      `INSERT INTO chat_logs (session_id, created_at, visitor_msg, ai_reply, turn)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(sessionId, now, visitorMsg, aiReply, turn).run();
  } catch (e) {
    console.error('D1 log error:', e.message);
  }
}

// ── Chat handler ──────────────────────────────────────────────────────────────

async function handleChat(request, env, ctx, headers) {
  // SEC-018: enforce POST body size limit
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > POST_MAX_BYTES) return jsonError(413, 'Request body too large', headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON', headers);
  }

  const { messages, sessionId } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError(400, 'messages array required', headers);
  }

  const cleanMessages = messages.slice(-10).map(m => ({
    role:    m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 2000),
  }));

  const safeSessionId = typeof sessionId === 'string'
    ? sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)
    : 'unknown';

  const kb           = await getKnowledgeBase(env);
  const systemPrompt = buildSystemPrompt(kb);

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type:          'text',
            text:          systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: cleanMessages,
      }),
    });
  } catch (e) {
    return jsonError(502, 'Failed to reach AI service. Please try again.', headers);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    console.error('Anthropic error:', errText);
    return jsonError(502, 'AI service error. Please try again.', headers);
  }

  const data  = await anthropicRes.json();
  const reply = data.content?.[0]?.text ||
    'Sorry, I could not generate a response. Please contact us at info@dataaischool.com.';

  const turn = Math.ceil(cleanMessages.length / 2);
  const lastUserMsg = cleanMessages.filter(m => m.role === 'user').pop()?.content || '';
  ctx.waitUntil(logConversation(env, safeSessionId, turn, lastUserMsg, reply));

  return new Response(JSON.stringify({ reply }), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────

async function handleTTS(request, env, headers) {
  if (!env.ELEVENLABS_API_KEY) {
    return jsonError(503, 'TTS not configured', headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON', headers);
  }

  const text = String(body.text || '').slice(0, TTS_MAX_CHARS).trim();
  if (!text) return jsonError(400, 'text required', headers);

  const voiceId = env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;

  let elRes;
  try {
    elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key':   env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: EL_TTS_MODEL,
        voice_settings: {
          stability:        0.5,
          similarity_boost: 0.75,
          style:            0,
          use_speaker_boost: true,
        },
      }),
    });
  } catch (e) {
    console.error('ElevenLabs TTS fetch error:', e.message);
    return jsonError(502, 'TTS service unreachable', headers);
  }

  if (!elRes.ok) {
    const errText = await elRes.text();
    console.error('ElevenLabs TTS error:', elRes.status, errText);
    return jsonError(502, 'TTS generation failed', headers);
  }

  // Stream the audio directly back to the browser
  return new Response(elRes.body, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type':  'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
}

// ── ElevenLabs STT ────────────────────────────────────────────────────────────

async function handleSTT(request, env, headers) {
  if (!env.ELEVENLABS_API_KEY) {
    return jsonError(503, 'STT not configured', headers);
  }

  const mimeType  = request.headers.get('Content-Type') || 'audio/webm';
  const extension = mimeType.includes('mp4') ? 'm4a'
                  : mimeType.includes('ogg') ? 'ogg'
                  : 'webm';

  let audioData;
  try {
    audioData = await request.arrayBuffer();
  } catch {
    return jsonError(400, 'Could not read audio', headers);
  }

  if (!audioData.byteLength) return jsonError(400, 'Empty audio', headers);
  if (audioData.byteLength > STT_MAX_BYTES) return jsonError(413, 'Audio file too large (max 5 MB)', headers);

  const formData = new FormData();
  formData.append(
    'file',
    new File([audioData], `recording.${extension}`, { type: mimeType }),
  );
  formData.append('model_id', 'scribe_v1');

  let elRes;
  try {
    elRes = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method:  'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
      body:    formData,
    });
  } catch (e) {
    console.error('ElevenLabs STT fetch error:', e.message);
    return jsonError(502, 'STT service unreachable', headers);
  }

  if (!elRes.ok) {
    const errText = await elRes.text();
    console.error('ElevenLabs STT error:', elRes.status, errText);
    return jsonError(502, 'STT transcription failed', headers);
  }

  const data = await elRes.json();
  // Return both the transcript and the detected language code so the
  // frontend can include it as a hint to Claude on the first message
  return new Response(JSON.stringify({
    text:     data.text            || '',
    language: data.language_code   || '',  // e.g. "ur", "ar", "fr", "es"
  }), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// ── Visitor registration ──────────────────────────────────────────────────────

// Table is created via wrangler migration (schema.sql).
// This function is a no-op safety net only — exec() is unreliable for DDL in D1.
async function ensureVisitorTable(env) {
  // No-op: visitor_sessions is created via `wrangler d1 execute` / schema.sql
  // Kept here so callers don't need changing if we ever add guard logic.
}

async function handleVisitor(request, env, headers) {
  // SEC-018: enforce POST body size limit
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > POST_MAX_BYTES) return jsonError(413, 'Request body too large', headers);

  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'Invalid JSON', headers); }

  const { sessionId, name, email, phone } = body;
  if (!sessionId) return jsonError(400, 'sessionId required', headers);

  // Enforce minimum 2-of-3 server-side as well
  const filled = [name, email, phone].filter(v => typeof v === 'string' && v.trim().length > 0).length;
  if (filled < 2) return jsonError(400, 'At least 2 contact fields are required', headers);

  if (!env.dais_chat_logs) return jsonError(503, 'D1 not configured', headers);

  await ensureVisitorTable(env);

  const safeId = typeof sessionId === 'string'
    ? sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)
    : 'unknown';

  try {
    await env.dais_chat_logs.prepare(
      `INSERT OR REPLACE INTO visitor_sessions
         (session_id, created_at, visitor_name, visitor_email, visitor_phone)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      safeId,
      new Date().toISOString(),
      (name  || '').trim().slice(0, 100),
      (email || '').trim().slice(0, 200),
      (phone || '').trim().slice(0, 50)
    ).run();
  } catch (e) {
    console.error('Visitor insert error:', e.message);
    return jsonError(500, 'Could not save visitor info', headers);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// ── WhatsApp helpers ──────────────────────────────────────────────────────────

/**
 * Normalise a raw phone string to E.164 (+44...) format.
 * Returns null if the result looks obviously wrong.
 */
function normalizePhone(raw) {
  let n = String(raw || '').replace(/[\s\-().​]/g, '');
  if (!n) return null;
  if (n.startsWith('00'))  n = '+' + n.slice(2);
  if (/^07\d{9}$/.test(n)) n = '+44' + n.slice(1);   // UK mobile without country code
  else if (/^0\d{10}$/.test(n)) n = '+44' + n.slice(1); // UK landline without country code
  else if (!n.startsWith('+')) n = '+' + n;
  // Must start with + followed by at least 7 digits
  if (!/^\+\d{7,15}$/.test(n)) return null;
  return n;
}

/**
 * Send a pre-approved WhatsApp template message to the enquirer.
 * Template "dais_enquiry_confirmation" must be approved in Meta Business Manager.
 * Variables: {{1}} = first name, {{2}} = courses URL.
 */
async function sendWhatsAppTemplate(env, phone, name) {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v22.0/${env.WA_PHONE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'template',
          template: {
            name: 'dais_enquiry_confirmation',
            language: { code: 'en_GB' },
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: name.split(' ')[0] },   // first name only
                { type: 'text', text: 'https://www.dataaischool.com/courses.html' },
              ],
            }],
          },
        }),
      }
    );
    const data = await resp.json();
    if (resp.ok && data.messages?.[0]?.id) {
      console.log('WhatsApp sent:', data.messages[0].id);
      return { ok: true, msgId: data.messages[0].id };
    }
    const err = data.error || {};
    console.error(`WhatsApp template error [${err.code}]: ${err.message}`);
    return { ok: false };
  } catch (e) {
    console.error('WhatsApp send error:', e.message);
    return { ok: false };
  }
}

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 */
async function verifyWASignature(body, signature, secret) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(raw)).map(b => b.toString(16).padStart(2, '0')).join('');
    const expected = 'sha256=' + hex;
    if (signature.length !== expected.length) return false;
    const enc = new TextEncoder();
    try {
      return await crypto.subtle.timingSafeEqual(enc.encode(signature), enc.encode(expected));
    } catch {
      let diff = 0;
      const a = enc.encode(signature), b = enc.encode(expected);
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      return diff === 0;
    }
  } catch (e) {
    console.error('WA signature error:', e.message);
    return false;
  }
}

// ── Enquiry handler ───────────────────────────────────────────────────────────

async function handleEnquiry(request, env, headers) {
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > POST_MAX_BYTES) return jsonError(413, 'Request body too large', headers);

  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'Invalid JSON', headers); }

  const name    = String(body.name    || '').trim().slice(0, 100);
  const email   = String(body.email   || '').trim().slice(0, 200);
  const phone   = String(body.phone   || '').trim().slice(0, 50);
  const subject = String(body.subject || '').trim().slice(0, 200);
  const message = String(body.message || '').trim().slice(0, 2000);

  if (!name || !email || !message) {
    return jsonError(400, 'name, email and message are required', headers);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonError(400, 'Invalid email address', headers);
  }

  if (!env.dais_chat_logs) return jsonError(503, 'D1 not configured', headers);

  const now           = new Date().toISOString();
  const normalPhone   = normalizePhone(phone);
  const initialStatus = normalPhone ? 'pending' : 'no_phone';

  // Store enquiry
  let enquiryId;
  try {
    const result = await env.dais_chat_logs.prepare(
      `INSERT INTO enquiries (created_at, name, email, phone, subject, message, wa_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(now, name, email, phone || null, subject || null, message, initialStatus).run();
    enquiryId = result.meta.last_row_id;
  } catch (e) {
    console.error('Enquiry insert error:', e.message);
    return jsonError(500, 'Could not save enquiry', headers);
  }

  // Send WhatsApp confirmation
  if (normalPhone && env.WA_TOKEN && env.WA_PHONE_ID) {
    const result = await sendWhatsAppTemplate(env, normalPhone, name);
    const waStatus = result.ok ? 'sent' : 'failed';

    await env.dais_chat_logs.prepare(
      'UPDATE enquiries SET wa_status = ? WHERE id = ?'
    ).bind(waStatus, enquiryId).run().catch(() => {});

    if (result.ok) {
      const confirmText = `Hi ${name.split(' ')[0]}, thank you for your enquiry at The Data and AI School of London. We have received your message and will reply within two working days. Explore our courses: https://www.dataaischool.com/courses.html`;
      await env.dais_chat_logs.prepare(
        `INSERT INTO wa_messages (enquiry_id, created_at, direction, wa_phone, message_text, wa_msg_id)
         VALUES (?, ?, 'outbound', ?, ?, ?)`
      ).bind(enquiryId, now, normalPhone, confirmText, result.msgId || null).run().catch(() => {});
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// ── WhatsApp webhook handlers ─────────────────────────────────────────────────

/** GET /wa-webhook — Meta calls this once to verify the endpoint. */
async function handleWAWebhookVerify(request, env) {
  const url       = new URL(request.url);
  const mode      = url.searchParams.get('hub.mode');
  const token     = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === env.WA_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

/** POST /wa-webhook — receives incoming WhatsApp messages from users. */
async function handleWAWebhookEvent(request, env) {
  const rawBody = await request.text();

  // Verify Meta signature
  if (env.WA_APP_SECRET) {
    const sig   = request.headers.get('X-Hub-Signature-256') || '';
    const valid = await verifyWASignature(rawBody, sig, env.WA_APP_SECRET);
    if (!valid) {
      console.error('WA webhook signature mismatch');
      return new Response('Forbidden', { status: 403 });
    }
  }

  let data;
  try { data = JSON.parse(rawBody); }
  catch { return new Response('OK', { status: 200 }); }

  if (data.object !== 'whatsapp_business_account') {
    return new Response('OK', { status: 200 });
  }

  const now = new Date().toISOString();
  for (const entry of (data.entry || [])) {
    for (const change of (entry.changes || [])) {
      for (const msg of (change.value?.messages || [])) {
        if (msg.type !== 'text') continue;
        const fromPhone  = '+' + msg.from;   // Meta omits the +
        const text       = msg.text?.body || '';
        const waMsgId    = msg.id;

        try {
          // Match to most recent enquiry with this phone number (last 9 digits match)
          const tail    = msg.from.slice(-9);
          const enquiry = await env.dais_chat_logs.prepare(
            `SELECT id FROM enquiries WHERE replace(replace(phone,'+',''),' ','') LIKE ? ORDER BY created_at DESC LIMIT 1`
          ).bind('%' + tail).first();

          await env.dais_chat_logs.prepare(
            `INSERT INTO wa_messages (enquiry_id, created_at, direction, wa_phone, message_text, wa_msg_id)
             VALUES (?, ?, 'inbound', ?, ?, ?)`
          ).bind(enquiry?.id || null, now, fromPhone, text, waMsgId).run();
        } catch (e) {
          console.error('WA message store error:', e.message);
        }
      }
    }
  }

  // Always return 200 immediately — Meta retries on any other status
  return new Response('OK', { status: 200 });
}

// ── Admin log viewer ──────────────────────────────────────────────────────────

async function handleAdminLogs(request, env) {
  const url    = new URL(request.url);
  const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit  = 50;
  const offset = (page - 1) * limit;

  // SEC-001: accept key from URL param (entry point) OR Authorization header (pagination AJAX)
  // Key is stored in sessionStorage client-side and sent as a header on subsequent requests.
  const authHeader = request.headers.get('Authorization') || '';
  let key = url.searchParams.get('key') || '';
  if (!key && authHeader.startsWith('Bearer ')) {
    key = authHeader.slice(7).trim();
  }

  if (!env.ADMIN_KEY || !await timingSafeEqual(key, env.ADMIN_KEY)) {
    return new Response(
      '<!doctype html><html><head><title>Unauthorised</title></head><body style="font-family:system-ui;padding:2rem"><h2>401 Unauthorised</h2><p>Invalid or missing admin key.</p></body></html>',
      {
        status: 401,
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'WWW-Authenticate': 'Bearer realm="DAIS Admin"', ...ADMIN_SECURITY_HEADERS },
      }
    );
  }

  if (!env.dais_chat_logs) {
    return new Response('D1 not configured', { status: 503 });
  }

  // Ensure visitor_sessions table exists before JOIN
  await ensureVisitorTable(env);

  const { results } = await env.dais_chat_logs.prepare(
    `SELECT c.session_id, c.created_at, c.turn, c.visitor_msg, c.ai_reply,
            v.visitor_name, v.visitor_email, v.visitor_phone
     FROM chat_logs c
     LEFT JOIN visitor_sessions v ON c.session_id = v.session_id
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const { results: countResult } = await env.dais_chat_logs.prepare(
    'SELECT COUNT(*) as total FROM chat_logs'
  ).all();
  const total = countResult[0]?.total || 0;
  const pages = Math.ceil(total / limit);

  const rows = (results || []).map(r => {
    const visitor = [
      r.visitor_name  ? `<strong>${esc(r.visitor_name)}</strong>` : '',
      r.visitor_email ? `<a href="mailto:${esc(r.visitor_email)}">${esc(r.visitor_email)}</a>` : '',
      r.visitor_phone ? esc(r.visitor_phone) : '',
    ].filter(Boolean).join('<br>') || '<span style="color:#aaa">unknown</span>';
    return `
    <tr>
      <td>${esc(r.created_at.replace('T',' ').slice(0,19))} UTC</td>
      <td><code>${esc(r.session_id.slice(0,8))}…</code></td>
      <td style="text-align:center">${esc(r.turn)}</td>
      <td>${visitor}</td>
      <td>${esc(r.visitor_msg)}</td>
      <td>${esc(r.ai_reply)}</td>
    </tr>`;
  }).join('');

  // SEC-001: pagination links use AJAX so the key never re-appears in URL or browser history
  const prevLink = page > 1     ? `<button onclick="nav(${page-1})">&#8592; Previous</button>` : '';
  const nextLink = page < pages ? `<button onclick="nav(${page+1})">Next &#8594;</button>` : '';

  const html = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>DAIS Chat Logs</title>
<style>
  body{font-family:system-ui,sans-serif;padding:2rem;background:#f5f0e8;color:#1b1612}
  h1{color:#0a2240}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(10,34,64,.08)}
  th{background:#0a2240;color:#fff;padding:10px 12px;text-align:left;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
  td{padding:9px 12px;border-bottom:1px solid #e8e0d4;font-size:.875rem;vertical-align:top;max-width:320px;word-break:break-word}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#f9f5ef}
  code{font-size:.8rem;color:#666}
  .meta{margin-bottom:1rem;color:#6b5e52;font-size:.875rem}
  .pager{margin-top:1rem;display:flex;gap:1rem;align-items:center}
  button{background:#0a2240;color:#fff;border:none;padding:.45rem 1rem;border-radius:6px;cursor:pointer;font-weight:700}
  button:hover{background:#0e2e5a}
</style>
<script>
/* SEC-001 fix: key extracted from URL once, stored only in sessionStorage,
   then immediately stripped from URL bar and never put back. Pagination
   uses fetch() with Authorization header so the key never appears in any URL. */
(function() {
  var params = new URLSearchParams(location.search);
  var k = params.get('key') || sessionStorage.getItem('_daisAdminKey') || '';
  if (k) sessionStorage.setItem('_daisAdminKey', k);
  // Strip key from URL bar immediately — prevents browser history capture
  params.delete('key');
  history.replaceState(null, '', location.pathname + '?' + params.toString());
})();

function nav(p) {
  var k = sessionStorage.getItem('_daisAdminKey') || '';
  fetch('?action=logs&page=' + p, {
    headers: { 'Authorization': 'Bearer ' + k }
  })
  .then(function(r) { return r.text(); })
  .then(function(html) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    var newTable = doc.querySelector('table');
    var newMeta  = doc.querySelector('.meta');
    var newPager = doc.querySelector('.pager');
    if (newTable) document.querySelector('table').outerHTML = newTable.outerHTML;
    if (newMeta)  document.querySelector('.meta').textContent = newMeta.textContent;
    if (newPager) document.querySelector('.pager').innerHTML  = newPager.innerHTML;
    // Update URL without key
    history.pushState(null, '', '?action=logs&page=' + p);
  })
  .catch(function(e) { alert('Failed to load page: ' + e.message); });
}
</script>
</head><body>
<h1>DAIS Admin</h1>
<nav style="display:flex;gap:1rem;margin-bottom:1.5rem">
  <a href="?action=logs" style="background:#0a2240;color:#fff;padding:.4rem 1rem;border-radius:6px;text-decoration:none;font-weight:600">Chat logs</a>
  <a href="?action=enquiries" style="background:#e5e0d8;color:#0a2240;padding:.4rem 1rem;border-radius:6px;text-decoration:none;font-weight:600">Enquiries &amp; WhatsApp</a>
</nav>
<p class="meta">Showing ${results.length} of ${total} messages. Page ${page} of ${Math.max(1,pages)}.</p>
<table>
<thead><tr><th>Timestamp</th><th>Session</th><th>Turn</th><th>Visitor</th><th>Visitor message</th><th>AI reply</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" style="text-align:center;padding:2rem;color:#999">No conversations yet.</td></tr>'}</tbody>
</table>
<div class="pager">${prevLink} ${nextLink}</div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type':  'text/html;charset=UTF-8',
      'X-Robots-Tag':  'noindex',
      ...ADMIN_SECURITY_HEADERS,
    },
  });
}

// ── Admin enquiries viewer ────────────────────────────────────────────────────

async function handleAdminEnquiries(request, env) {
  const url   = new URL(request.url);
  const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = 30, offset = (page - 1) * limit;

  const authHeader = request.headers.get('Authorization') || '';
  let key = url.searchParams.get('key') || '';
  if (!key && authHeader.startsWith('Bearer ')) key = authHeader.slice(7).trim();

  if (!env.ADMIN_KEY || !await timingSafeEqual(key, env.ADMIN_KEY)) {
    return new Response('Unauthorised', { status: 401, headers: ADMIN_SECURITY_HEADERS });
  }
  if (!env.dais_chat_logs) return new Response('D1 not configured', { status: 503 });

  const { results } = await env.dais_chat_logs.prepare(
    `SELECT id, created_at, name, email, phone, subject, message, wa_status
     FROM enquiries ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const { results: countRes } = await env.dais_chat_logs.prepare(
    'SELECT COUNT(*) as total FROM enquiries'
  ).all();
  const total = countRes[0]?.total || 0;
  const pages = Math.ceil(total / limit);

  // Fetch WhatsApp threads for every enquiry on this page in one query
  const ids = (results || []).map(r => r.id);
  let threads = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const { results: msgs } = await env.dais_chat_logs.prepare(
      `SELECT enquiry_id, direction, created_at, message_text FROM wa_messages
       WHERE enquiry_id IN (${placeholders}) ORDER BY created_at ASC`
    ).bind(...ids).all();
    for (const m of (msgs || [])) {
      if (!threads[m.enquiry_id]) threads[m.enquiry_id] = [];
      threads[m.enquiry_id].push(m);
    }
  }

  const waStatusBadge = s => {
    const map = { sent: '#22c55e', failed: '#ef4444', no_phone: '#9ca3af', pending: '#f59e0b' };
    return `<span style="background:${map[s]||'#9ca3af'};color:#fff;border-radius:4px;padding:2px 7px;font-size:.75rem;font-weight:700">${esc(s)}</span>`;
  };

  const rows = (results || []).map(r => {
    const thread = (threads[r.id] || []).map(m => {
      const align = m.direction === 'outbound' ? 'right' : 'left';
      const bg    = m.direction === 'outbound' ? '#dcf8c6' : '#fff';
      return `<div style="text-align:${align};margin:4px 0">
        <span style="display:inline-block;background:${bg};border:1px solid #e5e7eb;border-radius:8px;padding:4px 10px;max-width:80%;font-size:.8rem;text-align:left">
          <strong style="font-size:.7rem;color:#6b7280">${m.direction === 'outbound' ? 'DAIS' : 'Enquirer'} ${esc(m.created_at.slice(0,16).replace('T',' '))}</strong><br>
          ${esc(m.message_text)}
        </span>
      </div>`;
    }).join('') || '<em style="color:#9ca3af;font-size:.8rem">No WhatsApp messages yet.</em>';

    return `<tr>
      <td>${esc(r.created_at.replace('T',' ').slice(0,16))} UTC</td>
      <td><strong>${esc(r.name)}</strong><br>
          <a href="mailto:${esc(r.email)}">${esc(r.email)}</a><br>
          ${r.phone ? `<a href="https://wa.me/${esc(r.phone.replace('+',''))}">${esc(r.phone)}</a>` : '<span style="color:#9ca3af">no phone</span>'}</td>
      <td>${esc(r.subject || 'General enquiry')}</td>
      <td style="max-width:260px;word-break:break-word">${esc(r.message)}</td>
      <td>${waStatusBadge(r.wa_status)}</td>
      <td style="min-width:200px">${thread}</td>
    </tr>`;
  }).join('');

  const prevLink = page > 1     ? `<button onclick="nav(${page-1})">&#8592; Previous</button>` : '';
  const nextLink = page < pages ? `<button onclick="nav(${page+1})">Next &#8594;</button>` : '';

  const html = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>DAIS Enquiries</title>
<style>
  body{font-family:system-ui,sans-serif;padding:2rem;background:#f5f0e8;color:#1b1612}
  h1{color:#0a2240}.tabs{display:flex;gap:1rem;margin-bottom:1.5rem}
  .tabs a{background:#e5e0d8;color:#0a2240;padding:.4rem 1rem;border-radius:6px;text-decoration:none;font-weight:600}
  .tabs a.active{background:#0a2240;color:#fff}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(10,34,64,.08)}
  th{background:#0a2240;color:#fff;padding:10px 12px;text-align:left;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
  td{padding:9px 12px;border-bottom:1px solid #e8e0d4;font-size:.875rem;vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#f9f5ef}
  .meta{margin-bottom:1rem;color:#6b5e52;font-size:.875rem}
  .pager{margin-top:1rem;display:flex;gap:1rem}
  button{background:#0a2240;color:#fff;border:none;padding:.45rem 1rem;border-radius:6px;cursor:pointer;font-weight:700}
  button:hover{background:#0e2e5a}
</style>
<script>
(function(){
  var p=new URLSearchParams(location.search);
  var k=p.get('key')||sessionStorage.getItem('_daisAdminKey')||'';
  if(k) sessionStorage.setItem('_daisAdminKey',k);
  p.delete('key');
  history.replaceState(null,'',location.pathname+'?'+p.toString());
})();
function nav(p){
  var k=sessionStorage.getItem('_daisAdminKey')||'';
  fetch('?action=enquiries&page='+p,{headers:{'Authorization':'Bearer '+k}})
  .then(r=>r.text()).then(html=>{
    var doc=new DOMParser().parseFromString(html,'text/html');
    ['table','.meta','.pager'].forEach(sel=>{
      var a=document.querySelector(sel),b=doc.querySelector(sel);
      if(a&&b) a.outerHTML=b.outerHTML;
    });
    history.pushState(null,'','?action=enquiries&page='+p);
  }).catch(e=>alert('Error: '+e.message));
}
</script>
</head><body>
<h1>DAIS Admin</h1>
<nav class="tabs">
  <a href="?action=logs">Chat logs</a>
  <a href="?action=enquiries" class="active">Enquiries &amp; WhatsApp</a>
</nav>
<p class="meta">Showing ${(results||[]).length} of ${total} enquiries. Page ${page} of ${Math.max(1,pages)}.</p>
<table>
<thead><tr><th>Date</th><th>Contact</th><th>Subject</th><th>Message</th><th>WhatsApp</th><th>Conversation</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" style="text-align:center;padding:2rem;color:#999">No enquiries yet.</td></tr>'}</tbody>
</table>
<div class="pager">${prevLink} ${nextLink}</div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'X-Robots-Tag': 'noindex', ...ADMIN_SECURITY_HEADERS },
  });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Length mismatch: still do a constant-time compare on same-length buffers
  // to avoid leaking the key length via timing
  if (aBytes.length !== bBytes.length) {
    // Dummy compare to consume similar time
    await crypto.subtle.digest('SHA-256', aBytes);
    return false;
  }
  try {
    return await crypto.subtle.timingSafeEqual(aBytes, bBytes);
  } catch {
    // Fallback for environments where timingSafeEqual is unavailable
    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
    return diff === 0;
  }
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url     = new URL(request.url);
    const origin  = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env);
    const path    = url.pathname.replace(/\/+$/, '') || '/';
    const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';

    // ── WhatsApp webhook (Meta calls this — no DAIS Origin header) ───────────
    if (path === '/wa-webhook') {
      if (request.method === 'GET')  return handleWAWebhookVerify(request, env);
      if (request.method === 'POST') return handleWAWebhookEvent(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    // Admin log viewer (GET only, requires ADMIN_KEY — no origin check needed)
    if (request.method === 'GET' && url.searchParams.get('action') === 'logs') {
      return handleAdminLogs(request, env);
    }
    if (request.method === 'GET' && url.searchParams.get('action') === 'enquiries') {
      return handleAdminEnquiries(request, env);
    }

    // CORS preflight — respond before origin gate so browsers can check
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    // ── Server-side origin gate ───────────────────────────────────────────────
    // Reject all non-browser and wrong-origin callers. This stops direct API
    // abuse from curl, scripts, or other origins.
    if (!originAllowed(origin, env)) {
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    // ── Per-IP rate limiting ──────────────────────────────────────────────────
    if (!checkRateLimit(path, ip)) {
      return new Response(JSON.stringify({ error: 'Too many requests. Please wait a moment.' }), {
        status: 429,
        headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': '60' },
      });
    }

    // Opportunistic PII purge (runs ~1% of requests, fire-and-forget)
    if (env.dais_chat_logs) ctx.waitUntil(maybePurgeOldLogs(env));

    // Route POST requests
    if (path === '/enquiry') return handleEnquiry(request, env, headers);
    if (path === '/visitor') return handleVisitor(request, env, headers);
    if (path === '/tts')     return handleTTS(request, env, headers);
    if (path === '/stt')     return handleSTT(request, env, headers);

    // Default: chat
    return handleChat(request, env, ctx, headers);
  },
};
