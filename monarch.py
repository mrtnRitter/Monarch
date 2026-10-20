"""monarch – console chat with mastazilla incl. minizilla relay, session credit cap and stopzilla."""

# --------- IMPORTS ---------
import argparse
import os
import re
import sys
import time
import tomllib
import traceback
from datetime import datetime, timezone
from pathlib import Path

from skills.orca.orca import (
    AworkClient, OrcaError, answer_after, answer_text, download_answer_files, max_attachments, strip_file_blocks, terminal_states,
)

# --------- STATIC ---------
api_key_name = "AWORK_API_KEY"
wait_pattern = re.compile(r"<!--\s*orca:wait\s*-->")
status_pattern = re.compile(r"^\W*STATUS:\W*(\w+)", re.M | re.I)
minizilla_pattern = re.compile(r"minizilla_\d+")
urgent_states = {"question", "blocked"}
cancelled_states = {"cancelled", "canceled"}

# --------- CONFIG ---------
app_name = "monarch"
app_version = "0.2"
config_file = Path(__file__).parent / "monarch.toml"


# --------- SESSION ---------
class StopZilla(Exception):
    """Raised when the session credit cap is reached."""


class Session:
    """One console chat with mastazilla, incl. log, minizilla relay, credit cap and emergency stop."""

    def __init__(self, client: AworkClient, config: dict, thread_id: str | None):
        self.client = client
        self.config = config
        self.thread_id = thread_id
        self.started = datetime.now(timezone.utc)
        self.output_dir = Path(config["output_dir"])
        self.relayed: dict[str, str] = {}  # minizilla thread id -> last forwarded message id
        log_dir = Path(config["log_dir"])
        log_dir.mkdir(parents=True, exist_ok=True)
        self.log_file = log_dir / f"monarch_{self.started:%Y%m%d_%H%M%S}.log"
        self.baseline = self._thread_credits(client.thread_usage()) if thread_id else 0

    def log(self, text: str) -> None:
        with self.log_file.open("a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {text}\n")

    # --- credits ---
    def _minizilla_rows(self, rows: list[dict]) -> list[dict]:
        def is_new(row: dict) -> bool:
            created = row.get("createdOn")
            return bool(created) and datetime.fromisoformat(created.replace("Z", "+00:00")) >= self.started
        return [row for row in rows if row.get("agentId") == self.config["minizilla_agent_id"] and is_new(row)]

    def _thread_credits(self, rows: list[dict]) -> int:
        return next((row.get("creditsUsed") or 0 for row in rows if row.get("id") == self.thread_id), 0)

    def credits(self) -> int:
        """Credits of this session: mastazilla since start plus all minizillas started since start."""
        rows = self.client.thread_usage()
        mastazilla = self._thread_credits(rows) - self.baseline if self.thread_id else 0
        return mastazilla + sum(row.get("creditsUsed") or 0 for row in self._minizilla_rows(rows))

    def check_budget(self) -> None:
        limit = self.config["max_credits"]
        if limit and (used := self.credits()) >= limit:
            raise StopZilla(f"max_credits reached ({used}/{limit})")

    # --- mastazilla ---
    def run_state(self, thread_id: str, message_id: str) -> tuple[str | None, str | None]:
        """Return (final run state, response id) of a message, or (None, None) while it is still running."""
        status = self.client.message_status(thread_id, message_id)
        state = (status.get("status") or "").casefold()
        # "completed" can be reported before the answer is stored
        if state in terminal_states and (status.get("hasAgentResponse") or state != "completed"):
            return state, status.get("responseId")
        return None, None

    def send(self, text: str, attachments: list[dict] | None = None, author: str = "martin") -> list[dict]:
        """Send a message to mastazilla, wait for the answer, show it and return its messages."""
        if self.thread_id:
            accepted = self.client.send_message(self.thread_id, text, attachments)
        else:
            accepted = self.client.create_thread(self.config["mastazilla_agent_id"], text, f"monarch {self.started:%Y-%m-%d %H:%M}", attachments)
            self.thread_id = accepted["id"]
            print(f"(thread {self.thread_id})")
        self.log(f"{author}: {text}")
        return self.wait(accepted.get("acceptedMessageId"))

    def wait(self, message_id: str | None) -> list[dict]:
        response_id = None
        while message_id:
            state, response_id = self.run_state(self.thread_id, message_id)
            if state:
                break
            self.check_budget()
            time.sleep(self.config["poll_interval"])
        return self.show_answer(message_id, response_id)

    def show_answer(self, message_id: str | None, response_id: str | None = None) -> list[dict]:
        answer = answer_after(self.client.messages(self.thread_id), message_id, response_id)
        text = strip_file_blocks(answer_text(answer)) or "(no answer)"
        print(f"\nmastazilla> {text}\n")
        self.log(f"mastazilla: {text}")
        saved, warnings = download_answer_files(self.client, self.thread_id, answer, self.output_dir)
        for line in [f"file: {path}" for path in saved] + [f"warning: {warning}" for warning in warnings]:
            print(line)
            self.log(line)
        return answer

    def talk(self, text: str) -> None:
        """Send Martin's message, then relay minizilla answers as long as mastazilla ends with the wait marker."""
        answer = self.send(text)
        while any(wait_pattern.search(message.get("content") or "") for message in answer) and (relay := self.relay_wait()):
            answer = self.send(*relay, author="relay")

    # --- relay ---
    def _minizilla(self, row: dict) -> dict:
        thread_id = row["id"]
        label = match.group(0) if (match := minizilla_pattern.search(row.get("title") or "")) else f"thread_{thread_id[:8]}"
        messages = self.client.messages(thread_id)
        message_id = next((message.get("id") for message in reversed(messages) if (message.get("role") or "").casefold() == "user"), None)
        minizilla = {"thread_id": thread_id, "label": label, "message_id": message_id, "state": "working", "answer": []}
        if not message_id or not (run := self.run_state(thread_id, message_id))[0]:
            return minizilla
        state, response_id = run
        # reload: the answer may have been stored after the first read
        minizilla.update(state="answered" if state == "completed" else state, answer=answer_after(self.client.messages(thread_id), message_id, response_id))
        return minizilla

    def _forward(self, minizilla: dict, attachments: list[dict]) -> str:
        """Save and attach the files of one answered minizilla; return its section of the relay message."""
        target_dir = self.output_dir / "minizillas" / f"{minizilla['label']}_{minizilla['thread_id'][:8]}"
        saved, warnings = download_answer_files(self.client, minizilla["thread_id"], minizilla["answer"], target_dir)
        attached = []
        for path in saved:
            if len(attachments) >= max_attachments:
                warnings.append(f"{path.name} not attached (max. {max_attachments} files per message)")
                continue
            try:
                attachments.append({"temporaryFileId": self.client.upload_temporary_file(path)})
                attached.append(path.name)
            except OrcaError as exc:
                warnings.append(f"{path.name} not attached ({str(exc)[:160]})")
        self.relayed[minizilla["thread_id"]] = minizilla["message_id"]
        print(f"relay: {minizilla['label']} {minizilla['state']}, {len(attached)} files")
        lines = [f"## {minizilla['label']} ({minizilla['state']}, thread {minizilla['thread_id']})", strip_file_blocks(answer_text(minizilla["answer"])) or "(no answer text)"]
        lines += [f"attached: {', '.join(attached)}"] if attached else []
        lines += [f"warning: {warning}" for warning in warnings]
        return "\n".join(lines)

    def relay_message(self, done: list[dict], pending: list[dict], timed_out: bool) -> tuple[str, list[dict]]:
        attachments: list[dict] = []
        parts = ["[monarch relay] minizilla update"] + [self._forward(minizilla, attachments) for minizilla in done]
        if pending:
            parts.append(f"still working: {', '.join(minizilla['label'] for minizilla in pending)}" + (" (relay_timeout reached)" if timed_out else ""))
        return "\n\n".join(parts), attachments

    def relay_wait(self) -> tuple[str, list[dict]] | None:
        """Wait for minizilla answers without mastazilla. Returns the relay message incl. attachments, or None if nothing runs."""
        def is_urgent(minizilla: dict) -> bool:
            match = status_pattern.search(answer_text(minizilla["answer"]))
            return bool(match) and match.group(1).casefold() in urgent_states

        timeout = self.config.get("relay_timeout", 0)
        deadline = time.monotonic() + timeout if timeout else None
        idle_polls = 0
        print("relay: waiting for minizillas (Ctrl+C = stopzilla)")
        while True:
            self.check_budget()
            minizillas = [self._minizilla(row) for row in self._minizilla_rows(self.client.thread_usage())]
            fresh = [minizilla for minizilla in minizillas if minizilla["state"] != "working" and self.relayed.get(minizilla["thread_id"]) != minizilla["message_id"]]
            # mastazilla cancelled these itself, no need to wake it up
            self.relayed.update({minizilla["thread_id"]: minizilla["message_id"] for minizilla in fresh if minizilla["state"] in cancelled_states})
            done = [minizilla for minizilla in fresh if minizilla["state"] not in cancelled_states]
            pending = [minizilla for minizilla in minizillas if minizilla["state"] == "working"]
            timed_out = deadline is not None and time.monotonic() >= deadline
            # a second empty poll guards against threads that are not listed yet
            idle_polls = 0 if done or pending else idle_polls + 1
            if idle_polls >= 2:
                print("relay: no working minizillas – back to you")
                return None
            if (done and (not pending or any(is_urgent(minizilla) for minizilla in done))) or (timed_out and pending):
                return self.relay_message(done, pending, timed_out)
            time.sleep(self.config["poll_interval"])

    # --- control ---
    def stopzilla(self, reason: str = "manual") -> None:
        """Cancel mastazilla and all minizillas started in this session."""
        targets = ([self.thread_id] if self.thread_id else []) + [row["id"] for row in self._minizilla_rows(self.client.thread_usage())]
        for thread_id in targets:
            try:
                self.client.cancel(thread_id)
            except OrcaError:
                pass  # finished threads cannot be cancelled
        message = f"stopzilla ({reason}): {len(targets)} threads stopped"
        print(message)
        self.log(message)

    def budget(self) -> None:
        limit = self.config["max_credits"] or "no cap"
        print(f"credits: {self.credits()}/{limit}")


