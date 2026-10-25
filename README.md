# monarch

VS Code chat window for awork agents. You talk to an agent (e.g. **mastazilla**); the agent delegates work to co-agents (e.g. **minizilla**) with ORCA commands. monarch runs these commands, waits for the co-agents without the agent running (no agent credits while waiting) and passes their answers back.

## ORCA spawn dependencies

A spawn brief may contain one or more `AFTER:` lines. monarch reserves its `minizilla_N` ID immediately and reports `ok: spawn minizilla_N (waiting for ...)` while it waits. It starts the spawn only after every dependency has answered successfully. `AFTER: minizilla_N` names an existing minizilla, while `AFTER: spawn_K` names the K-th `### ORCA: spawn` block in the same mastazilla answer (counting from 1). A dependency answer with `STATUS: question` or `STATUS: blocked`, or a cancelled dependency, prevents the spawn and returns control to mastazilla; the relay timeout also returns control while work is still pending.

`ATTACH: spawn_K` resolves to the files staged by that spawn, when the dependent spawn starts. For example:

```text
### ORCA: spawn
Create the shared plan and save it as plan.md.

### ORCA: spawn
AFTER: spawn_1
ATTACH: spawn_1
Review the shared plan and save the review.
```

Multiple `AFTER:` lines are allowed; all listed minizillas must finish before launch. A waiting spawn can also be cancelled with `### ORCA: cancel minizilla_N`.

## Repository layout

```
monarch/
├── vscode/                 # VS Code extension (all monarch code)
│   ├── package.json        # extension manifest and settings
│   ├── src/                # extension code
│   ├── media/              # chat window (webview), styles adapted from vscode-acp (MIT)
│   ├── test/               # local tests (node, no network)
│   └── build_vsix.py       # builds monarch-<version>.vsix
└── zillas/
│   ├── codezilla.md        # system prompt for CodeZilla
│   ├── mastazilla.md       # system prompt for mastazilla
│   └── minizilla.md        # system prompt for minizilla
```

## Installation

Requirements: VS Code 1.85+ with the built-in Git extension, an awork account in the workspace; Python 3.11+ only for building.

```bash
cd monarch/vscode
python build_vsix.py                         # -> monarch-0.16.0.vsix
code --install-extension monarch-0.16.0.vsix
```

Or in VS Code: Extensions view → `…` → **Install from VSIX…**. Optional local tests: `node test/test.js`, `node test/test_month.js` and `node test/extension_smoke.js`. No API key is needed for chat; an API key is needed only for Month.

## Setup in awork (once per workspace, by the agent owner)

1. **Client app for sign-in:** Settings → Integrations → add a client application of type **Public** with the name `monarch`. Redirect URI: `http://localhost:8765/callback` (port = `monarch.redirectPort`). If the client ID is not `monarch`, every user enters it in `monarch.clientId`.
2. **Agents:** Create **minizilla** with `zillas/minizilla.md` and a low model preset (e.g. `fast`), **mastazilla** with `zillas/mastazilla.md` and a high model preset (e.g. `deep`); CodeZilla uses `zillas/codezilla.md`. After a change of a file in `zillas/`, copy it into the agent again.
3. **Sharing:** Share the agents with the colleagues who use monarch.

## Setup per user (step by step)

Every user, also the agent owner, does this once:

1. **Install** `monarch-0.16.0.vsix` (see *Installation*) and reload VS Code (Command Palette → **Developer: Reload Window**).
2. **Sign in:** Open **monarch** in the activity bar and click **Sign in** (or Command Palette → **monarch: Sign in**). The browser opens; log in to awork and select the workspace.
3. **Check the agents:** The agent circles at the top show the agents. If an agent shared with you is missing, set **Monarch: Agent Filter** (`monarch.agentFilter`) to `all`.
4. **Test files:** Start a **new chat** (blue **+**) and send: `Create output/download_test.txt with three lines.`
5. **Check:** `download_test.txt` appears as link in the answer and in the repo; **Output → monarch** shows `download download_test.txt: ok`. Then delete the test file.

| Problem | Cause and fix |
|---|---|
| `not downloaded (HTTP 403)` | awork refused the download of this file (seen for `package.json`). Get the file another way; note name and time to report the pattern |
| `not downloaded (HTTP 401)` | Sign-in expired or the download is not allowed for your login: sign in again |
| `not downloaded (no download link)` | awork listed the file without download link; ask the agent to save it again |
| `not written (…)` | The file could not be written (e.g. no folder open, file locked) |
| No agents | Sign in again; check sharing (owner setup 3) and `monarch.agentFilter` |

