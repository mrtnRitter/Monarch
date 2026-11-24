'use strict';

const assert = require('node:assert/strict');
const { ChatSession } = require('../src/session');

async function main() {
    const session = new ChatSession({
        client: { messages: async thread_id => {
            assert.equal(thread_id, 't1');
            return [
                { role: 'user', content: 'hi', createdOn: '2026-11-23T22:30:00Z' },
                { role: 'assistant', id: 'm2', content: 'ok', createdOn: '2026-11-24T08:05:00Z' },
                { role: 'user', content: 'x' },
            ];
        } },
        agent: { name: 'A' }, limits: {}, store: { load: () => ({ thread_id: 't1' }), save() {} },
        workspace: {}, ui: { message() {}, status() {} },
    });
    const items = await session.history();
    assert.equal(items[0].created, Date.parse('2026-11-23T22:30:00Z'));
    assert.equal(items.find(item => item.role === 'agent').created, Date.parse('2026-11-24T08:05:00Z'));
    assert.equal(items.filter(item => item.role === 'user')[1].created, null);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
