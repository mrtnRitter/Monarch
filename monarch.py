"""monarch – console chat with mastazilla incl. session credit cap and stopzilla."""

# --------- IMPORTS ---------
import argparse
import os
import sys
import time
import tomllib
import traceback
from datetime import datetime, timezone
from pathlib import Path

from skills.orca.orca import AworkClient, OrcaError, answer_after, clean_text, download_answer_files, terminal_states

# --------- STATIC ---------
api_key_name = "AWORK_API_KEY"

# --------- CONFIG ---------
app_name = "monarch"
app_version = "0.1"
config_file = Path(__file__).parent / "monarch.toml"


# --------- SESSION ---------
class StopZilla(Exception):
    """Raised when the session credit cap is reached."""


class Session:
    """One console chat with mastazilla, incl. log, credit cap and emergency stop."""

    def __init__(self, client: AworkClient, config: dict, thread_id: str | None):
        self.client = client
        self.config = config
        self.thread_id = thread_id
        self.started = datetime.now(timezone.utc)
        self.output_dir = Path(config["output_dir"])
        log_dir = Path(config["log_dir"])
        log_dir.mkdir(parents=True, exist_ok=True)
        self.log_file = log_dir / f"monarch_{self.started:%Y%m%d_%H%M%S}.log"
        self.baseline = self._thread_credits(client.thread_usage()) if thread_id else 0

    def log(self, text: str) -> None:
        with self.log_file.open("a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {text}\n")

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

    def send(self, text: str) -> None:
        if self.thread_id:
            accepted = self.client.send_message(self.thread_id, text)
        else:
            accepted = self.client.create_thread(self.config["mastazilla_agent_id"], text, f"monarch {self.started:%Y-%m-%d %H:%M}")
            self.thread_id = accepted["id"]
            print(f"(thread {self.thread_id})")
        self.log(f"martin: {text}")
        self.wait(accepted.get("acceptedMessageId"))

    def wait(self, message_id: str | None) -> None:
        response_id = None
        while message_id:
            status = self.client.message_status(self.thread_id, message_id)
            state = (status.get("status") or "").casefold()
            # "completed" can be reported before the answer is stored
            if state in terminal_states and (status.get("hasAgentResponse") or state != "completed"):
                response_id = status.get("responseId")
                break
            self.check_budget()
            time.sleep(self.config["poll_interval"])
        self.show_answer(message_id, response_id)

    def show_answer(self, message_id: str | None, response_id: str | None = None) -> None:
        answer = answer_after(self.client.messages(self.thread_id), message_id, response_id)
        text = "\n\n".join(part for message in answer if (part := clean_text(message.get("content")))) or "(no answer)"
        print(f"\nmastazilla> {text}\n")
        self.log(f"mastazilla: {text}")
        for path in download_answer_files(self.client, self.thread_id, answer, self.output_dir):
            print(f"file: {path}")
            self.log(f"file: {path}")


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
                session.send(text)
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
