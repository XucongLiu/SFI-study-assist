const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_API_VERSION = "2024-02-01";
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff"]);

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, "utf8");
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const equals = trimmed.indexOf("=");
    if (equals === -1) return;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

function parseArgs(argv) {
  const args = {
    input: "assets/sfi-week2-pages",
    output: "data/ocr/week-02",
    apiVersion: DEFAULT_API_VERSION,
    force: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--api-version") args.apiVersion = argv[++i];
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Azure Vision OCR for SFI page photos

Usage:
  node scripts/azure-vision-ocr.js --input assets/sfi-week2-pages --output data/ocr/week-02

Options:
  --input <folder>       Folder containing page images. Default: assets/sfi-week2-pages
  --output <folder>      Folder for OCR JSON and TXT output. Default: data/ocr/week-02
  --api-version <ver>    Azure Image Analysis API version. Default: ${DEFAULT_API_VERSION}
  --force                Re-run OCR even when an output JSON already exists
  --help                 Show this help

Credentials:
  Set AZURE_VISION_ENDPOINT and AZURE_VISION_KEY in your environment or in .env.local.
`);
}

function requireCredentials() {
  const endpoint = process.env.AZURE_VISION_ENDPOINT || process.env.VISION_ENDPOINT;
  const key = process.env.AZURE_VISION_KEY || process.env.VISION_KEY;

  if (!endpoint || !key) {
    throw new Error(
      "Missing Azure Vision credentials. Set AZURE_VISION_ENDPOINT and AZURE_VISION_KEY in .env.local or environment variables."
    );
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    key,
  };
}

function listImages(inputDir) {
  if (!fs.existsSync(inputDir)) throw new Error(`Input folder does not exist: ${inputDir}`);

  return fs.readdirSync(inputDir)
    .filter(name => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(name => path.join(inputDir, name));
}

function polygonToBox(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;

  const xs = polygon.map(point => point.x);
  const ys = polygon.map(point => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function normalizeResult(raw, imagePath) {
  const blocks = raw.readResult?.blocks || [];
  const lines = [];

  blocks.forEach((block, blockIndex) => {
    (block.lines || []).forEach((line, lineIndex) => {
      lines.push({
        blockIndex,
        lineIndex,
        text: line.text || "",
        boundingPolygon: line.boundingPolygon || [],
        boundingBox: polygonToBox(line.boundingPolygon),
        words: (line.words || []).map(word => ({
          text: word.text || "",
          confidence: word.confidence ?? null,
          boundingPolygon: word.boundingPolygon || [],
          boundingBox: polygonToBox(word.boundingPolygon),
        })),
      });
    });
  });

  return {
    sourceImage: imagePath.replace(/\\/g, "/"),
    modelVersion: raw.modelVersion || null,
    metadata: raw.metadata || null,
    text: lines.map(line => line.text).join("\n"),
    lines,
    raw,
  };
}

async function analyzeImage({ endpoint, key, apiVersion, imagePath }) {
  const url = `${endpoint}/computervision/imageanalysis:analyze?api-version=${encodeURIComponent(apiVersion)}&features=read`;
  const body = fs.readFileSync(imagePath);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Ocp-Apim-Subscription-Key": key,
    },
    body,
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { rawText: text };
  }

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || text || response.statusText;
    throw new Error(`Azure Vision OCR failed for ${imagePath}: HTTP ${response.status} ${message}`);
  }

  return payload;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(errorMessage, fallbackMs) {
  const match = /retry after\s+(\d+)\s+seconds/i.exec(errorMessage || "");
  return match ? (Number(match[1]) + 2) * 1000 : fallbackMs;
}

async function analyzeImageWithRetry(options) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await analyzeImage(options);
    } catch (error) {
      const message = error.message || "";
      const retryable = message.includes("HTTP 429") || message.includes("HTTP 503") || message.includes("HTTP 504");
      if (!retryable || attempt === maxAttempts) throw error;

      const waitMs = retryDelayMs(message, 15000 * attempt);
      console.log(`  Azure throttled the request. Waiting ${Math.round(waitMs / 1000)} seconds before retry ${attempt + 1}/${maxAttempts}...`);
      await sleep(waitMs);
    }
  }
}

async function main() {
  readEnvFile(path.resolve(".env.local"));
  readEnvFile(path.resolve(".env"));

  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const credentials = requireCredentials();
  const inputDir = path.resolve(args.input);
  const outputDir = path.resolve(args.output);
  const images = listImages(inputDir);

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`OCR input: ${inputDir}`);
  console.log(`OCR output: ${outputDir}`);
  console.log(`Images: ${images.length}`);

  for (const imagePath of images) {
    const baseName = path.basename(imagePath, path.extname(imagePath));
    const jsonPath = path.join(outputDir, `${baseName}.json`);
    const txtPath = path.join(outputDir, `${baseName}.txt`);

    if (!args.force && fs.existsSync(jsonPath)) {
      console.log(`Skip ${path.basename(imagePath)} because ${path.relative(process.cwd(), jsonPath)} already exists.`);
      continue;
    }

    console.log(`OCR ${path.basename(imagePath)}...`);
    const raw = await analyzeImageWithRetry({
      ...credentials,
      apiVersion: args.apiVersion,
      imagePath,
    });
    const normalized = normalizeResult(raw, path.relative(process.cwd(), imagePath));

    fs.writeFileSync(jsonPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.writeFileSync(txtPath, `${normalized.text}\n`, "utf8");
    console.log(`  lines: ${normalized.lines.length}`);
  }

  console.log("Done.");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
