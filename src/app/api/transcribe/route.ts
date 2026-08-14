import { rateLimit } from "@/lib/rate-limit";

/**
 * Voice-to-text transcription proxy (Phase 8 mic rebuild, 2026-06-25).
 *
 * The browser records audio (getUserMedia + MediaRecorder — see
 * `useVoiceToText`) and POSTs it here as multipart `audio`. We forward it to
 * Groq's OpenAI-compatible Whisper endpoint and return `{ text }`. This is the
 * "record + server STT" architecture (the way ChatGPT does it) — it works on
 * iPhone Safari + the installed PWA, Android, and desktop, unlike the browser
 * Web Speech API which is unfixable in iOS PWAs. See DECISIONS.md "Mic: record
 * + Groq Whisper".
 *
 * Cost guards mirror `/api/agent` (paid upstream): per-IP rate limit +
 * concurrency cap + a global daily circuit-breaker. Groq's free tier is
 * 2,000 req/day, ~$0.04/hr of audio after.
 */

// Concurrency limiter — bound simultaneous Groq calls (in-memory, single
// Railway Node process; resets on restart).
let _activeRequests = 0;
const MAX_CONCURRENT = 4;

// Global daily request cap — cost circuit-breaker bounding total transcription
// spend across ALL callers (the per-IP limit is bypassable behind shared NAT /
// many IPs). In-memory; resets on restart + at UTC midnight. Tunable via
// TRANSCRIBE_DAILY_LIMIT (default 2000 ≈ Groq's free daily tier).
const _parsedDailyLimit = Number(process.env.TRANSCRIBE_DAILY_LIMIT);
const TRANSCRIBE_DAILY_LIMIT =
  Number.isFinite(_parsedDailyLimit) && _parsedDailyLimit > 0 ? _parsedDailyLimit : 2000;
let _dailyCount = 0;
let _dailyKey = ""; // UTC "YYYY-MM-DD"

function checkDailyBudget(): boolean {
  const today = new Date().toISOString().slice(0, 10); // UTC date
  if (today !== _dailyKey) {
    _dailyKey = today;
    _dailyCount = 0;
  }
  if (_dailyCount >= TRANSCRIBE_DAILY_LIMIT) return false;
  _dailyCount++;
  return true;
}

// Groq's free tier caps uploads at 25MB. Dictation clips are tiny (~30s well
// under 1MB), so anything large is misuse — reject before forwarding upstream.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

export async function POST(req: Request) {
  // Concurrency check — don't overwhelm the upstream.
  if (_activeRequests >= MAX_CONCURRENT) {
    return Response.json({ error: "Busy — try again in a moment." }, { status: 429 });
  }

  // Per-IP rate limit. Same IP-extraction as the other external-proxy routes:
  // `.split(",")[0]` so a spoofed multi-hop header can't extend the budget;
  // `x-real-ip` fallback for proxies that drop x-forwarded-for. See SECURITY_AUDIT.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const rl = rateLimit(`transcribe:${ip}`, { limit: 30, windowMs: 60_000 });
  if (!rl.success) {
    return Response.json({ error: "Slow down — too many recordings." }, { status: 429 });
  }

  // .trim() defends against a trailing space / newline (a classic Windows
  // .env.local gotcha) sneaking into the Bearer header and causing a 401.
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: "Voice input is offline — no transcription key configured." },
      { status: 503 }
    );
  }

  // Parse the uploaded audio.
  let audio: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("audio");
    if (f instanceof File) audio = f;
  } catch {
    return Response.json({ error: "Invalid upload." }, { status: 400 });
  }
  if (!audio || audio.size === 0) {
    return Response.json({ error: "No audio received." }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: "Recording too long." }, { status: 413 });
  }

  // Global daily spend cap — checked just before we commit to a paid Groq call,
  // so only real upstream attempts count toward the budget.
  if (!checkDailyBudget()) {
    return Response.json(
      { error: "Voice input is taking a break — back tomorrow." },
      { status: 429 }
    );
  }

  _activeRequests++;
  try {
    const groqForm = new FormData();
    // Forward the audio with a filename whose extension matches its codec —
    // Groq/Whisper use it to interpret the container. The client names it
    // `recording.<ext>` from the detected MIME type.
    groqForm.append("file", audio, audio.name || "recording.webm");
    groqForm.append("model", GROQ_MODEL);
    groqForm.append("response_format", "json");
    groqForm.append("temperature", "0");
    // Hint English to avoid Whisper's "auto-detect on near-silence" misfires.
    groqForm.append("language", "en");

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: groqForm,
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("OpenBook: Groq transcription error", res.status, err);
      return Response.json({ error: "Couldn't transcribe that — try again." }, { status: 502 });
    }

    const data = (await res.json()) as { text?: string };
    return Response.json({ text: (data.text ?? "").trim() });
  } catch (e) {
    console.error("OpenBook: transcription request failed", e);
    return Response.json({ error: "Couldn't reach transcription right now." }, { status: 502 });
  } finally {
    _activeRequests--;
  }
}