Credits and limits apply per chat.

## Settings

All settings are optional. The agent list comes from awork (see `monarch.agentFilter`); `monarch.agents` adds co-agents and labels to single agents and always shows them in the list:

```json
"monarch.agents": [
  {
    "agentId": "<mastazilla-agent-id>",
    "coAgentId": "<minizilla-agent-id>",
    "coAgentName": "minizilla",
    "labels": { "month": "Monat", "chat": "Chat", "coAgents": "Co-Agenten", "stop": "/stopzilla" }
  }
]
```

| Setting | Default | Meaning |
|---|---|---|
| `monarch.clientId` | `monarch` | Client ID of the public awork client app |
| `monarch.redirectPort` | `8765` | Local port of the sign-in callback; must match the redirect URI |
| `monarch.apiBaseUrl` | `https://api.awork.com/api/v1` | awork API base URL |
| `monarch.agentFilter` | `own` | `own`: agents you created plus agents listed in `monarch.agents`; `all`: every agent shared with you |
| `monarch.agents` | entry for Mastazilla | Additions per agent, matched by `agentId` (or `name`): `coAgentId` (agent started by `ORCA: spawn`; empty = no co-agents), `coAgentName` (prefix of co-agent IDs), `labels` (UI names of the status items; `month`, `chat`, `coAgents`, `stop` (`credits` = deprecated, same as `chat`)). Agents used as `coAgentId` are not shown in the agent list. |
| `monarch.maxCredits` | `1000` | Credit cap per chat (agent + co-agents); reaching it stops everything; `0` = no cap. Can be changed per chat with − / + in the chat window. |
| `monarch.maxCoAgents` | `3` | Max. co-agents per job (a co-agent holds its slot until cancel/stopzilla); `0` = no cap. Can be changed per chat with − / + in the chat window. |
| `monarch.creditStep` | `100` | Credits added or removed per click on − / + of the Chat item (this chat only); minimum `1` |
| `monarch.monthlyCredits` | `0` | Your monthly awork AI credit quota (AI plan, see awork account settings → awork AI); `0` = show usage only |
| `monarch.creditResetDay` | `1` | Day of the month (UTC) on which your AI credits reset; range `1`–`28` |
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
| New chat (blue +) | Start a new conversation with the selected agent. **Ctrl+click** (Mac: Cmd+click) takes over an existing chat instead (workaround, e.g. for chats started in the awork web app): paste its link (`https://<workspace>.awork.com/ai/thread/<id>`) or id; the chat must belong to the selected agent and be readable with your login. It opens and is added to the history. |
| Month | Reads the signed-in user’s AI usage with an awork API key (Ctrl/Cmd+click Month or run `monarch: Set API key`). The key is stored in VS Code Secret Storage, used only for usage, and an empty value removes it. The quota cannot be read from the API; configure it with `monthlyCredits`. The period starts on `creditResetDay` (UTC). Requires awork admin rights; updated at most once per minute and warning-colored at 90% of quota. |
| Chat | Credits of this chat (agent + co-agents) against `maxCredits`. Hover to show − on the left, the current limit in the middle, and + on the right; clicks change only this chat’s limit by `creditStep`, saved with the chat. The limit cannot go below credits already used. `0` = no limit and no buttons. Turns warning-colored at 90%. |
| Co-agents | Co-agents of the current job against `maxCoAgents`, incl. how many are working. Hover to show − on the left, the current limit in the middle, and + on the right; clicks change only this chat’s limit by 1. Minimum is the number of active co-agents, and at least 1. `0` = no limit and no buttons. |
| Model | Model and reasoning level for the next messages of this chat; **Agent default** uses the agent's settings. Saved with the chat; co-agents keep their own model. |
| Stop | Stops the agent and all co-agents and closes the job |
| **Current file** / **Files** / **Folder** | Attach repo files to the next message; **Current file** takes the file of the active editor tab (also Markdown preview, images, notebooks, diffs), otherwise the last active file; folders are sent as ZIP (without `.git`, `node_modules`, `__pycache__`, `.venv`, `*.pyc` and `files.exclude`); max. 20 attachments and `maxFolderMB` per file or folder |
| Line above the input | Drag up/down to resize the input (min. 3 lines, max. 70 % of the panel); the height is kept |
| Enter / Shift+Enter | Send / new line |
| Ctrl+C / Cmd+C | Copies the selected text of the chat (or of the input) |

