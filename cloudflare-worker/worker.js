/**
 * DAIS AI Chat - Cloudflare Worker
 *
 * Handles:
 *   POST /          — chat endpoint (AI response + D1 logging)
 *   GET  /?action=logs&key=ADMIN_KEY  — secure admin log viewer
 *
 * Secrets (set via wrangler secret put):
 *   ANTHROPIC_API_KEY  — Anthropic API key
 *   ADMIN_KEY          — password to access /logs admin page
 *
 * Env vars (wrangler.toml [vars]):
 *   KNOWLEDGE_BASE_URL — raw GitHub URL to ai-knowledge-base.txt
 *   ALLOWED_ORIGIN     — your site origin
 *
 * D1 binding:
 *   dais_chat_logs     — Cloudflare D1 database
 */

const MODEL      = 'claude-haiku-4-5';
const MAX_TOKENS = 800;
const KB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
    cachedKB       = await res.text();
    cacheTimestamp = now;
    return cachedKB;
  } catch (e) {
    return cachedKB || 'You are an AI assistant for The Data and AI School of London (DAIS). Answer questions about DAIS qualifications, admissions and contact. If unsure, direct visitors to www.dataaischool.com or +44 207 0990 956.';
  }
}

function buildSystemPrompt(kb) {
  return `You are the friendly admissions assistant for The Data and AI School of London (DAIS). You speak in a warm, conversational tone, as if you are chatting with someone face to face.

STRICT FORMATTING RULES - you must follow these without exception:
- Write in plain sentences only. No bullet points, no numbered lists, no headers.
- Never use markdown of any kind: no asterisks, no hash symbols, no underscores, no backticks.
- Never use em dashes or en dashes. Use commas or short sentences instead.
- Keep answers to 2 to 4 short conversational sentences. If the answer needs more detail, offer to explain further rather than listing everything at once.
- End with a natural follow-up question or offer to help further, as a real person would.

Example of the right tone:
"Great question! Our Level 4 Data Analyst diploma is a Higher Technical Qualification, which means it is nationally recognised and sits just below degree level. Entry normally requires a Level 3 qualification or equivalent experience, though we assess everyone individually. Would you like to know more about what the course covers?"

If a question falls outside the knowledge base, direct the visitor to info@dataaischool.com or call +44 207 0990 956. Never invent information.

KNOWLEDGE BASE:
${kb}`;
}

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || 'https://www.dataaischool.com';
  const isAllowed = origin === allowed;
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ── D1 logging ────────────────────────────────────────────────────────────────

async function logConversation(env, sessionId, turn, visitorMsg, aiReply) {
  if (!env.dais_chat_logs) return; // D1 not bound (local dev)
  try {
    const now = new Date().toISOString();
    await env.dais_chat_logs.prepare(
      `INSERT INTO chat_logs (session_id, created_at, visitor_msg, ai_reply, turn)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(sessionId, now, visitorMsg, aiReply, turn).run();
  } catch (e) {
    console.error('D1 log error:', e.message);
    // Never fail a chat response due to a logging error
  }
}

// ── Admin log viewer ──────────────────────────────────────────────────────────

async function handleAdminLogs(request, env) {
  const url    = new URL(request.url);
  const key    = url.searchParams.get('key') || '';
  const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit  = 50;
  const offset = (page - 1) * limit;

  // Constant-time comparison to prevent timing attacks
  if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) {
    return new Response('Unauthorised', { status: 401 });
  }

  if (!env.dais_chat_logs) {
    return new Response('D1 not configured', { status: 503 });
  }

  const { results } = await env.dais_chat_logs.prepare(
    `SELECT session_id, created_at, turn, visitor_msg, ai_reply
     FROM chat_logs
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const { results: countResult } = await env.dais_chat_logs.prepare(
    'SELECT COUNT(*) as total FROM chat_logs'
  ).all();
  const total = countResult[0]?.total || 0;
  const pages = Math.ceil(total / limit);

  const rows = (results || []).map(r => `
    <tr>
      <td>${esc(r.created_at.replace('T',' ').slice(0,19))} UTC</td>
      <td><code>${esc(r.session_id.slice(0,8))}…</code></td>
      <td>${esc(r.turn)}</td>
      <td>${esc(r.visitor_msg)}</td>
      <td>${esc(r.ai_reply)}</td>
    </tr>`).join('');

  const prevLink = page > 1
    ? `<a href="?action=logs&key=${esc(key)}&page=${page-1}">Previous</a>` : '';
  const nextLink = page < pages
    ? `<a href="?action=logs&key=${esc(key)}&page=${page+1}">Next</a>` : '';

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
  a{color:#0a2240;font-weight:700}
</style></head><body>
<h1>DAIS AI Chat Logs</h1>
<p class="meta">Showing ${results.length} of ${total} messages. Page ${page} of ${Math.max(1,pages)}.</p>
<table>
<thead><tr><th>Timestamp</th><th>Session</th><th>Turn</th><th>Visitor message</th><th>AI reply</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:2rem;color:#999">No conversations yet.</td></tr>'}</tbody>
</table>
<div class="pager">${prevLink} ${nextLink}</div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'X-Robots-Tag': 'noindex' },
  });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env);

    // Admin log viewer (GET only, no CORS needed)
    if (request.method === 'GET' && url.searchParams.get('action') === 'logs') {
      return handleAdminLogs(request, env);
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const { messages, sessionId } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages array required' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Sanitise
    const cleanMessages = messages.slice(-10).map(m => ({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 2000),
    }));

    const safeSessionId = typeof sessionId === 'string'
      ? sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)
      : 'unknown';

    // Build prompt and call Anthropic
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
      return new Response(JSON.stringify({ error: 'Failed to reach AI service. Please try again.' }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic error:', errText);
      return new Response(JSON.stringify({ error: 'AI service error. Please try again.' }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const data  = await anthropicRes.json();
    const reply = data.content?.[0]?.text ||
      'Sorry, I could not generate a response. Please contact us at info@dataaischool.com.';

    // Log to D1 (fire-and-forget — never delays the response)
    const turn = Math.ceil(cleanMessages.length / 2);
    const lastUserMsg = cleanMessages.filter(m => m.role === 'user').pop()?.content || '';
    ctx.waitUntil(logConversation(env, safeSessionId, turn, lastUserMsg, reply));

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
