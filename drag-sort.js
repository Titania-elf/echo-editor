// Pointer-event sorting, shared by the real editor and its interaction sketch.
// Touch scrolling remains native everywhere except the dedicated drag handle.
export function createDragSorter({ container, rowSelector, handleSelector, getId, scroller, ghostHost, onCommit, canStart = () => true, onStart = () => {}, onEnd = () => {}, ghostClass = 'pmme-drag-ghost', placeholderClass = 'pmme-drag-placeholder' }) {
    let state = null, frame = 0, destroyed = false;
    const rows = () => [...container.querySelectorAll(rowSelector)].filter(row => !row.classList.contains(ghostClass));
    const ids = () => rows().map(getId);
    const scrollElement = () => typeof scroller === 'function' ? scroller() : scroller || container;

    function restoreOrder(original) {
        const byId = new Map(rows().map(row => [getId(row), row]));
        for (const id of original) if (byId.has(id)) container.appendChild(byId.get(id));
    }
    function positionRow() {
        if (!state?.started) return;
        state.ghost.style.top = `${state.y - state.offsetY}px`;
        const candidates = rows().filter(row => row !== state.row);
        const next = candidates.find(row => { const r = row.getBoundingClientRect(); return state.y < r.top + r.height / 2; });
        if (next) {
            if (state.row.nextElementSibling !== next) container.insertBefore(state.row, next);
        } else if (container.lastElementChild !== state.row) container.appendChild(state.row);
    }
    function animateScroll() {
        frame = 0;
        if (!state?.started) return;
        const scroll = scrollElement();
        const documentScroll = scroll === document.scrollingElement || scroll === document.documentElement || scroll === document.body;
        const rect = documentScroll ? {top:0,bottom:window.innerHeight,height:window.innerHeight} : scroll.getBoundingClientRect();
        const zone = Math.min(64, rect.height / 4);
        const distance = state.y < rect.top + zone ? state.y - rect.top - zone : state.y > rect.bottom - zone ? state.y - rect.bottom + zone : 0;
        if (distance) scroll.scrollTop += Math.sign(distance) * Math.min(15, Math.max(2, Math.abs(distance) / 5));
        positionRow();
        frame = requestAnimationFrame(animateScroll);
    }
    function start() {
        if (!state || state.started) return;
        state.started = true;
        const rect = state.row.getBoundingClientRect();
        state.offsetY = state.startY - rect.top;
        state.ghost = state.row.cloneNode(true);
        state.ghost.removeAttribute('id');
        state.ghost.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
        state.ghost.classList.add(ghostClass);
        state.ghost.setAttribute('aria-hidden', 'true');
        state.ghost.querySelectorAll('button').forEach(button => { button.tabIndex = -1; });
        Object.assign(state.ghost.style, { position:'fixed', left:`${rect.left}px`, top:`${rect.top}px`, width:`${rect.width}px`, pointerEvents:'none', margin:'0', zIndex:'25000' });
        (ghostHost || container).appendChild(state.ghost);
        state.row.classList.add(placeholderClass);
        state.oldUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        onStart(getId(state.row));
        frame = requestAnimationFrame(animateScroll);
    }
    function finish(cancelled) {
        if (!state) return;
        const ended = state; state = null;
        clearTimeout(ended.timer); cancelAnimationFrame(frame); frame = 0;
        if (ended.started) {
            if (cancelled) restoreOrder(ended.original);
            ended.ghost?.remove(); ended.row.classList.remove(placeholderClass);
            document.body.style.userSelect = ended.oldUserSelect;
        }
        if (container.hasPointerCapture?.(ended.pointerId)) container.releasePointerCapture(ended.pointerId);
        onEnd(cancelled);
        if (ended.started && !cancelled && !destroyed) {
            const next = ids();
            if (JSON.stringify(next) !== JSON.stringify(ended.original)) {
                Promise.resolve().then(() => onCommit(next, ended.original)).catch(error => {
                    console.error('[回声编辑台] 排序失败', error);
                    restoreOrder(ended.original);
                });
            }
        }
    }
    function down(event) {
        const handle = event.target.closest(handleSelector);
        if (!handle || !container.contains(handle) || state || !canStart() || event.isPrimary === false || event.button !== 0) return;
        const row = handle.closest(rowSelector); if (!row) return;
        event.preventDefault();
        state = { row, handle, pointerId:event.pointerId, original:ids(), startY:event.clientY, y:event.clientY, startX:event.clientX, started:false, timer:0 };
        // Capture on the stationary list, not the handle: moving its row would lose capture.
        container.setPointerCapture?.(event.pointerId);
        if (event.pointerType === 'mouse') start();
        else state.timer = setTimeout(start, 180);
    }
    function move(event) {
        if (!state || event.pointerId !== state.pointerId) return;
        event.preventDefault(); state.y = event.clientY;
        if (!state.started && Math.hypot(event.clientY-state.startY,event.clientX-state.startX)>6) { clearTimeout(state.timer); start(); }
        positionRow();
    }
    function up(event) { if (state && event.pointerId===state.pointerId) finish(false); }
    function cancel(event) { if (state && event.pointerId===state.pointerId) finish(true); }
    function click(event) { if (event.target.closest(handleSelector)) { event.preventDefault(); event.stopPropagation(); } }
    container.addEventListener('pointerdown',down);
    container.addEventListener('pointermove',move,{passive:false});
    container.addEventListener('pointerup',up);
    container.addEventListener('pointercancel',cancel);
    container.addEventListener('lostpointercapture',cancel);
    container.addEventListener('click',click,true);
    return { cancel:()=>finish(true), destroy(){destroyed=true;finish(true);container.removeEventListener('pointerdown',down);container.removeEventListener('pointermove',move);container.removeEventListener('pointerup',up);container.removeEventListener('pointercancel',cancel);container.removeEventListener('lostpointercapture',cancel);container.removeEventListener('click',click,true);} };
}
