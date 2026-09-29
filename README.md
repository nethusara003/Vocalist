# Vocalis

Vocalis is a local Text-to-Speech application that converts large amounts of text into downloadable WAV and MP3 audio files. It keeps the existing editor experience while adding a local backend, chunked generation, audio preview, batch processing, and ZIP export.

## Features

- Local TTS with no cloud API required
- Large text processing with paragraph and sentence-aware chunking
- Batch processing for multiple `.txt` files
- WAV generation
- MP3 generation through FFmpeg
- Audio preview with play, pause, stop, seek, and duration
- Downloadable individual WAV and MP3 files
- ZIP batch download
- Multiple text file support
- Local voice selection
- Speech speed controls
- Pitch and volume controls where supported
- Reading mode
- Dark mode and responsive layout
- Character and word counters
- Progress tracking
- Per-chunk retry and failed-document recovery
- Local saved text support
- Import and export of text files

## Architecture

```text
Frontend
  ↓ HTTP
Local Node backend
  ↓
Replaceable TTS service abstraction
  ↓
Platform TTS service abstraction
  ├── macOS: persistent Kokoro MLX worker → `say` fallback
  └── Windows: persistent SAPI PowerShell worker
  ↓
WAV audio chunks
  ↓
FFmpeg merge and conversion
  ↓
Final WAV + MP3
```

### Engine selection

The frontend only uses the existing HTTP API. The backend selects the worker
from the runtime platform:

| Platform | Preferred local engine | Fallback |
| --- | --- | --- |
| macOS Apple Silicon | Kokoro MLX | macOS `say` |
| Windows x64 | Windows SAPI | Installed SAPI voice set |

Windows SAPI is the first Windows implementation because it is offline,
already included with Windows, has no model redistribution requirement, and
supports direct WAV output. Its voice quality depends on the voices installed
on the user's system and is generally less neural/natural than Kokoro. A
bundled Piper or ONNX Kokoro engine can be added behind the same service
interface later without changing the frontend API.

The browser plays the generated audio file. It does not use `speechSynthesis` for generated audio.

The Node backend starts one Python worker when Vocalis starts. Kokoro MLX loads once and remains in memory while chunks and batch documents are processed sequentially. If the worker exits unexpectedly, the Node manager starts it again on the next request. The frontend uses the same API regardless of which local engine is active.

## Supported platforms

- macOS Apple Silicon
- Windows x64

## Requirements

- Node.js 20 or newer
- npm
- FFmpeg for development
- macOS: Python 3.10–3.12 for `kokoro-mlx` (optional fallback is `say` + `afconvert`)
- Windows: PowerShell and Windows SAPI, which are built into supported Windows versions

Kokoro model weights are downloaded by the local Python package on first use. Model weights are not included in this repository.

## Installation

### 1. Clone the repository

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd "Text to Speech"
```

### 2. Install Node dependencies

```bash
npm install
```

### 3. Install FFmpeg

```bash
brew install ffmpeg
```

Verify it:

```bash
ffmpeg -version
```

### 4. Create the Python environment

`kokoro-mlx` supports Python 3.10–3.12. Use Python 3.12 if it is available:

```bash
python3.12 -m venv .venv-kokoro
source .venv-kokoro/bin/activate
python -m pip install --upgrade pip
python -m pip install kokoro-mlx soundfile
```

If `python3.12` is not installed, install a supported Python version using your preferred local Python manager. Do not use Python 3.14 for the Kokoro environment.

### 5. Configure optional local settings

Copy the environment template if needed:

```bash
cp .env.example .env
```

The server does not require secrets or API keys. The `.env` file is ignored by Git.

Set the Python interpreter for the current shell:

```bash
export PYTHON_BIN="$PWD/.venv-kokoro/bin/python"
```

### 6. Start Vocalis

```bash
npm start
```

Open <http://localhost:8787>.

Do not open `index.html` directly when generating audio; the local backend must be running.

## Desktop application

The Electron desktop shell starts the existing Node backend automatically, waits for
`/api/health` to report that the persistent TTS worker is ready, and shuts down the
backend and worker when the application closes. It uses a dynamically selected local
port, so another development server on port 8787 does not block the desktop app.

Run the development desktop application on macOS:

```bash
PYTHON_BIN="$PWD/.venv-kokoro/bin/python" npm run electron
```

Create an unpacked macOS development package:

```bash
PYTHON_BIN="$PWD/.venv-kokoro/bin/python" npm run build:mac
```

Create a DMG:

```bash
PYTHON_BIN="$PWD/.venv-kokoro/bin/python" npm run dist:mac
```

Build Windows x64 artifacts from a Windows or cross-build-capable environment:

```bash
npm run build:win
npm run dist:win
```

The packaged shell does not require Node.js, npm, VS Code, or the project
working directory. macOS Kokoro development/package builds still need a local
supported Python environment and FFmpeg unless those resources are bundled as
part of a separate runtime distribution. The optional
`~/Library/Application Support/vocalis-local-tts/runtime.json` file can select
those resources without hard-coding a developer path, but it is not required
for the macOS `say` fallback.

Windows uses the persistent PowerShell SAPI worker. It requires no Python,
Kokoro, or model download. The Windows package includes an x64 FFmpeg binary
under its application resources, so end users do not need to install FFmpeg.
Development builds look for `FFMPEG_PATH`, the packaged
`resources/ffmpeg/win-x64/ffmpeg.exe`, then `ffmpeg` on `PATH`. The bundled
FFmpeg build is distributed under its upstream LGPL/GPL terms; review the
upstream license and build source before redistributing the installer.

## Usage

1. Enter or paste text into the editor.
2. Select a local voice and adjust speed, pitch, or volume.
3. Click **Generate audio**.
4. Vocalis chunks the document, generates WAV audio locally, merges the chunks, and converts the result to MP3.
5. Preview the generated MP3 in the built-in player.
6. Download the WAV or MP3 file.
7. Add multiple `.txt` files under **Batch generation**.
8. Click **Generate all** to process the files sequentially.
9. Download individual batch outputs or use **Download all (.zip)**.

## Project structure

```text
.
├── index.html
├── style.css
├── script.js
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
├── output/
│   └── .gitkeep
└── server/
    ├── server.js
    ├── tts_worker.py          # macOS Kokoro/say persistent worker
    ├── windows_tts_worker.ps1 # Windows SAPI persistent worker
    ├── services/
    │   └── ttsService.js      # worker lifecycle and request queue
    └── utils/
        ├── audioMerger.js
        └── textChunker.js
├── electron/
│   ├── main.js
│   └── loading.html
└── resources/
    └── ffmpeg/
        └── win-x64/ffmpeg.exe  # included in Windows packaging
```

### Backend endpoints

- `GET /api/health`
- `GET /api/diagnostics`
- `GET /api/voices`
- `POST /api/tts/generate`
- `POST /api/batch/generate`
- `POST /api/batch/zip`

## Privacy

Text is processed locally by the Node server and local TTS process. Vocalis does not send text to a cloud TTS provider, does not require an API key, and does not use an external AI service. Generated audio remains in the local `output/` directory and is ignored by Git.

Kokoro model files are downloaded from the package's configured model source during local setup. They are not committed to this repository.

## License

The Vocalis application source is provided under the MIT License. See [LICENSE](./LICENSE).

Kokoro MLX, Kokoro model weights, FFmpeg, macOS voices, and other dependencies have their own licenses and distribution terms. Review those upstream licenses separately before redistributing models or generated content.
