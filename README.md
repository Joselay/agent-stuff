# Agent Stuff

This repository contains the Pi extensions, skills, and themes I use across projects. They are tuned for my workflow, so some pieces may need small adjustments before reuse.

## Skills

All skills live in the [`skills`](skills) folder:

- [`imagegen`](skills/imagegen) — Generate or edit raster images with AI.
- [`librarian`](skills/librarian) — Cache and refresh remote Git repositories for reliable local research.
- [`writing-great-skills`](skills/writing-great-skills) — A reference for writing predictable, focused agent skills without duplication or sprawl.

## Pi Coding Agent Extensions

Custom extensions for [Pi](https://pi.dev) live in [`extensions`](extensions):

- [`edit.ts`](extensions/edit.ts) — Replaces Pi's built-in `edit` tool with a Codex-style `apply_patch` implementation, including grammar-constrained sampling and diff previews.
- [`handoff.ts`](extensions/handoff.ts) — Adds `/handoff [focus]` to summarize the current conversation and continue in a fresh linked session.
- [`recall.ts`](extensions/recall.ts) — Adds project-scoped prompt history to Pi's composable built-in editor.
- [`subagent.ts`](extensions/subagent.ts) — Standalone isolated, read-only `explore` subagent.
- [`trust-github-repos.ts`](extensions/trust-github-repos.ts) — Automatically trusts checkouts whose GitHub origin belongs to `Joselay` or `earendil-works`.
- [`usage.ts`](extensions/usage.ts) — Adds `/usage` for OpenAI Codex plan limits and credits.
- [`web-search.ts`](extensions/web-search.ts) — Adds live web search, page browsing, image search, finance, weather, sports, and time lookups. It uses OpenAI Codex OAuth by default.
- [`whimsical.ts`](extensions/whimsical.ts) — Adds a lightweight animated working label and generated-token counter.

## Pi Coding Agent Themes

Custom themes live in [`themes`](themes):

- [`nightowl.json`](themes/nightowl.json) — A dark, blue-forward theme inspired by Night Owl.

## Installation

Install everything as a Git-based Pi package:

```bash
pi install git:github.com/Joselay/agent-stuff
```

Pi discovers the conventional `extensions/`, `skills/`, and `themes/` directories automatically. Use `pi config` to enable or disable individual resources, and `/settings` to select the `nightowl` theme.
