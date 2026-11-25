'use strict';
/** Workspace folder helpers and read-only adapters for other open repositories. */
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const git = require('./git');

const repo_colors = [
    { theme: 'terminal.ansiBlue', hex: '#3b8eea' },
    { theme: 'terminal.ansiGreen', hex: '#23d18b' },
    { theme: 'terminal.ansiYellow', hex: '#e5e510' },
    { theme: 'terminal.ansiMagenta', hex: '#d670d6' },
    { theme: 'terminal.ansiCyan', hex: '#29b8db' },
    { theme: 'terminal.ansiRed', hex: '#f14c4c' },
];

function _config() {
    return vscode.workspace.getConfiguration('monarch');
}

function _root_or_throw(get_root) {
    const root = get_root();
    if (!root) throw new Error('no folder open');
    return root;
}

async function _read(root, path) {
    const uri = vscode.Uri.joinPath(root, ...path.split('/'));
    const limit_mb = _config().get('maxFolderMB');
    if ((await vscode.workspace.fs.stat(uri)).size > limit_mb * 1024 * 1024) throw new Error(`exceeds monarch.maxFolderMB (${limit_mb} MB)`);
    return vscode.workspace.fs.readFile(uri);
}

/** Return the open workspace folders with stable display indexes.
 * @returns {{name: string, uri: import('vscode').Uri, index: number}[]}
 */
function folders() {
    return (vscode.workspace.workspaceFolders || []).map((folder, index) => ({ name: folder.name, uri: folder.uri, index }));
}

/** Find an open workspace folder by its exact name.
 * @param {string|null} name
 * @returns {{name: string, uri: import('vscode').Uri, index: number}|null}
 */
function folder_by_name(name) {
    return name === null ? null : folders().find(folder => folder.name === name) || null;
}

/** Return the terminal theme color and icon for a workspace folder index.
 * @param {number} index
 * @returns {{theme: string, hex: string, icon: string}}
 */
function repo_color(index) {
    const slot = ((index % repo_colors.length) + repo_colors.length) % repo_colors.length;
    const color = repo_colors[slot];
    return { ...color, icon: `repo_${slot}.svg` };
}

/** Create the workspace adapter used by the active repo and its read-only peers.
 * @param {() => (import('vscode').Uri|null)} get_root
 * @returns {{exists(path: string): Promise<boolean>, eol_default(options?: {signal?: AbortSignal}): Promise<string|null>, repo_state(options?: {signal?: AbortSignal}): Promise<object>, read(path: string): Promise<Uint8Array>, write(path: string, data: string|Uint8Array): Promise<string>, other(name: string): ({name: string, read(path: string): Promise<Uint8Array>, repo_state(options?: {signal?: AbortSignal}): Promise<object}}|null)}}
 */
function make_workspace_adapter(get_root) {
    const adapter = {
        async exists(path) {
            const root = get_root();
            if (!root) return false;
            const uri = vscode.Uri.joinPath(root, ...path.split('/'));
            try {
                await vscode.workspace.fs.stat(uri);
                return true;
            } catch {
                return false;
            }
        },
        async eol_default({ signal } = {}) {
            const root = get_root();
            if (!root) return null;
            return git.eol_default(root.fsPath, { signal });
        },
        async repo_state({ signal } = {}) {
            const root = _root_or_throw(get_root);
            return git.repo_state(root.fsPath, { signal });
        },
        async read(path) {
            return _read(_root_or_throw(get_root), path);
        },
        async write(path, data) {
            const root = _root_or_throw(get_root);
            const uri = vscode.Uri.joinPath(root, ...path.split('/'));
            const text = typeof data === 'string' ? data : _decode_text(data);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
            if (text === null) {
                await vscode.workspace.fs.writeFile(uri, data);
                return path;
            }
            const edit = new vscode.WorkspaceEdit();
            const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
            if (exists) {
                const document = await vscode.workspace.openTextDocument(uri);
                edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
            } else {
                edit.createFile(uri, { ignoreIfExists: true });
                edit.insert(uri, new vscode.Position(0, 0), text);
            }
            if (!(await vscode.workspace.applyEdit(edit))) throw new Error('edit rejected');
            await (await vscode.workspace.openTextDocument(uri)).save();
            return path;
        },
        other(name) {
            const folder = folder_by_name(name);
            const root = get_root();
            if (!folder || folder.uri.toString() === root?.toString()) return null;
            return {
                name: folder.name,
                read: path => _read(folder.uri, path),
                repo_state: ({ signal } = {}) => git.repo_state(folder.uri.fsPath, { signal }),
            };
        },
    };
    return adapter;
}

function _decode_text(data) {
    if (data.includes(0)) return null;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
        return null;
    }
}


