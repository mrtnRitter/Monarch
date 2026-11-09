# monarch

VS Code chat window for awork agents. You talk to an agent (e.g. **CodeZilla**); the agent delegates work to co-agents (e.g. **minizilla**) with ORCA commands. monarch runs these commands, waits for the co-agents without the agent running (no agent credits while waiting) and passes their answers back.

## ORCA spawn dependencies

A spawn brief may contain one or more `AFTER:` lines. monarch reserves its `<coAgentName>_N` ID (e.g. `minizilla_N`) immediately and reports `ok: spawn minizilla_N (waiting for ...)` while it waits. It starts the spawn only after every dependency has answered successfully. `AFTER: <coAgentName>_N` (e.g. `AFTER: minizilla_2`) names an existing co-agent, while `AFTER: spawn_K` names the K-th `### ORCA: spawn` block in the same agent answer (counting from 1). A dependency answer with `STATUS: question`, `STATUS: blocked` or `STATUS: plan`, or a cancelled dependency, prevents the spawn and returns control to the agent; the relay timeout also returns control while work is still pending.

`ATTACH: spawn_K` resolves to the files staged by that spawn, when the dependent spawn starts. For example:

```text
### ORCA: spawn
Create the shared plan and save it as plan.md.

### ORCA: spawn
AFTER: spawn_1
ATTACH: spawn_1
Review the shared plan and save the review.
```

Multiple `AFTER:` lines are allowed; all listed co-agents must finish before launch. A waiting spawn can also be cancelled with `### ORCA: cancel minizilla_N`.

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
│   └── minizilla.md        # system prompt for minizilla
```

## Installation

Requirements: VS Code 1.85+ with the built-in Git extension, an awork account in the workspace; Python 3.11+ only for building.

```bash
cd monarch/vscode
python build_vsix.py                         # -> monarch-0.21.1.vsix
code --install-extension monarch-0.21.1.vsix
```

Or in VS Code: Extensions view → `…` → **Install from VSIX…**. Optional local tests: `node test/test.js`, `node test/steps_test.js`, `node test/webview_test.js`, `node test/extension_smoke.js`, `node test/relay_plan_progress_test.js`, `node test/chat_view_test.js` and `node test/notes_test.js`; `test/webview_notes_test.js` needs jsdom (`NODE_PATH=<folder>/node_modules node test/webview_notes_test.js`).

## Setup in awork (once per workspace, by the agent owner)

1. **Client app for sign-in:** Settings → Integrations → add a client application of type **Public** with the name `monarch`. Redirect URI: `http://localhost:8765/callback` (port = `monarch.redirectPort`). If the client ID is not `monarch`, every user enters it in `monarch.clientId`.
2. **Agents:** Create **CodeZilla** with `zillas/codezilla.md` and a high model preset (e.g. `deep`), **minizilla** with `zillas/minizilla.md` and a medium model preset; a low preset (e.g. `fast`) works only with fully specified briefs. Enter the agent IDs in `monarch.agents` (`agentId` = CodeZilla, `coAgentId` = minizilla) if they differ from the default. After a change of a file in `zillas/`, copy it into the agent again.
3. **Sharing:** Share the agents with the colleagues who use monarch.

## Setup per user (step by step)

Every user, also the agent owner, does this once:

