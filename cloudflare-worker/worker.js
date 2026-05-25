/**
 * DAIS AI Chat - Cloudflare Worker
 * Proxies requests to Anthropic API using the DAIS knowledge base as system prompt.
 *
 * Environment variables (set via wrangler secret or dashboard):
 *   ANTHROPIC_API_KEY  - your Anthropic API key
 *
 * Wrangler vars (in wrangler.toml):
 *   KNOWLEDGE_BASE_URL - raw GitHub URL to ai-knowledge-base.txt
 *   ALLOWED_ORIGIN     - your website origin (e.g. https://www.dataaischool.com)
 */

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 800;
const KB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedKB = null;
let cacheTimestamp = 0;

async function getKnowledgeBase(env) {
  const now = Date.now();
  if (cachedKB && (now - cacheTimestamp) < KB_CACHE_TTL_MS) {
    return cachedKB;
  }
  try {
    const url = env.KNOWLEDGE_BASE_URL ||
      'https://raw.githubusercontent.com/alifrazkhan92/dataaischoolwebsite/main/ai-knowledge-base.txt';
    const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) throw new Error('KB fetch failed: ' + res.status);
    cachedKB = await res.text();
    cacheTimestamp = now;
    return cachedKB;
  } catch (e) {
    // Fall back to cached version if available, otherwise use stub
    return cachedKB || 'You are an AI assistant for The Data and AI School of London (DAIS). Answer questions about DAIS qualifications, admissions and contact information. If unsure, direct visitors to www.dataaischool.com or call +44 207 0990 956.';
  }
}

function buildSystemPrompt(kb) {
  return `You are the AI assistant for The Data and AI School of London (DAIS). Your role is to help prospective students and visitors learn about DAIS qualifications, admissions, fees and policies.

Use the knowledge base below to answer questions accurately. Be friendly, concise and helpful. If a question falls outside this knowledge base, direct the visitor to info@dataaischool.com or +44 207 0990 956.

Never invent information. If you are not sure, say so and suggest the visitor contacts the admissions team directly.

Keep answers focused and concise, ideally 2 to 5 sentences. Use plain language. Do not use em dashes or en dashes anywhere in your response.

KNOWLEDGE BASE:
${kb}`;
}

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages array required' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Validate message structure
    const cleanMessages = messages.slice(-10).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 2000),
    }));

    const kb = await getKnowledgeBase(env);
    const systemPrompt = buildSystemPrompt(kb);

    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: systemPrompt,
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

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text || 'Sorry, I could not generate a response. Please contact us at info@dataaischool.com.';

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
