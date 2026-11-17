// Pointer sorting for flat rows or nested, contiguous groups.
// Native touch scrolling remains available outside dedicated drag handles.
export function createDragSorter({
    container, rowSelector, handleSelector, getId, scroller, ghostHost, onCommit,
    canStart = () => true, onStart = () => {}, onEnd = () => {},
    getOrder = null, dropContainers = null, canDrop = () => true, onTargetChange = () => {}, decorateGhost = () => {},
    ghostClass = 'pmme-drag-ghost', placeholderClass = 'pmme-drag-placeholder', dropClass = 'pmme-drop-target',
}) {
    let state = null, frame = 0, destroyed = false;
    const rows = () => [...container.querySelectorAll(rowSelector)].filter(row => !row.classList.contains(ghostClass));
    const ids = () => getOrder ? [...getOrder()] : rows().map(getId);
    const scrollElement = () => typeof scroller === 'function' ? scroller() : scroller || container;

    function restoreRow(ended) {
        if (!ended.parent.isConnected || !ended.row.isConnected) return;
        ended.parent.insertBefore(ended.row, ended.next?.parentElement === ended.parent ? ended.next : null);
    }
    function setTarget(target) {
        if (!state || state.target === target) return;
        state.target?.classList.remove(dropClass);
        state.target = target;
        target?.classList.add(dropClass);
        onTargetChange(target, getId(state.row));
    }
    function targetAtPointer() {
        if (!dropContainers) return container;
        const targets = typeof dropContainers === 'function' ? dropContainers() : container.querySelectorAll(dropContainers);
        // DOM order visits parents before children: prefer the deepest visible container under the pointer.
        return [...targets].reverse().find(target => {
            if (state.row.contains(target) || !canDrop(state.row, target) || !target.getClientRects().length) return false;
            const rect = target.getBoundingClientRect();
            return state.x >= rect.left && state.x <= rect.right && state.y >= rect.top && state.y <= rect.bottom;
        }) || container;
    }
    function positionRow() {
        if (!state?.started) return;
        state.ghost.style.top = `${state.y - state.offsetY}px`;
        const target = targetAtPointer();
        if (state.row.contains(target) || !canDrop(state.row, target)) return;
        setTarget(target);
        const candidates = rows().filter(row => row !== state.row && row.parentElement === target);
        const next = candidates.find(row => { const rect = row.getBoundingClientRect(); return state.y < rect.top + rect.height / 2; });
        if (next) {
            if (state.row.nextElementSibling !== next || state.row.parentElement !== target) target.insertBefore(state.row, next);
        } else if (state.row.parentElement !== target || target.lastElementChild !== state.row) target.appendChild(state.row);
    }
    function animateScroll() {
        frame = 0;
        if (!state?.started) return;
        const scroll = scrollElement();
        const documentScroll = scroll === document.scrollingElement || scroll === document.documentElement || scroll === document.body;
        const rect = documentScroll ? { top:0, bottom:window.innerHeight, height:window.innerHeight } : scroll.getBoundingClientRect();
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
        state.ghost.querySelectorAll('button,input,select,textarea').forEach(control => { control.tabIndex = -1; });
        decorateGhost(state.ghost, state.row);
        Object.assign(state.ghost.style, { position:'fixed', left:`${rect.left}px`, top:`${rect.top}px`, width:`${rect.width}px`, pointerEvents:'none', margin:'0', zIndex:'25000' });
        (ghostHost || container).appendChild(state.ghost);
        state.row.classList.add(placeholderClass);
        state.oldUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        onStart(getId(state.row), state.original);
        frame = requestAnimationFrame(animateScroll);
    }
    function finish(cancelled) {
        if (!state) return;
        const ended = state; state = null;
        clearTimeout(ended.timer); cancelAnimationFrame(frame); frame = 0;
        ended.target?.classList.remove(dropClass);
        if (ended.started) {
            if (cancelled) restoreRow(ended);
            ended.ghost?.remove(); ended.row.classList.remove(placeholderClass);
            document.body.style.userSelect = ended.oldUserSelect;
        }
        if (container.hasPointerCapture?.(ended.pointerId)) container.releasePointerCapture(ended.pointerId);
        onTargetChange(null, getId(ended.row));
        onEnd(cancelled);
        if (ended.started && !cancelled && !destroyed) {
            const next = ids();
            if (JSON.stringify(next) !== JSON.stringify(ended.original)) {
                Promise.resolve().then(() => onCommit(next, ended.original)).catch(error => {
                    console.error('[回声编辑台] 排序失败', error);
                    restoreRow(ended);
                });
            }
        }
    }
    function down(event) {
        const handle = event.target instanceof Element ? event.target.closest(handleSelector) : null;
        if (!handle || !container.contains(handle) || state || event.isPrimary === false || event.button !== 0) return;
        const row = handle.closest(rowSelector);
        if (!row || !container.contains(row) || !canStart(row)) return;
        event.preventDefault();
        state = {
            row, handle, parent:row.parentElement, next:row.nextElementSibling, pointerId:event.pointerId, original:ids(),
            startY:event.clientY, y:event.clientY, x:event.clientX, startX:event.clientX, started:false, timer:0, target:null,
        };
        // Capture on the stationary root, not on a row that will change parent while sorting.
        container.setPointerCapture?.(event.pointerId);
        if (event.pointerType === 'mouse') start();
        else state.timer = setTimeout(start, 180);
    }
    function move(event) {
        if (!state || event.pointerId !== state.pointerId) return;
        event.preventDefault(); state.y = event.clientY; state.x = event.clientX;
        if (!state.started && Math.hypot(event.clientY - state.startY, event.clientX - state.startX) > 6) { clearTimeout(state.timer); start(); }
        positionRow();
    }
    function up(event) { if (state && event.pointerId === state.pointerId) finish(false); }
    function cancel(event) { if (state && event.pointerId === state.pointerId) finish(true); }
    function click(event) { if (event.target instanceof Element && event.target.closest(handleSelector)) { event.preventDefault(); event.stopPropagation(); } }
    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move, { passive:false });
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', cancel);
    container.addEventListener('lostpointercapture', cancel);
    container.addEventListener('click', click, true);
    return {
        cancel:() => finish(true),
        destroy() {
            destroyed = true; finish(true);
            container.removeEventListener('pointerdown', down);container.removeEventListener('pointermove', move);container.removeEventListener('pointerup', up);
            container.removeEventListener('pointercancel', cancel);container.removeEventListener('lostpointercapture', cancel);container.removeEventListener('click', click, true);
        },
    };
}
