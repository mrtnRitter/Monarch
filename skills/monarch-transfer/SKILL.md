---
name: monarch-transfer
description: Send files from /workspace/output to monarch (VS Code) byte-exact. Required after saving files for Martin's repo when he works through monarch (messages with a [monarch context] line in the chat, or relay messages).
---

# monarch-transfer

monarch cannot download files from the output folder. It reads them from the stored results of your **code mode** tool calls. Results of shell or sandbox tools (e.g. `sandbox_execute`) are not stored in the chat; monarch never sees them. Never paste file contents into your answer.

1. Save every file for the repo in `/workspace/output/` with its repo path (e.g. `/workspace/output/src/app.py`).
2. Call `code_mode_execute` with `maxResultChars: 40000` and this code. Put the files you created or changed in this answer into `files` (paths relative to `/workspace/output/`). Do not send unchanged files from earlier answers; monarch would overwrite Martin's local versions.

   ```js
   const files = ['src/app.py', 'README.md'];
   const batch = 1;
   const found = await sandbox.exec("find /workspace/skills -path '*monarch-transfer*' -name pack.py | head -n 1");
   const script = found.stdout.trim();
   if (!script) return 'monarch-transfer: pack.py not found in /workspace/skills';
   const result = await sandbox.run({ executable: 'python3', args: [script, ...files, '--batch', String(batch)] });
   return result.stdout || result.stderr;
   ```

3. The result must be the complete stdout, not truncated and not stored behind a data reference. If it is, repeat the call with `'--max-chars', '15000'` added to `args`.
4. The last line is `MONARCH-BATCH k of m (...)`. If it ends with `next: run again with --batch k+1`, repeat the call with that `batch` until it ends with `done`.
5. Only tell Martin that the files were sent after a result ended with `done`, and quote that last line. If pack.py was not found or the call failed, say so instead.

monarch checks every file with its SHA-256 and reports files it could not take over as `not received (...)`. Send those files again.
