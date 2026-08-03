---
name: librarian
description: "Cache a remote Git repository for reuse when a task points to one as reference."
---

# Librarian

## 1. Catalog the repository

Run [`checkout.sh`](checkout.sh) from this skill directory with the repository reference:

```bash
bash ~/.pi/agent/skills/librarian/checkout.sh '<repo-reference>' --path-only
```

Pass the reference as one quoted argument. It may be an `owner/repo` shorthand, host path, HTTPS URL, SSH URL, or repository deep link. `owner/repo` defaults to GitHub.

Use `--force-update` when the task requires the latest remote state. Otherwise, accept the throttled refresh. Run the script with `--help` when other defaults or overrides are needed.

This step is complete when the command returns a checkout path and that path is a Git repository. On failure, diagnose and repair the checkout until it reaches that state.

## 2. Research from the catalog

Use the returned path for repository searches and reads. Run `checkout.sh` again whenever the repository appears in a later task; it reuses the stable cache path and refreshes stale checkouts.

This step is complete when every repository-dependent claim needed for the result has been verified against the cached checkout.

## 3. Isolate modifications

When the task requires edits, create a separate worktree or copy outside the cache and modify that workspace. Keep the cached checkout reusable for future research.

This step is complete when all task changes live in the isolated workspace and `git status --porcelain` in the cached checkout shows no task-specific changes.
