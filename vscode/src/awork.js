'use strict';
/** awork API client and OAuth 2.0 login (PKCE, local callback). No VS Code dependency. */
const crypto = require('crypto');
const http = require('http');
const files = require('./files');
const { log } = require('./log');

const uuid_pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const token_key = 'monarch.oauth';
const scopes = 'full_access offline_access';
const refresh_margin_ms = 60_000;
const request_timeout_ms = 60_000;

class AworkError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.status = status;
    }
}

function _base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _create_pkce() {
    const verifier = _base64url(crypto.randomBytes(32));
    return { verifier, challenge: _base64url(crypto.createHash('sha256').update(verifier).digest()) };
}

function _wait_for_code(port, state, timeout_ms) {
    return new Promise((resolve, reject) => {
        const finish = (error, code) => {
            clearTimeout(timer);
            server.close();
            error ? reject(error) : resolve(code);
        };
        const server = http.createServer((request, response) => {
            const url = new URL(request.url, `http://localhost:${port}`);
            if (url.pathname !== '/callback') return response.writeHead(404).end();
            const code = url.searchParams.get('state') === state ? url.searchParams.get('code') : null;
            response.writeHead(code ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
                .end(code ? '<p>monarch: signed in. You can close this window.</p>' : '<p>monarch: sign-in failed.</p>');
            finish(code ? null : new AworkError(`Sign-in failed: ${url.searchParams.get('error') || 'invalid response'}`), code);
        });
        const timer = setTimeout(() => finish(new AworkError('Sign-in timed out.')), timeout_ms);
        server.on('error', error => finish(new AworkError(`Port ${port} is not available (${error.message}). Change monarch.redirectPort.`)));
        server.listen(port, 'localhost');
    });
}

class OAuth {
    /**
     * OAuth 2.0 login for a public awork client app. Tokens are kept in secrets (VS Code SecretStorage or compatible).
     * @param {{settings: () => {base_url: string, client_id: string, redirect_port: number}, secrets: {get, store, delete}, fetch_impl?: typeof fetch}} options
     */
    constructor({ settings, secrets, fetch_impl }) {
        Object.assign(this, { settings, secrets, fetch: fetch_impl || fetch, refreshing: null });
    }

    redirect_uri() {
        return `http://localhost:${this.settings().redirect_port}/callback`;
    }

    authorize_url(state, challenge) {
        const { base_url, client_id } = this.settings();
        const params = { client_id, response_type: 'code', grant_type: 'authorization_code', redirect_uri: this.redirect_uri(), state, scope: scopes, code_challenge: challenge, code_challenge_method: 'S256' };
        return `${base_url}/accounts/authorize?${Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
    }

    /** Open the browser login and store the tokens. open_external(url) opens the URL. */
    async login(open_external, timeout_ms = 300_000) {
        if (!this.settings().client_id) throw new AworkError('Set monarch.clientId first.');
        const { verifier, challenge } = _create_pkce();
        const state = _base64url(crypto.randomBytes(16));
        const code_promise = _wait_for_code(this.settings().redirect_port, state, timeout_ms);
        await open_external(this.authorize_url(state, challenge));
        const code = await code_promise;
        await this._save(await this._token({ grant_type: 'authorization_code', code, redirect_uri: this.redirect_uri(), code_verifier: verifier }));
    }

    async logout() {
        await this.secrets.delete(token_key);
    }

    async is_logged_in() {
        return Boolean(await this._load());
    }

    /** Return a valid access token; refreshes it shortly before it expires. */
    async access_token() {
        const tokens = await this._load();
        if (!tokens) throw new AworkError('Not signed in. Run "monarch: Sign in".', 401);
        if (tokens.expires_at - refresh_margin_ms > Date.now()) return tokens.access_token;
        // one refresh at a time: the refresh token is single-use
        this.refreshing = this.refreshing || this._refresh(tokens).finally(() => { this.refreshing = null; });
        return this.refreshing;
    }

    async _refresh(tokens) {
        try {
            return (await this._save(await this._token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), tokens)).access_token;
        } catch (error) {
            if ([400, 401].includes(error.status)) {
                await this.logout();
                throw new AworkError('Sign-in expired. Run "monarch: Sign in" again.', 401);
            }
            throw error;
        }
    }

    async _token(fields) {
        const { base_url, client_id } = this.settings();
        const response = await this.fetch(`${base_url}/accounts/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id, ...fields }).toString(),
            signal: AbortSignal.timeout(request_timeout_ms),
        });
        if (!response.ok) throw new AworkError(`Token request failed with ${response.status}: ${(await response.text()).slice(0, 200)}`, response.status);
        return response.json();
    }

    async _save(token, previous = {}) {
        const tokens = {
            access_token: token.access_token,
            refresh_token: token.refresh_token || previous.refresh_token,
            expires_at: Date.now() + (token.expires_in || 3600) * 1000,
        };
        await this.secrets.store(token_key, JSON.stringify(tokens));
        return tokens;
    }

    async _load() {
        const raw = await this.secrets.get(token_key);
        return raw ? JSON.parse(raw) : null;
    }
}

