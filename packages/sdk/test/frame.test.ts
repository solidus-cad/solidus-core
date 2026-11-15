import { describe, expect, it } from "vitest";
import { cutList, layoutFrame, nodeKey, type FrameAnchor, type FrameSegment, type FrameStep, type JointSetting } from "../src/frame.ts";
import type { V3 } from "../src/sketch3d.ts";

const seg = (key: string, a: V3, b: V3): FrameSegment => ({ key, a, b });

function step(id: string, segments: FrameSegment[], opts: Partial<Omit<FrameStep, "data">> & { joints?: Record<string, JointSetting> } = {}): FrameStep {
  return {
    id,
    family: opts.family ?? "squareTube",
    size: opts.size ?? "40x3",
    rotation: opts.rotation ?? 0,
    anchor: (opts.anchor ?? "c") as FrameAnchor,
    corner: opts.corner ?? "miter",
    data: { segments: segments.map((s) => s.key), paths: segments, joints: opts.joints ?? {} },
  };
}

/** 1000 × 500 frame in XY, traversed counterclockwise. */
const rectangle = () => [
  seg("f1", [0, 0, 0], [1000, 0, 0]),
  seg("f2", [1000, 0, 0], [1000, 500, 0]),
  seg("f3", [1000, 500, 0], [0, 500, 0]),
  seg("f4", [0, 500, 0], [0, 0, 0]),
];

const byKey = (l: ReturnType<typeof layoutFrame>) => Object.fromEntries(l.map((m) => [m.key, m]));

describe("layoutFrame — tabs", () => {
  it("frame centered on the lines: overall length = line + width, 45° cuts", () => {
    const m = byKey(layoutFrame([step("s1", rectangle())]));
    expect(m.f1!.length).toBeCloseTo(1040, 6);
    expect(m.f2!.length).toBeCloseTo(540, 6);
    expect(m.f1!.angleStart).toBe(45);
    expect(m.f1!.angleEnd).toBe(45);
  });

  it("alignment: profile inside the frame → overall length = dimension of the line", () => {
    const m = byKey(layoutFrame([step("s1", rectangle(), { anchor: "w" })]));
    expect(m.f1!.length).toBeCloseTo(1000, 6);
    expect(m.f2!.length).toBeCloseTo(500, 6);
  });
});

describe("layoutFrame — butt joint", () => {
  const L = () => [seg("a", [0, 0, 0], [1000, 0, 0]), seg("b", [1000, 0, 0], [1000, 500, 0])];
  const joint = (j: Partial<JointSetting>) => ({ [nodeKey(["a", "b"])]: { type: "butt", trim: "outer", overhang: 0, gap: 0, ...j } as JointSetting });

  it("through profile flush on the outside, butting profile stopped on its face", () => {
    const m = byKey(layoutFrame([step("s", L(), { joints: joint({}) })]));
    expect(m.a!.length).toBeCloseTo(1020, 6);
    expect(m.b!.length).toBeCloseTo(480, 6);
    expect(m.a!.angleEnd).toBe(0);
    expect(m.b!.angleStart).toBe(0);
  });

  it("flush at the axis or inside, overhang, gap", () => {
    expect(byKey(layoutFrame([step("s", L(), { joints: joint({ trim: "axis" }) })])).a!.length).toBeCloseTo(1000, 6);
    expect(byKey(layoutFrame([step("s", L(), { joints: joint({ trim: "inner" }) })])).a!.length).toBeCloseTo(980, 6);
    expect(byKey(layoutFrame([step("s", L(), { joints: joint({ overhang: 10 }) })])).a!.length).toBeCloseTo(1030, 6);
    expect(byKey(layoutFrame([step("s", L(), { joints: joint({ gap: 2 }) })])).b!.length).toBeCloseTo(478, 6);
  });

  it("choice of the through profile", () => {
    const m = byKey(layoutFrame([step("s", L(), { joints: joint({ through: "b" }) })]));
    expect(m.a!.length).toBeCloseTo(980, 6);
    expect(m.b!.length).toBeCloseTo(520, 6);
  });

  it("default corner for butt joints: the first profile passes through", () => {
    const m = byKey(layoutFrame([step("s", L(), { corner: "butt" })]));
    expect(m.a!.length).toBeCloseTo(1020, 6);
    expect(m.b!.length).toBeCloseTo(480, 6);
  });
});

describe("layoutFrame — stop on profiles already placed", () => {
  it("the posts of a second step stop under the frame, which does not change", () => {
    const posts = [seg("p1", [0, 0, -800], [0, 0, 0]), seg("p2", [500, 0, -800], [500, 0, 0])];
    const m = byKey(layoutFrame([step("s1", rectangle()), step("s2", posts)]));
    expect(m.f1!.length).toBeCloseTo(1040, 6);
    expect(m.p1!.length).toBeCloseTo(780, 6);
    expect(m.p2!.length).toBeCloseTo(780, 6);
  });

  it("T start within the same step", () => {
    const m = byKey(layoutFrame([step("s", [seg("a", [0, 0, 0], [1000, 0, 0]), seg("t", [500, 0, 0], [500, 300, 0])])]));
    expect(m.a!.length).toBeCloseTo(1000, 6);
    expect(m.t!.length).toBeCloseTo(280, 6);
  });
});

describe("section rotation", () => {
  it("rectangular tube lying flat or standing", () => {
    const L = () => [seg("a", [0, 0, 0], [1000, 0, 0]), seg("b", [1000, 0, 0], [1000, 500, 0])];
    const j = { [nodeKey(["a", "b"])]: { type: "butt", trim: "outer", overhang: 0, gap: 0 } as JointSetting };
    // 80×40: width 40 in the plane (u), height 80 vertical; rotated by 90°, width 80 in the plane.
    expect(byKey(layoutFrame([step("s", L(), { family: "rectTube", size: "80x40x3", joints: j })])).a!.length).toBeCloseTo(1020, 6);
    expect(byKey(layoutFrame([step("s", L(), { family: "rectTube", size: "80x40x3", rotation: 90, joints: j })])).a!.length).toBeCloseTo(1040, 6);
  });
});

describe("cutList", () => {
  it("groups identical profiles", () => {
    const posts = [0, 1000].flatMap((x) => [0, 500].map((y) => seg(`p${x}${y}`, [x, y, -800] as V3, [x, y, 0] as V3)));
    const rows = cutList(layoutFrame([step("s1", rectangle()), step("s2", posts)]));
    expect(rows.map((r) => [r.length, r.quantity, r.angleA])).toEqual([
      [1040, 2, 45],
      [780, 4, 0],
      [540, 2, 45],
    ]);
    expect(rows.map((r) => r.mark)).toEqual([1, 2, 3]);
    // Tube 40×3: area 40² − 34² = 444 mm²; 1040 mm of steel → 3.62 kg.
    expect(rows[0]!.mass).toBeCloseTo((444 * 1040 * 7.85) / 1e6, 6);
  });
});