1. **Install** `monarch-0.21.0.vsix` (see *Installation*) and reload VS Code (Command Palette → **Developer: Reload Window**).
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
    "agentId": "<codezilla-agent-id>",
    "coAgentId": "<minizilla-agent-id>",
    "coAgentName": "minizilla",
    "labels": { "chat": "Chat", "coCredits": "Co-Credits", "coAgents": "Co-Agenten", "stop": "/stopzilla" }
  }
]
```

| Setting | Default | Meaning |
|---|---|---|
| `monarch.clientId` | `monarch` | Client ID of the public awork client app |
| `monarch.redirectPort` | `8765` | Local port of the sign-in callback; must match the redirect URI |
| `monarch.apiBaseUrl` | `https://api.awork.com/api/v1` | awork API base URL |
| `monarch.agentFilter` | `own` | `own`: agents you created plus agents listed in `monarch.agents`; `all`: every agent shared with you |
| `monarch.agents` | entry for CodeZilla | Additions per agent, matched by `agentId` (or `name`): `coAgentId` (agent started by `ORCA: spawn`; empty = no co-agents), `coAgentName` (prefix of co-agent IDs; empty = awork name of the co-agent in lower case without spaces, e.g. `minizilla`), `labels` (UI names of the status items; `chat`, `coCredits`, `coAgents`, `stop` (`credits` = deprecated, same as `chat`)). Agents used as `coAgentId` are not shown in the agent list. |
| `monarch.maxCredits` | `1000` | Credit cap per chat for the agent only; reaching it stops the agent and all co-agents; `0` = no cap. Can be changed per chat with − / + in the chat window. |
| `monarch.maxCoAgentCredits` | `1000` | Credit cap per chat for all co-agents together; reaching it stops the agent and all co-agents, `spawn` and `send` are refused; `0` = no cap. Can be changed per chat with − / + in the chat window. |
| `monarch.maxCoAgents` | `10` | Max. co-agents per job (a co-agent holds its slot until cancel/stopzilla); `0` = no cap. Can be changed per chat with − / + in the chat window. |
| `monarch.creditStep` | `100` | Credits added or removed per click on − / + of the Chat and Co-Credits items (this chat only); minimum `1` |
| `monarch.relayTimeout` | `600` | Seconds the relay waits before waking the agent with the current state, including the progress of working co-agents; `0` = no limit |
| `monarch.pollInterval` | `3` | Seconds between status checks |
| `monarch.maxFolderMB` | `20` | Max. size of a folder or file attachment |
| `monarch.notesPosition` | `right` | Side of the notes pane next to the chat: `left` or `right` |
| `monarch.syncInterval` | `4` | Seconds between checks for new messages of the current chat written elsewhere (e.g. awork web app) while the chat window is visible; while the agent is working, a newer message of yours written elsewhere ends the wait; `0` = off |

## Usage

1. Run **monarch: Sign in** (or the button in the chat window). The browser opens; log in to awork and select the workspace.
2. Open **monarch** in the activity bar.

