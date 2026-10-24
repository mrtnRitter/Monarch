'use strict';
/** Repo context for the agent: which repo "this repo" is, whether it is online and whether the local state differs. */

const marker = '[monarch context]';
const context_pattern = /(?:^|\n+)\[monarch context\][^\n]*\s*$/;

/** Browser URL of a git remote (https, ssh or scp form) without credentials; null for local or unknown remotes. */
function remote_web_url(url) {
    const match = /^(?:[a-z][a-z+.-]*:\/\/)?(?:[^@/]+@)?([^/:@]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec((url || '').trim());
    return match && match[1].includes('.') ? `https://${match[1]}/${match[2]}` : null;
}

/**
 * Facts from a repository of the VS Code git API.
 * @param {object|null|undefined} repository null = no git repository, undefined = git not available
 * @returns {{git: boolean|null, remote?: string|null, branch?: string|null, changes?: number, ahead?: number|null}}
 */
function git_info(repository) {
    if (!repository) return { git: repository === null ? false : null };
    const { HEAD, remotes = [], workingTreeChanges = [], indexChanges = [], untrackedChanges = [] } = repository.state;
    const remote = remotes.find(item => item.name === (HEAD?.upstream?.remote || 'origin')) || remotes[0];
    return {
        git: true, remote: remote?.fetchUrl || remote?.pushUrl || null, branch: HEAD?.name || null,
        changes: workingTreeChanges.length + indexChanges.length + untrackedChanges.length, ahead: HEAD?.upstream ? HEAD.ahead ?? 0 : null,
    };
}

/**
 * One-line repo context for the agent; folder = name of the open workspace folder.
 * Only states (no counts), so the line changes only when repo, link, branch or kind of local changes change.
 */
function context_line({ folder, git = null, remote = null, branch = null, changes = 0, ahead = null, transfer_task = null }) {
    const files = transfer_task ? `files: send with the skill monarch-transfer to awork task ${transfer_task}` : 'files: no transfer task set (monarch.transferTaskId), files cannot reach the repo';
    if (!folder) return `${marker} No folder is open in VS Code, so there is no "this repo" · ${files}`;
    const url = git ? remote_web_url(remote) : null;
    const online = git === null ? 'git status unknown' : !git ? 'not a git repository, not online' : url ? `online: ${url}` : 'not online (no remote); tell the user to push it first';
    const local = url ? [changes && 'uncommitted changes', ahead === null ? 'branch not pushed' : ahead && 'commits not pushed'].filter(Boolean) : [];
    const parts = [`"this repo" = the repo open in VS Code: ${folder}`, online, branch && `branch: ${branch}`, local.length && `local state differs from online (${local.join(', ')}); ask for attachments if needed`, files];
    return `${marker} ${parts.filter(Boolean).join(' · ').replace(/\s+/g, ' ')}`;
}

/** Text without the context line (for display). */
function strip_context(text) {
    return (text || '').replace(context_pattern, '');
}

module.exports = { remote_web_url, git_info, context_line, strip_context };
