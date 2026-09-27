// Lightweight processing indicator (§12): a status pill in the workspace,
// shown only while a long operation actually runs. `delay` avoids flashing
// on small, fast operations; hide always clears a pending show timer.
let timer = null;

function busyEl() {
    return document.getElementById('busy');
}

export function showBusy(text, delay = 0) {
    clearTimeout(timer);
    timer = null;
    const show = () => {
        timer = null;
        const el = busyEl();
        if (!el) return;
        const label = document.getElementById('busy-text');
        if (label) label.textContent = text;
        el.hidden = false;
    };
    if (delay > 0) timer = setTimeout(show, delay);
    else show();
}

export function hideBusy() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    const el = busyEl();
    if (el) el.hidden = true;
}
