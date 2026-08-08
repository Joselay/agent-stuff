# Agent Stuff

My personal [Pi Coding Agent](https://pi.dev) package: reusable skills, extensions, prompt templates, and a theme used across projects.

Most items are tuned for my workflow and environment, so expect to adjust paths, credentials, or defaults before reusing them elsewhere. The structure is influenced by [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), with only the specific ideas and conventions I found useful for my own workflow.

## Prompt Templates

Prompt templates live in [`prompts`](prompts):

- [`/discuss`](prompts/discuss.md) - Planning interviewer. Inspects first, asks focused questions in short rounds with defaults, stops when the plan is clear. Does not implement.

## Skills

Skills live in [`skills`](skills). Each skill has a `SKILL.md` plus any helper files it needs.

- [`/agent-browser`](skills/agent-browser) - Automate browsers, Electron apps, and exploratory QA with `agent-browser`.
- [`/frontend-design`](skills/frontend-design) - Frontend art direction for distinctive UI concepts, typography, palette, layout, and motion.
- [`/google-workspace`](skills/google-workspace) - Operate Google Docs, Sheets, Drive, and Gmail through `gws`.
- [`/imagegen`](skills/imagegen) - Generate and edit raster images with AI.
- [`/librarian`](skills/librarian) - Research remote git repositories locally for inspection, comparison, or implementation reference.
- [`/tmux`](skills/tmux) - Control tmux sessions for interactive CLIs, REPLs, debuggers, and long-running processes.
- [`/transcribe`](skills/transcribe) - Create evidence-reviewed transcripts from audio or video.
- [`/uv`](skills/uv) - Use `uv` for Python projects, scripts, dependencies, and builds.
- [`/writing-for-agents`](skills/writing-for-agents) - Guidance for writing agent-consumed documents (skills, `AGENTS.md`, `CLAUDE.md`).

## Extensions

Pi extensions live in [`extensions`](extensions):

Extension source files do not import other files from this repository, so each
`.ts` entry can be copied independently. Runtime assets and external tools are
not bundled: notably, `notify.ts` expects
`~/.cache/pi/notify/notification.mp3` to already exist. Integrations may also
require their named platform, executable, credentials, or network access.

- [`answer.ts`](extensions/answer.ts) - `/answer` plus `ctrl+.` to extract and answer questions from the last assistant message.
- [`btw.ts`](extensions/btw.ts) - `/btw` side-chat popover for quick tangential questions.
- [`continue.ts`](extensions/continue.ts) - `shift+alt+enter` sends `continue` when the agent is stopped.
- [`context.ts`](extensions/context.ts) - `/context` shows what fills the context window.
- [`control.ts`](extensions/control.ts) - Enables control sockets for inter-session messaging and coordination.
- [`dictate.ts`](extensions/dictate.ts) - `/dictate` enables hold-backtick voice dictation on macOS.
- [`edit.ts`](extensions/edit.ts) - Replaces `edit` with a grammar-constrained `apply_patch` implementation and diff previews.
- [`emoji.ts`](extensions/emoji.ts) - `/emoji` opens an emoji picker with shortcode autocomplete.
- [`fast.ts`](extensions/fast.ts) - `/fast` toggles OpenAI Codex Fast mode.
- [`files.ts`](extensions/files.ts) - `/files` browses repository and session-referenced files with open, reveal, edit, and diff actions.
- [`git.ts`](extensions/git.ts) - `/git` plus `ctrl+shift+g` browses uncommitted diffs and commit history.
- [`goal.ts`](extensions/goal.ts) - `/goal` manages long-running objectives, budgets, and automatic continuation.
- [`handoff.ts`](extensions/handoff.ts) - `/handoff` summarizes the conversation and continues in a fresh linked session.
- [`no-sleep.ts`](extensions/no-sleep.ts) - Prevents macOS sleep while Pi is active.
- [`notify.ts`](extensions/notify.ts) - Plays a notification sound when the agent finishes.
- [`bash-mode.ts`](extensions/bash-mode.ts) - Adds a Bash-mode indicator to the editor.
- [`recall.ts`](extensions/recall.ts) - Adds project-scoped prompt history to the editor.
- [`session-name.ts`](extensions/session-name.ts) - Adds session-name chrome to the editor.
- [`reset.ts`](extensions/reset.ts) - `/reset` redeems OpenAI Codex usage resets.
- [`review.ts`](extensions/review.ts) - `/review` reviews pull requests, branches, commits, folders, or local changes.
- [`skill-mentions.ts`](extensions/skill-mentions.ts) - Adds short skill commands, inline mentions, highlighting, and completion.
- [`split-fork.ts`](extensions/split-fork.ts) - `/split-fork` opens a forked session in a right-hand Ghostty split.
- [`statusline.ts`](extensions/statusline.ts) - Adds a compact footer with context, model, project, branch, and usage telemetry.
- [`subagent.ts`](extensions/subagent.ts) - Adds a serial, observable `subagent` tool backed by tmux.
- [`talk.ts`](extensions/talk.ts) - `/talk` toggles live voice conversation with a background agent on macOS.
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

*Inspired by the structure and selected ideas from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff).*
