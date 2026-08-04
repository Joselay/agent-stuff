---
name: uv
description: "uv Python tooling: use when running Python, invoking ephemeral CLIs, managing project dependencies or environments, selecting Python versions, maintaining standalone scripts, or building packages."
---

# uv

Route by ownership:

```bash
uv run <command>             # Project-owned command
uv run python <args>         # Python in the project environment
uvx <tool> [args]            # Ephemeral CLI, isolated from the project
uv add <package>             # Runtime dependency
uv add --dev <package>       # Development dependency
uv remove <package>          # Remove dependency and relock
uv sync                      # Reconcile environment and lockfile
uv sync --locked             # Sync only when the lockfile is current
uv python install <version>  # Install an interpreter
uv python pin <version>      # Pin the project interpreter
```

Project-owned tools run with `uv run`; ephemeral tools run with `uvx`. Project dependencies change with `uv add` or `uv remove`, keeping `pyproject.toml`, `uv.lock`, and the environment together.

For a syntax-only check that creates no `__pycache__`:

```bash
uv run python -m ast <file> >/dev/null
```

Standalone-script branch: before creating or modifying one, read [scripts.md](scripts.md); account for every dependency, interpreter constraint, isolation boundary, and reproducibility requirement.

Package-build branch: before creating or changing one, read [build.md](build.md); account for the backend, package layout, and included files.
