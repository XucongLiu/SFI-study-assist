const DEFAULT_VOICE = "sv-SE-SofieNeural";

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

export async function onRequestPost(context) {
  const { request, env } = context;
  const key = env.AZURE_SPEECH_KEY;
  const region = env.AZURE_SPEECH_REGION;
  const voice = env.AZURE_SPEECH_VOICE || DEFAULT_VOICE;

  if (!key || !region) {
    return jsonResponse({ error: "Azure Speech is not configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in Cloudflare Pages." }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Expected JSON body." }, 400);
  }

  const text = String(payload?.text || "").trim();
  if (!text) return jsonResponse({ error: "Missing text." }, 400);
  if (text.length > 500) return jsonResponse({ error: "Text is too long for this study helper." }, 400);

  const rate = payload?.slow ? "-20%" : "0%";
  const ssml = `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xml:lang="sv-SE" xmlns="http://www.w3.org/2001/10/synthesis">
  <voice name="${escapeXml(voice)}">
    <prosody rate="${rate}">${escapeXml(text)}</prosody>
  </voice>
</speak>`;

  const azureUrl = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const azureResponse = await fetch(azureUrl, {
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
    return jsonResponse({ error: "Azure Speech request failed.", status: azureResponse.status, details }, 502);
  }

  return new Response(azureResponse.body, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "public, max-age=31536000, immutable"
    }
  });
}

export function onRequestGet() {
  return jsonResponse({ ok: true, endpoint: "POST text here to synthesize Swedish speech." });
}
