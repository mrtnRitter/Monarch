(function (root) {
    const api = {
        time_text(ms) {
            return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        },
        date_text(ms) {
            return new Date(ms).toLocaleDateString([], { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
        },
        day_key(ms) {
            const date = new Date(ms);
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        },
        divider_for(last_day, created) {
            if (typeof created !== 'number' || !Number.isFinite(created)) return { divider: null, last_day };
            const key = api.day_key(created);
            return { divider: last_day && last_day !== key ? api.date_text(created) : null, last_day: key };
        },
    };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.monarch_time = api;
})(this);
