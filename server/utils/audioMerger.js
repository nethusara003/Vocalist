const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { resolveFfmpegPath } = require("./ffmpegPath");

function run(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(stderr.trim() || error.message));
    resolve(stdout);
  }));
}

async function mergeWavFiles(files, output) {
  if (files.length === 1) {
    await fs.promises.copyFile(files[0], output);
    return;
  }
  const ffmpeg = resolveFfmpegPath();
  const listFile = `${output}.concat.txt`;
  await fs.promises.writeFile(listFile, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  try {
    await run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output]);
  } finally {
    await fs.promises.rm(listFile, { force: true });
  }
}

async function convertToMp3(wav, mp3) {
  const ffmpeg = resolveFfmpegPath();
  await run(ffmpeg, ["-y", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "2", mp3]);
}

module.exports = { mergeWavFiles, convertToMp3 };
