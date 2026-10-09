"""Run with: python3 scripts/voice/local-whisper.test.py"""
import base64
import importlib.util
import io
import json
import threading
import unittest
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("helper", __file__.replace(".test.py", ".py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
# HTTP tests isolate inference/decoding; real PCM decode is checked with the helper demo.
helper.decode_audio = lambda audio: audio


class FakeHandler(helper.Handler):
    def __init__(self, body, *, origin=None, busy=False, duration=1):
        self.path = "/transcribe"
        self.headers = {"Content-Length": str(len(body)), "Host": "127.0.0.1:8798"}
        if origin:
            self.headers["Origin"] = origin
        self.rfile = io.BytesIO(body)
        self.connection = SimpleNamespace(settimeout=lambda _: None)
        self.server = SimpleNamespace(inference_lock=threading.Lock(), model=self)
        self.calls = 0
        self.duration = duration
        if busy:
            self.server.inference_lock.acquire()

    def transcribe(self, audio, **_kwargs):
        self.calls += 1
        return [SimpleNamespace(text=" three ")], SimpleNamespace(duration=self.duration)

    def reply(self, status, body):
        self.result = status, body


class LocalWhisperTest(unittest.TestCase):
    def request(self, body=None, **options):
        if body is None:
            body = json.dumps({"audioBase64": base64.b64encode(b"audio").decode()}).encode()
        handler = FakeHandler(body, **options)
        handler.do_POST()
        return handler

    def test_returns_text_and_unlocks(self):
        handler = self.request()
        self.assertEqual(handler.result, (200, {"text": "three"}))
        self.assertFalse(handler.server.inference_lock.locked())

    def test_rejects_browser_requests_before_inference(self):
        handler = self.request(origin="https://example.com")
        self.assertEqual(handler.result[0], 403)
        self.assertEqual(handler.calls, 0)

    def test_rejects_invalid_audio(self):
        handler = self.request(b'{"audioBase64":"invalid!"}')
        self.assertEqual(handler.result[0], 400)
        self.assertEqual(handler.calls, 0)

    def test_busy_returns_without_queuing(self):
        handler = self.request(busy=True)
        self.assertEqual(handler.result[0], 503)
        self.assertEqual(handler.calls, 0)

    def test_rejects_long_recording_and_unlocks(self):
        handler = self.request(duration=66)
        self.assertEqual(handler.result[0], 413)
        self.assertFalse(handler.server.inference_lock.locked())


if __name__ == "__main__":
    unittest.main()
