"""Persistent local TTS worker.

The daemon loads Kokoro MLX once and accepts newline-delimited JSON requests.
When Kokoro is unavailable, the same process uses the local macOS say fallback.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def load_kokoro():
    try:
        from kokoro_mlx import KokoroTTS
        return KokoroTTS.from_pretrained()
    except (ImportError, ModuleNotFoundError):
        return None


def kokoro_voices(model):
    return model.list_voices() if model else []


def run_kokoro(model, text, options, output):
    import soundfile as sf

    voice = (options.get("voice") or os.getenv("KOKORO_VOICE", "af_heart")).split("|||")[0]
    result = model.generate(text, voice=voice, speed=float(options.get("rate", 1)), sample_rate=24000)
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
        if voice_name and voice_name not in {"No voices available", "af_heart"}:
            command.extend(["-v", voice_name])
        command.append(text)
        subprocess.run(command, check=True, capture_output=True, text=True)
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16@22050", str(aiff), output],
            check=True,
            capture_output=True,
            text=True,
        )


def emit(message):
    print(json.dumps(message), flush=True)


def daemon():
    model = load_kokoro()
    engine = "kokoro-mlx" if model else "macos-say"
    voices = kokoro_voices(model)
    emit({"type": "ready", "engine": engine, "voices": voices})
    for line in sys.stdin:
        if not line.strip():
            continue
        request = None
        started = time.perf_counter()
        try:
            request = json.loads(line)
            text = str(request.get("text", "")).strip()
            if not text:
                raise ValueError("Text cannot be empty")
            output = request["output"]
            if model:
                run_kokoro(model, text, request.get("options", {}), output)
            else:
                run_macos_say(text, request.get("options", {}), output)
            emit({
                "id": request["id"],
                "ok": True,
                "engine": engine,
                "durationMs": round((time.perf_counter() - started) * 1000),
            })
        except Exception as error:
            emit({
                "id": request.get("id") if request else None,
                "ok": False,
                "error": str(error),
                "durationMs": round((time.perf_counter() - started) * 1000),
            })


def single_request(payload, output):
    model = load_kokoro()
    try:
        if model:
            run_kokoro(model, payload["text"].strip(), payload.get("options", {}), output)
        else:
            run_macos_say(payload["text"].strip(), payload.get("options", {}), output)
    finally:
        if model and hasattr(model, "close"):
            model.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--daemon", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.daemon:
        daemon()
    else:
        payload = json.load(sys.stdin)
        single_request(payload, args.output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
