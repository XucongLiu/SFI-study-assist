const DEFAULT_ENGINE = "azure";
const MAX_TEXT_LENGTH = 1200;

const GOOGLE_CHIRP3_VOICE_NAMES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe", "Callirrhoe",
  "Charon", "Despina", "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus", "Kore",
  "Laomedeia", "Leda", "Orus", "Puck", "Pulcherrima", "Rasalgethi", "Sadachbia",
  "Sadaltager", "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi"
];
const GOOGLE_STANDARD_VOICE_NAMES = ["A", "B", "C", "D", "E", "F", "G"];
const GOOGLE_WAVENET_VOICE_NAMES = ["A", "B", "C", "D", "E", "F", "G"];

const ENGINES = {
  azure: {
    label: "Azure AI Speech",
    defaultVoice: "sv-SE-SofieNeural",
    allowedVoices: new Set([
      "sv-SE-SofieNeural",
      "sv-SE-MattiasNeural"
    ])
  },
  google: {
    label: "Google Cloud Text-to-Speech",
    defaultVoice: "sv-SE-Chirp3-HD-Aoede",
    allowedVoices: new Set([
      ...GOOGLE_CHIRP3_VOICE_NAMES.map(name => `sv-SE-Chirp3-HD-${name}`),
      ...GOOGLE_STANDARD_VOICE_NAMES.map(name => `sv-SE-Standard-${name}`),
      ...GOOGLE_WAVENET_VOICE_NAMES.map(name => `sv-SE-Wavenet-${name}`)
    ])
  }
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function audioResponse(audio, cacheStatus) {
  return new Response(audio, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "public, max-age=31536000, immutable",
      "x-sfi-tts-cache": cacheStatus
    }
  });
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function normalizeEngine(value) {
  const engine = String(value || DEFAULT_ENGINE).toLowerCase();
  return ENGINES[engine] ? engine : DEFAULT_ENGINE;
}

function normalizeVoice(engine, requestedVoice, env) {
  const config = ENGINES[engine];
  const envVoice = engine === "azure" ? env.AZURE_SPEECH_VOICE : env.GOOGLE_TTS_VOICE;
  const voice = String(requestedVoice || envVoice || config.defaultVoice);
  return config.allowedVoices.has(voice) ? voice : config.defaultVoice;
}

function googleAudioConfig(voice, slow) {
  const audioConfig = { audioEncoding: "MP3" };
  if (!voice.includes("-Chirp3-HD-")) {
    audioConfig.speakingRate = slow ? 0.78 : 1;
  }
  return audioConfig;
}

async function synthesizeAzure({ env, text, voice, slow }) {
  const key = env.AZURE_SPEECH_KEY;
  const region = env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    return {
      error: jsonResponse({
        error: "Azure Speech is not configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in Cloudflare Pages."
      }, 500)
    };
  }

  const rate = slow ? "-20%" : "0%";
  const ssml = `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xml:lang="sv-SE" xmlns="http://www.w3.org/2001/10/synthesis">
  <voice name="${escapeXml(voice)}">
    <prosody rate="${rate}">${escapeXml(text)}</prosody>
  </voice>
</speak>`;

  const azureResponse = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "SFI-study-assist"
    },
    body: ssml
  });

  if (!azureResponse.ok) {
    const details = await azureResponse.text().catch(() => "");
    return {
      error: jsonResponse({ error: "Azure Speech request failed.", status: azureResponse.status, details }, 502)
    };
  }

  return { audio: await azureResponse.arrayBuffer() };
}

async function synthesizeGoogle({ env, text, voice, slow }) {
  const key = env.GOOGLE_TTS_API_KEY;
  if (!key) {
    return {
      error: jsonResponse({
        error: "Google Text-to-Speech is not configured. Set GOOGLE_TTS_API_KEY in Cloudflare Pages."
      }, 500)
    };
  }

  const googleResponse = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "SFI-study-assist"
    },
    body: JSON.stringify({
      input: { text },
      voice: {
        languageCode: "sv-SE",
        name: voice
      },
      audioConfig: googleAudioConfig(voice, slow)
    })
  });

  if (!googleResponse.ok) {
    const details = await googleResponse.text().catch(() => "");
    return {
      error: jsonResponse({ error: "Google Text-to-Speech request failed.", status: googleResponse.status, details }, 502)
    };
  }

  const payload = await googleResponse.json();
  if (!payload?.audioContent) {
    return {
      error: jsonResponse({ error: "Google Text-to-Speech did not return audio." }, 502)
    };
  }

  return { audio: base64ToArrayBuffer(payload.audioContent) };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Expected JSON body." }, 400);
  }

  const text = String(payload?.text || "").trim();
  if (!text) return jsonResponse({ error: "Missing text." }, 400);
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `Text is too long for this study helper. Maximum is ${MAX_TEXT_LENGTH} characters.` }, 400);
  }

  const engine = normalizeEngine(payload?.engine);
  const voice = normalizeVoice(engine, payload?.voice, env);
  const requestedSlow = Boolean(payload?.slow);
  const slow = engine === "google" && voice.includes("-Chirp3-HD-") ? false : requestedSlow;
  const cacheKeyHash = await sha256(JSON.stringify({ engine, text, voice, slow }));
  const cacheUrl = new URL(`/api/tts-cache/${cacheKeyHash}.mp3`, request.url);
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return audioResponse(cached.body, "hit");

  const result = engine === "google"
    ? await synthesizeGoogle({ env, text, voice, slow })
    : await synthesizeAzure({ env, text, voice, slow });

  if (result.error) return result.error;

  const response = audioResponse(result.audio, "miss");
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export function onRequestGet() {
  return jsonResponse({
    ok: true,
    endpoint: "POST text here to synthesize Swedish speech.",
    engines: Object.fromEntries(Object.entries(ENGINES).map(([key, config]) => [
      key,
      {
        label: config.label,
        defaultVoice: config.defaultVoice,
        voices: [...config.allowedVoices]
      }
    ]))
  });
}
