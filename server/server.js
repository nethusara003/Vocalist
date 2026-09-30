const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const archiver = require("archiver");
const { chunkText } = require("./utils/textChunker");
const { generateSpeech, start: startTts, stop: stopTts, status: ttsStatus } = require("./services/ttsService");
const { mergeWavFiles, convertToMp3 } = require("./utils/audioMerger");
const { resolveFfmpegPath } = require("./utils/ffmpegPath");

const root = process.env.VOCALIS_APP_ROOT || path.join(__dirname, "..");
const outputDir = process.env.VOCALIS_DATA_DIR || path.join(root, "output");
fs.mkdirSync(outputDir, { recursive: true });
const port = Number(process.env.PORT || 8787);
const MAX_ZIP_FILES = 100;
const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const STATIC_ASSETS = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/style.css", "style.css"],
  ["/script.js", "script.js"]
]);

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 50 * 1024 * 1024) req.destroy(new Error("Request is too large")); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (error) { reject(new Error(`Invalid JSON: ${error.message}`)); } });
    req.on("error", reject);
  });
}
function safeName(name) {
  return (String(name || "vocalis-document").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "vocalis-document");
}
let ffmpegCheckResult = null;
function ffmpegAvailable() {
  if (ffmpegCheckResult === null) {
    ffmpegCheckResult = Boolean(spawnSync(resolveFfmpegPath(), ["-version"], { stdio: "ignore" }).status === 0);
  }
  return ffmpegCheckResult;
}
function diagnostics() {
  const ffmpegPath = resolveFfmpegPath();
  return {
    platform: process.platform,
    architecture: process.arch,
    engine: ttsStatus().engine,
    ready: ttsStatus().ready,
    voices: ttsStatus().voices,
    voiceCount: ttsStatus().voices.length,
    ffmpeg: ffmpegAvailable(),
    ffmpegPath,
    backend: "ready",
    fallback: process.platform === "darwin" ? "macos-say" : process.platform === "win32" ? "windows-sapi" : "unavailable"
  };
}
function localVoices() {
  if (process.platform !== "darwin") return [];
  const output = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
  const voices = output.status === 0 ? output.stdout.split("\n").map((line) => line.trim().match(/^(.+?)\s+([a-z]{2}(?:[-_][A-Z]{2})?)\s+#/i)).filter(Boolean).map((match) => ({ name: match[1].trim(), lang: match[2] })) : [];
  return voices.map(({ name, lang }) => ({ name, lang, engine: "macos-say" }));
}
async function generateDocument(payload) {
  const text = String(payload.text || "").trim();
  if (!text) throw new Error("Text cannot be empty.");
  if (!ffmpegAvailable()) {
    throw new Error(process.platform === "win32"
      ? "Bundled FFmpeg is unavailable. Reinstall Vocalis or configure FFMPEG_PATH."
      : "FFmpeg is required for MP3 conversion and multi-chunk merging. Install it with: brew install ffmpeg");
  }
  const id = crypto.randomUUID();
  const base = safeName(payload.filename || "vocalis-document");
  const chunks = chunkText(text);
  const chunkFiles = [];
  const chunkTimings = [];
  const documentStarted = process.hrtime.bigint();
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkPath = path.join(outputDir, `${id}-${index}.wav`);
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const result = await generateSpeech(chunks[index], payload.options || {}, chunkPath);
          chunkTimings.push(result.durationMs);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await fs.promises.rm(chunkPath, { force: true });
        }
      }
      if (lastError) throw new Error(`Chunk ${index + 1}/${chunks.length} failed after retry: ${lastError.message}`);
      chunkFiles.push(chunkPath);
    }
    const wavPath = path.join(outputDir, `${id}-${base}.wav`);
    const mp3Path = path.join(outputDir, `${id}-${base}.mp3`);
    await mergeWavFiles(chunkFiles, wavPath);
    await convertToMp3(wavPath, mp3Path);
    return {
      id,
      filename: base,
      chunks: chunks.length,
      chunkTimingsMs: chunkTimings,
      totalGenerationMs: Number(process.hrtime.bigint() - documentStarted) / 1e6,
      engine: ttsStatus().engine,
      wav: `/files/${path.basename(wavPath)}`,
      mp3: `/files/${path.basename(mp3Path)}`
    };
  } finally {
    await Promise.all(chunkFiles.map((file) => fs.promises.rm(file, { force: true })));
  }
}
function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
function outputFileForZip(reference) {
  if (typeof reference !== "string" || !reference.startsWith("/files/")) {
    throw badRequest("ZIP files must reference generated /files paths.");
  }
  const filename = reference.slice("/files/".length);
  if (!filename || filename !== path.basename(filename) || filename.includes("\\") || filename.includes("/") || filename.includes("%")) {
    throw badRequest("ZIP file path is invalid.");
  }
  const resolvedOutputDir = path.resolve(outputDir);
  const resolvedFile = path.resolve(resolvedOutputDir, filename);
  if (!resolvedFile.startsWith(`${resolvedOutputDir}${path.sep}`)) {
    throw badRequest("ZIP file path must be inside the output directory.");
  }
  const extension = path.extname(filename).toLowerCase();
  if (extension !== ".wav" && extension !== ".mp3") {
    throw badRequest("ZIP files must be generated WAV or MP3 audio.");
  }
  let stats;
  try {
    stats = fs.statSync(resolvedFile);
  } catch {
    throw badRequest("Requested generated file was not found.");
  }
  if (!stats.isFile()) throw badRequest("Requested generated file is invalid.");
  let realFile;
  try {
    realFile = fs.realpathSync(resolvedFile);
  } catch {
    throw badRequest("Requested generated file was not found.");
  }
  if (!realFile.startsWith(`${fs.realpathSync(resolvedOutputDir)}${path.sep}`)) {
    throw badRequest("ZIP file path must be inside the output directory.");
  }
  return { path: realFile, filename, size: stats.size };
}
function zipEntryName(filename, usedNames) {
  const base = filename.split("-").slice(5).join("-") || filename;
  const extension = path.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  let name = base;
  let suffix = 2;
  while (usedNames.has(name)) name = `${stem} (${suffix++})${extension}`;
  usedNames.add(name);
  return name;
}
function zipFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw badRequest("Select at least one generated file to add to the ZIP.");
  if (files.length > MAX_ZIP_FILES) throw badRequest(`ZIPs are limited to ${MAX_ZIP_FILES} files.`);
  let totalBytes = 0;
  const usedNames = new Set();
  return files.map((file) => {
    const outputFile = outputFileForZip(file && file.path);
    totalBytes += outputFile.size;
    if (totalBytes > MAX_ZIP_BYTES) throw badRequest("ZIP contents exceed the 500 MB limit.");
    return { path: outputFile.path, name: zipEntryName(outputFile.filename, usedNames) };
  });
}
function createZip(files, res) {
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="Vocalis_Output.zip"' });
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (error) => { if (!res.headersSent) json(res, 500, { error: error.message }); else res.destroy(error); });
  archive.pipe(res);
  files.forEach((file) => archive.file(file.path, { name: file.name }));
  archive.finalize();
}
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }
  try {
    if (req.url === "/api/health") return json(res, 200, { ok: true, ffmpeg: ffmpegAvailable(), ...ttsStatus() });
    if (req.method === "GET" && req.url === "/api/diagnostics") return json(res, 200, diagnostics());
    if (req.method === "GET" && req.url === "/api/voices") return json(res, 200, { voices: ttsStatus().voices.length ? ttsStatus().voices.map((name) => ({ name, lang: "local", engine: ttsStatus().engine })) : localVoices() });
    if (req.method === "POST" && req.url === "/api/tts/generate") return json(res, 200, await generateDocument(await readBody(req)));
    if (req.method === "POST" && req.url === "/api/batch/generate") {
      const payload = await readBody(req), results = [];
      for (const document of payload.documents || []) {
        try { results.push({ ...await generateDocument(document), status: "completed" }); }
        catch (error) { results.push({ filename: safeName(document.filename), status: "failed", error: error.message }); }
      }
      return json(res, 200, { results });
    }
    if (req.method === "POST" && req.url === "/api/batch/zip") return createZip(zipFiles((await readBody(req)).files), res);
    if (req.method === "GET" && req.url.startsWith("/files/")) {
      const filename = path.basename(new URL(req.url, "http://localhost").pathname), file = path.join(outputDir, filename);
      let realFile;
      try {
        realFile = fs.realpathSync(file);
      } catch {
        return json(res, 404, { error: "File not found" });
      }
      if (!realFile.startsWith(`${fs.realpathSync(path.resolve(outputDir))}${path.sep}`)) {
        return json(res, 404, { error: "File not found" });
      }
      const size = fs.statSync(realFile).size;
      const contentType = filename.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
      const downloadName = filename.split("-").slice(5).join("-") || filename;
      const range = req.headers.range;
      if (range) {
        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (!match) return json(res, 416, { error: "Invalid byte range" });
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (start > end || start >= size) return json(res, 416, { error: "Requested range is not satisfiable" });
        res.writeHead(206, { "Content-Type": contentType, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Disposition": `inline; filename="${downloadName}"` });
        return fs.createReadStream(realFile, { start, end }).pipe(res);
      }
      res.writeHead(200, { "Content-Type": contentType, "Content-Length": size, "Accept-Ranges": "bytes", "Content-Disposition": `attachment; filename="${downloadName}"` });
      return fs.createReadStream(realFile).pipe(res);
    }
    const assetName = STATIC_ASSETS.get(new URL(req.url, "http://127.0.0.1").pathname);
    if (!assetName) return json(res, 404, { error: "Not found" });
    const filePath = path.join(root, assetName);
    if (!fs.existsSync(filePath)) return json(res, 404, { error: "Not found" });
    const ext = path.extname(filePath), types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" }); fs.createReadStream(filePath).pipe(res);
  } catch (error) { json(res, error.statusCode || 500, { error: error.message }); }
});
startTts()
  .then(() => server.listen(port, "127.0.0.1", () => console.log(`Vocalis local server: http://127.0.0.1:${port} (${ttsStatus().engine})`)))
  .catch((error) => {
    console.error(`Unable to start local TTS worker: ${error.message}`);
    process.exitCode = 1;
  });
process.on("SIGINT", async () => { await stopTts(); process.exit(0); });
process.on("SIGTERM", async () => { await stopTts(); process.exit(0); });
