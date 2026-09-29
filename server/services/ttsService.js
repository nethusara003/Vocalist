const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function generateSpeech(text, options, outputPath) {
  const python = process.env.PYTHON_BIN || "python3";
  const worker = path.join(__dirname, "..", "tts_worker.py");
  return new Promise((resolve, reject) => {
    const child = spawn(python, [worker, "--output", outputPath], {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => reject(new Error(`Unable to start local TTS worker: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) return resolve(outputPath);
      reject(new Error(stderr.trim() || `Local TTS worker exited with code ${code}`));
    });
    child.stdin.end(JSON.stringify({ text, options }));
  });
}

module.exports = { generateSpeech };
