import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/plugins/registry.ts";

describe("contribution registry", () => {
  it("adds, replaces and removes while notifying subscribers", () => {
    const r = createRegistry<{ id: string; v: number }>([{ id: "a", v: 1 }]);
    const events: string[] = [];
    r.subscribe((added, removed) => events.push(`+${added.map((x) => x.id + x.v).join()} -${removed.map((x) => x.id + x.v).join()}`));

    const undo = r.add({ id: "b", v: 1 });
    expect(r.list().map((x) => x.id)).toEqual(["a", "b"]);

    r.add({ id: "a", v: 2 });
    expect(r.get("a")?.v).toBe(2);

    undo();
    expect(r.get("b")).toBeUndefined();
    expect(events).toEqual(["+b1 -", "+a2 -a1", "+ -b1"]);
  });

  it("the removal function ignores an element replaced since", () => {
    const r = createRegistry<{ id: string; v: number }>();
    const undo = r.add({ id: "x", v: 1 });
    r.add({ id: "x", v: 2 });
    undo();
    expect(r.get("x")?.v).toBe(2);
  });
});
