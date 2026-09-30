const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveFfmpegPath } = require("../server/utils/ffmpegPath");

const root = path.join(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server/server.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const ffmpeg = path.join(root, "resources", "ffmpeg", "win-x64", "ffmpeg.exe");

assert.match(serverSource, /const MAX_ZIP_FILES = 100/);
assert.match(serverSource, /const MAX_ZIP_BYTES = 500 \* 1024 \* 1024/);
assert.match(serverSource, /path\.basename/);
assert.match(serverSource, /realpathSync/);
assert.match(serverSource, /startsWith\(`\$\{fs\.realpathSync\(resolvedOutputDir\)\}/);
assert.match(serverSource, /const STATIC_ASSETS = new Map/);
assert.match(serverSource, /server\.listen\(port, "127\.0\.0\.1"/);
assert.match(serverSource, /function diagnostics\(\)/);
assert.doesNotMatch(rendererSource, /\.innerHTML\s*=\s*`/);
assert.doesNotMatch(rendererSource, /\.innerHTML\s*=\s*[^'"]*\$/);
assert.doesNotMatch(rendererSource, /window\.open\s*\(/);

const previousOverride = process.env.FFMPEG_PATH;
process.env.FFMPEG_PATH = path.join(root, "test-override-ffmpeg");
assert.equal(resolveFfmpegPath(), process.env.FFMPEG_PATH);
if (previousOverride === undefined) delete process.env.FFMPEG_PATH;
else process.env.FFMPEG_PATH = previousOverride;

assert.ok(fs.existsSync(ffmpeg), "Bundled Windows FFmpeg is missing");
const header = Buffer.alloc(2);
const fd = fs.openSync(ffmpeg, "r");
try {
  fs.readSync(fd, header, 0, header.length, 0);
} finally {
  fs.closeSync(fd);
}
assert.equal(header.toString("ascii"), "MZ", "Bundled FFmpeg is still an LFS pointer");

console.log("CI validation checks passed.");
