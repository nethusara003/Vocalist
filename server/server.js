const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const archiver = require("archiver");
const { chunkText } = require("./utils/textChunker");
const { generateSpeech, start: startTts, stop: stopTts, status: ttsStatus } = require("./services/ttsService");
const { mergeWavFiles, convertToMp3 } = require("./utils/audioMerger");

const root = path.join(__dirname, "..");
const outputDir = path.join(root, "output");
fs.mkdirSync(outputDir, { recursive: true });
const port = Number(process.env.PORT || 8787);

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
function ffmpegAvailable() {
  return Boolean(spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0);
}
function localVoices() {
  const output = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
  const voices = output.status === 0 ? output.stdout.split("\n").map((line) => line.trim().match(/^(.+?)\s+([a-z]{2}(?:[-_][A-Z]{2})?)\s+#/i)).filter(Boolean).map((match) => ({ name: match[1].trim(), lang: match[2] })) : [];
  return [...[{ name: "af_heart", lang: "en-us", engine: "Kokoro" }], ...voices];
}
async function generateDocument(payload) {
  const text = String(payload.text || "").trim();
  if (!text) throw new Error("Text cannot be empty.");
  if (!ffmpegAvailable()) throw new Error("FFmpeg is required for MP3 conversion and multi-chunk merging. Install it with: brew install ffmpeg");
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
function createZip(files, res) {
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="Vocalis_Output.zip"' });
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (error) => { if (!res.headersSent) json(res, 500, { error: error.message }); else res.destroy(error); });
  archive.pipe(res);
  files.forEach((file) => {
    const localPath = String(file.path || "").startsWith("/files/") ? path.join(outputDir, path.basename(file.path)) : file.path;
    if (localPath && fs.existsSync(localPath)) archive.file(localPath, { name: file.name });
  });
  archive.finalize();
}
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }
  try {
    if (req.url === "/api/health") return json(res, 200, { ok: true, ffmpeg: ffmpegAvailable(), ...ttsStatus() });
    if (req.method === "GET" && req.url === "/api/voices") return json(res, 200, { voices: ttsStatus().voices.length ? ttsStatus().voices.map((name) => ({ name, lang: "local", engine: "Kokoro MLX" })) : localVoices() });
    if (req.method === "POST" && req.url === "/api/tts/generate") return json(res, 200, await generateDocument(await readBody(req)));
    if (req.method === "POST" && req.url === "/api/batch/generate") {
      const payload = await readBody(req), results = [];
      for (const document of payload.documents || []) {
        try { results.push({ ...await generateDocument(document), status: "completed" }); }
        catch (error) { results.push({ filename: safeName(document.filename), status: "failed", error: error.message }); }
      }
      return json(res, 200, { results });
    }
    if (req.method === "POST" && req.url === "/api/batch/zip") return createZip((await readBody(req)).files || [], res);
    if (req.method === "GET" && req.url.startsWith("/files/")) {
      const filename = path.basename(new URL(req.url, "http://localhost").pathname), file = path.join(outputDir, filename);
      if (!fs.existsSync(file)) return json(res, 404, { error: "File not found" });
      const size = fs.statSync(file).size;
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
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { "Content-Type": contentType, "Content-Length": size, "Accept-Ranges": "bytes", "Content-Disposition": `attachment; filename="${downloadName}"` });
      return fs.createReadStream(file).pipe(res);
    }
    const filePath = req.url === "/" ? path.join(root, "index.html") : path.join(root, path.normalize(req.url).replace(/^(\.\.(\/|\\|$))+/, ""));
    if (!filePath.startsWith(root) || !fs.existsSync(filePath)) return json(res, 404, { error: "Not found" });
    const ext = path.extname(filePath), types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" }); fs.createReadStream(filePath).pipe(res);
  } catch (error) { json(res, 500, { error: error.message }); }
});
startTts()
  .then(() => server.listen(port, () => console.log(`Vocalis local server: http://localhost:${port} (${ttsStatus().engine})`)))
  .catch((error) => {
    console.error(`Unable to start local TTS worker: ${error.message}`);
    process.exitCode = 1;
  });
process.on("SIGINT", async () => { await stopTts(); process.exit(0); });
process.on("SIGTERM", async () => { await stopTts(); process.exit(0); });