| Element | Function |
|---|---|
| Agent circles | Agents according to `monarch.agentFilter`, with their profile pictures; click to select. If they do not fit into the panel, a dropdown is shown instead. |
| Notes (note sheet) | Left of the history button: shows or hides the notes pane of the current chat (full height of the window, left or right of the chat according to `monarch.notesPosition`); shown or hidden stays as set for all chats |
| History (clock) | Chats of the selected agent from all repos (max. 100), newest first, with repo name and date; click to continue a chat, ✕ removes it from the list (the chat stays in awork) |
| New chat (blue +) | Start a new conversation with the selected agent. **Ctrl+click** (Mac: Cmd+click) takes over an existing chat instead (workaround, e.g. for chats started in the awork web app): paste its link (`https://<workspace>.awork.com/ai/thread/<id>`) or id; the chat must belong to the selected agent and be readable with your login. It opens and is added to the history. |
| Row above the input | **+** (attachments) on the left, **Chat**, **Co-Credits** and **Co-agents** in the middle, **Model** on the right (details below) |
| **+** | Opens a small menu to the right of the button, **Current file** at the height of **+**: **Current file** attaches the file of the active editor tab (also Markdown preview, images, notebooks, diffs), otherwise the last active file, as single file. **Files** and **Folder** open the file dialog for files or folders. Everything picked with **Files** and **Folder** is sent together as one `attachments.zip` with paths relative to the repo root (files outside the repo under their file name; folders without `.git`, `node_modules`, `__pycache__`, `.venv`, `*.pyc` and `files.exclude`). Attachments appear as blue chips above the input; click a chip to remove it. Max. 20 attachments and `maxFolderMB` per file or folder |
| Chat | Credits of the agent in this chat (without co-agents) against `maxCredits`. Hover to show − on the left, the current limit in the middle, and + on the right; clicks change only this chat’s limit by `creditStep`, saved with the chat. The limit cannot go below credits already used. `0` = no limit and no buttons. Turns warning-colored at 90%. |
| Co-Credits | Credits of all co-agents of this chat against `maxCoAgentCredits`. − / + and limit as for Chat (steps of `creditStep`, not below the co-agent credits already used, saved with the chat). `0` = no limit and no buttons. Turns warning-colored at 90%. |
| Co-agents | Co-agents of the current job against `maxCoAgents`, incl. how many are working. Hover to show − on the left, the current limit in the middle, and + on the right; clicks change only this chat’s limit by 1. Minimum is the number of active co-agents, and at least 1. `0` = no limit and no buttons. |
| Model | Opens its menu above the button, aligned to its right edge: **Agent default** (uses the agent's settings) at the top, below **Reasoning** with the levels of the selected model in one line, below **AI models** with model name, credit factor (e.g. `3×`, in one column) and provider. Model and reasoning level apply to the next messages of this chat and are saved with the chat; co-agents keep their own model. |
| Send / Stop | **Send** sends the message. While the agent works, **Stop** replaces Send: it stops the agent and all co-agents and closes the job. When the agent is idle, use **monarch: Stop agent and co-agents** to stop waiting co-agents |
| Line above the input | Drag up/down to resize the input (min. 3 lines, max. 70 % of the panel); the height is kept |
| Line between chat and notes | Drag left/right to resize the notes pane (min. 120 px, max. 70 % of the panel); the width is kept |
| Enter / Shift+Enter | Send / new line |
| Ctrl+C / Cmd+C | Copies the selected text of the chat (or of the input) |

The labels of Chat, Co-Credits, Co-agents and Stop come from `labels` of the selected agent. Every new VS Code window starts with a new chat; earlier chats are continued from the history. The history is stored locally in VS Code for all repos together and survives restarts. Histories of older versions (per repo) are taken over when the repo is opened the first time. It only contains chats started or taken over in monarch: awork does not let API clients list chats (the route of the web app and `/agents/management/threads` are refused for non-admins).

A chat continued in the awork web app is updated in the chat window after `syncInterval` seconds. Files from answers that were not started in monarch are not written into the repo.

If the agent credits cannot be read and `maxCredits` is not `0` (or the co-agent credits and `maxCoAgentCredits`), the chat does not accept further messages.

### Chat view

| Item | Display |
|---|---|
| Your messages | Right, in a bubble, with your awork profile picture |
| Agent answers | Left, in a bubble (max. 85 % wide), with the agent's awork profile picture, name, answer time and the agent's credits for this answer without co-agents (e.g. `CodeZilla · 9:12 min · 50c`); the credits are added as soon as they are read and saved with the chat, older answers without a saved value show only the time; Markdown incl. tables and code (wide code and tables scroll inside the bubble). **Copy** next to the name (on hover) copies the answer as Markdown |
| Code blocks | Language and toolbar above each block: **Copy**; **Insert** at the cursor of the active or last active editor (replaces selections); **New file** opens an unsaved file with the block's language; **Terminal** puts the code into the active terminal (or a new `monarch` terminal) without running it. Multi-line code is pasted via the clipboard, so it stays in the clipboard |
| Questions | Questions from the agent as a card; with one single-choice question, click an option to send it or type your own answer below; with several questions or multiple choice, select the options, optionally fill in your own answer and send them together with **Send answer** |
| Steps | Relay and agent steps between two messages as one line with the latest step, e.g. `Relay: minizilla_1 answered, 2 files staged  + 4 Steps`; click the line (or Enter) to show or hide the earlier steps in chronological order above it. While the steps are shown, `+ 4 Steps` is hidden. Steps: `Relay: spawn minizilla_1`, `Relay: refused – <reason>`, `Agent step: <intent>` (tool calls without intent are not shown). Warning boxes do not split the line. After reloading a chat, relay messages appear summarized (`Relay: co-agent update`, `Relay: inspect`) and agent steps as far as awork returns the tool calls with the messages |
| While running | Spinner with the elapsed time of the current phase on its right, behind the latest step (before any step: in its own line at the end of the chat); it disappears as soon as the agent and all co-agents are done |
| Warnings | Yellow box in the middle, e.g. a co-agent file that could not be downloaded; stays until closed with ✕ |
| Errors | Red box in the middle; hints about actions that are not possible right now (e.g. `Stop the agent first.`, attachments) disappear after 5 s; ✕ closes any error box |

Profile pictures are loaded once per VS Code session; without a picture, initials are shown.

### Notes

Free text for ideas and open points of the current chat, outside the repo. Type into the notes pane; the text is saved with the chat in the history and comes back when the chat is continued. A new chat starts with empty notes; notes typed in a new chat before its first message are lost when you switch to another chat. **✕** in the history removes the notes of that chat as well.

The agent sees the notes: when they changed since the last message to the agent (also relay messages), monarch adds them at the end of the next message as a `[monarch notes] … [/monarch notes]` block, before the context line; the block is not shown in the chat. The agent replaces the notes with `### ORCA: notes` (see *Co-agents*); the pane shows the new text at once. If you changed the notes after the agent's last message, the command is refused and the agent gets your current notes.

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
| `### ORCA: inspect` + `ATTACH:` lines | Send files to the agent for its own review, at once: `ATTACH: <co-agent id>` (all its staged files), `ATTACH: <repo path>` (staged version, else local repo), `ATTACH: repo:<repo path>` (local repo version, e.g. the base of a staged file); max. 20 files per answer. Wakes no co-agent and writes nothing. Not allowed in the same answer as `spawn`, `send`, `wait`, `commit` or `stopzilla` |
| `### ORCA: notes` + complete new notes | Replace the notes of this chat (empty = clear); refused if the user changed them after the agent's last message, then the agent is woken with the current notes. Wakes no co-agent, works without `coAgentId` |
| `### ORCA: commit` | Write all staged co-agent files into the repo; failed ones stay staged |
| `### ORCA: stopzilla` | Stop all co-agents, close the job |

monarch wakes the agent with a `[monarch relay]` message when all working co-agents have answered, when one answers with `STATUS: question`/`blocked`/`plan`, or after `relayTimeout`. After `relayTimeout` the message has a `progress (working co-agents):` part with the number of steps and the last 3 steps of each working co-agent (`- minizilla_2: 14 steps, last: … | … | …`), read from its run events for at most 5 s; without readable events it says `steps not readable`. It lists the staged files of each co-agent (`files (staged, not in the repo yet): …`), download warnings and the credits of agent and co-agents separately (`credits: agent 120/1000, co-agents 340/1000`); no files are attached. After `inspect`, monarch answers at once with a `[monarch relay] inspect` message: the files as attachments, a list `<file name> = <repo path>, <source>` (`staged by <co-agent id>` or `local repo`; equal names get `-2`, `-3`, …) and the files that could not be attached. A line `ATTACH: <repo path>` in a brief or message attaches that file (staged version first, else from the local repo, `maxFolderMB` each); `ATTACH: <co-agent id>` attaches all staged files of that co-agent; max. 20 files per message. Commands beyond the limits are refused and reported to the agent.

## Commands

| Command | Effect |
|---|---|
| `monarch: Sign in` / `monarch: Sign out` | OAuth sign-in in the browser / delete the stored sign-in |
| `monarch: New chat` | Same as the blue + button |
| `monarch: Stop agent and co-agents` | Same as the Stop button |
