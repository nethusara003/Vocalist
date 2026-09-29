"""Local speech adapter. Kokoro MLX is preferred; macOS `say` is a local fallback."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def run_kokoro(text, options, output):
    from kokoro_mlx import KokoroTTS
    import soundfile as sf

    voice = options.get("voice") or os.getenv("KOKORO_VOICE", "af_heart")
    voice = voice.split("|||")[0]
    with KokoroTTS.from_pretrained() as tts:
        result = tts.generate(text, voice=voice, speed=float(options.get("rate", 1)), sample_rate=24000)
        audio = result.audio.numpy() if hasattr(result.audio, "numpy") else result.audio
        sf.write(output, audio, result.sample_rate)


def run_macos_say(text, options, output):
    if not shutil.which("say") or not shutil.which("afconvert"):
        raise RuntimeError("Neither Kokoro nor macOS say/afconvert is available")
    voice = options.get("voice")
    voice_name = voice.split("|||")[0] if voice else None
    with tempfile.TemporaryDirectory() as temp:
        aiff = Path(temp) / "speech.aiff"
        command = ["say", "-o", str(aiff)]
        if voice_name and voice_name != "No voices available":
            command.extend(["-v", voice_name])
        command.append(text)
        subprocess.run(command, check=True, capture_output=True, text=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@22050", str(aiff), output], check=True, capture_output=True, text=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    text = payload.get("text", "").strip()
    if not text:
        raise ValueError("Text cannot be empty")
    try:
        run_kokoro(text, payload.get("options", {}), args.output)
    except (ImportError, ModuleNotFoundError) as kokoro_error:
        print(f"Kokoro unavailable; using local macOS speech fallback: {kokoro_error}", file=sys.stderr)
        run_macos_say(text, payload.get("options", {}), args.output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
