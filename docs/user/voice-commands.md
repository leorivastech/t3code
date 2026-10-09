# Voice commands

Hold a key and say what you want. Thread navigation and scrolling happen after a short
pause while you keep holding the key: "one", pause, "two", or "up", pause, "up again".
Other orders wait until you let go. T3 Code carries out short spoken orders: open a
thread by its number, write or send a message, stop or settle a thread, start a new thread,
change the model or effort, scroll the open thread, and take a screenshot. It works in
English and Spanish without a language setting. It does not talk back: a toast shows what was
understood, and the app does it.

## Turning it on

Open **Settings → Integrations → Voice** and turn on **Local Whisper** for thread navigation
and scrolling without a cloud provider. Start the optional helper on the computer running
**the T3 server** (which can be different from your browser):

```sh
python3 -m venv .venv-voice
.venv-voice/bin/python -m pip install -r scripts/voice/requirements.txt
.venv-voice/bin/python scripts/voice/local-whisper.py
```

Python 3.10+ is required. The default uses CPU/int8; for a configured CUDA installation use
`--device cuda --compute-type float16`. The first launch downloads the `small` Whisper model;
subsequent launches can work offline. `--model /path/to/model` uses an already downloaded model.
Wait for “Local Whisper ready” before speaking. Keep the helper running while you use voice;
after a restart, start it again. It listens only on `127.0.0.1:8798`; do not expose that port.
Audio is processed in memory and is not saved. Local mode recognizes navigation and scrolling
only; unsupported phrases do nothing and never fall back to a cloud provider.

For other orders, turn local mode off and save one API key, from Groq or OpenAI. The same
key does the hearing and the understanding. Removing the key turns voice off.

The key belongs to the environment and is kept with its other secrets. Each order sends the
recording, and then its text, to that provider; T3 Code keeps neither.

**Key to hold** is the key you keep down while speaking, on this device. Right Ctrl by
default. Pick one you do not type with. Pressed together with another key it is an ordinary
shortcut, and a tap is ignored, so the key keeps its usual job. It only listens while T3 Code
is in front.

## What you can say

- **Threads**: "three", "open the second one", "next". A thread's number is the one its jump
  shortcut shows, so "the third one" is the thread `thread.jump.3` opens.
- **Messages**: "write: check the login test" leaves text in the composer. "Send it" sends
  what is there. "Tell it to run the tests" writes and sends in one go.
- **Several at once**: "open the second one and tell it to continue", "new thread with Opus
  and ask it to review the billing module".
- **Agents**: "stop", "stop the second one", "close it", "switch to GPT", "set effort to high".
- **Scrolling**: "up", "down a lot", "go to the top", "to the bottom".
- **Screenshots**: "take a screenshot" copies a picture of the screen to the clipboard and
  saves it in a `T3 Code` folder in Pictures, keeping the last twenty. "Paste it" attaches the
  last one to the draft. "Take a screenshot and ask what's wrong here" does all of it.
  Screenshots need the desktop app.

A bare number, "up" and "down" are carried out without asking a model, so they are the fastest.

Each command an order needs must have a shortcut bound in **Settings → Keybindings**. **Stop
the running turn** (`thread.stop`) has no default shortcut: bind one before asking to stop a
thread by voice.

Approvals and pending questions stay in the app. No order approves a request or changes an
access mode.
