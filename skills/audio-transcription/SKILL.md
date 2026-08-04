---
name: audio-transcription
description: "Transcription and evidence review for local audio/video files."
---

# Audio Transcription

Produce an **evidence-reviewed** transcript with `transcribe-audio.py` in this directory.

## Backend contract

The helper uses OpenAI Realtime `gpt-transcribe`. It reads the `openai-codex` OAuth credential from `$PI_AGENT_DIR/auth.json`, falling back to `~/.pi/agent/auth.json` when `PI_AGENT_DIR` is unset. Keep this model and credential entry.

## Steps

1. **Stage immediately.** Make the helper invocation the first tool operation on an attachment or other temporary input—before probing the file. Choose the language and prompt only from information already supplied by the user. Run from this skill directory:

   ```bash
   ./transcribe-audio.py "/path/to/input.m4a" --language en \
     --prompt "English project meeting; speakers include Ana García; topic: WebRTC."
   ```

   Add `--prompt` when independent context is known. Select a specific language from the user's statement or recording context; otherwise use `--language auto`. Filename text carries no evidence. This step is complete when the command reports both a staged path under `/private/tmp/audio-transcription-inputs/` and a `transcript.txt`.

2. **Audit the complete pass.** Read all of `transcript.txt`. Flag every implausible name or term, contextual contradiction, malformed number, repeated phrase, apparent omission, and uncertain passage. This step is complete when every flagged passage is either supported by evidence or remains explicitly unresolved.

3. **Triangulate suspicious audio.** For every flagged passage where unused independent context could help, rerun the helper on the **staged path recorded in `source.txt`** with that context in a more specific prompt. Read the complete new pass and compare it with every relevant earlier pass. Treat each pass as evidence, never as an automatic replacement. Every retry must test new independent context; this step is complete when all available context has been tested.

4. **Prepare the faithful text.** Select wording supported by the audio, independent context, authoritative spellings, or agreement between passes. Preserve the speaker's words and language; add only light punctuation, paragraphs, and obvious orthographic corrections. Render unsupported speech as `[unclear]`. This step is complete when every flag from step 2 has a supported rendering or `[unclear]`.

5. **Deliver and preserve.** If review changed the selected raw pass, write the delivered text beside it as `transcript-reviewed.txt`; otherwise deliver its `transcript.txt`. Return all transcribed speech and the delivered file path.

## Evidence boundaries

- Prompt context may contain only facts known independently of model output. Speculative model words are not prompt evidence.
- Prefer `[unclear]` to a contextually convenient guess when the audio and passes do not resolve a disagreement.

## Outputs and failures

Each successful default invocation creates `/private/tmp/audio-transcriptions/<name>-<timestamp>/` containing `transcript.txt` and `source.txt`. Keep separate pass directories so their raw outputs remain comparable.

- OAuth error: ask the user to run `/login` for `openai-codex`, then rerun the reported staged input.
- Missing FFmpeg: report that `ffmpeg` is required, then rerun the reported staged input once available.
- Missing input: request the attachment again; its temporary path may have expired.
