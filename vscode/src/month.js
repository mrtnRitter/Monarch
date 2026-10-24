'use strict';

function _clamp_reset_day(reset_day) {
    const value = Number(reset_day);
    if (!Number.isFinite(value)) return 1;
    return Math.min(28, Math.max(1, Math.trunc(value)));
}

function period_start(now, reset_day = 1) {
    const day = _clamp_reset_day(reset_day);
    const date = new Date(now);
    const month = date.getUTCDate() >= day ? date.getUTCMonth() : date.getUTCMonth() - 1;
    return new Date(Date.UTC(date.getUTCFullYear(), month, day));
}

function _utc_day(date) {
    return `${date.toISOString().slice(0, 10)}T00:00:00Z`;
}

function _now_ms(now) {
    try {
        return now().getTime();
    } catch (_) {
        return Date.now();
    }
}

function _sum_credits(rows, matches) {
    return rows.reduce((total, row) => {
        if (!matches(row)) return total;
        const credits = Number(row.creditsUsed);
        return total + (Number.isFinite(credits) ? credits : 0);
    }, 0);
}

async function month_credits(usage_client, user_id, now = new Date(), reset_day = 1) {
    const from = _utc_day(period_start(now, reset_day));
    const to = _utc_day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    let rows;
    try {
        rows = await usage_client.usage_rows({ from, to, group_by: 'user' });
    } catch (error) {
        if (error.status !== 400) throw error;
        rows = await usage_client.usage_rows({ from, to });
        return _sum_credits(Array.isArray(rows) ? rows : [], row => row.createdBy === user_id);
    }
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.some(row => row.usageUserId !== undefined && row.usageUserId !== null)) {
        rows = await usage_client.usage_rows({ from, to });
        return _sum_credits(Array.isArray(rows) ? rows : [], row => row.createdBy === user_id);
    }
    return _sum_credits(rows, row => row.usageUserId === user_id);
}

class MonthCredits {
    constructor({ client, usage_client = client, settings, now = () => new Date(), refresh_ms = 60_000 }) {
        Object.assign(this, { client, usage_client, settings, now, refresh_ms });
        this._user_id = null;
        this._cached = { used: null, error: null, period_start: null };
        this._last_refresh = null;
        this._in_flight = null;
        this._generation = 0;
    }

    status() {
        let quota = 0;
        try {
            const value = Number((this.settings() || {}).quota);
            quota = Number.isFinite(value) ? value : 0;
        } catch (_) {
            quota = 0;
        }
        return { used: this._cached.used, quota, error: this._cached.error, period_start: this._cached.period_start };
    }

    async refresh(force = false) {
        if (this._in_flight) return this._in_flight;
        const started = _now_ms(this.now);
        if (!force && this._last_refresh !== null && started - this._last_refresh < this.refresh_ms) return this.status();

        const generation = this._generation;
        const refresh_promise = (async () => {
            let settings;
            try {
                settings = this.settings() || {};
                const now = this.now();
                const start = period_start(now, settings.reset_day);
                if (generation === this._generation) this._cached.period_start = start.toISOString().slice(0, 10);
                if (!this._user_id) this._user_id = (await this.client.me()).id;
                const used = await month_credits(this.usage_client, this._user_id, now, settings.reset_day);
                if (generation === this._generation) this._cached = { used, error: null, period_start: start.toISOString().slice(0, 10) };
            } catch (error) {
                const message = error && error.status === 401
                    ? 'API key rejected (401). Ctrl+click Month to enter it again.'
                    : error && error.status === 403
                        ? 'admin rights needed to read your credit usage'
                        : String(error && error.message ? error.message : error).slice(0, 160);
                if (generation === this._generation) this._cached = { used: null, error: message, period_start: this._cached.period_start };
            } finally {
                if (generation === this._generation) this._last_refresh = _now_ms(this.now);
            }
            return this.status();
        })();
        this._in_flight = refresh_promise;
        try {
            return await refresh_promise;
        } finally {
            if (this._in_flight === refresh_promise) this._in_flight = null;
        }
    }

    reset() {
        this._generation++;
        this._user_id = null;
        this._cached = { used: null, error: null, period_start: null };
        this._last_refresh = null;
        this._in_flight = null;
    }
}

module.exports = { period_start, month_credits, MonthCredits };
