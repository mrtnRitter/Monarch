---
name: monarch-transfer
description: Send files from /workspace/output to monarch (VS Code) byte-exact. Use after saving files for Martin's repo when he works through monarch (messages with a [monarch context] line in the chat, or relay messages).
---

# monarch-transfer

monarch cannot download files from the output folder. It reads them from your tool results instead. Never paste file contents into your answer.

1. Save every file for the repo in `/workspace/output/` with its repo path (e.g. `/workspace/output/src/app.py`).
2. Run `pack.py` (in the folder of this SKILL.md) with the files you created or changed in this answer, paths relative to `/workspace/output/`:
   `python3 <skill folder>/pack.py src/app.py README.md`
   Do not send unchanged files from earlier answers; monarch would overwrite Martin's local versions. `--all` sends every file of the output folder.
3. The complete stdout must be the tool result, without truncation or data reference. In awork code mode: `const r = await sandbox.exec('python3 <skill folder>/pack.py src/app.py'); return r.stdout || r.stderr;` with `maxResultChars: 40000`.
4. The last line is `MONARCH-BATCH k of m (...)`. If it says `next: run again with --batch k+1`, run the same command with that option until it says `done`.
5. If a result is truncated or stored behind a data reference, run the same files again with `--max-chars 15000`.

monarch checks every file with its SHA-256 and reports files it could not take over as `not received (...)`. Send those files again.
