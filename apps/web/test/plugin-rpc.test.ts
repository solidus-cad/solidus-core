import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_METHODS, createEndpoint, type Endpoint, type RpcPort } from "../src/plugins/rpc.ts";
import { workerMain } from "../src/plugins/sandbox-runtime.ts";

const open: { close(): void }[] = [];
afterEach(() => {
  for (const p of open.splice(0)) p.close();
});

function pair(a: (m: string, args: unknown[]) => unknown, b: (m: string, args: unknown[]) => unknown): [Endpoint, Endpoint] {
  const ch = new MessageChannel();
  open.push(ch.port1, ch.port2);
  return [createEndpoint(ch.port1 as unknown as RpcPort, a), createEndpoint(ch.port2 as unknown as RpcPort, b)];
}

describe("sandboxed plugin RPC", () => {
  it("calls, returns the values and relays the functions passed as arguments", async () => {
    let saved: (() => Promise<unknown>) | null = null;
    const [host, worker] = pair(
      (m, args) => {
        if (m === "commands.register") saved = (args[0] as { run: () => Promise<unknown> }).run;
        return { ok: m, n: args.length };
      },
      () => undefined,
    );
    let ran = 0;
    expect(await worker.request("commands.register", [{ id: "x", run: () => ++ran }])).toEqual({ ok: "commands.register", n: 1 });
    expect(await saved!()).toBe(1);
    expect(ran).toBe(1);
    expect(host).toBeTruthy();
  });

  it("propagates errors, respects timeouts and rejects after closing", async () => {
    const [host, worker] = pair(
      () => undefined,
      (m) => {
        if (m === "boom") throw new Error("cassé");
        return new Promise(() => {});
      },
    );
    await expect(host.request("boom", [])).rejects.toThrow("cassé");
    await expect(host.request("hang", [], 50)).rejects.toThrow(/délai dépassé/);
    const pending = host.request("hang", []);
    host.close("arrêt");
    await expect(pending).rejects.toThrow("arrêt");
    expect(worker).toBeTruthy();
  });

  it("the code injected into the Worker is self-contained", async () => {
    // Recompiled outside its module: fails if a function references an external declaration.
    const src = `const createEndpoint = ${createEndpoint.toString()}; return [createEndpoint, (${workerMain.toString()})];`;
    const [ce, wm] = new Function(src)() as [typeof createEndpoint, typeof workerMain];
    expect(typeof ce).toBe("function");
    expect(typeof wm).toBe("function");
    const ch = new MessageChannel();
    open.push(ch.port1, ch.port2);
    const a = ce(ch.port1 as unknown as RpcPort, () => undefined);
    ce(ch.port2 as unknown as RpcPort, (_m, args) => (args[0] as () => number)());
    expect(await a.request("x", [() => 42])).toBe(42);
    expect(CONTEXT_METHODS).toContain("commands.register");
  });
});
