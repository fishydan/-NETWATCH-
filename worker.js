const ALLOWED_ORIGIN = "https://www.arasaka-archives.devs.surf";

const ALLOWED_MODELS = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
]);

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 500;
const MAX_BODY_BYTES = 16000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

const rateBuckets = new Map();

const SYSTEM_PROMPT =
  "You are NCPD Neural Assistance Node, a helpful AI embedded in a Cyberpunk-inspired Night City personal terminal. " +
  "Be intelligent, concise but detailed when useful. Distinguish real-world facts from Cyberpunk fictional lore. " +
  "Never claim fictional corporations are real. Use terminal-style headings sparingly.";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  const current = rateBuckets.get(ip);

  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return true;
  }

  current.count += 1;
  return current.count <= RATE_LIMIT_MAX;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }

  return headers;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    const origin = request.headers.get("Origin");

    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed." }, 403, cors);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405, cors);
    }

    if (!env.GROQ_API_KEY) {
      return json({ error: "AI service is not configured." }, 503, cors);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: "Request too large." }, 413, cors);
    }

    const ip = getClientIp(request);
    if (!checkRateLimit(ip)) {
      return json(
        { error: "Rate limit reached. Please wait a moment and try again." },
        429,
        { ...cors, "Retry-After": "60" }
      );
    }

    let body;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
        return json({ error: "Request too large." }, 413, cors);
      }
      body = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON." }, 400, cors);
    }

    const model = typeof body.model === "string" ? body.model : "";
    if (!ALLOWED_MODELS.has(model)) {
      return json({ error: "Model not allowed." }, 400, cors);
    }

    if (!Array.isArray(body.messages) || body.messages.length > MAX_MESSAGES) {
      return json({ error: "Invalid message history." }, 400, cors);
    }

    const messages = body.messages.map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content:
        typeof m?.content === "string"
          ? m.content.slice(0, MAX_MESSAGE_CHARS)
          : "",
    }));

    if (messages.some((m) => !m.content.trim())) {
      return json({ error: "Invalid message content." }, 400, cors);
    }

    let upstream;
    try {
      upstream = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
          }),
        }
      );
    } catch (error) {
      console.error("Groq fetch failed:", error);
      return json({ error: "Could not reach the AI service." }, 502, cors);
    }

    if (!upstream.ok) {
      console.error("Groq upstream error:", upstream.status);
      return json(
        { error: "The AI service returned an error. Please try again." },
        502,
        cors
      );
    }

    let data;
    try {
      data = await upstream.json();
    } catch {
      return json({ error: "The AI service returned invalid data." }, 502, cors);
    }

    const answer = data?.choices?.[0]?.message?.content;

    if (typeof answer !== "string" || !answer.trim()) {
      return json({ error: "The AI returned an empty response." }, 502, cors);
    }

    return json({ text: answer }, 200, cors);
  },
};
