import type { PluginManifest } from "@solidus-cad/sdk";
import type { HostApi } from "./host.ts";
import { CONTEXT_METHODS, createEndpoint } from "./rpc.ts";
import { workerMain } from "./sandbox-runtime.ts";

/**
 * Sandbox host (unverified publishers).
 *
 * The plugin runs in a Worker created by an isolated `srcdoc` iframe:
 * - `sandbox="allow-scripts"`: opaque origin, no access to the DOM, storage or cookies of the application;
 * - iframe CSP, inherited by the Worker: no network connection (`connect-src` absent → 'none'),
 *   scripts only from blobs (no remote import, no eval);
 * - classic Worker (a module Worker does not load from an opaque origin); the plugin itself is a module
 *   loaded by `import()`; an infinite loop does not block the interface, and removing the iframe stops the Worker.
 * The application talks directly to the Worker through a MessageChannel; only the context methods
 * (CONTEXT_METHODS) are exposed, and the host checks the manifest's permissions.
 */

const IFRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:";

const BOOTSTRAP = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}"><script>
addEventListener("message", (e) => {
  if (e.source !== parent || !e.data || typeof e.data.source !== "string" || !e.ports[0]) return;
  const w = new Worker(URL.createObjectURL(new Blob([e.data.source], { type: "text/javascript" })));
  w.postMessage(null, [e.ports[0]]);
}, { once: true });
</script>`;

/** Worker text: standalone RPC and program; an `import()` written here escapes the bundler's rewriting. */
const WORKER_SOURCE = `const createEndpoint = ${createEndpoint.toString()};
(${workerMain.toString()})(createEndpoint, ${JSON.stringify(CONTEXT_METHODS)}, (u) => import(u));
`;

/** Activation delay (module loading and `activate`). */
const ACTIVATE_MS = 10_000;
const DEACTIVATE_MS = 3_000;

export interface SandboxHandle {
  stop(): Promise<void>;
}

/** Resolves an "a.b" path of the context (allowed method only). */
function method(host: HostApi, path: string): (...a: unknown[]) => unknown {
  if (!(CONTEXT_METHODS as readonly string[]).includes(path)) throw new Error(`méthode non autorisée : ${path}`);
  let o: unknown = host.ctx;
  for (const p of path.split(".")) o = (o as Record<string, unknown>)[p];
  if (typeof o !== "function") throw new Error(`méthode inconnue : ${path}`);
  return o as (...a: unknown[]) => unknown;
}

export async function startSandbox(manifest: PluginManifest, code: string, host: HostApi): Promise<SandboxHandle> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("aria-hidden", "true");
  iframe.dataset.plugin = manifest.id;
  iframe.style.display = "none";
  iframe.srcdoc = BOOTSTRAP;
  const loaded = new Promise<void>((resolve) => iframe.addEventListener("load", () => resolve(), { once: true }));
  document.body.append(iframe);
  await loaded;

  const channel = new MessageChannel();
  const ep = createEndpoint(channel.port1, (path, args) => method(host, path)(...args));
  let stopped = false;
  const kill = (reason: string) => {
    if (stopped) return;
    stopped = true;
    ep.close(reason);
    channel.port1.close();
    iframe.remove();
  };

  iframe.contentWindow!.postMessage({ source: WORKER_SOURCE }, "*", [channel.port2]);
  try {
    await ep.request("init", [manifest, code], ACTIVATE_MS);
  } catch (e) {
    kill("plugin arrêté");
    throw e;
  }

  return {
    async stop() {
      if (stopped) return;
      try {
        await ep.request("deactivate", [], DEACTIVATE_MS);
      } catch {
        /* plugin blocked or in error: stopped anyway */
      }
      kill("plugin arrêté");
    },
  };
}
