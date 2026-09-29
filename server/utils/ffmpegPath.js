const fs = require("node:fs");
const path = require("node:path");

function existingFile(...paths) {
  return paths.filter(Boolean).find((candidate) => fs.existsSync(candidate));
}

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  const projectRoot = process.env.VOCALIS_APP_ROOT || path.join(__dirname, "../..");
  const resourcesRoot = process.resourcesPath;
  return existingFile(
    process.platform === "win32" && resourcesRoot && path.join(resourcesRoot, "ffmpeg", "win-x64", "ffmpeg.exe"),
    resourcesRoot && path.join(resourcesRoot, "ffmpeg", "bin", "ffmpeg"),
    process.platform === "win32" && path.join(projectRoot, "resources", "ffmpeg", "win-x64", "ffmpeg.exe"),
    path.join(projectRoot, "resources", "ffmpeg", "bin", "ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg"
  ) || "ffmpeg";
}

module.exports = { resolveFfmpegPath };
