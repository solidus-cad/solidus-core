import type { createEndpoint as CreateEndpoint } from "./rpc.ts";

/**
 * Program of the Worker of a sandboxed plugin. Injected as is (`Function.prototype.toString`) into a Worker
 * created by the isolated iframe (sandbox.ts): it must remain self-contained, with no import or reference to the rest of the module.
 *
 * The first message brings the MessagePort to the application; after that everything goes through RPC:
 * `importModule` is defined in the Worker text (an `import()` written here would be rewritten by the bundler).
 * `init(manifest, code)` loads the plugin module and activates it with a context whose every method is an RPC call.
 */
export function workerMain(createEndpoint: typeof CreateEndpoint, methods: readonly string[], importModule: (url: string) => Promise<unknown>): void {
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent) => void) | null;
  } & Record<string, unknown>;

  /**
   * Defense in depth: removes network and storage access from the Worker. The real barrier is the iframe's CSP
   * (connect-src 'none', script-src blob:), inherited by the Worker, and its opaque origin.
   */
  const lockdown = () => {
    const names = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "SharedWorker", "BroadcastChannel", "indexedDB", "caches", "WebTransport"];
    for (const n of names) {
      for (let o: object | null = self; o; o = Object.getPrototypeOf(o)) {
        try {
          if (Object.prototype.hasOwnProperty.call(o, n)) delete (o as Record<string, unknown>)[n];
        } catch {
          /* non-configurable property */
        }
      }
      try {
        Object.defineProperty(self, n, { value: undefined, configurable: false, writable: false });
      } catch {
        /* already locked */
      }
    }
  };

  scope.onmessage = (first: MessageEvent) => {
    const port = first.ports[0];
    if (!port) return;
    scope.onmessage = null;
    let plugin: { activate(ctx: unknown): unknown; deactivate?(): unknown } | null = null;

    const ep = createEndpoint(port as unknown as Parameters<typeof createEndpoint>[0], async (method, args) => {
      if (method === "init") {
        const [manifest, code] = args as [unknown, string];
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        lockdown();
        const mod = (await importModule(url)) as { default?: typeof plugin };
        URL.revokeObjectURL(url);
        if (!mod.default || typeof mod.default.activate !== "function") throw new Error("export par défaut definePlugin({ activate }) attendu");
        plugin = mod.default;
        // Context: each method is an RPC call to the application.
        const ctx: Record<string, unknown> = { manifest };
        for (const path of methods) {
          const parts = path.split(".");
          let o = ctx;
          for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
          o[parts[parts.length - 1]!] = (...a: unknown[]) => ep.request(path, a);
        }
        await plugin.activate(ctx);
        return true;
      }
      if (method === "deactivate") {
        await plugin?.deactivate?.();
        return true;
      }
      throw new Error(`méthode inconnue : ${method}`);
    });
    port.start();
  };
}
