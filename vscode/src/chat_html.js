'use strict';

const crypto = require('node:crypto');
const vscode = require('vscode');

function chat_html({ webview, extension_uri }) {
    const media = vscode.Uri.joinPath(extension_uri, 'media');
    const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    const nonce = crypto.randomBytes(16).toString('hex');

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('chat.css')}"></head><body>
<div class="app">
<div class="topbar">
<button id="notes_toggle" class="icon-btn" title="Show or hide notes" aria-pressed="false"><svg viewBox="0 0 16 16" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3"/><path d="M5.5 8.5h5M5.5 11h3.5"/></svg></button>
<div class="menu-wrap"><button id="history" class="icon-btn" title="Chat history"><svg viewBox="0 0 16 16" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.4v2.7h2.7"/><path d="M8 5v3.2l2.2 1.4"/></svg></button><div id="history_menu" class="menu right hidden"></div></div>
<div class="menu-wrap"><button id="new_chat" class="icon-btn primary" title="New chat"><svg viewBox="0 0 16 16" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg></button><div id="new_menu" class="menu right hidden"></div></div>
</div>
<main class="main" id="main">
<div class="areas" id="areas"></div>
<div id="notes_pane" class="notes-pane hidden"><div id="notes_splitter" class="notes-splitter"></div><div id="notes_groups" class="notes-groups"><textarea id="notes" placeholder="Notes for this chat …" spellcheck="false"></textarea></div></div>
</main>
</div>
<template id="area_template">
<div class="chat area" data-el="chat">
<div class="messages" data-el="messages"></div>
<button class="new-answer hidden" data-el="new_answer" type="button" title="New answer – click to jump to it"></button>
<div class="input-area">
<div class="splitter" data-el="splitter" title="Drag to resize the input"></div>
<div class="input-toolbar" data-el="statusbar">
<div class="menu-wrap attach-wrap"><button class="icon-btn small" data-el="attach" title="Attach"><svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg></button><div class="menu hidden" data-el="attach_menu"></div></div>
<div class="toolbar-status"><span class="badge" data-el="credits"></span><span class="badge" data-el="co_credits"></span><span class="badge" data-el="co_agents"></span></div>
<div class="menu-wrap model-wrap"><button class="picker-btn" data-el="model" title="Model for this chat"></button><div class="menu up right hidden" data-el="model_menu"></div></div>
</div>
<div class="attachments" data-el="attachments"></div>
<div class="input-editor-wrap"><textarea data-el="input" rows="3" placeholder="Message … (Enter = send, Shift+Enter = new line)"></textarea></div>
<div class="bottom-row">
<div class="menu-wrap repo-wrap"><button class="repo-btn" data-el="repo" title="Repo of this chat"><span class="repo-dot" data-el="repo_dot"></span><span data-el="repo_name"></span></button><div class="menu up hidden" data-el="repo_menu"><div class="menu-header">Repo of this chat</div><input class="menu-filter" data-el="repo_filter" type="text" placeholder="Filter repos …" spellcheck="false"><div class="repo-list"></div></div></div>
<button class="icon-btn small" data-el="terminal" title="Terminal for this repo"><svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11v9h-11z"/><path d="M5 6.5l2 1.5-2 1.5"/><path d="M8.5 10h2.5"/></svg></button>
<button class="icon-btn small" data-el="close" title="Close this chat"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
<span class="grow"></span><button class="send-btn" data-el="send">Send</button><button class="stop-btn hidden" data-el="stop">Stop</button>
</div>
</div>
</div>
</template>
<script nonce="${nonce}" src="${asset('markdown.js')}"></script>
<script nonce="${nonce}" src="${asset('chat_time.js')}"></script>
<script nonce="${nonce}" src="${asset('chat_scroll.js')}"></script>
<script nonce="${nonce}" src="${asset('chat_layout.js')}"></script>
<script nonce="${nonce}" src="${asset('chat.js')}"></script>
<script nonce="${nonce}" src="${asset('chat_host.js')}"></script></body></html>`;
}

module.exports = { chat_html };
