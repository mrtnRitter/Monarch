'use strict';
/** Git queries for safe workspace snapshots and repository line-ending defaults. */

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { is_junk, safe_rel_path } = require('./files');

const max_buffer = 64 * 1024 * 1024;

function _is_abort(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function _throw_if_aborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason?.name === 'AbortError') throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}

/** Run a bounded Git command and return its UTF-8 stdout. */
function run_git(cwd, args, { signal, timeout_ms = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, signal, timeout: timeout_ms, maxBuffer: max_buffer, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (!error) {
                resolve(stdout);
                return;
            }
            if (_is_abort(error)) {
                reject(error);
                return;
            }
            const stderr_line = String(stderr || '').split(/\r?\n/, 1)[0].trim();
            reject(new Error(`git ${args[0]} failed: ${stderr_line || error.message}`));
        });
    });
}

/** Return an explicit .gitattributes default or the majority index line ending. */
async function eol_default(cwd, { signal } = {}) {
    try {
        const attributes = await fs.readFile(path.join(cwd, '.gitattributes'), { encoding: 'utf8', signal });
        for (const line of attributes.split(/\r?\n/)) {
            const tokens = line.trim().split(/\s+/);
            if (tokens[0] !== '*') continue;
            if (tokens.includes('eol=lf')) return 'lf';
            if (tokens.includes('eol=crlf')) return 'crlf';
        }
    } catch (error) {
        if (_is_abort(error)) throw error;
        if (error.code !== 'ENOENT') return null;
    }

    try {
        const output = await run_git(cwd, ['ls-files', '--eol'], { signal });
        let lf = 0;
        let crlf = 0;
        for (const line of output.split(/\r?\n/)) {
            const token = line.trimStart().split(/\s+/, 1)[0];
            if (token === 'i/lf') lf += 1;
            else if (token === 'i/crlf') crlf += 1;
        }
        return lf > crlf ? 'lf' : crlf > lf ? 'crlf' : null;
    } catch (error) {
        if (_is_abort(error)) throw error;
        return null;
    }
}

function _included_path(file_path) {
    return safe_rel_path(file_path) === file_path && !is_junk(file_path) && file_path !== '.monarch' && !file_path.startsWith('.monarch/');
}

function _sorted_unique(paths) {
    return [...new Set(paths)].sort();
}

/** Read safe repository files and Git's changed/deleted path sets. */
async function repo_state(cwd, { signal } = {}) {
    const files_output = await run_git(cwd, ['ls-files', '-co', '--exclude-standard', '-z'], { signal });
    const status_output = await run_git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { signal });
    const branch_output = await run_git(cwd, ['branch', '--show-current'], { signal });
    let head = null;
    try {
        head = (await run_git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { signal })).trim() || null;
    } catch (error) {
        if (_is_abort(error)) throw error;
    }

    const files = [];
    const missing = [];
    const seen = new Set();
    for (const file_path of files_output.split('\0')) {
        if (!file_path || seen.has(file_path) || !_included_path(file_path)) continue;
        seen.add(file_path);
        _throw_if_aborted(signal);
        try {
            const stat = await fs.stat(path.join(cwd, file_path));
            _throw_if_aborted(signal);
            if (stat.isFile()) files.push({ path: file_path, size: stat.size });
        } catch (error) {
            if (signal?.aborted) _throw_if_aborted(signal);
            if (error.code === 'ENOENT') missing.push(file_path);
        }
    }

    const changed = [];
    const deleted = [...missing];
    const entries = status_output.split('\0');
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry) continue;
        const x = entry[0];
        const y = entry[1];
        const file_path = entry.slice(3);
        if (_included_path(file_path)) (x === 'D' || y === 'D' ? deleted : changed).push(file_path);
        if (x === 'R' || x === 'C') index += 1;
    }

    return {
        branch: branch_output.trim() || null,
        head,
        files,
        changed: _sorted_unique(changed),
        deleted: _sorted_unique(deleted),
    };
}

module.exports = { run_git, eol_default, repo_state };
