"""orca – start, steer and stop minizillas from mastazilla within fixed limits."""

# --------- IMPORTS ---------
import argparse
import json
import mimetypes
import os
import re
import sys
import time
import tomllib
import traceback
from datetime import datetime, timezone
from pathlib import Path

import requests

# --------- STATIC ---------
api_key_name = "AWORK_API_KEY"
terminal_states = {"completed", "failed", "cancelled", "canceled", "error"}
state_file = Path("scratch/orca_job.json")
default_collect_dir = Path("scratch/minizillas")
comment_pattern = re.compile(r"<!--.*?-->", re.S)

# --------- CONFIG ---------
app_name = "orca"
app_version = "0.1"
config_file = Path(__file__).parent / "orca.toml"


# --------- API ---------
class OrcaError(Exception):
    """Expected error with a message meant for the caller."""


class AworkClient:
    """Minimal client for the awork agents API."""

    def __init__(self, base_url: str, api_key: str, timeout: int = 60):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {api_key}"
        self.timeout = timeout

    def _request(self, method: str, path: str, raw: bool = False, **kwargs):
        response = self.session.request(method, f"{self.base_url}{path}", timeout=self.timeout, **kwargs)
        if not response.ok:
            raise OrcaError(f"awork API {method} {path} failed with {response.status_code}: {response.text[:300]}")
        if raw:
            return response.content
        return response.json() if response.content else {}

    def create_thread(self, agent_id: str, content: str, title: str, attachments: list[dict] | None = None) -> dict:
        """Create a custom-agent thread with a first message. Returns the created thread incl. acceptedMessageId."""
        body = {"type": "custom-agent", "agentId": agent_id, "title": title, "content": content}
        if attachments:
            body["attachments"] = attachments
        return self._request("POST", "/agents/threads", json=body)

    def send_message(self, thread_id: str, content: str, attachments: list[dict] | None = None) -> dict:
        """Submit a message to a thread. Returns the acceptance incl. acceptedMessageId."""
        body = {"content": content, **({"attachments": attachments} if attachments else {})}
        return self._request("POST", f"/agents/threads/{thread_id}/messages", json=body)

    def message_status(self, thread_id: str, message_id: str) -> dict:
        """Return the processing status of an accepted message."""
        return self._request("GET", f"/agents/threads/{thread_id}/messages/{message_id}/status")

    def messages(self, thread_id: str) -> list[dict]:
        """Return all messages of a thread in conversation order."""
        items = self._request("GET", f"/agents/threads/{thread_id}/messages") or []
        return sorted(items, key=lambda item: item.get("messageOrder") or 0)

    def cancel(self, thread_id: str) -> None:
        """Cancel the active run of a thread."""
        self._request("POST", f"/agents/threads/{thread_id}/cancel")

    def upload_temporary_file(self, path: Path) -> str:
        """Upload a local file as temporary file and return its id."""
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        with path.open("rb") as handle:
            return self._request("POST", "/temporaryfiles", files={"file": (path.name, handle, mime_type)})["id"]

    def download_thread_file(self, thread_id: str, file_id: str, target: Path) -> Path:
        """Download a file attached to a thread into target."""
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self._request("GET", f"/agents/threads/{thread_id}/files/{file_id}/download", raw=True))
        return target

    def thread_usage(self) -> list[dict]:
        """Return admin thread metadata incl. creditsUsed. Requires admin rights (API key)."""
        return self._request("GET", "/agents/management/threads") or []


def get_api_key() -> str:
    """Read the API key from the awork skill secret or the environment."""
    try:
        import awork_secrets  # only available inside the awork sandbox
        api_key = awork_secrets.get(api_key_name)
    except Exception:
        api_key = None
    api_key = api_key or os.environ.get(api_key_name)
    if not api_key:
        raise OrcaError(f"{api_key_name} is missing. Set it as skill secret or environment variable.")
    return api_key


def attachments_for(client: AworkClient, files: list[str] | None) -> list[dict]:
    """Upload local files and return attachment references for a message."""
    paths = [Path(file) for file in files or []]
    if missing := [str(path) for path in paths if not path.is_file()]:
        raise OrcaError(f"File not found: {', '.join(missing)}")
    return [{"temporaryFileId": client.upload_temporary_file(path)} for path in paths]


def answer_after(messages: list[dict], message_id: str | None) -> list[dict]:
    """Return the assistant messages that follow the given user message (or the last user message)."""
    ids = [message.get("id") for message in messages]
    if message_id in ids:
        start = ids.index(message_id) + 1
    else:
        user_indexes = [index for index, message in enumerate(messages) if message.get("role") == "user"]
        start = user_indexes[-1] + 1 if user_indexes else 0
    return [message for message in messages[start:] if message.get("role") == "assistant"]


