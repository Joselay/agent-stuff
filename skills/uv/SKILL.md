---
name: uv
description: "uv Python tooling: use for Python execution, ephemeral CLI tools, project dependencies or environments, Python versions, standalone scripts, and package builds."
---

# uv

Route by lifetime:

```bash
uv run <command>                         # Project-owned command
uv run python <args>                     # Python in the project environment
uvx <tool> [args]                        # Ephemeral CLI, isolated from the project
uv add <package>                         # Runtime dependency
uv add --dev <package>                   # Development dependency
uv remove <package>                      # Remove dependency and relock
uv sync                                  # Reconcile environment and lockfile
uv sync --locked                         # Reconcile while requiring a current lockfile
uv python install <version>              # Install an interpreter
uv python pin <version>                  # Pin the project interpreter
```

Use `uv run`, rather than `uvx`, for tools declared by the project. Use `uv add` and `uv remove`, rather than editing dependency tables directly, so `pyproject.toml`, `uv.lock`, and the environment move together.

For a syntax-only check that creates no `__pycache__`:

```bash
uv run python -m ast <file> >/dev/null
```

Standalone-script branch: before creating or modifying one, read [scripts.md](scripts.md); account for every dependency, interpreter constraint, isolation boundary, and reproducibility requirement.

Package-build branch: before creating or changing one, read [build.md](build.md); account for the backend, package layout, and included files.
