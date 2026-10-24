# monarch

VS Code chat window for awork agents. You talk to an agent (e.g. **mastazilla**); the agent delegates work to co-agents (e.g. **minizilla**) with ORCA commands. monarch runs these commands, waits for the co-agents without the agent running (no agent credits while waiting) and passes their answers back.

## Repository layout

```
monarch/
├── vscode/                 # VS Code extension (all monarch code)
│   ├── package.json        # extension manifest and settings
│   ├── src/                # extension code
│   ├── media/              # chat window (webview), styles adapted from vscode-acp (MIT)
│   ├── test/               # local tests (node, no network)
│   └── build_vsix.py       # builds monarch-<version>.vsix
├── zillas/
│   ├── codezilla.md        # system prompt for CodeZilla
│   ├── mastazilla.md       # system prompt for mastazilla
│   └── minizilla.md        # system prompt for minizilla
└── skills/
    └── monarch-transfer/   # skill: sends output files to monarch (SKILL.md, pack.py)
```

## Installation

Requirements: VS Code 1.85+, Python 3.11+ (only for building).

```bash
cd monarch/vscode
python build_vsix.py                         # -> monarch-0.11.0.vsix
code --install-extension monarch-0.11.0.vsix
```

Or in VS Code: Extensions view → `…` → **Install from VSIX…**. Optional local tests: `node test/test.js` and `node test/extension_smoke.js`.

## Setup in awork (once per workspace)

1. **Client app for sign-in:** Settings → Integrations → add a client application of type **Public** with the name `monarch`. Redirect URI: `http://localhost:8080/callback` (port = `monarch.redirectPort`). If the client ID is not `monarch`, enter it in `monarch.clientId`.
2. **Agents:** Create **minizilla** with `zillas/minizilla.md` and a low model preset (e.g. `fast`), **mastazilla** with `zillas/mastazilla.md` and a high model preset (e.g. `deep`). No secret is needed.
3. **Skill for files:** Create a skill **monarch-transfer** from `skills/monarch-transfer/` (`SKILL.md` and `pack.py`) and attach it to every agent used with monarch (CodeZilla, mastazilla, minizilla). Without it, files cannot reach the repo (see *Files written into the repo*).

## Sharing with colleagues

Colleagues in the same awork workspace only need to install the `.vsix` and run **monarch: Sign in** with their own account. They see their own agents plus the agents listed in `monarch.agents` (if shared with them); with `monarch.agentFilter` = `all` they see every agent shared with them. Credits and limits apply per chat.

## Settings

All settings are optional. The agent list comes from awork (see `monarch.agentFilter`); `monarch.agents` adds co-agents and labels to single agents and always shows them in the list:

```json
"monarch.agents": [
  {
    "agentId": "<mastazilla-agent-id>",
    "coAgentId": "<minizilla-agent-id>",
    "coAgentName": "minizilla",
    "labels": { "credits": "Credits", "coAgents": "Minizillas", "stop": "/stopzilla" }
  }
]
```

| Setting | Default | Meaning |
|---|---|---|
| `monarch.clientId` | `monarch` | Client ID of the public awork client app |
| `monarch.redirectPort` | `8765` | Local port of the sign-in callback; must match the redirect URI |
| `monarch.apiBaseUrl` | `https://api.awork.com/api/v1` | awork API base URL |
| `monarch.agentFilter` | `own` | `own`: agents you created plus agents listed in `monarch.agents`; `all`: every agent shared with you |
| `monarch.agents` | entry for Mastazilla | Additions per agent, matched by `agentId` (or `name`): `coAgentId` (agent started by `ORCA: spawn`; empty = no co-agents), `coAgentName` (prefix of co-agent IDs), `labels` (UI names of the three status items). Agents used as `coAgentId` are not shown in the agent list. |
| `monarch.maxCredits` | `1000` | Credit cap per chat (agent + co-agents); reaching it stops everything; `0` = no cap |
| `monarch.maxCoAgents` | `3` | Max. co-agents per job (a co-agent holds its slot until cancel/stopzilla); `0` = no cap |
| `monarch.maxRounds` | `20` | Max. messages to co-agents per job; `0` = no cap |
| `monarch.relayTimeout` | `900` | Seconds the relay waits before waking the agent with the current state; `0` = no limit |
| `monarch.pollInterval` | `3` | Seconds between status checks |
| `monarch.maxFolderMB` | `20` | Max. size of a folder or file attachment |
| `monarch.syncInterval` | `4` | Seconds between checks for new messages of the current chat written elsewhere (e.g. awork web app) while the chat window is visible; while the agent is working, a newer message of yours written elsewhere ends the wait; `0` = off |

## Usage

1. Run **monarch: Sign in** (or the button in the chat window). The browser opens; log in to awork and select the workspace.
2. Open **monarch** in the activity bar.

| Element | Function |
|---|---|
| Agent circles | Agents according to `monarch.agentFilter`, with their profile pictures; click to select. If they do not fit into the panel, a dropdown is shown instead. |
| History (clock) | Chats of the selected agent from all repos (max. 100), newest first, with repo name and date; click to continue a chat, ✕ removes it from the list (the chat stays in awork) |
| New chat (blue +) | Start a new conversation with the selected agent |
| Credits | Credits of the current chat (agent + co-agents) against `maxCredits` |
| Co-agents | Co-agents of the current job against `maxCoAgents`, incl. how many are working |
| Model | Model and reasoning level for the next messages of this chat; **Agent default** uses the agent's settings. Saved with the chat; co-agents keep their own model. |
| Stop | Stops the agent and all co-agents and closes the job |
| **Current file** / **Files** / **Folder** | Attach repo files to the next message; **Current file** takes the file of the active editor tab (also Markdown preview, images, notebooks, diffs), otherwise the last active file; folders are sent as ZIP (without `.git`, `node_modules`, `__pycache__`, `.venv`, `*.pyc` and `files.exclude`); max. 20 attachments and `maxFolderMB` per file or folder |
| Line above the input | Drag up/down to resize the input (min. 3 lines, max. 70 % of the panel); the height is kept |
| Enter / Shift+Enter | Send / new line |

