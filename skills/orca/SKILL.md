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
| `wait [<minizilla_id> ...] [--timeout SEC]` | Block up to `wait_timeout` seconds until answers arrive. Repeat while it prints `still working`. |
| `status` | Show the state of all minizillas (`working`, `answered`, `cancelled`, `failed`). |
| `collect <minizilla_id> [--dest DIR]` | Print the latest answer and download its files (default `scratch/minizillas/<minizilla_id>/`). |
| `cancel <minizilla_id>` | Stop a minizilla and free its slot. |
| `budget` | Show credits, rounds and minizillas against the limits. |
| `stopzilla` | Stop all minizillas and close the job. Run it at the end of every job. |

## Rules

- A job starts with the first `spawn` and ends with `stopzilla`.
- A minizilla occupies a slot until `cancel` or `stopzilla`. Cancel minizillas you no longer need.
- When orca refuses a command because of a limit, do not work around it. Report the situation to Martin.
- Exceeding `max_credits_per_job` during `wait` stops all minizillas automatically.
