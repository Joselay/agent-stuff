---
name: audio-transcription
description: "Transcribe local audio/video and Apple Voice Memos through OpenAI gpt-transcribe using Pi's Codex OAuth."
---

Use this skill whenever the user asks to transcribe an audio/video file, Voice Memo, dictation, lecture, meeting recording, or bad audio.

## Core rules

1. **Preserve temporary inputs immediately.** Voice Memo share-sheet paths can disappear. The helper stages the input under `/private/tmp/audio-transcription-inputs/` before connecting or probing.
2. **Use the included helper only.** It streams audio to OpenAI Realtime `gpt-transcribe` using the `openai-codex` OAuth credential in `~/.pi/agent/auth.json`. Never request an OpenAI API key and never use local MLX/Whisper models.
3. **Cloud disclosure.** Audio is uploaded to OpenAI. This workflow is configured because the user explicitly selected cloud transcription.
4. **Force language when known.** Do not infer language from the filename. Use `auto` only when genuinely unknown.
5. **Use prompt hints for difficult audio.** Include names, places, jargon, accent, and likely subject matter.
6. **Deliver a cleaned best-effort transcript.** Lightly punctuate and paragraph output; mark uncertain spans as `[unclear]` rather than inventing words.

## Usage

Run from this skill directory:

```bash
./transcribe-audio.py "/path/to/audio.m4a" --language en \
  --prompt "Names, places, programming terms, accent, and subject context."
```

Auto-detect language:

```bash
./transcribe-audio.py "/path/to/audio.m4a" --language auto
```

The helper:

- stages a stable copy under `/private/tmp/audio-transcription-inputs/`
- obtains and refreshes Pi's `openai-codex` OAuth credential without exposing it
- converts audio/video to 24 kHz mono PCM with FFmpeg
- streams PCM to OpenAI Realtime `gpt-transcribe`
- writes `transcript.txt` and `source.txt` under `/private/tmp/audio-transcriptions/<name>-<timestamp>/`

If authentication fails, ask the user to run `/login` for `openai-codex`. Do not fall back to API keys or local models.

## Quality checks

Inspect `transcript.txt`. Rerun with a stronger prompt when names or technical vocabulary are wrong. Do not over-edit uncertain content.
