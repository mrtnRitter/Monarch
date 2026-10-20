'use strict';
/** monarch VS Code extension: chat window for awork agents with co-agent relay. */
const vscode = require('vscode');
const { AworkClient, OAuth } = require('./awork');
const { ChatView } = require('./chat_view');

const api_key_secret = 'monarch.apiKey';

function _config() {
    return vscode.workspace.getConfiguration('monarch');
}

function activate(context) {
    const oauth = new OAuth({
        settings: () => ({ base_url: _config().get('apiBaseUrl'), client_id: _config().get('clientId'), redirect_port: _config().get('redirectPort') }),
        secrets: context.secrets,
    });
    const client = new AworkClient({
        base_url: () => _config().get('apiBaseUrl'),
        get_token: () => oauth.access_token(),
        get_api_key: async () => process.env.AWORK_API_KEY || (await context.secrets.get(api_key_secret)),
    });
    const view = new ChatView(context, client, oauth);
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
            await view.refresh();
        })),
        vscode.commands.registerCommand('monarch.signOut', run(async () => {
            await oauth.logout();
            await view.refresh();
        })),
        vscode.commands.registerCommand('monarch.setApiKey', run(async () => {
            const key = await vscode.window.showInputBox({ prompt: 'awork API key (used only if your user may not read credits)', password: true, ignoreFocusOut: true });
            if (key) await context.secrets.store(api_key_secret, key.trim());
        })),
        vscode.commands.registerCommand('monarch.clearApiKey', run(() => context.secrets.delete(api_key_secret))),
        vscode.commands.registerCommand('monarch.newChat', run(() => view.new_chat())),
        vscode.commands.registerCommand('monarch.stop', run(() => view.stop())),
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
