'use strict';
// Local tests without VS Code and without network.
const assert = require('assert/strict');
const { period_start, month_credits, MonthCredits } = require('../src/month');
const { AworkClient } = require('../src/awork');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const date = value => new Date(value);

test('period starts before, on and after the reset day', () => {
    assert.equal(period_start(date('2026-06-09T23:59:00Z'), 10).toISOString(), '2026-05-10T00:00:00.000Z');
    assert.equal(period_start(date('2026-06-10T00:00:00Z'), 10).toISOString(), '2026-06-10T00:00:00.000Z');
    assert.equal(period_start(date('2026-06-11T00:00:00Z'), 10).toISOString(), '2026-06-10T00:00:00.000Z');
});

test('period start crosses the year boundary and clamps reset day', () => {
    assert.equal(period_start(date('2026-01-02T00:00:00Z'), 5).toISOString(), '2025-12-05T00:00:00.000Z');
    assert.equal(period_start(date('2026-06-01T00:00:00Z'), 0).toISOString(), '2026-06-01T00:00:00.000Z');
    assert.equal(period_start(date('2026-06-01T00:00:00Z'), 40).toISOString(), '2026-05-28T00:00:00.000Z');
});

test('sums grouped rows for the requested user and passes the UTC period', async () => {
    const calls = [];
    const usage_client = { usage_rows: async args => {
        calls.push(args);
        return [
            { usageUserId: 'user-a', creditsUsed: 12 },
            { usageUserId: 'user-b', creditsUsed: 100 },
            { usageUserId: 'user-a', creditsUsed: 8 }
        ];
    } };
    const used = await month_credits(usage_client, 'user-a', date('2026-07-17T15:43:00Z'), 10);
    assert.equal(used, 20);
    assert.deepEqual(calls, [{ from: '2026-07-10T00:00:00Z', to: '2026-07-17T00:00:00Z', group_by: 'user' }]);
});

test('falls back to createdBy rows after a grouped 400', async () => {
    const calls = [];
    const usage_client = { usage_rows: async args => {
        calls.push(args);
        if (args.group_by) throw Object.assign(new Error('bad group'), { status: 400 });
        return [{ createdBy: 'user-a', creditsUsed: 7 }, { createdBy: 'other', creditsUsed: 50 }];
    } };
    assert.equal(await month_credits(usage_client, 'user-a', date('2026-02-20T00:00:00Z'), 1), 7);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].group_by, undefined);
});

test('falls back when grouped rows have no usageUserId', async () => {
    const calls = [];
    const usage_client = { usage_rows: async args => {
        calls.push(args);
        return args.group_by
            ? [{ creditsUsed: 90 }]
            : [{ createdBy: 'user-a', creditsUsed: 14 }, { createdBy: 'other', creditsUsed: 2 }];
    } };
    assert.equal(await month_credits(usage_client, 'user-a', date('2026-02-20T00:00:00Z'), 1), 14);
    assert.equal(calls.length, 2);
});

test('usage rows use the key client while me uses the OAuth client', async () => {
    let me_calls = 0;
    let usage_calls = 0;
    const manager = new MonthCredits({
        client: {
            me: async () => { me_calls++; return { id: 'user-a' }; },
            usage_rows: async () => { throw new Error('OAuth client must not read usage'); }
        },
        usage_client: {
            usage_rows: async () => { usage_calls++; return [{ usageUserId: 'user-a', creditsUsed: 14 }]; }
        },
        settings: () => ({ quota: 1000, reset_day: 1 }),
        now: () => date('2026-04-12T12:00:00Z')
    });
    assert.equal((await manager.refresh()).used, 14);
    assert.equal(me_calls, 1);
    assert.equal(usage_calls, 1);
});

test('401 stores the API-key rejection message', async () => {
    const manager = new MonthCredits({
        client: { me: async () => ({ id: 'user-a' }) },
        usage_client: { usage_rows: async () => { throw Object.assign(new Error('denied'), { status: 401 }); } },
        settings: () => ({ quota: 1000, reset_day: 1 }),
        now: () => date('2026-04-12T12:00:00Z')
    });
    assert.equal((await manager.refresh()).error, 'API key rejected (401). Ctrl+click Month to enter it again.');
});

