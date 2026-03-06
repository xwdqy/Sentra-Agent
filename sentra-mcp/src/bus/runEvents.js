import { EventEmitter } from 'node:events';

// A lightweight per-run event bus to enable push-based streaming inside the process
// API:
// - RunEvents.emit(runId, event)
// - RunEvents.subscribe(runId) -> AsyncIterator yielding events
// - RunEvents.close(runId) -> cleanup emitter and listeners

const emitters = new Map(); // runId -> EventEmitter

function getOrCreate(runId) {
  if (!emitters.has(runId)) {
    const ee = new EventEmitter();
    // Increase max listeners to avoid warnings under high concurrency
    ee.setMaxListeners(1000);
    emitters.set(runId, ee);
  }
  return emitters.get(runId);
}

export const RunEvents = {
  emit(runId, event) {
    try {
      const ee = getOrCreate(runId);
      ee.emit('event', event);
    } catch { }
  },
  emitIfOpen(runId, event) {
    try {
      const rid = String(runId || '');
      if (!rid) return false;
      const ee = emitters.get(rid);
      if (!ee) return false;
      ee.emit('event', event);
      return true;
    } catch {
      return false;
    }
  },
  has(runId) {
    try {
      const rid = String(runId || '');
      if (!rid) return false;
      return emitters.has(rid);
    } catch {
      return false;
    }
  },
  // Returns an AsyncIterator of events for the given runId
  subscribe(runId) {
    const ee = getOrCreate(runId);
    const queue = [];
    const waiters = [];
    let closed = false;

    const onEvent = (ev) => {
      if (waiters.length) {
        const resolve = waiters.shift();
        resolve({ value: ev, done: false });
      } else {
        queue.push(ev);
      }
    };
    const onClose = () => {
      closed = true;
      while (waiters.length) {
        const resolve = waiters.shift();
        resolve({ value: undefined, done: true });
      }
    };

    ee.on('event', onEvent);
    ee.on('close', onClose);

    const iterator = {
      async next() {
        if (queue.length) return { value: queue.shift(), done: false };
        if (closed) return { value: undefined, done: true };
        return new Promise((resolve) => waiters.push(resolve));
      },
      async return() {
        try { ee.off('event', onEvent); } catch { }
        try { ee.off('close', onClose); } catch { }
        closed = true;
        while (waiters.length) {
          const resolve = waiters.shift();
          resolve({ value: undefined, done: true });
        }
        return { done: true };
      },
      [Symbol.asyncIterator]() { return this; },
    };

    return iterator;
  },
  close(runId) {
    const ee = emitters.get(runId);
    if (ee) {
      try { ee.emit('close'); } catch { }
      try { ee.removeAllListeners(); } catch { }
      emitters.delete(runId);
    }
  }
};

export default RunEvents;
