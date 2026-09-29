const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const isPackaged = app.isPackaged;
const logFile = path.join(app.getPath("userData"), "startup.log");
function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(logFile, line);
  console.log(message);
}
const projectRoot = isPackaged ? path.join(process.resourcesPath, "app.asar") : path.join(__dirname, "..");
const serverScript = isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked", "server", "server.js")
  : path.join(projectRoot, "server", "server.js");
const loadingPage = path.join(__dirname, "loading.html");
let backend;
let backendPort;
let mainWindow;
let shuttingDown = false;

function existingFile(...paths) {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function runtimeConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "runtime.json"), "utf8"));
  } catch {
    return {};
  }
}

function runtimeEnvironment() {
  const config = runtimeConfig();
  const python = process.env.VOCALIS_PYTHON_BIN
    || process.env.PYTHON_BIN
    || config.pythonBin
    || existingFile(
      path.join(projectRoot, ".venv-kokoro", "bin", "python"),
      path.join(process.resourcesPath, "python", "bin", "python")
    )
    || "python3";
  const ffmpeg = process.env.FFMPEG_PATH
    || config.ffmpegPath
    || existingFile(
      path.join(process.resourcesPath, "ffmpeg", "bin", "ffmpeg"),
      path.join(process.resourcesPath, "ffmpeg", "win-x64", "ffmpeg.exe"),
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg"
    )
    || "ffmpeg";
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_PATH: path.join(projectRoot, "node_modules"),
    PYTHON_BIN: python,
    FFMPEG_PATH: ffmpeg,
    VOCALIS_APP_ROOT: projectRoot,
    VOCALIS_DATA_DIR: path.join(app.getPath("userData"), "output"),
    PORT: String(backendPort),
    PYTHONUNBUFFERED: "1"
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 120000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out while starting the local TTS backend."));
        return;
      }
      const request = http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          try {
            const health = JSON.parse(body);
            if (response.statusCode === 200 && health.ok && health.ready) {
              resolve(health);
            } else {
              setTimeout(check, 250);
            }
          } catch {
            setTimeout(check, 250);
          }
        });
      });
      request.on("error", () => setTimeout(check, 250));
      request.setTimeout(1000, () => request.destroy());
    };
    check();
  });
}

function showStartupError(error) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <main style="font: -apple-system-body; padding: 48px; color: #f3f4f6; background: #0b1120; min-height: 100vh">
      <h1>Vocalis could not start</h1>
      <p>${String(error.message).replace(/[<>&]/g, "")}</p>
      <p>Check that Python, Kokoro MLX (or macOS say), and FFmpeg are installed.</p>
    </main>
  `)}`);
}

async function startBackend() {
  backendPort = await findFreePort();
  backend = spawn(process.execPath, [serverScript], {
    cwd: path.dirname(serverScript),
    env: runtimeEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  log(`Starting backend ${serverScript} on port ${backendPort} with ${runtimeEnvironment().PYTHON_BIN}`);
  backend.stdout.on("data", (data) => log(`[backend] ${data}`));
  backend.stderr.on("data", (data) => log(`[backend:error] ${data}`));
  backend.once("error", (error) => {
    log(`Backend spawn error: ${error.stack || error.message}`);
    if (!shuttingDown) showStartupError(error);
  });
  backend.once("exit", (code, signal) => {
    log(`Backend exited: ${signal || `code ${code}`}`);
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
      showStartupError(new Error(`The local backend stopped (${signal || `code ${code}`}).`));
    }
  });
  return waitForHealth(backendPort);
}

async function stopBackend() {
  if (!backend || backend.killed) return;
  shuttingDown = true;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (backend && !backend.killed) backend.kill("SIGKILL");
      resolve();
    }, 5000);
    backend.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    backend.kill("SIGTERM");
  });
  backend = null;
}

async function createWindow() {
  log(`Creating window packaged=${isPackaged} root=${projectRoot} server=${serverScript}`);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#0b1120",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile(loadingPage).catch((error) => log(`Loading page error: ${error.message}`));
  mainWindow.show();
  try {
    await startBackend();
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);
  } catch (error) {
    showStartupError(error);
  }
}

app.whenReady().then(createWindow).catch((error) => {
  log(`Application startup error: ${error.stack || error.message}`);
  app.quit();
});
app.on("before-quit", (event) => {
  if (backend && !shuttingDown) {
    event.preventDefault();
    stopBackend().finally(() => app.quit());
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
