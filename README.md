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
└── skills/                 # skills for the agents
```

## Installation

Requirements: VS Code 1.85+, Python 3.11+ (only for building).

```bash
cd monarch/vscode
python build_vsix.py                         # -> monarch-0.5.1.vsix
code --install-extension monarch-0.5.1.vsix
```

Or in VS Code: Extensions view → `…` → **Install from VSIX…**. Optional local tests: `node test/test.js` and `node test/extension_smoke.js`.

## Setup in awork (once per workspace)

1. **Client app for sign-in:** Settings → Integrations → add a client application of type **Public** with the name `monarch`. Redirect URI: `http://localhost:8080/callback` (port = `monarch.redirectPort`). If the client ID is not `monarch`, enter it in `monarch.clientId`.
2. **Agents:** Create **minizilla** with `zillas/minizilla.md` and a low model preset (e.g. `fast`), **mastazilla** with `zillas/mastazilla.md` and a high model preset (e.g. `deep`). No skill and no secret are needed.

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
| `monarch.maxFolderMB` | `20` | Max. size of a folder attachment |

## Usage

1. Run **monarch: Sign in** (or the button in the chat window). The browser opens; log in to awork and select the workspace.
2. Open **monarch** in the activity bar.

| Element | Function |
|---|---|
| Agent circles | Agents according to `monarch.agentFilter`, with their profile pictures; click to select. If they do not fit into the panel, a dropdown is shown instead. |
| History (clock) | Chats of the selected agent in this repo, newest first; click to continue a chat, ✕ removes it from the list (the chat stays in awork) |
| New chat (blue +) | Start a new conversation with the selected agent |
| Credits | Credits of the current chat (agent + co-agents) against `maxCredits` |
| Co-agents | Co-agents of the current job against `maxCoAgents`, incl. how many are working |
| Model | Model and reasoning level for the next messages of this chat; **Agent default** uses the agent's settings. Saved with the chat; co-agents keep their own model. |
| Stop | Stops the agent and all co-agents and closes the job |
| **Current file** / **Files** / **Folder** | Attach repo files to the next message; folders are sent as ZIP (without `.git`, `node_modules`, `__pycache__`, `.venv`, `*.pyc` and `files.exclude`); max. 20 attachments |
| Enter / Shift+Enter | Send / new line |

The labels of Credits, Co-agents and Stop come from `labels` of the selected agent. The history only contains chats started with monarch; chats started in the awork web app are not listed.

If credits cannot be read and `maxCredits` is not `0`, the chat does not accept further messages.

### Chat view

| Item | Display |
|---|---|
| Your messages | Right, in a bubble, with your awork profile picture |
| Agent answers | Left, with the agent's awork profile picture, name and answer time (e.g. `Mastazilla · 19 s`); Markdown incl. tables and code |
| Steps | Relay and command events as collapsible group (`relay · 3 events`) |
| While running | Spinner with elapsed time: `<agent> is working …` or `waiting for <co-agents> …` |
| Errors | Red box in the middle |

Profile pictures are loaded once per VS Code session; without a picture, initials are shown.

### Files written into the repo

Files from the agent's answer are written into the first open workspace folder:

- FILE blocks (`### FILE: <path> sha256=<checksum>` plus code block) with a matching checksum
- output files of the agent that can be downloaded (path below `/workspace/output/` = path in the repo)

Only paths inside the repo are written (no absolute paths, no `..`, nothing in `.git`). Text files are written as undoable edits. Files with `checksum mismatch` or without checksum (`unverified`) and Python caches are not written; the chat shows a warning. Written files appear as links in the chat.

The checksum is SHA-256 over the file as UTF-8 text with LF line endings and exactly one final line break. Check a file manually:

```bash
python3 -c "import hashlib,pathlib,sys;[print(hashlib.sha256((pathlib.Path(p).read_text(encoding='utf-8').replace('\r\n','\n').rstrip('\n')+'\n').encode()).hexdigest(),p) for p in sys.argv[1:]]" <file>
```

### Co-agents (ORCA commands)

An agent with `coAgentId` controls co-agents with blocks at the end of its answer:

| Block | Effect |
|---|---|
| `### ORCA: spawn` + brief | Start a co-agent (`<coAgentName>_N`) |
| `### ORCA: send <id>` + message | Message to a co-agent |
| `### ORCA: cancel <id>` | Stop one co-agent |
| `### ORCA: wait` | Keep waiting |
| `### ORCA: stopzilla` | Stop all co-agents, close the job |

monarch wakes the agent with a `[monarch relay]` message when all working co-agents have answered, when one answers with `STATUS: question`/`blocked`, or after `relayTimeout`. Co-agent files are attached to that message (only with matching checksum). Commands beyond the limits are refused and reported to the agent.

## Commands

| Command | Effect |
|---|---|
| `monarch: Sign in` / `monarch: Sign out` | OAuth sign-in in the browser / delete the stored sign-in |
| `monarch: New chat` | Same as the blue + button |
| `monarch: Stop agent and co-agents` | Same as the Stop button |
