'use strict';
/** monarch VS Code extension: chat window for awork agents with co-agent relay. */
const vscode = require('vscode');
const { AworkClient, OAuth } = require('./awork');
const { ChatPanels } = require('./chat_panels');
const { set_log } = require('./log');

function _config() {
    return vscode.workspace.getConfiguration('monarch');
}

function activate(context) {
    const channel = vscode.window.createOutputChannel?.('monarch');
    if (channel) {
        context.subscriptions.push(channel);
        set_log(line => channel.appendLine(line));
    }
    const oauth = new OAuth({
        settings: () => ({ base_url: _config().get('apiBaseUrl'), client_id: _config().get('clientId'), redirect_port: _config().get('redirectPort') }),
        secrets: context.secrets,
    });
    const client = new AworkClient({ base_url: () => _config().get('apiBaseUrl'), get_token: () => oauth.access_token() });
    // API key of the removed Month item (0.16 and older)
    context.secrets.delete('monarch.apiKey').then(undefined, () => {});
    const panels = new ChatPanels(context, client, oauth);
    const view = panels.sidebar;
    const run = action => async () => {
        try {
            await action();
        } catch (error) {
            vscode.window.showErrorMessage(`monarch: ${error.message}`);
        }
    };
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('monarch.chat', view, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('monarch.signIn', run(async () => {
            await oauth.login(url => vscode.env.openExternal(vscode.Uri.parse(url, true)));
            vscode.window.showInformationMessage('monarch: signed in.');
            await Promise.all(panels.all().map(async chat => { chat.forget_user(); await chat.refresh(); }));
        })),
        vscode.commands.registerCommand('monarch.signOut', run(async () => {
            await oauth.logout();
            await Promise.all(panels.all().map(async chat => { chat.forget_user(); await chat.refresh(); }));
        })),
        vscode.commands.registerCommand('monarch.newChat', run(() => panels.active().new_chat())),
        vscode.commands.registerCommand('monarch.stop', run(() => panels.active().stop())),
        vscode.commands.registerCommand('monarch.openChatInEditor', run(() => panels.open(panels.active().current_repo?.() || null))),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('monarch.agents') || event.affectsConfiguration('monarch.agentFilter')) {
                panels.all().forEach(chat => chat.refresh({ reload_agents: true }));
            }
            if (event.affectsConfiguration('monarch.notesPosition')) panels.all().forEach(chat => chat.post_notes_position());
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => panels.all().forEach(chat => chat.refresh())),
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
