import { describe, expect, test, vi } from "vitest";
import { describeEvent, formatTimeline, Journal, persistJournal, type KeyValueStore } from "../src/bugreport/journal.ts";

const memStore = (init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe("Journal", () => {
  test("keeps only the latest events", () => {
    const j = new Journal(3);
    for (let i = 0; i < 5; i++) j.record("click", "b" + i);
    expect(j.events.map((e) => e.text)).toEqual(["b2", "b3", "b4"]);
  });

  test("groups immediate repetitions", () => {
    const j = new Journal();
    j.record("error", "boom");
    j.record("error", "boom");
    j.record("error", "boom");
    j.record("click", "OK");
    j.record("error", "boom");
    expect(j.events.map((e) => e.text)).toEqual(["boom ×3", "OK", "boom"]);
  });

  test("counts the errors up to the report", () => {
    const j = new Journal();
    const seen = vi.fn();
    j.onChange(seen);
    j.record("error", "a");
    j.record("warn", "b");
    j.record("error", "c");
    expect(j.errorsSinceReport).toBe(2);
    j.markReported();
    expect(j.errorsSinceReport).toBe(0);
    expect(seen).toHaveBeenCalledTimes(4);
  });

  test("truncates texts that are too long", () => {
    const j = new Journal();
    j.record("message", "x".repeat(1000));
    expect(j.events[0]!.text.length).toBe(300);
  });
});

describe("persistJournal", () => {
  test("the current session becomes the previous session at startup", () => {
    const store = memStore({ "cad.journal": JSON.stringify([{ t: 1, kind: "error", text: "plantage" }]) });
    const { previous } = persistJournal(new Journal(), store);
    expect(previous.map((e) => e.text)).toEqual(["plantage"]);
    expect(store.data["cad.journal"]).toBe("[]");
    expect(JSON.parse(store.data["cad.journal.prev"]!)).toHaveLength(1);
  });

  test("an error is written immediately, the rest deferred", () => {
    vi.useFakeTimers();
    const store = memStore();
    const j = new Journal();
    persistJournal(j, store, 1000);
    j.record("click", "OK");
    expect(store.data["cad.journal"]).toBe("[]");
    j.record("error", "boom");
    expect(JSON.parse(store.data["cad.journal"]!)).toHaveLength(2);
    j.record("click", "Annuler");
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(store.data["cad.journal"]!)).toHaveLength(3);
    vi.useRealTimers();
  });

  test("corrupted storage: no previous session", () => {
    expect(persistJournal(new Journal(), memStore({ "cad.journal": "{pas du json" })).previous).toEqual([]);
  });
});

test("formatTimeline: one line per event, indented detail", () => {
  const t = new Date(2026, 0, 1, 9, 5, 7, 42).getTime();
  const out = formatTimeline([
    { t, kind: "command", text: "Extrusion [part.extrude]" },
    { t, kind: "error", text: "TypeError: x", detail: "at a\nat b" },
  ]);
  expect(out).toBe("09:05:07.042  CMD   Extrusion [part.extrude]\n09:05:07.042  ERR   TypeError: x\n      at a\n      at b");
});

describe("describeEvent", () => {
  const t = 0;
  test("commands: menu and shortcut", () => {
    expect(describeEvent({ t, type: "command", id: "view.fit", label: "Zoom ajusté", via: "ui" })).toEqual({ kind: "command", text: "Zoom ajusté [view.fit]" });
    expect(describeEvent({ t, type: "command", id: "view.fit", label: "Zoom ajusté", via: "key", combo: "F" })!.text).toBe("F → Zoom ajusté [view.fit]");
  });
  test("the feature search (typed text) does not enter the journal", () => {
    expect(describeEvent({ t, type: "search", query: "congé", results: 0 })).toBeNull();
  });
  test("library requests: failures only", () => {
    expect(describeEvent({ t, type: "library.request", method: "GET", path: "/search", status: 200, ms: 12 })).toBeNull();
    expect(describeEvent({ t, type: "library.request", method: "GET", path: "/search", status: 0, ms: 12 })).toEqual({ kind: "warn", text: "Bibliothèque : GET /search → réseau (12 ms)" });
  });
  test("error: stack in detail", () => {
    expect(describeEvent({ t, type: "error", source: "rejection", message: "x", stack: "at y" })).toEqual({ kind: "error", text: "Promesse rejetée : x", detail: "at y" });
  });
});
