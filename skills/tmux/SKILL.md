---
name: tmux
description: "Tmux control loop for interactive REPLs, debuggers, and TTY programs; monitoring long-running commands; or reconnecting to existing sessions."
---

# tmux

Run a one-pane **control loop**: select, expose, observe, send one input, then wait for fresh evidence.

Resolve `<tmux-skill>` below to the absolute directory containing this file.

## 1. Select one pane

Create an isolated server by default. Start the interactive program directly, making its prompt the first observable state:

```bash
SOCKET_DIR="${PI_TMUX_SOCKET_DIR:-/tmp/pi-tmux-$UID}"
RUN_ID="${PI_SESSION_ID:-$(date +%s)-$$}"
SOCKET="$SOCKET_DIR/${RUN_ID:0:12}.sock"
SESSION="pi-$(date +%s)-$$"
TARGET="$SESSION:0.0"
umask 077
mkdir -p "$SOCKET_DIR"
tmux -S "$SOCKET" -f /dev/null new-session -d -s "$SESSION" -n main \
  'exec env PYTHON_BASIC_REPL=1 python3 -q' \; \
  set-option -t "$SESSION" remain-on-exit on
printf 'SOCKET=%s\nSESSION=%s\nTARGET=%s\n' "$SOCKET" "$SESSION" "$TARGET"
```

Replace the final command with the required interactive program. `remain-on-exit` preserves its final output if it exits quickly. `-f /dev/null` applies when creating the server; use the user's configuration only when the task depends on it. Record the printed literal values because shell variables do not persist across tool calls.

To reconnect, locate candidates:

```bash
"<tmux-skill>/scripts/find-sessions.sh" --all
tmux -S '<socket>' list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}'
```

`--all` checks the default socket, the current `$TMUX` socket, and managed sockets under `PI_TMUX_SOCKET_DIR`.

Completion: one literal socket and full `session:window.pane` target are selected, and `capture-pane` shows the expected program or preserved final output.

## 2. Expose the session

Immediately give the user copy/paste commands containing literal values:

```text
Monitor:
  tmux -S '<socket>' attach-session -t '<session>'
Snapshot:
  tmux -S '<socket>' capture-pane -p -J -t '<target>' -S -200
Detach with Ctrl+b d.
```

Completion: the user has both commands before interactive work continues.

## 3. Drive the control loop

Observe first. Wait for a unique task-specific completion marker when possible; otherwise wait for a stable prompt:

```bash
"<tmux-skill>/scripts/wait-for-text.sh" \
  -S '<socket>' -t '<target>' -p '^>>>' -T 15 -l 4000
```

For repeated prompts and bounded output, count existing matching lines before sending and require one new line. Keep capture, send, and wait in one shell call so failure cannot be masked:

```bash
set -euo pipefail
SOCKET='<socket>'; TARGET='<target>'; WAIT='<tmux-skill>/scripts/wait-for-text.sh'
PANE="$(tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -4000)"
SEEN="$(printf '%s\n' "$PANE" | awk '/^>>>/{n++} END{print n+0}')"
tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- '2 + 2'
tmux -S "$SOCKET" send-keys -t "$TARGET" Enter
"$WAIT" -S "$SOCKET" -t "$TARGET" -p '^>>>' -n "$((SEEN + 1))" -T 15 -l 4000
tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -200
```

Send text with `-l --`; send Enter separately. Use key names such as `C-c`, `C-d`, `C-z`, or `Escape` only for control input. `tmux wait-for` synchronizes tmux events, not pane text.

On timeout, use the helper's pane dump as the next observed state.

Completion: every input is preceded by an observed state and followed by a new prompt, marker, or state change; the final capture contains the requested outcome.

## 4. Finish

Preserve the session when the user requested it or its program is still useful/running; report the monitor command and exact live state. Otherwise remove sessions created during this run:

```bash
tmux -S "$SOCKET" kill-session -t "$SESSION"
if tmux -S "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  echo "session still exists: $SESSION" >&2
  exit 1
fi
```

Leave pre-existing sessions running unless the user asked to terminate them.

Completion: every created session is either intentionally live with a monitor command reported, or confirmed absent.

## Program notes

- **Python:** `PYTHON_BASIC_REPL=1 python3 -q`; prompt `^>>>`.
- **Debuggers:** disable pagination, wait for the debugger prompt, use `C-c` to interrupt a running inferior, and confirm destructive commands.

Run either helper with `--help` for its authoritative options and defaults.
