'use strict';
/** Workspace folder helpers and read-only adapters for other open repositories. */
const vscode = require('vscode');
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

module.exports = { folders, folder_by_name, repo_color, make_workspace_adapter };
