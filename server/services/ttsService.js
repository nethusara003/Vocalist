const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

class TtsWorkerManager {
  constructor() {
    this.python = process.env.PYTHON_BIN || "python3";
    this.worker = path.join(__dirname, "..", "tts_worker.py");
    this.child = null;
    this.ready = null;
    this.queue = Promise.resolve();
    this.nextId = 1;
    this.pending = new Map();
    this.engine = "starting";
    this.voices = [];
  }

  start() {
    if (this.child && !this.child.killed) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.worker, "--daemon"], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      const output = readline.createInterface({ input: child.stdout });
      output.on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.type === "ready") {
          this.engine = message.engine;
          this.voices = message.voices || [];
          resolve(message);
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.ok) request.resolve(message);
        else request.reject(new Error(message.error || "TTS worker request failed"));
      });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data.toString(); });
      child.once("error", (error) => {
        this.engine = "error";
        reject(new Error(`Unable to start local TTS worker: ${error.message}`));
      });
      child.once("close", (code) => {
        this.child = null;
        this.engine = "offline";
        const error = new Error(stderr.trim() || `Local TTS worker exited with code ${code}`);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        if (this.ready) this.ready = null;
      });
    });
    return this.ready;
  }

  async request(text, options, outputPath) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await this.start();
      const id = String(this.nextId++);
      const response = await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.child.stdin.write(`${JSON.stringify({ id, text, options, output: outputPath })}\n`, (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      });
      return response;
    });
    return this.queue;
  }

  async stop() {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
    this.ready = null;
  }

  status() {
    return { engine: this.engine, ready: Boolean(this.child), voices: this.voices };
  }
}

const manager = new TtsWorkerManager();

async function start() {
  return manager.start();
}

async function generateSpeech(text, options, outputPath) {
  return manager.request(text, options, outputPath);
}

function status() {
  return manager.status();
}

module.exports = { generateSpeech, start, stop: () => manager.stop(), status };
