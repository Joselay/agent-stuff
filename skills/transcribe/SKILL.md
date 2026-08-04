---
name: transcribe
description: "Create an evidence-reviewed transcript from audio or video."
disable-model-invocation: true
---

# Transcribe

## Steps

1. **Preserve.** When the input is an attachment or ephemeral path, make the helper the first tool call; it stages a durable copy before contacting the transcription service. Invoke it by absolute location because commands start in the project directory:

   ```bash
   ~/.pi/agent/skills/transcribe/transcribe.py \
     "/path/to/input.m4a" --language en \
     --prompt "English project meeting; speakers include Ana García; topic: WebRTC."
   ```

   Use `--language auto` unless the user or recording context establishes a language. Build `--prompt` only from independently supplied or verified names, jargon, accents, and subject matter. Treat the filename solely as a locator. Complete when the command reports a staged path under `/private/tmp/transcribe-inputs/` and a `transcript.txt`.

2. **Audit.** Read the entire `transcript.txt` and build an evidence ledger. Flag every implausible name or term, language mismatch, contextual contradiction, malformed number, suspicious repetition, broken sentence, and uncertain passage; record each exact span and reason. Complete when every transcript span has been checked and every suspicion appears in the ledger.

3. **Corroborate.** For any flagged item, rerun the helper on the staged path in the first pass's `source.txt`; each invocation already creates a distinct output directory. Prefer an unprompted retry to test acoustic convergence. Use a focused prompt when unused independent context bears on a flag. Read each retry completely, add newly exposed discrepancies to the ledger, and compare relevant spans across passes. One retry may corroborate multiple flags. Complete when every ledger item has comparison evidence and every relevant independent fact has been tested once.

4. **Adjudicate.** Treat convergence as evidence of what was spoken; use independent context for spelling, terminology, and plausibility. Preserve the speaker's words, language, repetitions, and disfluencies. Edit punctuation, paragraphing, and supported orthography. Render unresolved speech as `[unclear]`. Complete when every ledger item has a supported rendering or `[unclear]`.

5. **Deliver.** Select the best-supported raw pass. When adjudication changes it, write the exact final text beside that pass as `transcript-reviewed.txt`; otherwise deliver its `transcript.txt`. Return the complete transcript and its path. Complete when returned text byte-for-byte matches the delivered file.

## Outputs and failures

Each invocation creates `/private/tmp/transcripts/<name>-<timestamp>/` containing `transcript.txt` and `source.txt`.

- OAuth error: ask the user to run `/login` for `openai-codex`, then rerun the reported staged input.
- Missing FFmpeg: report that `ffmpeg` is required, then rerun the reported staged input once available.
- Missing input: request the attachment again; its temporary path may have expired.
