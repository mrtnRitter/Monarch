(function (root) {
    const api = {
        at_bottom({ scroll_top, scroll_height, client_height }, threshold = 24) {
            return scroll_height - client_height - scroll_top <= threshold;
        },
        answer_target({ scroll_height, client_height, top }) {
            const bottom = Math.max(0, scroll_height - client_height);
            if (scroll_height - top <= client_height) return bottom;
            return Math.min(bottom, Math.max(0, Math.round(top - client_height / 6)));
        },
        reached(avatar_top, indicator_top) {
            return avatar_top <= indicator_top;
        },
    };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.monarch_scroll = api;
})(this);
