---
name: audio-transcription
description: "Transcription for local audio/video and Apple Voice Memos via OpenAI. Use for dictation, lectures, meetings, or difficult/noisy recordings."
---

# Audio Transcription

Produce a **faithful** transcript with the included helper. It uploads audio to OpenAI Realtime `gpt-transcribe` using Pi's `openai-codex` OAuth.

## Execution

1. Resolve the local input path without probing the file. This step is complete when one source path is identified.
2. Choose the language from the user's statement or recording context—never from its filename. Use a language code when known and `auto` only when unknown. Add a prompt containing any known names, places, jargon, accent, and subject. This step is complete when language and available hints are represented in the command.
3. Run `transcribe-audio.py` from this skill directory. For a Voice Memo, share-sheet attachment, or other temporary path, make this the first operation that touches the source; the helper copies it before authentication or media probing. This step is complete when it reports both a staged path under `/private/tmp/audio-transcription-inputs/` and `transcript.txt`, or returns a specific error handled below.
4. Read the entire `transcript.txt`. If recognizable names or technical terms are wrong, rerun from the original input with a more specific prompt, then inspect the entire replacement. This step is complete when no identifiable prompt-correctable errors remain.
5. Return the faithful transcript: preserve wording and language, add only light punctuation and paragraph breaks, and render genuinely uncertain speech as `[unclear]`. Include the saved transcript path. The task is complete when all transcribed speech is delivered without invented content.

## Helper

Known language:

```bash
./transcribe-audio.py "/path/to/audio.m4a" --language en \
  --prompt "Known names, places, jargon, accent, and subject."
```

Unknown language:

```bash
./transcribe-audio.py "/path/to/audio.m4a" --language auto
```

The helper writes `transcript.txt` and `source.txt` under `/private/tmp/audio-transcriptions/<name>-<timestamp>/`.

## Failures

- Authentication: ask the user to run `/login` for `openai-codex`, then rerun the helper. Keep OAuth as the credential path; use no API key or local transcription model.
- Missing FFmpeg: report that `ffmpeg` is required.
- Missing or unreadable input: ask for the attachment again; temporary share paths may have expired.
