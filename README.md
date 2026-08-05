# Agent Stuff

My personal [Pi Coding Agent](https://pi.dev) package: reusable skills, extensions, and a theme used across projects.

Most items are tuned for my workflow and environment, so expect to adjust paths, credentials, or defaults before reusing them elsewhere.

## Skills

Skills live in [`skills`](skills). Each skill has a `SKILL.md` plus any helper files it needs.

- [`/agent-browser`](skills/agent-browser) - Automate browsers, Electron apps, and exploratory QA with `agent-browser`.
- [`/frontend-design`](skills/frontend-design) - Create distinctive, production-ready frontend UI with strong visual direction.
- [`/google-workspace`](skills/google-workspace) - Operate Google Docs, Sheets, Drive, and Gmail through `gws`.
- [`/imagegen`](skills/imagegen) - Generate and edit raster images with AI.
- [`/librarian`](skills/librarian) - Cache and refresh remote git repositories for local research.
- [`/tmux`](skills/tmux) - Control tmux sessions for interactive CLIs and long-running processes.
- [`/transcribe`](skills/transcribe) - Create evidence-reviewed transcripts from audio or video.
- [`/uv`](skills/uv) - Use `uv` for Python projects, scripts, dependencies, and builds.
- [`/writing-great-skills`](skills/writing-great-skills) - Guidance for writing predictable, focused agent skills.

## Extensions

Pi extensions live in [`extensions`](extensions):

- [`answer.ts`](extensions/answer.ts) - `/answer` plus `ctrl+.` to extract and answer questions from the last assistant message.
- [`btw.ts`](extensions/btw.ts) - `/btw` side-chat popover for quick tangential questions.
- [`continue.ts`](extensions/continue.ts) - `shift+alt+enter` sends `continue` when the agent is stopped.
- [`dictate.ts`](extensions/dictate.ts) - `/dictate` enables hold-backtick voice dictation on macOS.
- [`edit.ts`](extensions/edit.ts) - Replaces `edit` with a grammar-constrained `apply_patch` implementation and diff previews.
- [`fast.ts`](extensions/fast.ts) - `/fast` toggles OpenAI Codex Fast mode.
- [`files.ts`](extensions/files.ts) - `/files` browses repository and session-referenced files with open, reveal, edit, and diff actions.
- [`git.ts`](extensions/git.ts) - `/git` plus `ctrl+shift+g` browses uncommitted diffs and commit history.
- [`goal.ts`](extensions/goal.ts) - `/goal` manages long-running objectives, budgets, and automatic continuation.
- [`handoff.ts`](extensions/handoff.ts) - `/handoff` summarizes the conversation and continues in a fresh linked session.
- [`no-sleep.ts`](extensions/no-sleep.ts) - Prevents macOS sleep while Pi is active.
- [`notify.ts`](extensions/notify.ts) - Plays a notification sound when the agent finishes.
- [`recall.ts`](extensions/recall.ts) - Adds project-scoped prompt history to the editor.
- [`reset.ts`](extensions/reset.ts) - `/reset` redeems OpenAI Codex usage resets.
- [`review.ts`](extensions/review.ts) - `/review` reviews pull requests, branches, commits, folders, or local changes.
- [`skill-mentions.ts`](extensions/skill-mentions.ts) - Adds short skill commands, inline mentions, highlighting, and completion.
- [`split-fork.ts`](extensions/split-fork.ts) - `/split-fork` opens a forked session in a right-hand Ghostty split.
- [`statusline.ts`](extensions/statusline.ts) - Adds a compact footer with context, model, project, branch, and usage telemetry.
- [`subagent.ts`](extensions/subagent.ts) - Adds a serial, observable `subagent` tool backed by tmux.
- [`todos.ts`](extensions/todos.ts) - Adds a file-backed `todo` tool and `/todos` interface.
- [`trust-github-repos.ts`](extensions/trust-github-repos.ts) - Automatically trusts GitHub repositories owned by `Joselay` or `earendil-works`.
- [`usage.ts`](extensions/usage.ts) - `/usage` shows OpenAI Codex plan limits and credits.
- [`uv.ts`](extensions/uv.ts) - Replaces `bash` with a `uv`-aware Python workflow.
- [`web-search.ts`](extensions/web-search.ts) - Adds web search, browsing, images, finance, weather, sports, and time lookups.
- [`whimsical.ts`](extensions/whimsical.ts) - Adds an animated working indicator and whimsical status labels.

## Themes

Custom themes live in [`themes`](themes):

- [`nightowl.json`](themes/nightowl.json) - Dark Night Owl-inspired theme.

## Installation

Install as a Git-based Pi package:

```sh
pi install git:github.com/Joselay/agent-stuff
```