The labels of Credits, Co-agents and Stop come from `labels` of the selected agent. The history is stored locally in VS Code for all repos together and survives restarts; the current chat is remembered per repo. Histories of older versions (per repo) are taken over when the repo is opened the first time. It only contains chats started with monarch; chats started in the awork web app are not listed.

A chat continued in the awork web app is updated in the chat window after `syncInterval` seconds. Files from answers that were not started in monarch are not written into the repo.

If credits cannot be read and `maxCredits` is not `0`, the chat does not accept further messages.

### Chat view

| Item | Display |
|---|---|
| Your messages | Right, in a bubble, with your awork profile picture |
| Agent answers | Left, in a bubble (max. 85 % wide), with the agent's awork profile picture, name and answer time (e.g. `Mastazilla · 19 s`); Markdown incl. tables and code (wide code and tables scroll inside the bubble). **Copy** next to the name (on hover) copies the answer as Markdown |
| Code blocks | Language and toolbar above each block: **Copy**; **Insert** at the cursor of the active or last active editor (replaces selections); **New file** opens an unsaved file with the block's language; **Terminal** puts the code into the active terminal (or a new `monarch` terminal) without running it. Multi-line code is pasted via the clipboard, so it stays in the clipboard |
| Questions | Questions with answer options from the agent as a card; click an option to send it as your answer, or type your own answer |
| Steps | Relay and command events as collapsible group (`relay · 3 events`) |
| While running | Spinner with elapsed time: `<agent> is working …` or `waiting for <co-agents> …` |
| Errors | Red box in the middle; hints about actions that are not possible right now (e.g. `Stop the agent first.`, attachments) disappear after 5 s |

Profile pictures are loaded once per VS Code session; without a picture, initials are shown.

### "This repo" (repo context)

The first message of a chat gets a context line at the end that is not shown in the chat. It tells the agent which repo is open in VS Code (the first workspace folder), the browser link of its git remote (`origin` or the upstream of the branch, without credentials), the branch and whether there are uncommitted changes or commits not pushed. Without a remote it says that the repo is not online. Later messages only get the line again when it changes (other repo, link or branch, or local changes appear or disappear). The agent reads the repo via this link (only the pushed state); attached files take precedence over the link. Requires the built-in VS Code Git extension.

```
[monarch context] "this repo" = the repo open in VS Code: Monarch · online: https://github.com/mrtnRitter/Monarch · branch: main
```

The agent prompts in `zillas/` contain the matching rule; copy them into the agents in awork after a change.

### Files written into the repo

The agent saves its result files in `/workspace/output/` with their repo path (e.g. `/workspace/output/src/app.py` → `src/app.py`) and then runs the skill **monarch-transfer** for the files it created or changed. The skill prints each file packed and with its SHA-256 as `MONARCH-FILE` lines into its tool results; awork stores these results with the chat. monarch reads them, puts the parts together, checks the checksum and writes the files into the first open workspace folder; existing files are overwritten. Text files are written as undoable edits. Only paths inside the repo are written (no absolute paths, no `..`, nothing in `.git`), Python caches never. Written files appear as links in the chat; files that could not be taken over are shown as warning, e.g. `not received (checksum mismatch)` or `not received (transfer incomplete (2/3 parts))`.

The skill sends about 30,000 chars per tool call (roughly 60–100 KB of source code, less for binary files); larger sets take several calls. The agent reads these results, so they cost credits.

Files of the answer that were not transferred are still downloaded the classic way (download link, artifact route, file route by id), which awork currently refuses for API clients (`401 No permissions to access this endpoint`); they then show up as `not received (download failed: …)`.

### Log

**Output → monarch** shows the run status reported by awork, every transferred file (`transfer <path>: ok` or the reason), every download attempt (route and result), for failed downloads the file data reported by awork (`id`, `name`, `mimeType`, `sandboxPath`, `downloadUrl`) and every reload by `syncInterval`.

### Co-agents (ORCA commands)

An agent with `coAgentId` controls co-agents with blocks at the end of its answer:

| Block | Effect |
|---|---|
| `### ORCA: spawn` + brief | Start a co-agent (`<coAgentName>_N`) |
| `### ORCA: send <id>` + message | Message to a co-agent |
| `### ORCA: cancel <id>` | Stop one co-agent |
| `### ORCA: wait` | Keep waiting |
| `### ORCA: stopzilla` | Stop all co-agents, close the job |

monarch wakes the agent with a `[monarch relay]` message when all working co-agents have answered, when one answers with `STATUS: question`/`blocked`, or after `relayTimeout`. Downloaded output files of the co-agents are attached to that message. A line `ATTACH: <repo path>` in a brief or message attaches that file from the local repo (max. 20, `maxFolderMB` each). Commands beyond the limits are refused and reported to the agent.

## Commands

| Command | Effect |
|---|---|
| `monarch: Sign in` / `monarch: Sign out` | OAuth sign-in in the browser / delete the stored sign-in |
| `monarch: New chat` | Same as the blue + button |
| `monarch: Stop agent and co-agents` | Same as the Stop button |