def clean_text(text: str | None) -> str:
    """Remove hidden HTML comments from agent text."""
    return comment_pattern.sub("", text or "").strip()


def download_answer_files(client: AworkClient, thread_id: str, answer: list[dict], target_dir: Path) -> list[Path]:
    """Download all files attached to the given assistant messages."""
    files = [file for message in answer for file in message.get("temporaryFiles") or []]
    return [client.download_thread_file(thread_id, file["id"], target_dir / Path(file.get("name") or file["id"]).name) for file in files]


# --------- JOB STATE ---------
def load_config() -> dict:
    if not config_file.is_file():
        raise OrcaError(f"Config not found: {config_file}")
    config = tomllib.loads(config_file.read_text(encoding="utf-8"))
    if not config.get("minizilla_agent_id") or "<" in config["minizilla_agent_id"]:
        raise OrcaError("minizilla_agent_id is not set in orca.toml.")
    return config


def load_state() -> dict:
    if state_file.is_file():
        return json.loads(state_file.read_text(encoding="utf-8"))
    return {"job_started": datetime.now(timezone.utc).isoformat(), "rounds": 0, "minizillas": {}}


def save_state(state: dict) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")


def alive(state: dict) -> dict:
    return {key: value for key, value in state["minizillas"].items() if value["state"] != "cancelled"}


def get_minizilla(state: dict, minizilla_id: str) -> dict:
    if minizilla_id not in state["minizillas"]:
        raise OrcaError(f"Unknown {minizilla_id}. Known: {', '.join(state['minizillas']) or 'none'}")
    return state["minizillas"][minizilla_id]


def job_credits(client: AworkClient, state: dict) -> int | None:
    """Sum the credits of all minizilla threads of the job; None if usage is not readable."""
    thread_ids = {value["thread_id"] for value in state["minizillas"].values()}
    if not thread_ids:
        return 0
    try:
        return sum(row.get("creditsUsed") or 0 for row in client.thread_usage() if row.get("id") in thread_ids)
    except OrcaError as exc:
        print(f"warning: credits not readable ({exc})")
        return None


def check_limits(client: AworkClient, config: dict, state: dict, new_minizilla: bool) -> None:
    if state["rounds"] >= config["max_rounds"]:
        raise OrcaError(f"max_rounds reached ({state['rounds']}/{config['max_rounds']}). Review results or run stopzilla.")
    if new_minizilla and len(alive(state)) >= config["max_minizillas"]:
        raise OrcaError(f"max_minizillas reached ({len(alive(state))}/{config['max_minizillas']}). Cancel one first.")
    limit = config["max_credits_per_job"]
    if limit and (used := job_credits(client, state)) is not None and used >= limit:
        raise OrcaError(f"max_credits_per_job reached ({used}/{limit}). Run stopzilla.")


# --------- COMMANDS ---------
def cmd_spawn(client: AworkClient, config: dict, state: dict, args) -> None:
    check_limits(client, config, state, new_minizilla=True)
    minizilla_id = f"minizilla_{len(state['minizillas']) + 1}"
    print(f"sending isotope to {minizilla_id}")
    thread = client.create_thread(config["minizilla_agent_id"], args.task, f"{minizilla_id} – {args.task[:60]}", attachments_for(client, args.file))
    state["minizillas"][minizilla_id] = {"thread_id": thread["id"], "message_id": thread.get("acceptedMessageId"), "state": "working"}
    state["rounds"] += 1
    save_state(state)
    print(f"{minizilla_id} spawned")


def cmd_send(client: AworkClient, config: dict, state: dict, args) -> None:
    minizilla = get_minizilla(state, args.minizilla_id)
    if minizilla["state"] == "cancelled":
        raise OrcaError(f"{args.minizilla_id} is cancelled. Spawn a new one.")
    check_limits(client, config, state, new_minizilla=False)
    print(f"sending isotope to {args.minizilla_id}")
    accepted = client.send_message(minizilla["thread_id"], args.message, attachments_for(client, args.file))
    minizilla.update(message_id=accepted.get("acceptedMessageId"), state="working")
    state["rounds"] += 1
    save_state(state)
    print(f"{args.minizilla_id}: {accepted.get('status', 'accepted')}")


def refresh(client: AworkClient, state: dict) -> None:
    for minizilla in alive(state).values():
        if minizilla["state"] == "working" and minizilla.get("message_id"):
            status = client.message_status(minizilla["thread_id"], minizilla["message_id"]).get("status") or ""
            if status.casefold() in terminal_states:
                minizilla["state"] = "answered" if status.casefold() == "completed" else status.casefold()
    save_state(state)


