import type { AppEvent, StampedEvent } from "@solidus-cad/sdk";

/**
 * Application event bus (types: @solidus-cad/sdk, events.ts). Publication is synchronous; a subscriber that throws
 * does not prevent the others from being called, and the exception does not propagate to the caller.
 */
const listeners = new Set<(e: StampedEvent) => void>();
/** Recent events, replayed to late subscribers that request it (extensions activated after startup). */
const recent: StampedEvent[] = [];
const RECENT_MAX = 200;

export function emit(e: AppEvent): void {
  const stamped = { ...e, t: Date.now() } as StampedEvent;
  recent.push(stamped);
  if (recent.length > RECENT_MAX) recent.shift();
  for (const l of listeners) {
    try {
      l(stamped);
    } catch {
      /* failing subscriber: ignored (no console.error, which would republish an event) */
    }
  }
}

export function onEvent(listener: (e: StampedEvent) => void, opts?: { replay?: boolean }): () => void {
  if (opts?.replay)
    for (const e of recent.slice()) {
      try {
        listener(e);
      } catch {
        /* same */
      }
    }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
