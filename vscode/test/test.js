'use strict';
// Local tests without VS Code and without network (fake awork API). Run: node test/test.js
const assert = require('assert/strict');
const http = require('http');
const zlib = require('zlib');
const files = require('../src/files');
const { parse_commands } = require('../src/orca');
const { create_zip } = require('../src/zip');
const { AworkClient, OAuth } = require('../src/awork');
const { ChatSession } = require('../src/session');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const block = (path, content, hash = files.sha256_text(content)) => `### FILE: ${path} sha256=${hash}\n\`\`\`python\n${content}\`\`\`\n`;

// --- files ---
test('checksum matches the one-liner from the prompts', () => {
    assert.equal(files.sha256_text('a\r\nb'), '911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2');
    assert.equal(files.sha256_text('a\nb\n\n'), files.sha256_text('a\nb'));
    assert.equal(files.sha256_text(''), '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b');
});

test('FILE blocks: verified, mismatch, unverified, nested fences', () => {
    const text = [block('src/a.py', 'A = 1\n'), block('b.py', 'B = 2\n', 'f'.repeat(64)), '### FILE: c.md\n````markdown\n```python\nx\n```\n````\n'].join('\n');
    const blocks = files.parse_file_blocks(text);
    assert.deepEqual(blocks.map(item => [item.path, item.check]), [['src/a.py', 'verified'], ['b.py', 'mismatch'], ['c.md', 'unverified']]);
    assert.equal(blocks[2].content, '```python\nx\n```\n');
    assert.equal(files.strip_file_blocks(text), '[file: src/a.py]\n\n[file: b.py]\n\n[file: c.md]');
});

test('safe paths and junk', () => {
    assert.equal(files.safe_rel_path('./src\\a.py'), 'src/a.py');
    for (const bad of ['/etc/x', 'C:/x', '../x', 'a/../../x', '.git/config', '']) assert.equal(files.safe_rel_path(bad), null, bad);
    assert.ok(files.is_junk('x/__pycache__/a.cpython-312.pyc'));
    assert.equal(files.output_rel_path({ id: '/workspace/output/src/a.py', name: 'a.py' }), 'src/a.py');
});

// --- orca ---
test('ORCA commands: text, bodies, headers inside fences ignored', () => {
    const text = 'Plan steht.\n\n### ORCA: spawn\nBaue x.\n```md\n### ORCA: stopzilla\n```\n### ORCA: send minizilla_2\nKorrektur\n### ORCA: wait';
    const { text: visible, commands } = parse_commands(text);
    assert.equal(visible, 'Plan steht.');
    assert.deepEqual(commands.map(command => [command.action, command.target]), [['spawn', null], ['send', 'minizilla_2'], ['wait', null]]);
    assert.equal(commands[0].body, 'Baue x.\n```md\n### ORCA: stopzilla\n```');
});

// --- zip ---
test('zip: readable entry with UTF-8 name', () => {
    const data = Buffer.from('hallo äöü '.repeat(50));
    const zip = create_zip([{ name: 'src/ü.txt', data }]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const name_length = zip.readUInt16LE(26);
    assert.equal(zip.subarray(30, 30 + name_length).toString('utf8'), 'src/ü.txt');
    const body = zip.subarray(30 + name_length, 30 + name_length + zip.readUInt32LE(18));
    assert.deepEqual(zlib.inflateRawSync(body), data);
    require('fs').writeFileSync(require('path').join(__dirname, 'out_test.zip'), create_zip([{ name: 'f/a.txt', data: Buffer.from('a') }, { name: 'f/sub/b.bin', data: Buffer.from([0, 1, 2]) }]));
});

// --- OAuth ---
const memory_secrets = () => { const store = new Map(); return { get: async key => store.get(key), store: async (key, value) => { store.set(key, value); }, delete: async key => { store.delete(key); }, store_map: store }; };

test('OAuth: login via local callback, refresh rotates token', async () => {
    const calls = [];
    const fake_fetch = async (url, options) => {
        const body = new URLSearchParams(options.body);
        calls.push(Object.fromEntries(body));
        const n = calls.length;
        return { ok: true, status: 200, json: async () => ({ access_token: `access_${n}`, refresh_token: `refresh_${n}`, expires_in: n === 1 ? 1 : 86400 }) };
    };
    const secrets = memory_secrets();
    const oauth = new OAuth({ settings: () => ({ base_url: 'https://api.awork.com/api/v1', client_id: 'client', redirect_port: 18765 }), secrets, fetch_impl: fake_fetch });
    await oauth.login(async url => {
        const params = new URL(url).searchParams;
        assert.equal(params.get('redirect_uri'), 'http://localhost:18765/callback');
        assert.equal(params.get('code_challenge_method'), 'S256');
        await new Promise((resolve, reject) => http.get(`http://localhost:18765/callback?code=abc&state=${params.get('state')}`, response => { response.resume(); response.on('end', resolve); }).on('error', reject));
    });
    assert.equal(calls[0].grant_type, 'authorization_code');
    assert.equal(calls[0].code, 'abc');
    assert.ok(calls[0].code_verifier.length >= 43);
    // first token expires immediately -> refresh, concurrent calls share one refresh
    const [first, second] = await Promise.all([oauth.access_token(), oauth.access_token()]);
    assert.equal(first, 'access_2');
    assert.equal(second, 'access_2');
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[1].grant_type, calls[1].refresh_token], ['refresh_token', 'refresh_1']);
    assert.equal(JSON.parse(secrets.store_map.get('monarch.oauth')).refresh_token, 'refresh_2');
});

