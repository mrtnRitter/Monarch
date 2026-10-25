'use strict';
/** Temporary probe: download agent output files of a thread via temporaryFiles[].downloadUrl. No VS Code dependency. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

async function _get(client, route, raw, log) {
    try {
        return { ok: true, data: await client.request('GET', route, { raw }) };
    } catch (error) {
        log(`  GET ${route}\n    -> ${error.status || 'error'}: ${error.message.slice(0, 300)}`);
        if (error.status === 401) log('    hint: 401 = endpoint not released for this client, or sign-in expired');
        return { ok: false };
    }
}

async function _download(client, route, out_dir, name, artifact, log) {
    const { ok, data } = await _get(client, route, true, log);
    if (!ok) return false;
    const target = path.join(out_dir, path.basename(name));
    fs.writeFileSync(target, data);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const checks = artifact ? { size: artifact.sizeBytes == null || artifact.sizeBytes === data.length, sha256: !artifact.sha256 || artifact.sha256.toLowerCase() === sha256 } : {};
    log(`  GET ${route}\n    -> 200 ${data.length} bytes, saved ${target}\n    sha256=${sha256}  ${artifact ? JSON.stringify(checks) : '(no artifact entry to compare)'}`);
    return Object.values(checks).every(Boolean);
}

/**
 * Download all agent output files of thread_id into out_dir and compare them with GET /artifacts.
 * client: AworkClient; log(line). Returns {ok, total}.
 */
async function run_probe(client, thread_id, out_dir, log) {
    fs.mkdirSync(out_dir, { recursive: true });
    log(`probe thread=${thread_id}  out=${out_dir}`);
    const messages = await _get(client, `/agents/threads/${thread_id}/messages`, false, log);
    const artifact_list = await _get(client, `/agents/threads/${thread_id}/artifacts`, false, log);
    if (!messages.ok) return { ok: 0, total: 0 };
    if (!artifact_list.ok) log('  artifact list not available - downloads are not compared');
    const artifacts = new Map(((artifact_list.ok && artifact_list.data) || []).map(item => [item.path, item]));
    const temp_files = [...new Map((messages.data || []).flatMap(message => (message.temporaryFiles || []).map(file => [file.id || file.downloadUrl, { ...file, role: message.role }]))).values()];
    log(`messages: ${(messages.data || []).length}  temporaryFiles: ${temp_files.length}  artifacts: ${artifacts.size}`);
    for (const [key, item] of artifacts) log(`  artifact: ${key}  ${item.sizeBytes} bytes  sha256=${item.sha256}`);

    const results = [];
    log('\n[1] download via temporaryFiles[].downloadUrl');
    for (const file of temp_files) {
        log(`- ${file.name}  role=${file.role}  id=${file.id}  sandboxPath=${file.sandboxPath}  downloadUrl=${file.downloadUrl}`);
        if (!file.downloadUrl) { log('  no downloadUrl (uploaded file?) - skipped'); continue; }
        results.push(await _download(client, file.downloadUrl, out_dir, file.name || file.id, artifacts.get(file.sandboxPath) || artifacts.get(file.id), log));
    }

    const covered = new Set(temp_files.flatMap(file => [file.sandboxPath, file.id]));
    const rest = [...artifacts.keys()].filter(key => !covered.has(key));
    log(`\n[2] artifacts without downloadUrl via /artifacts/download?path=  (${rest.length})`);
    for (const key of rest) results.push(await _download(client, `/agents/threads/${thread_id}/artifacts/download?path=${encodeURIComponent(key)}`, out_dir, key, artifacts.get(key), log));

    const ok = results.filter(Boolean).length;
    log(`\nresult: ${ok}/${results.length} downloads ok${results.length ? '' : ' (nothing to download)'}`);
    return { ok, total: results.length };
}

module.exports = { run_probe };