The labels of Month, Chat, Co-agents and Stop come from `labels` of the selected agent. The history is stored locally in VS Code for all repos together and survives restarts; the current chat is remembered per repo. Histories of older versions (per repo) are taken over when the repo is opened the first time. It only contains chats started or taken over in monarch: awork does not let API clients list chats (the route of the web app and `/agents/management/threads` are refused for non-admins).

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
| Warnings | Yellow box in the middle, e.g. a co-agent file that could not be downloaded; stays until closed with ✕ |
| Errors | Red box in the middle; hints about actions that are not possible right now (e.g. `Stop the agent first.`, attachments) disappear after 5 s; ✕ closes any error box |

Profile pictures are loaded once per VS Code session; without a picture, initials are shown.

### "This repo" (repo context)

The first message of a chat gets a context line at the end that is not shown in the chat. It tells the agent which repo is open in VS Code (the first workspace folder), the browser link of its git remote (`origin` or the upstream of the branch, without credentials), the branch and whether there are uncommitted changes or commits not pushed. Without a remote it says that the repo is not online. Later messages only get the line again when it changes (other repo, link or branch, or local changes appear or disappear). The agent reads the repo via this link (only the pushed state); attached files take precedence over the link. Requires the built-in VS Code Git extension.

```
[monarch context] "this repo" = the repo open in VS Code: Monarch · online: https://github.com/mrtnRitter/Monarch · branch: main
```

The agent prompts in `zillas/` contain the matching rule; copy them into the agents in awork after a change.

### Files written into the repo

The agent saves its files in `/workspace/output/` with their repo path (e.g. `/workspace/output/src/app.py` → `src/app.py`). awork lists every file created or changed in a run at the agent's answer, with a download link. After each answer monarch downloads these files and writes them into the first open workspace folder; existing files are overwritten. Text files are written as undoable edits. Only paths inside the repo are written (no absolute paths, no `..`, nothing in `.git`), Python caches never. Written files appear as links in the chat; a click opens the file in the editor (images and binary files with the matching viewer). Files that could not be downloaded or written are shown as warning below the answer, e.g. `package.json not downloaded (HTTP 403)`.

Co-agent files are not written directly: monarch downloads them when the co-agent answers and keeps them staged outside the repo (latest version per path) until the agent sends `### ORCA: commit`. Failed downloads of co-agent files are shown as yellow warning box and reported to the agent. A new chat discards staged files.

### Log

**Output → monarch** shows the run status reported by awork, every download (`download <path>: ok` or the error), every `commit` and every reload by `syncInterval`.

### Co-agents (ORCA commands)

An agent with `coAgentId` controls co-agents with blocks at the end of its answer:

| Block | Effect |
|---|---|
| `### ORCA: spawn` + brief | Start a co-agent (`<coAgentName>_N`) |
| `### ORCA: send <id>` + message | Message to a co-agent |
| `### ORCA: cancel <id>` | Stop one co-agent |
| `### ORCA: wait` | Keep waiting |
| `### ORCA: commit` | Write all staged co-agent files into the repo; failed ones stay staged |
| `### ORCA: stopzilla` | Stop all co-agents, close the job |

monarch wakes the agent with a `[monarch relay]` message when all working co-agents have answered, when one answers with `STATUS: question`/`blocked`, or after `relayTimeout`. It lists the staged files of each co-agent (`files (staged, not in the repo yet): …`) and download warnings; no files are attached. A line `ATTACH: <repo path>` in a brief or message attaches that file (staged version first, else from the local repo, `maxFolderMB` each); `ATTACH: <co-agent id>` attaches all staged files of that co-agent; max. 20 files per message. Commands beyond the limits are refused and reported to the agent.

## Commands

| Command | Effect |
|---|---|
| `monarch: Sign in` / `monarch: Sign out` | OAuth sign-in in the browser / delete the stored sign-in |
| `monarch: Set API key` | Store or remove the awork API key used only for Month usage |
| `monarch: New chat` | Same as the blue + button |
| `monarch: Stop agent and co-agents` | Same as the Stop button |
