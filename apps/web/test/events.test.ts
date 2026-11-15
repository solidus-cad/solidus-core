import { expect, test } from "vitest";
import { emit, onEvent } from "../src/events.ts";

test("bus: timestamps, failing subscriber isolated, replay for late subscribers", () => {
  const seen: string[] = [];
  const stopBad = onEvent(() => {
    throw new Error("abonné cassé");
  });
  const stop = onEvent((e) => seen.push(e.type));
  emit({ type: "undo" });
  emit({ type: "redo" });
  expect(seen).toEqual(["undo", "redo"]);

  const late: string[] = [];
  const stopLate = onEvent((e) => late.push(e.type), { replay: true });
  expect(late.slice(-2)).toEqual(["undo", "redo"]);
  stop();
  stopBad();
  stopLate();
  emit({ type: "undo" });
  expect(seen).toHaveLength(2);
});
