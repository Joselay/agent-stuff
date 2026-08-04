#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "websockets>=15,<17",
# ]
# ///
"""Transcribe audio/video through OpenAI Realtime using Pi's Codex OAuth."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from websockets.sync.client import connect

SAMPLE_RATE = 24_000
REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
TRANSCRIPTION_MODEL = "gpt-transcribe"
TOKEN_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
AUTH_CLAIM = "https://api.openai.com/auth"
AGENT_DIR = Path(os.environ.get("PI_AGENT_DIR") or Path.home() / ".pi" / "agent").expanduser()
AUTH_PATH = AGENT_DIR / "auth.json"


def slugify(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._") or "audio"


def timestamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]


def decode_account_id(access_token: str) -> str | None:
    try:
        payload = access_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(payload))
        account_id = decoded.get(AUTH_CLAIM, {}).get("chatgpt_account_id")
        return account_id if isinstance(account_id, str) and account_id else None
    except (IndexError, ValueError, TypeError, json.JSONDecodeError):
        return None


def read_auth() -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        all_auth = json.loads(AUTH_PATH.read_text())
        credential = all_auth["openai-codex"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"could not read openai-codex OAuth from {AUTH_PATH}; run /login") from error
    if credential.get("type") != "oauth" or not credential.get("access"):
        raise RuntimeError("openai-codex OAuth is unavailable; run /login")
    return all_auth, credential


def refresh_oauth(all_auth: dict[str, Any], credential: dict[str, Any]) -> dict[str, Any]:
    refresh_token = credential.get("refresh")
    if not isinstance(refresh_token, str) or not refresh_token:
        raise RuntimeError("openai-codex OAuth refresh token is unavailable; run /login")

    request = Request(
        TOKEN_URL,
        data=urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": CLIENT_ID,
            }
        ).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            token = json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError("openai-codex OAuth refresh failed; run /login") from error

    access = token.get("access_token")
    expires_in = token.get("expires_in")
    if not isinstance(access, str) or not access or not isinstance(expires_in, (int, float)):
        raise RuntimeError("openai-codex OAuth refresh returned invalid credentials; run /login")

    updated = {
        **credential,
        "type": "oauth",
        "access": access,
        "refresh": token.get("refresh_token") or refresh_token,
        "expires": int(time.time() * 1000 + expires_in * 1000),
        "accountId": decode_account_id(access) or credential.get("accountId"),
    }
    all_auth["openai-codex"] = updated
    path = AUTH_PATH
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(all_auth, indent=2) + "\n")
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return updated


def oauth_credentials() -> tuple[str, str | None]:
    all_auth, credential = read_auth()
    expires = credential.get("expires")
    if not isinstance(expires, (int, float)) or expires <= time.time() * 1000 + 120_000:
        credential = refresh_oauth(all_auth, credential)
    access = credential["access"]
    account_id = credential.get("accountId") or decode_account_id(access)
    return access, account_id if isinstance(account_id, str) else None


def stage_input(source: Path) -> Path:
    if not source.exists():
        raise RuntimeError(f"input does not exist: {source}")
    if not source.is_file():
        raise RuntimeError(f"input is not a file: {source}")
    stage_dir = Path("/private/tmp/audio-transcription-inputs")
    stage_dir.mkdir(parents=True, exist_ok=True)
    staged = stage_dir / f"{slugify(source.stem)}-{timestamp()}-{os.getpid()}{source.suffix or '.audio'}"
    shutil.copy2(source, staged)
    return staged


def wait_for_session_ready(websocket) -> None:
    deadline = time.monotonic() + 15
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Realtime transcription session timed out")
        event = json.loads(websocket.recv(timeout=remaining))
        if event.get("type") == "session.updated":
            return
        if event.get("type") == "error":
            error = event.get("error") or {}
            raise RuntimeError(error.get("message") or "Realtime transcription session failed")


def receive_transcript(websocket) -> str:
    deadline = time.monotonic() + 120
    transcripts: list[str] = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Realtime transcription finalization timed out")
        event = json.loads(websocket.recv(timeout=remaining))
        event_type = event.get("type")
        if event_type == "conversation.item.input_audio_transcription.completed":
            transcripts.append(str(event.get("transcript") or ""))
            return "\n".join(transcripts).strip()
        if event_type in {"conversation.item.input_audio_transcription.failed", "error"}:
            error = event.get("error") or {}
            raise RuntimeError(event.get("message") or error.get("message") or "Realtime transcription failed")


def transcribe(staged: Path, *, language: str, prompt: str | None) -> str:
    access, account_id = oauth_credentials()
    headers = {
        "Authorization": f"Bearer {access}",
        "originator": "pi",
    }
    if account_id:
        headers["chatgpt-account-id"] = account_id

    transcription: dict[str, Any] = {"model": TRANSCRIPTION_MODEL}
    if language and language.lower() != "auto":
        transcription["language"] = language
    if prompt:
        transcription["prompt"] = prompt

    with connect(
        REALTIME_URL,
        additional_headers=headers,
        user_agent_header=f"pi-audio-transcription ({sys.platform})",
        open_timeout=15,
        close_timeout=2,
        max_size=4 * 1024 * 1024,
    ) as websocket:
        websocket.send(
            json.dumps(
                {
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": {
                            "input": {
                                "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                                "transcription": transcription,
                                "noise_reduction": {"type": "far_field"},
                                "turn_detection": None,
                            }
                        },
                    },
                }
            )
        )
        wait_for_session_ready(websocket)

        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("ffmpeg is required but was not found")
        process = subprocess.Popen(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(staged),
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-f",
                "s16le",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        byte_count = 0
        try:
            assert process.stdout is not None
            while chunk := process.stdout.read(48_000):
                byte_count += len(chunk)
                websocket.send(
                    json.dumps(
                        {
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(chunk).decode(),
                        }
                    )
                )
            stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
            code = process.wait()
        except BaseException:
            process.kill()
            process.wait()
            raise
        if code != 0:
            raise RuntimeError(stderr.strip() or f"ffmpeg exited with code {code}")
        if byte_count < 1000:
            raise RuntimeError(stderr.strip() or "input produced no audio")

        websocket.send(json.dumps({"type": "input_audio_buffer.commit"}))
        return receive_transcript(websocket)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", help="Local audio/video file")
    parser.add_argument("--language", default="auto", help="Language code, or auto")
    parser.add_argument("--prompt", help="Names, jargon, accent, and subject context")
    parser.add_argument("--output-dir", type=Path, help="Output directory")
    args = parser.parse_args()

    source = Path(args.audio).expanduser().resolve()
    staged = stage_input(source)
    output_dir = args.output_dir or Path("/private/tmp/audio-transcriptions") / f"{slugify(source.stem)}-{timestamp()}"
    output_dir.mkdir(parents=True, exist_ok=True)
    source_path = output_dir / "source.txt"
    source_path.write_text(f"original: {source}\nstaged: {staged}\n")
    print(f"staged input: {staged}", file=sys.stderr, flush=True)
    print(f"source manifest: {source_path}", file=sys.stderr, flush=True)

    transcript = transcribe(staged, language=args.language, prompt=args.prompt)
    transcript_path = output_dir / "transcript.txt"
    transcript_path.write_text(transcript + ("\n" if transcript else ""))
    print(transcript or "[no speech]")
    print(f"\ntranscript: {transcript_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("transcription cancelled", file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:
        print(f"transcription failed: {error}", file=sys.stderr)
        raise SystemExit(1)
