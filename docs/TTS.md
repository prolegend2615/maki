# Voice replies (Piper)

Mika can answer with a voice clip instead of text. The model chooses that itself (`{"action":"voice","text":"..."}`). The text is not posted. Piper turns it into a `.wav` which is sent as an attachment. The spoken text is stored as the attachment's alt text, so it stays in the chat history. If Piper fails, the bot posts the text instead.

Piper only runs while it speaks, so it uses no RAM when idle. Jobs run one at a time.

## Install on a Linux VPS

Pick the archive for your CPU: `x86_64` (most VPS) or `aarch64` (ARM).

```bash
mkdir -p ~/piper && cd ~/piper
curl -L -O https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar -xzf piper_linux_x86_64.tar.gz        # creates ~/piper/piper/piper (the binary)

mkdir -p ~/piper/voices && cd ~/piper/voices
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```

Both voice files must sit next to each other. The `.onnx` is about 60 MB. The binary folder is about 25 MB. Another voice: browse https://huggingface.co/rhasspy/piper-voices (for example `en/en_US/amy/medium`).

Test it:

```bash
echo "hello, this is a test" | ~/piper/piper/piper --model ~/piper/voices/en_US-lessac-medium.onnx --output_file /tmp/test.wav
```

A `/tmp/test.wav` file means it works.

## Install on Windows (for local testing)

Download `piper_windows_amd64.zip` from the same release page and unzip it. Download the two voice files from the links above.

## Configure the bot

In `.env` (use absolute paths):

```
PIPER_BIN=/home/youruser/piper/piper/piper
PIPER_VOICE=/home/youruser/piper/voices/en_US-lessac-medium.onnx
TTS_MAX_CHARS=300
TTS_TIMEOUT_SECONDS=30
```

Restart the bot. The bot needs the **Attach Files** permission in the channel. Without it, voice replies fall back to text.
