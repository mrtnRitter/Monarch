(function (root) {
    const api = {
        equal_sizes(count) {
            return count > 0 ? Array.from({ length: count }, () => 1 / count) : [];
        },
        input_empty_lines(value) {
            if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
            return Math.min(10, Math.max(1, Math.round(value)));
        },
        auto_input_height({ text_px, line_px, base_px, max_px, empty_lines }) {
            return Math.round(Math.min(max_px, Math.max(base_px, text_px + empty_lines * line_px)));
        },
        drag_split(sizes, index, delta_px, total_px, min_px) {
            const next = sizes.slice();
            const first_px = sizes[index] * total_px;
            const second_px = sizes[index + 1] * total_px;
            const pair_px = first_px + second_px;
            if (pair_px < 2 * min_px) return next;
            const updated_first_px = Math.min(pair_px - min_px, Math.max(min_px, first_px + delta_px));
            next[index] = updated_first_px / total_px;
            next[index + 1] = (pair_px - updated_first_px) / total_px;
            return next;
        },
        insert_index(count, position) {
            return position === 'left' ? 0 : count;
        },
        next_active(ids, removed_id, active_id) {
            const remaining = ids.filter(id => id !== removed_id);
            if (remaining.length === 0) return null;
            if (active_id !== removed_id && remaining.includes(active_id)) return active_id;
            const removed_index = ids.indexOf(removed_id);
            return removed_index > 0 ? remaining[removed_index - 1] : remaining[0];
        },
    };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.monarch_layout = api;
})(this);
