# monarch

Run a high-model orchestrator agent (**mastazilla**) in awork that delegates coding work to several low-model agents (**minizilla**). You only talk to mastazilla.

- `monarch chat` – console chat between you and mastazilla
- `orca` – awork skill used by mastazilla to start, steer and stop minizillas within fixed limits

## Repository layout

```
monarch/
├── monarch.py              # console chat
├── monarch.toml            # console config
├── zillas/
│   ├── mastazilla.md       # system prompt for mastazilla
│   └── minizilla.md        # system prompt for minizilla
└── skills/orca/
    ├── SKILL.md            # skill instructions for mastazilla
    ├── orca.py             # skill CLI
    └── orca.toml           # skill config (limits)
```

## Installation

Requirements: Python 3.11+, an awork API key.

```bash
git clone <repo-url> monarch
cd monarch
pip install requests
```

Set the API key as environment variable (never in a config file):

```bash
# Linux / macOS
export AWORK_API_KEY="<your-api-key>"
# Windows PowerShell
$env:AWORK_API_KEY = "<your-api-key>"
```

## Setup in awork

1. Create the agent **minizilla** with the prompt from `zillas/minizilla.md` and a low model preset (e.g. `fast`).
2. Create the agent **mastazilla** with the prompt from `zillas/mastazilla.md` and a high model preset (e.g. `deep`).
3. Import `skills/orca` as a skill and link it to mastazilla.
4. Set the skill secret `AWORK_API_KEY` for orca.
5. Enter the agent IDs in `monarch.toml` and `skills/orca/orca.toml`.

## Usage

```bash
python monarch.py chat              # start a new conversation with mastazilla
python monarch.py chat --thread ID  # continue an existing conversation
```

Type your task and press Enter. mastazilla asks questions if needed, then delegates to minizillas and reports back.

Commands inside the chat:

| Command | Effect |
|---|---|
| `/stopzilla` | Emergency stop: stops mastazilla and all running minizillas |
| `/budget` | Show credits used in this session against `max_credits` |
| `/exit` | Leave the chat; the conversation stays in awork |
| `Ctrl+C` | Same as `/stopzilla` |

When the session reaches `max_credits`, the console triggers `/stopzilla` automatically.

Result files from mastazilla are saved to `output_dir`. Each job writes a log file to `log_dir`.

## orca commands

Used by mastazilla inside awork. Listed here for reference.

| Command | Effect |
|---|---|
| `orca spawn "<task>" [--file PATH ...]` | Start a new minizilla with a task; returns its `minizilla_id` (e.g. `minizilla_1`) |
| `orca send <minizilla_id> "<message>" [--file PATH ...]` | Send a follow-up message to a minizilla |
| `orca wait [<minizilla_id> ...] [--timeout SEC]` | Wait until the given (or all) minizillas have answered, max. `wait_timeout` |
| `orca status` | Show state of all minizillas of the current job |
| `orca collect <minizilla_id> [--dest DIR]` | Fetch the latest answer and result files of a minizilla |
| `orca cancel <minizilla_id>` | Stop one minizilla |
| `orca budget` | Show used credits, rounds and running minizillas against the limits |
| `orca stopzilla` | Stop all minizillas and close the current job |

A job starts with the first `spawn` and ends with `stopzilla`.
When a limit is reached, `orca` refuses further `spawn`/`send` calls; exceeding `max_credits_per_job` stops all minizillas.

## Configuration

### monarch.toml

```toml
mastazilla_agent_id = "<agent-id>"
minizilla_agent_id = "<agent-id>"
api_base_url = "https://api.awork.com/api/v1"
max_credits = 1000        # credit cap per session (mastazilla + minizillas); 0 = no cap
poll_interval = 3          # seconds between status and credit checks
output_dir = "./output"    # where result files are saved
log_dir = "./logs"         # one log file per job
```

### skills/orca/orca.toml

```toml
minizilla_agent_id = "<agent-id>"
api_base_url = "https://api.awork.com/api/v1"
max_minizillas = 3         # max. minizillas running at the same time
max_credits_per_job = 300  # credit cap for minizillas per job; 0 = no cap
max_rounds = 20            # max. messages sent to minizillas per job
wait_timeout = 170         # max. seconds one `orca wait` blocks
poll_interval = 5          # seconds between status checks
```

| Entry | Meaning |
|---|---|
| `mastazilla_agent_id` / `minizilla_agent_id` | ID of the respective agent in awork |
| `api_base_url` | awork API base URL |
| `max_minizillas` | Upper limit of parallel minizillas |
| `max_credits` | Credit cap per console session, mastazilla and minizillas combined (`monarch.toml`) |
| `max_credits_per_job` | Credit cap for all minizillas of one job (`orca.toml`) |
| `max_rounds` | Upper limit of messages to minizillas per job |
| `wait_timeout` | Max. duration of one `orca wait` call |
| `poll_interval` | Interval between status and credit checks |
| `output_dir` / `log_dir` | Local folders for results and logs |