test('client: base path, download route order, API key fallback for credits', async () => {
    const seen = [];
    const fake_fetch = async (url, options) => {
        seen.push([url, options.headers.Authorization]);
        const status = url.includes('artifacts') ? 401 : url.includes('management') && options.headers.Authorization === 'Bearer user' ? 403 : 200;
        return { ok: status === 200, status, text: async () => (status === 200 ? '[{"id":"t1","creditsUsed":5}]' : 'no'), arrayBuffer: async () => new ArrayBuffer(1) };
    };
    const client = new AworkClient({ base_url: () => 'https://api.awork.com/api/v1', get_token: async () => 'user', get_api_key: async () => 'key', fetch_impl: fake_fetch });
    await assert.rejects(client.download_file('t', { id: '/workspace/output/a.py', downloadUrl: '/api/v1/agents/threads/t/artifacts/download?path=a' }));
    assert.equal(seen[0][0], 'https://api.awork.com/api/v1/agents/threads/t/artifacts/download?path=a');
    assert.equal(seen.length, 1);
    assert.deepEqual(await client.thread_usage(), [{ id: 't1', creditsUsed: 5 }]);
    assert.deepEqual(seen.slice(1).map(item => item[1]), ['Bearer user', 'Bearer key']);
});

// --- session with fake awork ---
class FakeAwork {
    constructor() {
        Object.assign(this, { threads: {}, uploads: [], cancelled: [], next: 1, usage_error: null });
    }
    _thread(agent_id) {
        const id = `t${this.next++}`;
        this.threads[id] = { agent_id, messages: [], pending: null };
        return id;
    }
    _user(thread_id, content, attachments) {
        const thread = this.threads[thread_id];
        const id = `m${this.next++}`;
        thread.messages.push({ id, role: 'user', content, attachments, messageOrder: thread.messages.length });
        thread.pending = { id, polls: 0 };
        return id;
    }
    async create_thread(agent_id, content, title, attachments) {
        const id = this._thread(agent_id);
        this.threads[id].title = title;
        return { id, acceptedMessageId: this._user(id, content, attachments) };
    }
    async send_message(thread_id, content, attachments) {
        return { acceptedMessageId: this._user(thread_id, content, attachments) };
    }
    async message_status(thread_id, message_id) {
        const thread = this.threads[thread_id];
        if (thread.pending?.id === message_id) {
            if (++thread.pending.polls < (thread.delay || 1)) return { status: 'running' };
            const reply = this.reply(thread_id, thread.messages.at(-1));
            thread.messages.push({ id: `a${this.next++}`, role: 'agent', content: reply.content, temporaryFiles: reply.files || [], messageOrder: thread.messages.length });
            thread.pending = null;
        }
        return { status: 'completed', hasAgentResponse: true };
    }
    async messages(thread_id) {
        return this.threads[thread_id].messages;
    }
    async cancel(thread_id) {
        this.cancelled.push(thread_id);
    }
    async upload_temporary_file(name, data) {
        this.uploads.push({ name, data: Buffer.from(data).toString('utf8') });
        return `tmp${this.uploads.length}`;
    }
    async download_file() {
        throw new Error('401 no permissions');
    }
    async thread_usage() {
        if (this.usage_error) throw new Error(this.usage_error);
        return Object.keys(this.threads).map(id => ({ id, creditsUsed: 10 }));
    }
}

function make_session(fake, reply, limits = {}) {
    fake.reply = reply;
    const written = {};
    const events = [];
    const session = new ChatSession({
        client: fake,
        agent: { name: 'Mastazilla', agentId: 'master', coAgentId: 'mini', coAgentName: 'minizilla' },
        limits: { maxCredits: 0, maxCoAgents: 3, maxRounds: 20, relayTimeout: 0, pollInterval: 0, ...limits },
        store: { load: () => undefined, save: () => {} },
        workspace: { write: async (path, data) => { written[path] = data; return path; } },
        ui: { message: item => events.push(item), info: text => events.push({ role: 'info', text }), status: () => {} },
        sleep: async () => {},
    });
    return { session, written, events };
}

const mini_answer = (status, file_content) => ({ content: `STATUS: ${status}\nNOTES: x\n\n${file_content ? block('hello.py', file_content) : ''}` });

