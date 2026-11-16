// Serialize settings writes, coalescing further edits while a request is in flight.
// A response only confirms the revision actually sent, never newer UI changes.
export function createSaveQueue({ persist, isCurrent = () => true, onPending = () => {}, onSaved = () => {}, onError = () => {} }) {
    const states = new Map(), pending = new Map();
    let running = false;
    const settle = (state, error) => {
        for (const waiter of state.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve();
    };
    async function drain() {
        if (running) return;
        running = true;
        try {
            while (pending.size) {
                const [owner, state] = pending.entries().next().value;
                const revision = state.requested;
                try {
                    if (!isCurrent(owner)) {
                        const error = new Error('预设已经切换，未将后台修改写入其他预设。');
                        error.code = 'STALE_SETTINGS_CONTEXT';
                        throw error;
                    }
                    await persist(owner);
                    if (states.get(owner) !== state) continue;
                    state.confirmed = revision;
                    if (state.requested === revision) {
                        pending.delete(owner);
                        onSaved(owner);
                        settle(state);
                    }
                } catch (error) {
                    if (states.get(owner) !== state) continue;
                    pending.delete(owner);
                    state.error = error;
                    onError(owner, error);
                    settle(state, error);
                }
            }
        } finally { running = false; }
    }
    return {
        request(owner) {
            let state = states.get(owner);
            if (!state) { state = { requested:0, confirmed:0, error:null, waiters:[] }; states.set(owner,state); }
            state.requested++;
            state.error = null;
            pending.set(owner,state);
            onPending(owner);
            void drain();
        },
        wait(owner) {
            const state = states.get(owner);
            if (!state || state.confirmed === state.requested) return Promise.resolve();
            if (state.error) return Promise.reject(state.error);
            return new Promise((resolve,reject) => state.waiters.push({resolve,reject}));
        },
        cancel(owner) {
            const state = states.get(owner);
            pending.delete(owner); states.delete(owner);
            if (state) settle(state,new Error('已放弃这次待保存修改。'));
        },
        isPending(owner) {
            const state = states.get(owner);
            return Boolean(state && state.confirmed < state.requested);
        },
    };
}
