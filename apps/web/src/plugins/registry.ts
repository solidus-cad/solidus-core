import { createSignal } from "solid-js";

/**
 * Reactive registry of identified items (workbenches, tabs, commands): built-in workbenches and plugins
 * add their contributions, and remove them on deactivation.
 */
export interface Registry<T extends { id: string }> {
  /** Items in registration order (reactive). */
  list(): T[];
  get(id: string): T | undefined;
  /** Adds (or replaces) items; returns the function that removes them. */
  add(...items: T[]): () => void;
  remove(...ids: string[]): void;
  /** Called on each change, with the added and removed items. */
  subscribe(fn: (added: T[], removed: T[]) => void): () => void;
}

export function createRegistry<T extends { id: string }>(initial: T[] = []): Registry<T> {
  const items = new Map<string, T>(initial.map((x) => [x.id, x]));
  const [version, setVersion] = createSignal(0);
  const listeners = new Set<(added: T[], removed: T[]) => void>();
  const notify = (added: T[], removed: T[]) => {
    setVersion((v) => v + 1);
    for (const fn of listeners) fn(added, removed);
  };
  const remove = (...ids: string[]) => {
    const removed = ids.map((id) => items.get(id)).filter((x): x is T => !!x);
    if (!removed.length) return;
    for (const x of removed) items.delete(x.id);
    notify([], removed);
  };
  return {
    list: () => (version(), [...items.values()]),
    get: (id) => (version(), items.get(id)),
    add(...added) {
      const replaced = added.map((x) => items.get(x.id)).filter((x): x is T => !!x);
      for (const x of added) items.set(x.id, x);
      notify(added, replaced);
      // Only removes what has not been replaced since.
      return () => remove(...added.filter((x) => items.get(x.id) === x).map((x) => x.id));
    },
    remove,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
