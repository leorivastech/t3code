"""Optional loopback transcription service for T3 voice. See docs/user/voice-commands.md."""
from __future__ import annotations

import argparse
import base64
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8798
MAX_BODY = 12_000_256


def decode_audio(data):
    import av
    import numpy as np

    samples = []
    total = 0
    with av.open(io.BytesIO(data)) as container:
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                array = converted.to_ndarray().reshape(-1)
                total += array.size
                if total > 16000 * 65:
                    raise ValueError("Recording too long")
                samples.append(array)
        for converted in resampler.resample(None):
            samples.append(converted.to_ndarray().reshape(-1))
    if not samples:
        raise ValueError("No audio")
    return np.concatenate(samples).astype(np.float32)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Never log speech or recordings.

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        return not self.headers.get("Origin") and self.headers.get("Host") in {
            f"127.0.0.1:{PORT}", f"localhost:{PORT}",
        }

    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {"error": "Forbidden"})
        if self.path != "/health":
            return self.reply(404, {"error": "Not found"})
        self.reply(200, {"ready": True})

    def do_POST(self):
        if not self.allowed():
            return self.reply(403, {"error": "Forbidden"})
        if self.path != "/transcribe":
            return self.reply(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {"error": "Invalid recording size"})
            self.connection.settimeout(30)
            body = json.loads(self.rfile.read(length))
            audio = base64.b64decode(body["audioBase64"], validate=True)
            if not audio:
                raise ValueError("Empty recording")
            audio = decode_audio(audio)
        except Exception:
            return self.reply(400, {"error": "Invalid recording"})
        # Do not accumulate a queue of stale navigation commands.
        if not self.server.inference_lock.acquire(blocking=False):
            return self.reply(503, {"error": "Transcription busy"})
        try:
            segments, info = self.server.model.transcribe(audio, vad_filter=True, condition_on_previous_text=False)
            if info.duration > 65:
                return self.reply(413, {"error": "Recording too long"})
            text = " ".join(segment.text.strip() for segment in segments).strip()
            self.reply(200, {"text": text})
        except Exception:
            self.reply(503, {"error": "Local transcription failed"})
        finally:
            self.server.inference_lock.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="small", help="Whisper model name or downloaded model path")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()
    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.model = model
    server.inference_lock = threading.Lock()
    print(f"Local Whisper ready on 127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
