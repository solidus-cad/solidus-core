/**
 * Symmetric RPC over a MessagePort, between the application and the Worker of a sandboxed plugin.
 *
 * Each side can call a method of the other (`request`) and responds to the calls it receives (`handle`).
 * Functions passed as arguments (e.g. `run` of a command) are replaced by a `{ __cb: n }` marker;
 * the other side receives a function that calls back the original via RPC.
 *
 * IMPORTANT: `createEndpoint` is also injected as is into the Worker (`Function.prototype.toString`):
 * it must remain self-contained (no reference to an import or to another declaration of the module).
 */

export interface RpcPort {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

export interface Endpoint {
  request(method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  /** Rejects pending calls; no further message is processed. */
  close(reason: string): void;
}

export function createEndpoint(port: RpcPort, handle: (method: string, args: unknown[]) => unknown): Endpoint {
  type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> };
  const pending = new Map<number, Pending>();
  const callbacks = new Map<number, (...a: unknown[]) => unknown>();
  let seq = 0;
  let cbSeq = 0;
  let closed = false;

  const isPlain = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== "object") return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };

  const encode = (v: unknown): unknown => {
    if (typeof v === "function") {
      const id = ++cbSeq;
      callbacks.set(id, v as (...a: unknown[]) => unknown);
      return { __cb: id };
    }
    if (Array.isArray(v)) return v.map(encode);
    if (isPlain(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) out[k] = encode(v[k]);
      return out;
    }
    return v;
  };

  const decode = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(decode);
    if (isPlain(v)) {
      if (typeof v.__cb === "number" && Object.keys(v).length === 1) {
        const id = v.__cb;
        return (...a: unknown[]) => request("__cb", [id, ...a]);
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) out[k] = decode(v[k]);
      return out;
    }
    return v;
  };

  const post = (m: unknown) => {
    if (!closed) port.postMessage(m);
  };

  function request(method: string, args: unknown[], timeoutMs = 0): Promise<unknown> {
    if (closed) return Promise.reject(new Error("plugin arrêté"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject };
      if (timeoutMs > 0)
        p.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`délai dépassé (${method})`));
        }, timeoutMs);
      pending.set(id, p);
      post({ t: "req", id, method, args: encode(args) });
    });
  }

  port.onmessage = async (e: MessageEvent) => {
    const m = e.data as { t?: string; id?: number; method?: string; args?: unknown; ok?: boolean; value?: unknown; error?: string };
    if (closed || !m || typeof m.id !== "number") return;
    if (m.t === "req") {
      try {
        const args = decode(Array.isArray(m.args) ? m.args : []) as unknown[];
        let value: unknown;
        if (m.method === "__cb") {
          const fn = callbacks.get(args[0] as number);
          if (!fn) throw new Error("rappel inconnu");
          value = await fn(...args.slice(1));
        } else value = await handle(String(m.method), args);
        post({ t: "res", id: m.id, ok: true, value: encode(value) });
      } catch (err) {
        post({ t: "res", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (m.t === "res") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.ok) p.resolve(decode(m.value));
      else p.reject(new Error(String(m.error)));
    }
  };

  return {
    request,
    close(reason) {
      closed = true;
      port.onmessage = null;
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      pending.clear();
      callbacks.clear();
    },
  };
}

/** Methods of the `PluginContext` accessible via RPC (path within the context). */
export const CONTEXT_METHODS = [
  "lang",
  "commands.register",
  "tabs.register",
  "features.define",
  "document.kind",
  "document.part",
  "document.beginFeature",
  "document.addFeature",
  "ui.notify",
  "ui.form",
  "storage.get",
  "storage.set",
  "fetch",
] as const;
