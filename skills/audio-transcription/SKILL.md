---
name: audio-transcription
description: "Faithful, reviewed transcription for local audio/video and Apple Voice Memos via OpenAI, including difficult or noisy recordings."
---

# Audio Transcription

Produce a **faithful, reviewed** transcript with the included helper. It uploads audio to OpenAI Realtime `gpt-transcribe` using Pi's `openai-codex` OAuth. Do not use local MLX/Whisper models.

## Core rules

1. **Preserve temporary inputs immediately.** Make the helper the first operation on Voice Memo, share-sheet, attachment, or other temporary paths; it stages a stable copy before authentication or media probing.
2. **Use the cloud model only.** Use the included OpenAI Realtime `gpt-transcribe` helper and Pi's `openai-codex` OAuth. Do not substitute MLX Whisper or another local model.
3. **Force language when known.** Infer it from the user's statement or recording context, never the filename. Use `auto` only when genuinely unknown.
4. **Supply known context.** Prompt with names, places, jargon, accent, subject, and other facts known independently of the model output. Do not feed speculative words back as facts.
5. **Review, do not blindly autocorrect.** Fix only errors strongly supported by audio, context, spelling, or agreement between passes. Preserve wording and language. Mark unresolved speech `[unclear]`; never invent it.
6. **Escalate difficult audio.** Rerun with a more specific evidence-based prompt when output has improbable words, contradictions, dropped speech, or repetition. Compare complete passes rather than automatically accepting the newest one.

## Workflow

1. Resolve one local source path without probing it.
2. Choose the language and build a prompt from available independent hints.
3. Run `transcribe-audio.py` from this skill directory. Success requires both a staged path under `/private/tmp/audio-transcription-inputs/` and a `transcript.txt`.
4. Read the entire `transcript.txt`. Check names, jargon, isolated words, numbers, repeated phrases, and contextually implausible text.
5. If anything suspicious is plausibly prompt-correctable, rerun from the original source with a better prompt. Read the entire new transcript and compare both passes. A rerun is another opinion, not automatically the truth.
6. Lightly punctuate and paragraph the best-supported text. Correct obvious orthography without rewriting the speaker. Use `[unclear]` wherever evidence remains insufficient.
7. When review changes the raw output, preserve `transcript.txt` and write the delivered version beside it as `transcript-reviewed.txt`. Otherwise deliver `transcript.txt`.
8. Return all transcribed speech and the path to the delivered transcript.

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

For a second pass, use the same original input and add only independently known context:

```bash
./transcribe-audio.py "/path/to/audio.m4a" --language fr \
  --prompt "French educational recording reading a restaurant menu and prices."
```

## Quality checks

Rerun and compare when the transcript contains:

- recognizable names or technical terms rendered implausibly;
- words contradicting known recording context;
- repeated phrases suggesting a transcription loop;
- missing or malformed numbers where the surrounding structure is clear;
- suspicious text in noisy, clipped, or low-volume audio.

Do not silently choose a contextually convenient word when passes disagree. Use the audio and independent context; otherwise write `[unclear]`.

## Failures

- Authentication: ask the user to run `/login` for `openai-codex`, then rerun the helper. Keep OAuth as the credential path; use no API key or local transcription model.
- Missing FFmpeg: report that `ffmpeg` is required.
- Missing or unreadable input: ask for the attachment again; temporary share paths may have expired.