# --------- MAIN ---------
def load_config() -> dict:
    if not config_file.is_file():
        sys.exit(f"Config not found: {config_file}")
    config = tomllib.loads(config_file.read_text(encoding="utf-8"))
    if missing := [key for key in ("mastazilla_agent_id", "minizilla_agent_id") if "<" in config.get(key, "<")]:
        sys.exit(f"Set {', '.join(missing)} in {config_file.name}.")
    return config


def chat(session: Session) -> None:
    print(f"{app_name} {app_version} – /stopzilla, /budget, /exit")
    while True:
        try:
            text = input("you> ").strip()
            if not text:
                continue
            if text == "/exit":
                return
            if text == "/stopzilla":
                session.stopzilla()
            elif text == "/budget":
                session.budget()
            else:
                session.check_budget()
                session.talk(text)
        except StopZilla as exc:
            session.stopzilla(str(exc))
        except KeyboardInterrupt:
            print()
            session.stopzilla("Ctrl+C")
        except EOFError:
            return
        except OrcaError as exc:
            print(f"error: {exc}")
            session.log(f"error: {exc}")


def main() -> None:
    parser = argparse.ArgumentParser(prog=app_name)
    commands = parser.add_subparsers(dest="command", required=True)
    chat_parser = commands.add_parser("chat", help="chat with mastazilla")
    chat_parser.add_argument("--thread", help="continue an existing conversation")
    args = parser.parse_args()
    api_key = os.environ.get(api_key_name) or sys.exit(f"Set the environment variable {api_key_name}.")
    config = load_config()
    session = Session(AworkClient(config["api_base_url"], api_key), config, args.thread)
    chat(session)


# --------- EXEC ---------
if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Unhandled error in main: {exc}")
        print(traceback.format_exc())
