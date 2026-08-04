---
name: audio-transcription
description: "Audio transcription and evidence review for local recordings or attachments; use to transcribe speech or verify uncertain names, terms, and numbers."
---

# Audio Transcription

Produce a faithful, **evidence-reviewed** transcript with the helper at `~/.pi/agent/skills/audio-transcription/transcribe-audio.py`.

## Steps

1. **Stage immediately.** On an attachment or other temporary input, make the helper invocation the first tool operation. Commands start in the project directory, so invoke the helper by its absolute path:

   ```bash
   ~/.pi/agent/skills/audio-transcription/transcribe-audio.py \
     "/path/to/input.m4a" --language en \
     --prompt "English project meeting; speakers include Ana García; topic: WebRTC."
   ```

   Use a specific language only when the user or recording context establishes it; otherwise use `--language auto`. Add a prompt only with independently known facts such as names, jargon, accent, or subject. Treat the filename as a locator. This step is complete when the command reports a staged path under `/private/tmp/audio-transcription-inputs/` and a `transcript.txt`.

2. **Audit the complete pass.** Read all of `transcript.txt`. Inventory every implausible name or term, contextual contradiction, malformed number, repeated phrase, apparent omission, and uncertain passage. This step is complete when the entire transcript has been checked and every suspicious passage is in the inventory.

3. **Triangulate each flag.** When unused independent context could resolve a flag, rerun the helper on the staged path from the first pass's `source.txt`, using that context in a focused prompt. Keep each pass in its own output directory. Read each new transcript completely and compare all relevant passes. A retry earns its place by testing new evidence. This step is complete when every relevant independently known fact has been tested once.

4. **Adjudicate the evidence.** Treat raw passes as evidence rather than replacements. Use convergence between passes to support the heard wording and independent sources to support names, terminology, and orthography. Preserve the speaker's words and language; add only light punctuation, paragraphs, and obvious orthographic corrections. Render unresolved speech as `[unclear]`. This step is complete when every inventory item has a supported rendering or `[unclear]`.

5. **Deliver and preserve.** If review changed the selected raw pass, write the delivered text beside it as `transcript-reviewed.txt`; otherwise deliver its `transcript.txt`. Return all transcribed speech and the delivered file path.

## Evidence boundaries

- Prompt facts must originate independently of transcript output; a model's speculative wording is not new evidence.
- Context supports spelling and plausibility, while converging passes support what was spoken. Use `[unclear]` when they do not resolve a disagreement.

## Outputs and failures

The helper uses OpenAI Realtime `gpt-transcribe` with Pi's `openai-codex` OAuth. Each default invocation creates `/private/tmp/audio-transcriptions/<name>-<timestamp>/` containing `transcript.txt` and `source.txt`.

- OAuth error: ask the user to run `/login` for `openai-codex`, then rerun the reported staged input.
- Missing FFmpeg: report that `ffmpeg` is required, then rerun the reported staged input once available.
- Missing input: request the attachment again; its temporary path may have expired.