class AworkClient {
    /**
     * Minimal client for the awork agents API.
     * @param {{base_url: () => string, get_token: () => Promise<string>, fetch_impl?: typeof fetch}} options
     */
    constructor({ base_url, get_token, fetch_impl }) {
        Object.assign(this, { base_url, get_token, fetch: fetch_impl || fetch });
    }

    _url(route) {
        if (/^https?:\/\//.test(route)) return route;
        const base = this.base_url().replace(/\/+$/, '');
        const base_path = new URL(base).pathname.replace(/\/+$/, '');
        // downloadUrl may already contain the API base path
        return base + (base_path && route.startsWith(`${base_path}/`) ? route.slice(base_path.length) : route);
    }

    /** Send a request with the OAuth token. Throws AworkError on non-2xx. */
    async request(method, route, { json, body, raw = false } = {}) {
        const token = await this.get_token();
        const headers = { Authorization: `Bearer ${token}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) };
        const response = await this.fetch(this._url(route), { method, headers, body: json !== undefined ? JSON.stringify(json) : body, signal: AbortSignal.timeout(request_timeout_ms) });
        if (!response.ok) throw new AworkError(`awork API ${method} ${route} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`, response.status);
        if (raw) return Buffer.from(await response.arrayBuffer());
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    }

    /**
     * Create a custom-agent thread with a first message. Returns the thread incl. acceptedMessageId.
     * options: optional {modelProvider, modelName, reasoningLevel} override for this message.
     */
    create_thread(agent_id, content, title, attachments = [], options = {}) {
        return this.request('POST', '/agents/threads', { json: { type: 'custom-agent', agentId: agent_id, title, content, ...(attachments.length ? { attachments } : {}), ...options } });
    }

    /** Submit a message to a thread. Returns the acceptance incl. acceptedMessageId. options as in create_thread. */
    send_message(thread_id, content, attachments = [], options = {}) {
        return this.request('POST', `/agents/threads/${thread_id}/messages`, { json: { content, ...(attachments.length ? { attachments } : {}), ...options } });
    }

    /** Thread details incl. title and usage.creditsUsed. */
    thread(thread_id) {
        return this.request('GET', `/agents/threads/${thread_id}`);
    }

    /** Custom agents visible to the signed-in user. */
    async agents() {
        return (await this.request('GET', '/agents')) || [];
    }

    /** Effective model settings of a custom agent incl. availableModels. */
    agent_defaults(agent_id) {
        return this.request('GET', `/agents/defaults?type=custom-agent&agentId=${agent_id}`);
    }

    message_status(thread_id, message_id) {
        return this.request('GET', `/agents/threads/${thread_id}/messages/${message_id}/status`);
    }

    /** Return all messages of a thread in conversation order. */
    async messages(thread_id) {
        const items = (await this.request('GET', `/agents/threads/${thread_id}/messages`)) || [];
        return [...items].sort((a, b) => (a.messageOrder || 0) - (b.messageOrder || 0));
    }

    cancel(thread_id) {
        return this.request('POST', `/agents/threads/${thread_id}/cancel`);
    }

    /** Upload bytes as temporary file and return its id for message attachments. */
    async upload_temporary_file(name, data, mime_type = 'application/octet-stream') {
        const form = new FormData();
        form.append('file', new Blob([data], { type: mime_type }), name);
        return (await this.request('POST', '/temporaryfiles', { body: form })).id;
    }

    /**
     * Routes for an agent output file, each once: downloadUrl, the artifact route by output path
     * (as given and with "output/" prefix, the expected form is not documented), then the file route if id is a uuid.
     */
    _download_routes(thread_id, file) {
        const path = files.output_path(file);
        const artifact = value => `/agents/threads/${thread_id}/artifacts/download?path=${value.split('/').map(encodeURIComponent).join('/')}`;
        const routes = [file.downloadUrl, path && artifact(path), path && artifact(`output/${path}`), uuid_pattern.test(file.id || '') && `/agents/threads/${thread_id}/files/${file.id}/download`];
        return [...new Map(routes.filter(Boolean).map(route => [this._url(route), route])).values()];
    }

    /** Download an agent output file; tries all routes of _download_routes and logs each attempt. */
    async download_file(thread_id, file) {
        const errors = [];
        for (const route of this._download_routes(thread_id, file)) {
            try {
                const data = await this.request('GET', route, { raw: true });
                log(`download ${file.name || file.sandboxPath}: ok via ${route}`);
                return data;
            } catch (error) {
                log(`download ${file.name || file.sandboxPath}: ${route} failed (${error.message.slice(0, 200)})`);
                errors.push(error.message.slice(0, 300));
            }
        }
        throw new AworkError(errors.join('; ') || 'no download route (no downloadUrl, no output path, no file id)');
    }

    /** Signed-in user incl. id, firstName and lastName. */
    me() {
        return this.request('GET', '/me');
    }

    /** Profile image of a user or agent (kind 'users' or 'agents'), square and size x size pixels, as Buffer. */
    image(kind, id, size = 64) {
        return this.request('GET', `/files/images/${kind}/${id}?width=${size}&height=${size}&crop=true`, { raw: true });
    }
}

module.exports = { AworkClient, AworkError, OAuth };
