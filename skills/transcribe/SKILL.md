---
name: transcribe
description: "Evidence-reviewed transcripts for recordings or attachments, including verification of uncertain names, terms, languages, and numbers."
disable-model-invocation: true
---

# Transcribe

Produce a faithful, evidence-reviewed transcript with `~/.pi/agent/skills/transcribe/transcribe.py`.

## Steps

1. **Preserve the input.** For an attachment or other temporary input, invoke the helper as the first tool operation so it stages a durable copy. Commands start in the project directory, so use the helper's full path:

   ```bash
   ~/.pi/agent/skills/transcribe/transcribe.py \
     "/path/to/input.m4a" --language en \
     --prompt "English project meeting; speakers include Ana García; topic: WebRTC."
   ```

   Set a language only when the user or recording context establishes it; otherwise use `--language auto`. Build any prompt from independently supplied or verified names, jargon, accent, and subject; use the filename only to locate the input. This step is complete when the command reports both a staged path under `/private/tmp/transcribe-inputs/` and a `transcript.txt`.

2. **Audit the complete pass.** Read all of `transcript.txt`. Inventory every implausible name or term, language mismatch, contextual contradiction, malformed number, suspicious repetition, broken sentence, and uncertain passage. Record the exact span and reason for each flag. This step is complete when every line has been checked and every suspicious span is inventoried.

3. **Corroborate every flag.** Rerun the helper on the staged path recorded in the first pass's `source.txt`, keeping each pass in its own output directory. Use a focused prompt only when unused independent context bears on a flag; an unprompted retry tests acoustic convergence. Read every retry completely, add new discrepancies to the inventory, and compare the relevant spans across passes. This step is complete when each flag has a comparison pass and every relevant independent fact has been tested once.

4. **Adjudicate the evidence.** Converging passes support what was spoken; independent context supports spelling, terminology, and plausibility. Preserve the speaker's words, language, repetitions, and disfluencies. Limit editing to punctuation, paragraphs, and supported orthographic corrections. Render unresolved speech as `[unclear]`. This step is complete when every inventory item has a supported rendering or `[unclear]`.

5. **Deliver and preserve.** Select the best-supported raw pass. If adjudication changes it, write the exact delivered text beside it as `transcript-reviewed.txt`; otherwise use its `transcript.txt`. Return the complete transcript and delivered file path. This step is complete when the returned text exactly matches that file.

## Outputs and failures

Each invocation creates `/private/tmp/transcripts/<name>-<timestamp>/` containing `transcript.txt` and `source.txt`.

- OAuth error: ask the user to run `/login` for `openai-codex`, then rerun the reported staged input.
- Missing FFmpeg: report that `ffmpeg` is required, then rerun the reported staged input once available.
- Missing input: request the attachment again; its temporary path may have expired.