test('relay: spawn two, forward together, write verified final file, skip unverified', async () => {
    const fake = new FakeAwork();
    let master_turn = 0;
    const { session, written, events } = make_session(fake, (thread_id, message) => {
        if (fake.threads[thread_id].agent_id === 'mini') return mini_answer('done', message.content.includes('A') ? 'print("a")\n' : null);
        master_turn += 1;
        if (master_turn === 1) return { content: `Los gehts.\n### ORCA: spawn\nTask A\n${block('brief.txt', 'input\n')}\n### ORCA: spawn\nTask B` };
        assert.ok(message.content.startsWith('[monarch relay]'));
        assert.match(message.content, /## minizilla_1 \(answered\)/);
        assert.match(message.content, /## minizilla_2 \(answered\)/);
        assert.match(message.content, /attached: hello\.py \(verified\)/);
        assert.match(message.content, /ok: spawn minizilla_1/);
        return { content: `Fertig.\n${block('src/final.py', 'X = 1\n')}\n### FILE: notes.md\n\`\`\`\nno hash\n\`\`\`\n### ORCA: stopzilla` };
    });
    await session.send('Bau was');
    assert.equal(master_turn, 2);
    assert.deepEqual(Object.keys(written), ['src/final.py']);
    assert.equal(written['src/final.py'], 'X = 1\n');
    const agent_messages = events.filter(item => item.role === 'agent');
    assert.ok(agent_messages.at(-1).warnings.some(warning => warning.includes('notes.md not written (unverified)')));
    const mini_threads = Object.values(fake.threads).filter(thread => thread.agent_id === 'mini');
    assert.equal(mini_threads[0].messages[0].attachments.length, 1);
    assert.match(mini_threads[0].messages[0].content, /Attached files: brief\.txt/);
    assert.ok(fake.uploads.some(item => item.name === 'brief.txt' && item.data === 'input\n'));
    assert.equal(session.status().co_agents, 0);
    assert.equal(session.state.rounds, 0);
});

test('relay: question wakes the agent early, others keep working', async () => {
    const fake = new FakeAwork();
    let master_turn = 0;
    const { session } = make_session(fake, (thread_id, message) => {
        const thread = fake.threads[thread_id];
        if (thread.agent_id === 'mini') return message.content.includes('slow') ? mini_answer('done') : mini_answer('question');
        master_turn += 1;
        if (master_turn === 1) return { content: '### ORCA: spawn\nfast\n### ORCA: spawn\nslow' };
        assert.match(message.content, /minizilla_1 \(answered\)/);
        assert.match(message.content, /still working: minizilla_2/);
        return { content: 'Warte noch.' };
    });
    const original = fake.create_thread.bind(fake);
    fake.create_thread = async (...args) => {
        const result = await original(...args);
        if (args[1] === 'slow') fake.threads[result.id].delay = 1000;
        return result;
    };
    await session.send('go');
    assert.equal(master_turn, 2);
});

test('limits: maxCoAgents refused and reported immediately', async () => {
    const fake = new FakeAwork();
    let master_turn = 0;
    const { session } = make_session(fake, (thread_id, message) => {
        if (fake.threads[thread_id].agent_id === 'mini') return mini_answer('done');
        master_turn += 1;
        if (master_turn === 1) return { content: '### ORCA: spawn\na\n### ORCA: spawn\nb' };
        assert.match(message.content, /refused: spawn: maxCoAgents reached \(1\/1\)/);
        return { content: 'ok' };
    }, { maxCoAgents: 1 });
    await session.send('go');
    assert.equal(master_turn, 2);
});

test('budget: unreadable credits block the start, cap stops everything', async () => {
    const fake = new FakeAwork();
    fake.usage_error = 'forbidden';
    const { session } = make_session(fake, () => ({ content: 'x' }), { maxCredits: 100 });
    await assert.rejects(session.send('go'), /Credits not readable/);
    fake.usage_error = null;
    let master_turn = 0;
    const capped = make_session(fake, (thread_id) => {
        if (fake.threads[thread_id].agent_id === 'mini') return mini_answer('done');
        master_turn += 1;
        return { content: '### ORCA: spawn\na' };
    }, { maxCredits: 25 });
    capped.session.credit_refresh_ms = 0;
    for (const thread of Object.values(fake.threads)) thread.delay = 3;
    const original = fake.create_thread.bind(fake);
    fake.create_thread = async (...args) => { const result = await original(...args); fake.threads[result.id].delay = 3; return result; };
    await capped.session.send('go');
    assert.ok(capped.events.some(item => item.role === 'info' && item.text.startsWith('stop (maxCredits reached')));
    assert.ok(fake.cancelled.length >= 1);
});

test('unsafe or mismatched brief files refuse the command', async () => {
    const fake = new FakeAwork();
    let master_turn = 0;
    const { session } = make_session(fake, (thread_id, message) => {
        master_turn += 1;
        if (master_turn === 1) return { content: `### ORCA: spawn\nTask\n${block('a.py', 'A\n', '0'.repeat(64))}` };
        assert.match(message.content, /refused: spawn: file a\.py checksum mismatch/);
        return { content: 'ok' };
    });
    await session.send('go');
    assert.equal(Object.keys(session.state.co_agents).length, 0);
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`ok   ${name}`);
        } catch (error) {
            failed += 1;
            console.log(`FAIL ${name}\n${error.stack}`);
        }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