function _path_key(fs_path) {
    const resolved = path.resolve(fs_path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Return the configured repository root, or unique parents of open folders.
 * @returns {string[]}
 */
function repo_roots() {
    const configured = vscode.workspace.getConfiguration('monarch').get('reposRoot');
    if (typeof configured === 'string' && configured.trim()) return [configured.trim()];

    const seen = new Set();
    return (vscode.workspace.workspaceFolders || []).reduce((roots, folder) => {
        const root = path.dirname(folder.uri.fsPath);
        const key = _path_key(root);
        if (!seen.has(key)) {
            seen.add(key);
            roots.push(root);
        }
        return roots;
    }, []);
}

/** List git repositories directly inside each root and all open folders.
 * @returns {Promise<{name: string, uri: import('vscode').Uri, open: boolean}[]>}
 */
async function list_repos() {
    const roots = await Promise.all(repo_roots().map(async root => {
        try {
            const entries = await fs.readdir(root, { withFileTypes: true });
            const candidates = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
            return await Promise.all(candidates.map(async entry => {
                const fs_path = path.join(root, entry.name);
                try {
                    await fs.stat(path.join(fs_path, '.git'));
                    return { name: entry.name, uri: vscode.Uri.file(fs_path), open: false };
                } catch {
                    return null;
                }
            }));
        } catch {
            return [];
        }
    }));

    const repos = new Map();
    for (const repo of roots.flat()) {
        if (repo) repos.set(_path_key(repo.uri.fsPath), repo);
    }
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const repo = { name: folder.name, uri: folder.uri, open: true };
        repos.set(_path_key(folder.uri.fsPath), repo);
    }
    return [...repos.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Find a repository by existing directory path, then by exact name.
 * @param {{name?: string|null, path?: string|null}} [options]
 * @returns {Promise<{name: string, uri: import('vscode').Uri, open: boolean}|null>}
 */
async function find_repo({ name = null, path: repo_path = null } = {}) {
    if (repo_path !== null && repo_path !== undefined) {
        try {
            if ((await fs.stat(repo_path)).isDirectory()) {
                const key = _path_key(repo_path);
                const folder = (vscode.workspace.workspaceFolders || []).find(item => _path_key(item.uri.fsPath) === key);
                return {
                    name: name || path.basename(repo_path),
                    uri: vscode.Uri.file(repo_path),
                    open: Boolean(folder),
                };
            }
        } catch {
            // Fall back to the exact-name lookup.
        }
    }
    return (await list_repos()).find(repo => repo.name === name) || null;
}

/** Choose the least-used available repository color slot.
 * @param {Record<string, number>} assigned
 * @param {number[]} in_use_slots
 * @returns {number}
 */
function pick_slot(assigned, in_use_slots) {
    const in_use = new Set(in_use_slots);
    let candidates = repo_colors.map((_, slot) => slot).filter(slot => !in_use.has(slot));
    if (!candidates.length) candidates = repo_colors.map((_, slot) => slot);
    const counts = new Map(candidates.map(slot => [slot, 0]));
    for (const slot of Object.values(assigned)) {
        if (counts.has(slot)) counts.set(slot, counts.get(slot) + 1);
    }
    return candidates.reduce((best, slot) => counts.get(slot) < counts.get(best) ? slot : best);
}

/** Create persistent, stable color assignments for repository names.
 * @param {{get(key: string): Record<string, number>|undefined, update(key: string, value: Record<string, number>): Promise<unknown>}} memento
 * @param {() => string[]} [in_use]
 * @returns {{slot(name: string): number, color(name: string): {theme: string, hex: string, icon: string}, peek(name: string): {theme: string, hex: string, icon: string}|null}}
 */
function make_repo_colors(memento, in_use = () => []) {
    let assigned = { ...(memento.get('monarch.repoColors') || {}) };
    const name_key = name => typeof name === 'string' ? name.toLowerCase() : '';

    function slot(name) {
        const key = name_key(name);
        if (!key) return 0;
        if (Object.prototype.hasOwnProperty.call(assigned, key)) return assigned[key];

        const occupied = in_use()
            .map(name_key)
            .filter(other => other && other !== key)
            .map(other => assigned[other])
            .filter(value => Number.isInteger(value) && value >= 0 && value < repo_colors.length);
        const next_slot = pick_slot(assigned, occupied);
        assigned = { ...assigned, [key]: next_slot };
        try {
            const update = memento.update('monarch.repoColors', assigned);
            if (update && typeof update.catch === 'function') update.catch(() => {});
        } catch {
            // A failed persistence must not prevent this session from using the color.
        }
        return next_slot;
    }

    function peek(name) {
        const key = name_key(name);
        return key && Object.prototype.hasOwnProperty.call(assigned, key) ? repo_color(assigned[key]) : null;
    }

    return { slot, color: name => repo_color(slot(name)), peek };
}

module.exports = { folders, folder_by_name, repo_color, make_workspace_adapter, repo_roots, list_repos, find_repo, pick_slot, make_repo_colors };
