"""Companion's offline, loopback-only English speech recognizer.

Model installation is a separate step. This process never downloads models and
does not persist microphone audio, request bodies, or transcripts.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import select
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Set before importing model libraries. A missing local model is a startup error.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"

import av
import numpy as np
from faster_whisper import WhisperModel


HOST = "127.0.0.1"
PORT = 8178
MAX_BYTES = 10 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_SAMPLES = SAMPLE_RATE * 65
FORMATS = {
    "audio/webm": "matroska",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mp4": "mov",
    "audio/m4a": "mov",
    "audio/x-m4a": "mov",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
}


def decode_audio(body: bytes, mime: str) -> np.ndarray:
    """Decode bounded audio in memory; disallow external media protocols."""
    chunks = []
    samples = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)

    def append(frame):
        nonlocal samples
        data = frame.to_ndarray().reshape(-1)
        samples += data.size
        if samples > MAX_SAMPLES:
            raise ValueError("Recording is longer than 65 seconds.")
        chunks.append(data)

    with av.open(
        io.BytesIO(body), mode="r", format=FORMATS[mime],
        options={"protocol_whitelist": "pipe"},
    ) as container:
        if not container.streams.audio:
            raise ValueError("No audio track was found.")
        for frame in container.decode(audio=0):
            frame.pts = None
            for output in resampler.resample(frame):
                append(output)
        for output in resampler.resample(None):
            append(output)
    if not samples:
        raise ValueError("The recording contains no audio.")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


class SpeechServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, model):
        self.model = model
        self.inference_lock = threading.Lock()
        super().__init__((HOST, PORT), SpeechHandler)


class SpeechHandler(BaseHTTPRequestHandler):
    server_version = "CompanionSpeech/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, _format, *_args):
        # No request paths, audio, or transcripts in logs.
        pass

    def reply(self, status, payload):
        self.close_connection = True
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            pass

    def local_request(self):
        hosts = self.headers.get_all("Host", [])
        if hosts != [f"{HOST}:{PORT}"]:
            self.reply(403, {"error": "Only Companion's loopback endpoint is allowed."})
            return False
        # The desktop main process sends no Origin. Browser pages cannot use this
        # helper directly, including through a cross-origin preflight.
        if self.headers.get("Origin") is not None:
            self.reply(403, {"error": "Browser requests are not allowed."})
            return False
        return True

    def client_connected(self):
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return not readable or bool(self.connection.recv(1, socket.MSG_PEEK))
        except OSError:
            return False

    def do_GET(self):
        if not self.local_request():
            return
        if self.path != "/health":
            self.reply(404, {"error": "Unknown endpoint."})
            return
        self.reply(200, {"ready": True, "model": "base.en", "device": "cpu"})

    def do_POST(self):
        if not self.local_request():
            return
        if self.path != "/transcribe":
            self.reply(404, {"error": "Unknown endpoint."})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            self.reply(411, {"error": "A single Content-Length is required."})
            return
        if self.headers.get("Transfer-Encoding") is not None:
            self.reply(400, {"error": "Transfer-Encoding is not supported."})
            return
        if len(lengths[0]) > 10 or int(lengths[0]) > MAX_BYTES:
            self.reply(413, {"error": "Recording exceeds the 10 MB limit."})
            return
        length = int(lengths[0])
        if length < 1:
            self.reply(400, {"error": "The recording is empty."})
            return
        mime = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if mime not in FORMATS:
            self.reply(415, {"error": "Unsupported audio format."})
            return
        if not self.server.inference_lock.acquire(blocking=False):
            self.reply(429, {"error": "Speech recognition is busy. Try again shortly."})
            return
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                self.reply(400, {"error": "The recording was incomplete."})
                return
            try:
                audio = decode_audio(body, mime)
            except ValueError as error:
                self.reply(400, {"error": str(error)})
                return
            except (av.error.FFmpegError, EOFError):
                self.reply(400, {"error": "The recording could not be decoded."})
                return
            if not self.client_connected():
                return
            # Exact silence otherwise invites Whisper to invent a transcript.
            if np.max(np.abs(audio)) < 0.0001:
                self.reply(200, {"text": ""})
                return
            segments, _ = self.server.model.transcribe(
                audio, language="en", beam_size=3, vad_filter=True,
                condition_on_previous_text=False, word_timestamps=False,
            )
            pieces = []
            for segment in segments:
                if not self.client_connected():
                    return
                pieces.append(segment.text.strip())
            if self.client_connected():
                self.reply(200, {"text": " ".join(pieces).strip()[:8000]})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            # Cancellation discards the result. A running CPU operation may finish
            # before the next connection check; it never sends data elsewhere.
            pass
        except Exception:
            self.reply(500, {"error": "Local speech recognition failed. Try another recording."})
        finally:
            self.server.inference_lock.release()

    def do_OPTIONS(self):
        self.reply(403, {"error": "Browser requests are not allowed."})


def main():
    configured = os.environ.get("COMPANION_SPEECH_MODEL_DIR", "")
    model_path = Path(configured)
    if not configured or not model_path.is_absolute() or not (model_path / "model.bin").is_file():
        raise SystemExit("The local base.en speech model is missing. Run speech setup first.")
    if not (model_path / "tokenizer.json").is_file():
        raise SystemExit("The local speech tokenizer is missing. Run speech setup first.")
    model = WhisperModel(
        str(model_path), device="cpu", compute_type="int8",
        cpu_threads=min(4, os.cpu_count() or 1), num_workers=1,
        local_files_only=True,
    )
    with SpeechServer(model) as server:
        print(f"Companion speech ready on {HOST}:{PORT} (base.en, CPU int8)", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
