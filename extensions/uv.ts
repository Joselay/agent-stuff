import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const messages = {
  pip: [
    "Error: pip is disabled. Use uv instead:",
    "",
    "  To install a package for a script: uv run --with PACKAGE python script.py",
    "  To add a dependency to the project: uv add PACKAGE",
    "",
  ].join("\n"),
  pip3: [
    "Error: pip3 is disabled. Use uv instead:",
    "",
    "  To install a package for a script: uv run --with PACKAGE python script.py",
    "  To add a dependency to the project: uv add PACKAGE",
    "",
  ].join("\n"),
  poetry: [
    "Error: poetry is disabled. Use uv instead:",
    "",
    "  To initialize a project: uv init",
    "  To add a dependency: uv add PACKAGE",
    "  To sync dependencies: uv sync",
    "  To run commands: uv run COMMAND",
    "",
  ].join("\n"),
  pythonPip: [
    "Error: 'python -m pip' is disabled. Use uv instead:",
    "",
    "  To install a package for a script: uv run --with PACKAGE python script.py",
    "  To add a dependency to the project: uv add PACKAGE",
    "",
  ].join("\n"),
  pythonVenv: [
    "Error: 'python -m venv' is disabled. Use uv instead:",
    "",
    "  To create a virtual environment: uv venv",
    "",
  ].join("\n"),
  pythonPyCompile: [
    "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
    "",
    "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
    "",
  ].join("\n"),
} as const;

function disabledCommandShim(message: string): string {
  return `#!/bin/sh
cat >&2 <<'UV_SHIM_MESSAGE'
${message}
UV_SHIM_MESSAGE
exit 1
`;
}

const pythonShim = `#!/bin/bash

command_name="\${0##*/}"

deny_module() {
    case "$1" in
        pip)
            echo "Error: '$command_name -m pip' is disabled. Use uv instead:" >&2
            echo "" >&2
            echo "  To install a package for a script: uv run --with PACKAGE python script.py" >&2
            echo "  To add a dependency to the project: uv add PACKAGE" >&2
            ;;
        venv)
            echo "Error: '$command_name -m venv' is disabled. Use uv instead:" >&2
            echo "" >&2
            echo "  To create a virtual environment: uv venv" >&2
            ;;
        py_compile)
            echo "Error: '$command_name -m py_compile' is disabled because it writes .pyc files to __pycache__." >&2
            echo "" >&2
            echo "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null" >&2
            ;;
    esac
    echo "" >&2
    exit 1
}

for argument in "$@"; do
    case "$argument" in
        -mpip|"-m pip"|pip) deny_module pip ;;
        -mvenv|"-m venv"|venv) deny_module venv ;;
        -mpy_compile|"-m py_compile"|py_compile) deny_module py_compile ;;
    esac
done

resolve_uv_python() {
    local shim_dir candidate candidate_dir executable
    shim_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

    candidate="$(uv python find --managed-python 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        candidate_dir="$(cd "$(dirname "$candidate")" && pwd)"
        if [ "$candidate_dir" != "$shim_dir" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    fi

    for executable in python3 python; do
        while IFS= read -r candidate; do
            [ -n "$candidate" ] || continue
            candidate_dir="$(cd "$(dirname "$candidate")" && pwd)"
            [ "$candidate_dir" = "$shim_dir" ] && continue
            printf '%s\n' "$candidate"
            return 0
        done < <(type -aP "$executable" 2>/dev/null)
    done

    return 1
}

UV_PYTHON="$(resolve_uv_python)"
if [ -z "$UV_PYTHON" ]; then
    echo "Error: Unable to locate a Python interpreter outside intercepted-commands." >&2
    exit 1
fi

exec uv run --python "$UV_PYTHON" python "$@"
`;

const assets = {
  pip: disabledCommandShim(messages.pip),
  pip3: disabledCommandShim(messages.pip3),
  poetry: disabledCommandShim(messages.poetry),
  python: pythonShim,
  python3: pythonShim,
} as const;

function materializeAssets(): string {
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const root = join(cacheRoot, "pi", "uv");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);

  for (const [relativePath, contents] of Object.entries(assets)) {
    const path = join(root, relativePath);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o755, flag: "wx" });
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  return root;
}

function getBlockedCommandMessage(command: string): string | null {
  const segmentStart = String.raw`(?:^|\n|[;|&]{1,2})\s*`;
  const python = `${segmentStart}(?:\\S+\\/)?python(?:3(?:\\.\\d+)?)?\\b[^\\n;|&]*`;
  const rules: ReadonlyArray<readonly [RegExp, string]> = [
    [new RegExp(`${segmentStart}(?:\\S+\\/)?pip(?=$|\\s)`, "m"), messages.pip],
    [new RegExp(`${segmentStart}(?:\\S+\\/)?pip3(?=$|\\s)`, "m"), messages.pip3],
    [new RegExp(`${segmentStart}(?:\\S+\\/)?poetry(?=$|\\s)`, "m"), messages.poetry],
    [new RegExp(`${python}(?:\\s-m\\s*pip\\b|\\s-mpip\\b)`, "m"), messages.pythonPip],
    [new RegExp(`${python}(?:\\s-m\\s*venv\\b|\\s-mvenv\\b)`, "m"), messages.pythonVenv],
    [
      new RegExp(`${python}(?:\\s-m\\s*py_compile\\b|\\s-mpy_compile\\b)`, "m"),
      messages.pythonPyCompile,
    ],
  ];

  for (const [pattern, message] of rules) {
    if (pattern.test(command)) return message;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  const runtimeRoot = materializeAssets();
  const bashTool = createBashTool(process.cwd(), {
    spawnHook: (ctx) => {
      const blockedMessage = getBlockedCommandMessage(ctx.command);
      if (blockedMessage) throw new Error(blockedMessage);

      return {
        ...ctx,
        env: {
          ...ctx.env,
          PATH: `${runtimeRoot}:${ctx.env.PATH ?? ""}`,
        },
      };
    },
  });

  pi.registerTool(bashTool);
}
