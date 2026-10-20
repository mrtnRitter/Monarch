---
name: orca
description: Start, steer and stop minizilla coding agents within fixed limits (minizillas, rounds, credits). Use for every delegation to minizillas.
---

# orca

Run all commands from your workspace root as `python3 <path-of-this-skill>/orca.py <command>`. Requires the skill secret `AWORK_API_KEY`.

## Commands

| Command | Use |
|---|---|
| `spawn "<task>" [--file PATH ...]` | Start a new minizilla with a complete brief. Prints its `minizilla_id`. |
| `send <minizilla_id> "<message>" [--file PATH ...]` | Answer a question or give corrections. |
| `wait [<minizilla_id> ...] [--timeout SEC]` | Only without monarch relay. Block up to `wait_timeout` seconds until answers arrive. Repeat while it prints `still working`. |
| `status` | Show the state (`working`, `answered`, `cancelled`, `failed`) and thread of all minizillas. |
| `collect <minizilla_id> [--dest DIR]` | Only without monarch relay. Print the latest answer and save its files (default `scratch/minizillas/<minizilla_id>/`). |
| `cancel <minizilla_id>` | Stop a minizilla and free its slot. |
| `budget` | Show credits, rounds and minizillas against the limits. |
| `stopzilla` | Stop all minizillas and close the job. Run it at the end of every job. |

## Relay

With the monarch console, end your turn after `spawn`/`send` with `<!-- orca:wait -->` as last line. monarch waits for the minizillas and sends their answers as `[monarch relay]` message with the files attached. Do not call `wait`/`collect` then.

## Rules

- A job starts with the first `spawn` and ends with `stopzilla`.
- A minizilla occupies a slot until `cancel` or `stopzilla`. Cancel minizillas you no longer need.
- When orca refuses a command because of a limit, do not work around it. Report the situation to Martin.
- Exceeding `max_credits_per_job` during `wait` stops all minizillas automatically.
- `collect` saves files from downloads and from FILE blocks in the answer text; `__pycache__` and `*.pyc` are skipped. Unsaved files are listed as `warning`.
- FILE blocks carry a checksum (`### FILE: <name> sha256=<checksum>`). `collect` and the relay compare it with the saved content:
  - match: file is listed as `file:` (verified)
  - `checksum mismatch`: block differs from the minizilla's file; do not use it, request it again with `send`
  - `unverified`: block has no checksum; request it again with `send`