test('403 stores the admin-rights message', async () => {
    const manager = new MonthCredits({
        client: { me: async () => ({ id: 'user-a' }) },
        usage_client: { usage_rows: async () => { throw Object.assign(new Error('denied'), { status: 403 }); } },
        settings: () => ({ quota: 1000, reset_day: 1 }),
        now: () => date('2026-04-12T12:00:00Z')
    });
    const status = await manager.refresh();
    assert.equal(status.used, null);
    assert.equal(status.error, 'admin rights needed to read your credit usage');
    assert.equal(status.quota, 1000);
});

test('missing API key keeps its original message', async () => {
    const manager = new MonthCredits({
        client: { me: async () => ({ id: 'user-a' }) },
        usage_client: { usage_rows: async () => { throw new Error('No API key set. Ctrl+click Month to enter it.'); } },
        settings: () => ({ quota: 1000, reset_day: 1 }),
        now: () => date('2026-04-12T12:00:00Z')
    });
    assert.equal((await manager.refresh()).error, 'No API key set. Ctrl+click Month to enter it.');
});

test('refresh throttles cached requests unless forced', async () => {
    let usage_calls = 0;
    const manager = new MonthCredits({
        client: { me: async () => ({ id: 'user-a' }) },
        usage_client: { usage_rows: async () => { usage_calls++; return [{ usageUserId: 'user-a', creditsUsed: 35 }]; } },
        settings: () => ({ quota: 500, reset_day: 1 }),
        now: () => date('2026-04-12T12:00:00Z'),
        refresh_ms: 60_000
    });
    assert.equal((await manager.refresh()).used, 35);
    await manager.refresh();
    assert.equal(usage_calls, 1);
    await manager.refresh(true);
    assert.equal(usage_calls, 2);
});

test('reset forgets the user and cached status', async () => {
    let me_calls = 0;
    const manager = new MonthCredits({
        client: { me: async () => ({ id: `user-${++me_calls}` }) },
        usage_client: { usage_rows: async () => [{ usageUserId: 'user-1', creditsUsed: 22 }] },
        settings: () => ({ quota: 300, reset_day: 1 }),
        now: () => date('2026-04-12T12:00:00Z')
    });
    await manager.refresh();
    manager.reset();
    assert.deepEqual(manager.status(), { used: null, error: null, period_start: null, quota: 300 });
    await manager.refresh();
    assert.equal(me_calls, 2);
});

test('usage_rows builds encoded URL and returns an array', async () => {
    let request;
    const client = new AworkClient({
        base_url: () => 'https://api.awork.com/api/v1',
        get_token: async () => 'token',
        fetch_impl: async (url, options) => {
            request = { url, options };
            return { ok: true, text: async () => '[{"creditsUsed":4}]' };
        }
    });
    const rows = await client.usage_rows({ from: '2026-07-10T00:00:00Z', to: '2026-07-17T00:00:00Z', group_by: 'user team' });
    assert.deepEqual(rows, [{ creditsUsed: 4 }]);
    assert.equal(request.url, 'https://api.awork.com/api/v1/agents/management/threads?usageFrom=2026-07-10T00%3A00%3A00Z&usageTo=2026-07-17T00%3A00%3A00Z&usageGroupBy=user%20team');
    assert.equal(request.options.method, 'GET');

    const empty_client = new AworkClient({
        base_url: () => 'https://api.awork.com/api/v1',
        get_token: async () => 'token',
        fetch_impl: async () => ({ ok: true, text: async () => '{\"not\":\"rows\"}' })
    });
    assert.deepEqual(await empty_client.usage_rows({ from: '2026-07-10T00:00:00Z', to: '2026-07-17T00:00:00Z' }), []);
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`ok - ${name}`);
        } catch (error) {
            failed++;
            console.error(`not ok - ${name}`);
            console.error(error);
        }
    }
    console.log(`${tests.length - failed}/${tests.length} tests passed`);
    if (failed) process.exitCode = 1;
})();
