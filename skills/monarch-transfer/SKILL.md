---
name: monarch-transfer
description: Send files from /workspace/output to monarch (VS Code) byte-exact via an awork task. Required after saving files for Martin's repo when he works through monarch ([monarch context] line in the chat, or a [monarch transfer] line in a brief).
---

# monarch-transfer

monarch cannot download files from the output folder. You pack them into one bundle and upload it to the awork transfer task; monarch fetches the bundle, checks every file and deletes the bundle. Never paste file contents into your answer. Requires awork access.

1. Save every file for the repo in `/workspace/output/` with its repo path (e.g. `/workspace/output/src/app.py`).
2. Pack the files you created or changed in this answer (paths relative to `/workspace/output/`). Do not send unchanged files from earlier answers; monarch would overwrite Martin's local versions.
   `python3 "$(find /workspace/skills -path '*monarch-transfer*' -name pack.py | head -n 1)" src/app.py README.md`
   It prints `bundle: <path>` and the packed files. If it finds no pack.py, tell Martin that the skill files are missing.
3. Upload the bundle with `code_mode_execute` to the task id from the `[monarch context]` line (`files: ... awork task <id>`) or from the `[monarch transfer]` line of your brief:
   - `sandboxInputs`: `[{"name": "bundle", "path": "<path from step 2>", "format": "file"}]`
   - code: `return await sandbox.uploadFile('bundle', { taskId: '<task id>' });`
4. Only tell Martin that the files were sent after the upload succeeded. If there is no task id, no awork access or the upload fails, say so instead.

monarch reports files it could not take over as `not received (...)` or `not transferred`. Send those files again with a new bundle.