def cmd_wait(client: AworkClient, config: dict, state: dict, args) -> None:
    targets = args.minizilla_ids or [key for key, value in alive(state).items() if value["state"] == "working"]
    for minizilla_id in targets:
        get_minizilla(state, minizilla_id)
    timeout = min(args.timeout or config["wait_timeout"], config["wait_timeout"])
    deadline = time.monotonic() + timeout
    limit = config["max_credits_per_job"]
    while True:
        refresh(client, state)
        if limit and (used := job_credits(client, state)) is not None and used >= limit:
            print(f"max_credits_per_job exceeded ({used}/{limit}) – stopping all minizillas")
            cmd_stopzilla(client, config, state, args)
            return
        pending = [key for key in targets if state["minizillas"][key]["state"] == "working"]
        if not pending or time.monotonic() >= deadline:
            break
        time.sleep(config["poll_interval"])
    cmd_status(client, config, state, args, refreshed=True)
    if pending:
        print(f"still working: {', '.join(pending)} – call wait again")


def cmd_status(client: AworkClient, config: dict, state: dict, args, refreshed: bool = False) -> None:
    if not refreshed:
        refresh(client, state)
    if not state["minizillas"]:
        print("no minizillas in this job")
    for minizilla_id, minizilla in state["minizillas"].items():
        print(f"{minizilla_id}: {minizilla['state']}")


def cmd_collect(client: AworkClient, config: dict, state: dict, args) -> None:
    minizilla = get_minizilla(state, args.minizilla_id)
    answer = answer_after(client.messages(minizilla["thread_id"]), minizilla.get("message_id"))
    if not answer:
        print(f"{args.minizilla_id}: no answer yet")
        return
    print("\n\n".join(text for message in answer if (text := clean_text(message.get("content")))))
    target_dir = Path(args.dest or default_collect_dir) / args.minizilla_id
    for path in download_answer_files(client, minizilla["thread_id"], answer, target_dir):
        print(f"file: {path}")


def cmd_cancel(client: AworkClient, config: dict, state: dict, args) -> None:
    minizilla = get_minizilla(state, args.minizilla_id)
    if minizilla["state"] == "working":
        client.cancel(minizilla["thread_id"])
    minizilla["state"] = "cancelled"
    save_state(state)
    print(f"{args.minizilla_id} cancelled")


def cmd_budget(client: AworkClient, config: dict, state: dict, args) -> None:
    used = job_credits(client, state)
    limit = config["max_credits_per_job"] or "no cap"
    print(f"credits: {'unknown' if used is None else used}/{limit}")
    print(f"rounds: {state['rounds']}/{config['max_rounds']}")
    print(f"minizillas: {len(alive(state))}/{config['max_minizillas']}")


def cmd_stopzilla(client: AworkClient, config: dict, state: dict, args) -> None:
    for minizilla_id, minizilla in alive(state).items():
        if minizilla["state"] == "working":
            try:
                client.cancel(minizilla["thread_id"])
            except OrcaError as exc:
                print(f"warning: {minizilla_id} not cancelled ({exc})")
        minizilla["state"] = "cancelled"
    used = job_credits(client, state)
    state_file.unlink(missing_ok=True)
    print(f"stopzilla: job closed, {len(state['minizillas'])} minizillas, credits used: {'unknown' if used is None else used}")


# --------- MAIN ---------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=app_name, description=f"{app_name} {app_version}")
    commands = parser.add_subparsers(dest="command", required=True)
    spawn = commands.add_parser("spawn", help="start a new minizilla with a task")
    spawn.add_argument("task")
    spawn.add_argument("--file", action="append")
    send = commands.add_parser("send", help="send a follow-up message to a minizilla")
    send.add_argument("minizilla_id")
    send.add_argument("message")
    send.add_argument("--file", action="append")
    wait = commands.add_parser("wait", help="wait for answers")
    wait.add_argument("minizilla_ids", nargs="*")
    wait.add_argument("--timeout", type=int)
    commands.add_parser("status", help="show the state of all minizillas")
    collect = commands.add_parser("collect", help="fetch the latest answer and files")
    collect.add_argument("minizilla_id")
    collect.add_argument("--dest")
    cancel = commands.add_parser("cancel", help="stop one minizilla")
    cancel.add_argument("minizilla_id")
    commands.add_parser("budget", help="show credits, rounds and minizillas against the limits")
    commands.add_parser("stopzilla", help="stop all minizillas and close the job")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = load_config()
    client = AworkClient(config["api_base_url"], get_api_key())
    globals()[f"cmd_{args.command}"](client, config, load_state(), args)
    return 0


# --------- EXEC ---------
if __name__ == "__main__":
    try:
        sys.exit(main())
    except OrcaError as exc:
        print(f"orca: {exc}")
        sys.exit(1)
    except Exception as exc:
        print(f"Unhandled error in main: {exc}")
        print(traceback.format_exc())
        sys.exit(1)
