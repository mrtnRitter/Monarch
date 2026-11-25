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
├── skills/                 # awork skills with all monarch rules for the agents
│   ├── monarch-main-agent/SKILL.md   # main agent: ORCA commands, repo context, notes, files, delegation, review
│   └── monarch-co-agent/SKILL.md     # co-agent: briefing, delivery, worker/reviewer, answer formats
└── zillas/
    ├── codezilla.md        # system prompt for CodeZilla (without the monarch rules)
    └── minizilla.md        # system prompt for minizilla (without the monarch rules)
```

The monarch rules live in the two skills only, so they are maintained in one place and can be reused by other agents. The prompts in `zillas/` contain the agent's own role, coding style and security rules plus a short pointer that tells the agent when to load its skill.

## Installation

Requirements: VS Code 1.85+ with the built-in Git extension, an awork account in the workspace; Python 3.11+ only for building.

```bash
cd monarch/vscode
python build_vsix.py                         # -> monarch-0.24.1.vsix
code --install-extension monarch-0.24.1.vsix
```

Or in VS Code: Extensions view → `…` → **Install from VSIX…**. `Optional local tests (node, no network): for f in test/*_test.js; do node "$f"; done` – `test/webview_notes_test.js` needs jsdom (`NODE_PATH=<folder>/node_modules`).

## Setup in awork (once per workspace, by the agent owner)

1. **Client app for sign-in:** Settings → Integrations → add a client application of type **Public** with the name `monarch`. Redirect URI: `http://localhost:8765/callback` (port = `monarch.redirectPort`). If the client ID is not `monarch`, every user enters it in `monarch.clientId`.
2. **Skills:** In awork open **Library → Skills → + Skill → Skill importieren** and import `skills/monarch-main-agent/SKILL.md` and `skills/monarch-co-agent/SKILL.md` (one Markdown file each). Share both skills with the colleagues who use monarch (**Teilen → Lesen und verwenden**). After a change of a `SKILL.md`, import it again or paste the changed text into the existing skill.
3. **Agents:** Create **CodeZilla** with `zillas/codezilla.md` and a high model preset (e.g. `deep`), **minizilla** with `zillas/minizilla.md` and a medium model preset; a low preset (e.g. `fast`) works only with fully specified briefs. In the agent details, **Skills → + Hinzufügen → Vorhandenen Skill hinzufügen**: add `monarch-main-agent` to CodeZilla and `monarch-co-agent` to minizilla. Enter the agent IDs in `monarch.agents` (`agentId` = CodeZilla, `coAgentId` = minizilla) if they differ from the default. After a change of a file in `zillas/`, copy it into the agent again.
4. **Sharing:** Share the agents with the colleagues who use monarch.

### Using monarch with your own agents

Any awork agent can work with monarch:

1. Import both skills (see above) and add `monarch-main-agent` to your main agent and `monarch-co-agent` to your co-agent.
2. Add this paragraph to the prompt of the main agent (and the same with `monarch-co-agent` to the prompt of the co-agent): *“All rules for working through monarch are in the skill `monarch-main-agent`. Load it with `load_skill` before you answer a message containing `[monarch context]`, `[monarch relay]` or `[monarch notes]`, output ORCA blocks, delegate to or review co-agents, or save files for the repo in `/workspace/output/`. Load it again when its content is no longer visible in the conversation. If the skill is not available, tell the user; output no ORCA blocks and do not claim that co-agents were started.”*
3. Add the agents to `monarch.agents` (`agentId`, `coAgentId`, optionally `coAgentName`, see *Settings*). Without `coAgentId` the agent works without co-agents; the skill rules for repo context, notes and files still apply.
4. Run the test from *Setup per user*.

The skills use the neutral terms *main agent* and *co-agent* and the placeholder `<co_agent_name>_N` for co-agent IDs (e.g. `minizilla_1`). Role, coding style and security rules of your agents stay in their own prompts.

## Setup per user (step by step)

Every user, also the agent owner, does this once:

1. **Install** `monarch-0.24.1.vsix` (see *Installation*) and reload VS Code (Command Palette → **Developer: Reload Window**).
2. **Sign in:** Open **monarch** in the activity bar and click **Sign in** (or Command Palette → **monarch: Sign in**). The browser opens; log in to awork and select the workspace.
3. **Check the agents:** Open the **Model** menu in a chat to choose its agent. If an agent shared with you is missing, set **Monarch: Agent Filter** (`monarch.agentFilter`) to `all`.
4. **Test files:** Start a **new chat** (blue **+**) and send: `Create output/download_test.txt with three lines.`
5. **Check:** `download_test.txt` appears as link in the answer and in the repo; **Output → monarch** shows `download download_test.txt: ok`. Then delete the test file.

| Problem | Cause and fix |
|---|---|
| `not downloaded (HTTP 403)` | awork refused the download of this file (seen for `package.json`). Get the file another way; note name and time to report the pattern |
| `not downloaded (HTTP 401)` | Sign-in expired or the download is not allowed for your login: sign in again |
| `not downloaded (no download link)` | awork listed the file without download link; ask the agent to save it again |
| `not written (…)` | The file could not be written (e.g. no folder open, file locked) |
| No agents | Sign in again; check sharing (owner setup 3) and `monarch.agentFilter` |

Credits and co-agent counts are displayed per chat; monarch does not limit them.

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
| `monarch.agents` | entry for CodeZilla | Additions per agent, matched by `agentId` (or `name`): `coAgentId` (agent started by `ORCA: spawn`; empty = no co-agents), `coAgentName` (prefix of co-agent IDs; empty = awork name of the co-agent in lower case without spaces, e.g. `minizilla`), `labels` (UI names for `Chat`, `Co-Credits`, `Co-Agenten` display values and `stop`). Agents used as `coAgentId` are not shown in the agent list. |
| `monarch.relayTimeout` | `600` | Seconds the relay waits before waking the agent with the current state, including the progress of working co-agents; `0` = no limit |
| `monarch.pollInterval` | `3` | Seconds between status checks |
| `monarch.maxFolderMB` | `20` | Max. size of a folder or file attachment |
| `monarch.autoSnapshot` | `off` | `spawn`: attach the repo snapshot to every `ORCA: spawn` (once, also if the brief has `ATTACH: repo-snapshot`); `off`: only on `ATTACH: repo-snapshot` |
| `monarch.maxSnapshotMB` | `20` | Max. size of the repo snapshot (sum of the uncompressed files); larger snapshots refuse the command and name the 5 largest top-level folders; `0` = no cap |
| `monarch.normalizeSuffixCopies` | `true` | A co-agent file `X-<n>.<ext>` (n ≥ 1) is staged as `X.<ext>` if `X.<ext>` is in the repo, staged or in the same answer; with several copies in one answer the highest `n` wins |
| `monarch.normalizeLineEndings` | `false` | `true`: co-agent text files with CRLF are converted to LF when LF is expected; otherwise only a warning |
| `monarch.relayDiff` | `inline` | Diffs of newly staged co-agent files in the relay: `inline`, `attach` (always as `<name>.diff` attachment) or `off` |
| `monarch.relayDiffMaxKB` | `40` | Max. total size of inline diffs per relay; the largest diffs beyond it are attached instead |
| `monarch.notesPosition` | `left` | Side of the notes pane next to all chats: `left` or `right`; changes apply immediately |
| `monarch.newChatPosition` | `right` | Side where a new chat area from the **+** menu or `monarch.addChat` opens: `right` or `left`; changes apply immediately without moving open areas |
| `monarch.reposRoot` | `""` | Folder whose direct subfolders with `.git` are the repos you can pick for a chat; empty = parent folders of the open workspace folders. Open workspace folders are always listed. |
| `monarch.syncInterval` | `4` | Seconds between checks for new messages of the current chat written elsewhere (e.g. awork web app) while the chat window is visible; while the agent is working, a newer message of yours written elsewhere ends the wait; `0` = off |

## Usage

1. Run **monarch: Sign in** (or the button in the chat window). The browser opens; log in to awork and select the workspace.
2. Open **monarch** in the activity bar.

| Element | Function |
|---|---|
| Chat areas | The monarch sidebar shows up to 4 chats side by side. Drag the dividers between chats to resize them; each chat area is at least 300 px wide. |
| Top bar | **Notes**, **History**, and **+** appear once above all chats. |
| Repo (colored dot + name) | Click to open a filterable list of all repos, including repos not open in VS Code; type to filter, use ↑ / ↓ and Enter to select, or Esc to close. Open workspace folders are always listed. A selected repo that is not open is added directly in a multi-root window. In a single-folder window, monarch asks before adding it and does so only when no chat is working, no co-agent is working or waiting, and no files are staged; the window then becomes an untitled multi-root workspace. The next message carries the new `[monarch context]` line. |
| Notes (note sheet) | In the top bar: shows or hides the notes pane, which spans the full height beside all chats on the left or right according to `monarch.notesPosition`; the visibility setting applies to all chats. |
| History (clock) | Chats of the selected agent from all repos (max. 100), newest first, with repo name and date; click to open a chat in the active area, or focus its existing area; ✕ removes it from the list (the chat stays in awork). |
| New chat (blue +) | Opens a menu: **New chat here** starts a chat in this area; **New chat right** or **New chat left** adds a new area beside the open chats, on the configured side (not in the active area), carrying over the active area’s repo and agent and becoming active. **Ctrl/Cmd+click** on **+** takes over a chat from awork in the active area. |
| Terminal | Each chat has a **Terminal** button in its bottom row; it opens or shows the `monarch: <repo>` terminal in the chat's repo in the panel. The **Terminal** code-block action uses it. |
| Bottom row | Each chat has its repo button, **Terminal**, **×** (when available, close; the chat stays in History), and **Send** or **Stop**. The close button is available with at least 2 chats when no agent or co-agent is working or waiting and no files are staged. |
| Message times | Every message shows its time; a thin line with the date separates messages from different days. |
| Row above the input | **+** (attachments), the **Chat**, **Co-Credits**, and **Co-Agenten** values as plain text styled like the **Model** button (no pills; unknown values show `?`; no limits or warning color), and the **Model** menu. |
| **+** (attachments) | Opens a small menu to the right of the button, **Current file** at the height of **+**: **Current file** attaches the file of the active editor tab (also Markdown preview, images, notebooks, diffs), otherwise the last active file, as single file. **Files** and **Folder** open the file dialog for files or folders. Everything picked with **Files** and **Folder** is sent together as one `attachments.zip` with paths relative to the repo root (files outside the repo under their file name; folders without `.git`, `node_modules`, `__pycache__`, `.venv`, `*.pyc` and `files.exclude`). Attachments appear as blue chips above the input; click a chip to remove it. Max. 20 attachments and `maxFolderMB` per file or folder |
| Chat | Credits of the agent in this chat, without co-agents, shown as a read-only value. |
| Co-Credits | Credits of all co-agents in this chat, shown as a read-only value. |
| Co-Agenten | The number of co-agents in the current job and how many are working, shown as a read-only value. |
| Model | Opens its menu above the button, aligned to its right edge. Choose the agent for this chat, **Agent default** (uses the selected agent's settings), **Reasoning**, or an **AI model**. The agent choice applies to this chat; model and reasoning level apply to its next messages and are saved with the chat. |
| Send / Stop | **Send** sends the message. While the agent works, **Stop** replaces Send: it stops the agent and all co-agents and closes the job. When the agent is idle, use **monarch: Stop agent and co-agents** to stop waiting co-agents. |
| Line above the input | Drag up/down to resize the input (min. 3 lines, max. 70 % of the panel); the height is kept |
| Line between chat and notes | Drag left/right to resize the notes pane (min. 120 px, max. 70 % of the panel); the width is kept |
| Enter / Shift+Enter | Send / new line |
| Ctrl+C / Cmd+C | Copies the selected text of the chat (or of the input) |
The labels of Chat, Co-Credits, Co-Agenten and Stop come from `labels` of the selected agent. Chat, Co-Credits and Co-Agenten are display values only; monarch does not limit credits or co-agents. Every new VS Code window starts with a new chat; earlier chats are continued from the history. The history is stored locally in VS Code for all repos together and survives restarts. Histories of older versions (per repo) are taken over when the repo is opened the first time. It only contains chats started or taken over in monarch: awork does not let API clients list chats (the route of the web app and `/agents/management/threads` are refused for non-admins).

A chat continued in the awork web app is updated in the chat window after `syncInterval` seconds. Files from answers that were not started in monarch are not written into the repo.


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

With two or more open chats, the notes pane shows one group per open chat. Each header line has a colored dot, repo name, and chat title; groups are ordered from left to right to match the chat areas and separated by draggable dividers. Groups share the height; edits show up in all chat windows at once.

### Scrolling

The chat follows new output only while you are at the bottom (within 24 px). An answer or question that does not fit is shown with its top in the upper part of the window. While you are scrolled up, a new answer or question shows the agent avatar bouncing at the bottom left; it stays there while you scroll until the answer's own avatar reaches it. Click the avatar to jump to the answer. Your own message always scrolls to the end.

### "This repo" (repo context)

The first message of a chat gets a context line at the end that is not shown in the chat. It tells the agent which repo this chat belongs to, the browser link of its git remote (`origin` or the upstream of the branch, without credentials), the branch and whether there are uncommitted changes or commits not pushed. Without a remote it says that the repo is not online. Later messages only get the line again when it changes (other repo, link or branch, or local changes appear or disappear). The agent reads the repo via this link (only the pushed state); attached files take precedence over the link. Uses the built-in VS Code Git extension for repos open in VS Code and git directly for other repos.

```
[monarch context] "this repo" = the repo of this chat: <name> · online: https://github.com/mrtnRitter/Monarch · branch: main
```

The matching rule is part of the skill `monarch-main-agent` (`skills/monarch-main-agent/SKILL.md`); update the skill in awork after a change.

### Files written into the repo

The agent saves its files in `/workspace/output/` with their repo path (e.g. `/workspace/output/src/app.py` → `src/app.py`). awork lists every file created or changed in a run at the agent's answer, with a download link. After each answer monarch downloads these files and writes them into the repo of this chat; existing files are overwritten. Text files are written as undoable edits. Only paths inside the repo are written (no absolute paths, no `..`, nothing in `.git`), Python caches never. Written files appear as links in the chat; a click opens the file in the editor (images and binary files with the matching viewer). Files that could not be downloaded or written are shown as warning below the answer, e.g. `package.json not downloaded (HTTP 403)`.

Co-agent files are not written directly: monarch downloads them when the co-agent answers and keeps them staged outside the repo (latest version per path) until the agent sends `### ORCA: commit`. Failed downloads of co-agent files are shown as yellow warning box and reported to the agent. A new chat discards staged files.

Every message to a co-agent starts with a fixed line `[monarch files] …`: deliver each file complete under `/workspace/output/<repo path>` with LF line endings, overwrite existing files under the same path, no suffix copies. If a co-agent still delivers `X-<n>.<ext>` (n ≥ 1) and `X.<ext>` exists in the repo, is staged or comes in the same answer, monarch stages it as `X.<ext>` and reports `warning: X-<n>.<ext> mapped to X.<ext>` (`monarch.normalizeSuffixCopies`); with several copies in one answer the highest `n` wins, the other copies and a delivered `X.<ext>` are dropped with `warning: <path> ignored (X-<n>.<ext> mapped to X.<ext>)`. A text file with CRLF where LF is expected (repo version with LF, or a new file and `.gitattributes` or the majority of the repo files use LF) gives `warning: CRLF in <path>`; with `monarch.normalizeLineEndings` it is converted to LF. Files of the agent itself are written unchanged.

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
| `### ORCA: inspect` + `ATTACH:` lines | For special cases (relay diffs normally replace it): send files to the agent for its own review, at once: `ATTACH: <co-agent id>` (all its staged files), `ATTACH: <repo path>` (staged version, else local repo), `ATTACH: repo:<repo path>` (local repo version, e.g. the base of a staged file); max. 20 files per answer. Wakes no co-agent and writes nothing. Not allowed in the same answer as `spawn`, `send`, `wait`, `commit` or `stopzilla` |
| `### ORCA: notes` + complete new notes | Replace the notes of this chat (empty = clear); refused if the user changed them after the agent's last message, then the agent is woken with the current notes. Wakes no co-agent, works without `coAgentId` |
| `### ORCA: commit` | Write all staged co-agent files into the repo; failed ones stay staged |
| `### ORCA: stopzilla` | Stop all co-agents, close the job |

monarch wakes the agent with a `[monarch relay]` message when all working co-agents have answered, when one answers with `STATUS: question`/`blocked`/`plan`, or after `relayTimeout`. After `relayTimeout` the message has a `progress (working co-agents):` part with the number of steps and the last 3 steps of each working co-agent (`- minizilla_2: 14 steps, last: … | … | …`), read from its run events for at most 5 s; without readable events it says `steps not readable`. It lists the staged files of each co-agent (`files (staged, not in the repo yet): …`), download warnings and the credits of agent and co-agents separately (`credits: agent 120, co-agents 340`); no files are attached. After `inspect`, monarch answers at once with a `[monarch relay] inspect` message: the files as attachments, a list `<file name> = <repo path>, <source>` (`staged by <co-agent id>` or `local repo`; equal names get `-2`, `-3`, …) and the files that could not be attached. A line `ATTACH: <repo path>` in a brief or message attaches that file (staged version first, else from the local repo, `maxFolderMB` each); `ATTACH: <co-agent id>` attaches all staged files of that co-agent; max. 20 files per message. Commands that exceed attachment or snapshot limits are refused and reported to the agent.

`ATTACH: repo-snapshot` in a spawn or send (not in `inspect`) attaches `repo-snapshot.zip`: every file of `git ls-files -co --exclude-standard` in the workspace folder (tracked plus untracked, not ignored, including local changes not pushed), with all staged co-agent files on top (latest version per path), never `.git`, `.monarch/` or Python caches, plus `SNAPSHOT.md` in the archive root (branch, HEAD, locally changed files, overlaid staged files with `staged by <id>`, deleted files as “nicht enthalten”). It counts as one of the 20 attachments. The command line in the relay shows `repo-snapshot.zip = <branch>@<sha7> + <n> staged`; for a spawn that waited for `AFTER:` the same line appears as `repo-snapshot: …` in that co-agent's relay part. Above `monarch.maxSnapshotMB` the command is refused with the 5 largest folders. Requires git on the PATH. Co-agents have internet access (checked with `curl -sI https://nodejs.org` → HTTP 200 and `pip download pytest` → ok), so project setups that download tools can run from the snapshot; unpack it to `/tmp`, because `git clone` into `/workspace/...` fails in the sandbox (`chmod on .git/config.lock`).

For every file staged since the last relay, the co-agent's part of the relay ends with a `diffs:` block: unified diff with 3 context lines, header `--- <path> (staged by <id>, <kind>, +<added> -<deleted>)` with kind `delta to previous staged` (the path was staged before), `vs local repo` or `new file`. CRLF and LF count as equal. Binary files give only `binary <path> changed (<size> bytes)`, files with more than 20000 lines (old plus new) `diff for <path> skipped (more than 20000 lines)`. The suffix and CRLF warnings stand directly before the diffs. If the inline diffs exceed `monarch.relayDiffMaxKB`, the largest ones are attached as `<name>.diff` (`diff for <path> attached (too large)`, plus a list `<file name> = <repo path>, staged by <id>`); `monarch.relayDiff` switches this to always attached or off.

## Several repos in one window

Each chat belongs to one repo, including repos that are not open in VS Code. Up to 4 chats can appear side by side in the monarch sidebar. Click the colored dot and repo name in a chat to open a filterable list of all repos (type to filter, ↑ ↓ Enter, Esc). Open workspace folders are always listed.

A selected repo that is not open is added directly to a multi-root workspace. In a single-folder window, monarch asks before adding it; it does so only when no chat is working, no co-agent is working or waiting, and no files are staged. The window then becomes an untitled multi-root workspace.

You can also change the repo of an existing chat, but not while the agent or co-agents are working or files are staged; the next message carries the new `[monarch context]` line.

Every repo keeps its color permanently (dot and terminal); a new repo gets a color no open chat uses.

**+** opens a menu: **New chat here** | **New chat right** / **New chat left** (according to `monarch.newChatPosition`). **Ctrl/Cmd+click** on **+** takes over a chat from awork into the active area.

Folder attachments work for repos open in VS Code; single files work everywhere.

Open repos as a multi-root workspace with **File → Add Folder to Workspace…**; optionally save it as a `.code-workspace` file.

A chat writes only to its repo. The agent sees other open repos in its context line and can read them only with `ATTACH: read:<repo>:<path>` and `ATTACH: repo-snapshot:<repo>`.

Close **×** in a chat's bottom row when it is available; the chat stays in History. Continue chats from History after a restart.

For terminal tabs with repo names, use this settings JSON block:

```json
"terminal.integrated.tabs.title": "${workspaceFolderName}${separator}${process}",
"terminal.integrated.tabs.description": "${cwdFolder}"
```

## Commands

| Command | Effect |
|---|---|
| `monarch: Sign in` / `monarch: Sign out` | OAuth sign-in in the browser / delete the stored sign-in |
| `monarch: New chat` | Starts a new chat in the active chat area (like **New chat here**) |
| `monarch: Add chat` (`monarch.addChat`) | Adds a new chat area beside the open chats, on the right or left according to `monarch.newChatPosition` (not in the active area) |
| `monarch: Stop agent and co-agents` | Same as the Stop button |
