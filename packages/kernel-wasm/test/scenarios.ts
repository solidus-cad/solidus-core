import { createPartDocument, emptySketch, SKETCH_AXIS_V, SKETCH_ORIGIN, type Feature, type GeometryRecipe, type PartDocument, type SketchData } from "@solidus-cad/sdk";

/** Reference documents, computed by both kernels (parity) and by the benchmarks. */

export function doc(features: (Omit<Feature, "id" | "name"> & { id?: string })[], parameters: PartDocument["parameters"] = []): PartDocument {
  const d = createPartDocument("test");
  d.parameters = parameters;
  d.features = features.map((f, i) => ({ ...f, id: f.id ?? `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  return d;
}

export const block = { type: "box", params: { width: "L", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } };
export const hole = { type: "cylinder", params: { radius: "15", height: "40", x: "L / 2", y: "30", z: "0", axis: "z", op: "cut" } };
export const L = (v: number) => [{ name: "L", expr: String(v) }];
const L0 = 50;

/** Plugin feature with its recipe (or its error). */
export const recipe = (r?: GeometryRecipe, error?: string): Omit<Feature, "id" | "name"> => ({
  type: "com.exemple.test/forme",
  params: {},
  plugin: { id: "com.exemple.test", version: "1.0.0", ...(r ? { recipe: r } : {}), ...(error ? { error } : {}) },
});

/** w × h rectangle with one corner at the origin, plus an optional centered hole of radius r. */
export function rectSketch(w: string, h: string, r?: string): SketchData {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "b", type: "point", x: 10, y: 0 },
    { id: "c", type: "point", x: 10, y: 10 },
    { id: "d", type: "point", x: 0, y: 10 },
    { id: "l1", type: "line", p1: SKETCH_ORIGIN, p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
    { id: "l3", type: "line", p1: "c", p2: "d" },
    { id: "l4", type: "line", p1: "d", p2: SKETCH_ORIGIN },
  ];
  s.constraints = [
    { id: "h1", type: "horizontal", a: "l1" },
    { id: "h2", type: "horizontal", a: "l3" },
    { id: "v1", type: "vertical", a: "l2" },
    { id: "v2", type: "vertical", a: "l4" },
  ];
  s.dimensions = [
    { id: "dw", type: "distance", a: "l1", value: w, driving: true },
    { id: "dh", type: "distance", a: "l2", value: h, driving: true },
  ];
  if (r) {
    s.geometry.push({ id: "hc", type: "point", x: 5, y: 5 }, { id: "hole", type: "circle", c: "hc", r: 1 });
    s.dimensions.push(
      { id: "dr", type: "radius", a: "hole", value: r, driving: true },
      { id: "dx", type: "horizontalDistance", a: SKETCH_ORIGIN, b: "hc", value: `(${w}) / 2`, driving: true },
      { id: "dy", type: "verticalDistance", a: SKETCH_ORIGIN, b: "hc", value: `(${h}) / 2`, driving: true },
    );
  }
  return s;
}

/** Revolved tube: 10 × 40 rectangle, 20 from the V axis. */
export function tubeSketch(): SketchData {
  const s = rectSketch("10", "40");
  s.dimensions.push({ id: "off", type: "horizontalDistance", a: SKETCH_ORIGIN, b: "b", value: "30", driving: true });
  const at: Record<string, [number, number]> = { b: [30, 0], c: [30, 40], d: [20, 40] };
  s.geometry = s.geometry.map((g) => (g.type === "point" && at[g.id] ? { ...g, x: at[g.id]![0], y: at[g.id]![1] } : g));
  s.geometry.push({ id: "a", type: "point", x: 20, y: 0 });
  s.geometry = s.geometry.map((g) =>
    g.type === "line" ? { ...g, p1: g.p1 === SKETCH_ORIGIN ? "a" : g.p1, p2: g.p2 === SKETCH_ORIGIN ? "a" : g.p2 } : g,
  );
  s.constraints.push({ id: "onH", type: "pointOnCurve", point: "a", curve: "axis:H" });
  return s;
}

/** Open L-shaped polyline: (0,0) → (50,0) → (50,30). */
export function lSketch(): SketchData {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 50, y: 0 },
    { id: "c", type: "point", x: 50, y: 30 },
    { id: "l1", type: "line", p1: "a", p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
  ];
  return s;
}

const box = { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } };
const plate = { type: "box", params: { width: "100", depth: "60", height: "10", x: "0", y: "0", z: "0", op: "add" } };

/** L-shaped path: line from (0,0) to (50,0), 90° arc of radius 20, then a vertical line. */
export function pathSketch(): SketchData {
  const s = emptySketch("XZ");
  s.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 50, y: 0 },
    { id: "c", type: "point", x: 50, y: 20 },
    { id: "d", type: "point", x: 70, y: 20 },
    { id: "e", type: "point", x: 70, y: 60 },
    { id: "l1", type: "line", p1: "a", p2: "b" },
    { id: "arc", type: "arc", c: "c", start: "b", end: "d" },
    { id: "l2", type: "line", p1: "d", p2: "e" },
  ];
  return s;
}

/** Standalone points at the given positions (hole locations). */
export function pointsSketch(pts: [number, number][], offset = "0"): SketchData {
  const s = emptySketch("XY");
  s.plane.offset = offset;
  s.geometry = pts.map(([x, y], i) => ({ id: `p${i}`, type: "point" as const, x, y }));
  return s;
}

/** Slot axes: two segments on top of the plate. */
function slotAxes(): SketchData {
  const s = pointsSketch([[20, 20], [50, 20], [70, 15], [70, 45]], "10");
  s.geometry.push({ id: "l1", type: "line", p1: "p0", p2: "p1" }, { id: "l2", type: "line", p1: "p2", p2: "p3" });
  return s;
}

/** 1 m straight line on XY: path for profiles. */
function lineSketch(): SketchData {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 1000, y: 0 },
    { id: "l", type: "line", p1: "a", p2: "b" },
  ];
  return s;
}

/** Test feature (optional id). */
type F = Omit<Feature, "id" | "name"> & { id?: string };

const holeAt = (type: string, size: string, mode: string, depth = "1"): F[] => [
  plate,
  { id: "pts", type: "sketch", params: {}, sketch: pointsSketch([[20, 20], [80, 40]], "10") },
  { type: "hole", params: { sketch: "pts", type, size, mode, depth, reverse: "no" } },
];
const slot = (params: Record<string, string>): F[] => [
  plate,
  { id: "ax", type: "sketch", params: {}, sketch: slotAxes() },
  { type: "slot", params: { sketch: "ax", mode: "throughAll", depth: "1", reverse: "no", ...params } },
];
const pocket = { id: "pk", type: "box", params: { width: "10", depth: "10", height: "5", x: "5", y: "5", z: "5", op: "cut" } };

type V3 = [number, number, number];
const seg = (key: string, a: V3, b: V3) => ({ key, a, b });
const frameStep = (id: string, segs: ReturnType<typeof seg>[], params: Record<string, string> = {}) => ({
  id,
  type: "frameMembers",
  params: { family: "squareTube", size_squareTube: "40x3", rotation: "0", anchor: "c", corner: "miter", ...params },
  frame: { segments: segs.map((s) => s.key), paths: segs, joints: {} },
});
const rectFrame = [
  seg("f1", [0, 0, 0], [1000, 0, 0]),
  seg("f2", [1000, 0, 0], [1000, 500, 0]),
  seg("f3", [1000, 500, 0], [0, 500, 0]),
  seg("f4", [0, 500, 0], [0, 0, 0]),
];
const posts = [0, 1000].flatMap((x) => [0, 500].map((y) => seg(`p${x}-${y}`, [x, y, -800], [x, y, 0])));

const p1 = { id: "p1", type: "plane", params: {}, datum: { method: "offset" as const, refs: [{ kind: "base" as const, name: "XY" as const }], distance: "H" } };
const onDatum = () => ({ id: "sk", type: "sketch", params: {}, sketch: { ...rectSketch("20", "10"), plane: { base: "XY" as const, offset: "0", datum: "p1" } } });
const ex4 = { id: "ex", type: "extrude", params: { sketch: "sk", mode: "blind", depth: "4", reverse: "no", op: "add" } };

const thin = (sketch: string, thinSide: string, extra: Record<string, string> = {}) => ({
  type: "thinExtrude",
  params: { sketch, mode: "blind", depth: "10", reverse: "no", op: "add", thickness: "2", thinSide, ...extra },
});

const extrude = (sketch: string, mode: string, op = "add", reverse = "no") => ({
  type: "extrude",
  params: { sketch, mode, depth: "10", reverse, op },
});

const twist = (sketch: string, twistDeg: string, extra: Record<string, string> = {}) => ({
  type: "twistExtrude",
  params: { sketch, mode: "blind", depth: "10", twist: twistDeg, reverse: "no", op: "add", ...extra },
});

export const SCENARIOS: Record<string, () => PartDocument> = {
  "twisted extrusion": () => doc([{ id: "sk", type: "sketch", params: {}, sketch: rectSketch("60", "40") }, twist("sk", "90")]),
  "symmetric twisted extrusion with hole": () =>
    doc([{ id: "sk", type: "sketch", params: {}, sketch: rectSketch("L", "40", "5") }, twist("sk", "-45", { mode: "symmetric" })], L(60)),
  "twisted extrusion with zero twist": () => doc([{ id: "sk", type: "sketch", params: {}, sketch: rectSketch("60", "40") }, twist("sk", "0")]),
  "box with hole": () => doc([block, hole], L(100)),
  "box with hole + fillets": () => doc([block, hole, { type: "fillet", params: { radius: "3" } }], L(100)),
  "box + chamfers": () => doc([block, { type: "chamfer", params: { distance: "2" } }], L(100)),
  "impossible fillet": () => doc([block, { type: "fillet", params: { radius: "500" } }], L(100)),
  "extruded sketch with hole": () =>
    doc([{ id: "sk", type: "sketch", params: {}, sketch: rectSketch("L", "40", "5") }, extrude("sk", "blind")], L(60)),
  "symmetric extrusion": () => doc([{ id: "sk", type: "sketch", params: {}, sketch: rectSketch("60", "40") }, extrude("sk", "symmetric")]),
  "reversed extrusion": () =>
    doc([{ id: "sk", type: "sketch", params: {}, sketch: rectSketch("60", "40") }, extrude("sk", "blind", "add", "yes")]),
  "through-all cut": () => {
    const cut = rectSketch("20", "20");
    cut.plane.offset = "100";
    return doc([
      { id: "sk", type: "sketch", params: {}, sketch: rectSketch("60", "40") },
      extrude("sk", "blind"),
      { id: "sk2", type: "sketch", params: {}, sketch: cut },
      extrude("sk2", "throughAll", "cut"),
    ]);
  },
  revolve: () =>
    doc([
      { id: "sk", type: "sketch", params: {}, sketch: tubeSketch() },
      { type: "revolve", params: { sketch: "sk", axis: SKETCH_AXIS_V, angle: "360", op: "add" } },
    ]),
  "revolve 90°": () =>
    doc([
      { id: "sk", type: "sketch", params: {}, sketch: tubeSketch() },
      { type: "revolve", params: { sketch: "sk", axis: SKETCH_AXIS_V, angle: "90", op: "add" } },
    ]),
  "fillet on a selected edge": () =>
    doc([box, { type: "fillet", params: { radius: "5" }, refs: [{ kind: "edge", p: [50, 0, 40], size: 100 }] }]),
  "chamfer on two selected edges": () =>
    doc([
      box,
      {
        type: "chamfer",
        params: { distance: "2" },
        refs: [
          { kind: "edge", p: [50, 0, 40], size: 100 },
          { kind: "edge", p: [50, 60, 40], size: 100 },
        ],
      },
    ]),
  "edge not found": () =>
    doc([box, { type: "chamfer", params: { distance: "2" }, refs: [{ kind: "edge", p: [500, 0, 40], size: 100 }] }]),
  "shell open at the top": () =>
    doc([box, { type: "shell", params: { thickness: "2", direction: "inside" }, refs: [{ kind: "face", p: [50, 30, 40], size: 6000 }] }]),
  "outward shell": () =>
    doc([box, { type: "shell", params: { thickness: "2", direction: "outside" }, refs: [{ kind: "face", p: [50, 30, 40], size: 6000 }] }]),
  "thin extrusion, one side": () => doc([{ id: "sk", type: "sketch", params: {}, sketch: lSketch() }, thin("sk", "side1")]),
  "thin extrusion, other side": () => doc([{ id: "sk", type: "sketch", params: {}, sketch: lSketch() }, thin("sk", "side2")]),
  "thin extrusion, centered and symmetric": () =>
    doc([{ id: "sk", type: "sketch", params: {}, sketch: lSketch() }, thin("sk", "both", { mode: "symmetric" })]),
  "thin extrusion of a closed sketch": () =>
    doc([{ id: "sk", type: "sketch", params: {}, sketch: rectSketch("60", "40") }, thin("sk", "side1")]),
  "thin extrusion too thick": () => doc([{ id: "sk", type: "sketch", params: {}, sketch: lSketch() }, thin("sk", "side1", { thickness: "40" })]),
  "tube sweep": () =>
    doc([
      { id: "path", type: "sketch", params: {}, sketch: pathSketch() },
      { type: "sweep", params: { path: "path", profile: "circle", diameter: "10", inner: "6", profileSketch: "", op: "add" } },
    ]),
  "sweep of a closed sketch": () =>
    doc([
      { id: "path", type: "sketch", params: {}, sketch: pathSketch() },
      { id: "sec", type: "sketch", params: {}, sketch: { ...rectSketch("6", "4"), plane: { base: "YZ", offset: "0" } } },
      { type: "sweep", params: { path: "path", profile: "sketch", profileSketch: "sec", diameter: "1", inner: "0", op: "add" } },
    ]),
  "sweep without a path": () =>
    doc([
      { id: "path", type: "sketch", params: {}, sketch: rectSketch("10", "10") },
      { type: "sweep", params: { path: "path", profile: "circle", diameter: "10", inner: "0", profileSketch: "", op: "add" } },
    ]),
  "M6 through holes": () => doc(holeAt("simple", "M6", "throughAll")),
  "M6 counterbored holes": () => doc(holeAt("counterbore", "M6", "throughAll")),
  "M6 countersunk holes": () => doc(holeAt("countersink", "M6", "throughAll")),
  "M8 blind tapped holes": () => doc(holeAt("tapped", "M8", "blind", "6")),
  "counterbored hole too shallow": () => doc(holeAt("counterbore", "M6", "blind", "2")),
  "hole of unknown size": () => doc(holeAt("simple", "M99", "throughAll")),
  "hole without points": () =>
    doc([plate, { id: "pts", type: "sketch", params: {}, sketch: lSketch() }, { type: "hole", params: { sketch: "pts", type: "simple", size: "M6", mode: "throughAll", depth: "1", reverse: "no" } }]),
  "hole from a side face": () => {
    const pts = { ...emptySketch("XY"), geometry: [{ id: "p", type: "point" as const, x: 30, y: 20 }] };
    pts.plane.face = { p: [100, 30, 20], n: [1, 0, 0] };
    return doc([box, { id: "sk", type: "sketch", params: {}, sketch: pts }, { type: "hole", params: { sketch: "sk", type: "simple", size: "M8", mode: "blind", depth: "20", reverse: "no" } }]);
  },
  "boss on the top face": () => {
    const s = rectSketch("20", "10");
    s.plane.face = { p: [50, 30, 40], n: [0, 0, 1] };
    return doc([box, { id: "sk", type: "sketch", params: {}, sketch: s }, { type: "extrude", params: { sketch: "sk", mode: "blind", depth: "5", reverse: "no", op: "add" } }]);
  },
  "through slots": () => doc(slot({ width: "8" })),
  "blind slots": () => doc(slot({ width: "6", mode: "blind", depth: "4" })),
  "M6 clearance slots": () => doc(slot({ widthMode: "clearance", size: "M6", width: "1" })),
  "M6 counterbored slots": () => doc(slot({ widthMode: "clearance", size: "M6", type: "counterbore" })),
  "M6 countersunk slots": () => doc(slot({ widthMode: "clearance", size: "M6", type: "countersink" })),
  "mirror of a pocket": () => doc([plate, pocket, { type: "mirror", params: { feature: "pk", plane: "YZ", offset: "50" } }]),
  "mirror of the body": () => doc([plate, { type: "mirror", params: { feature: "", plane: "YZ", offset: "0" } }]),
  "mirror of an unknown feature": () => doc([plate, { type: "mirror", params: { feature: "nope", plane: "YZ", offset: "0" } }]),
  "linear pattern 4 × 2": () =>
    doc([
      plate,
      pocket,
      { type: "linearPattern", params: { feature: "pk", direction: "X", reverse: "no", count: "4", spacing: "20", direction2: "Y", count2: "2", spacing2: "30" } },
    ]),
  // Default preview on a large bore (20 spacing, Ø80): instances overlap (this used to crash the kernel).
  "linear pattern with overlapping instances": () =>
    doc([
      { type: "box", params: { width: "420", depth: "120", height: "190", x: "-60", y: "-60", z: "40", op: "add" } },
      { id: "bore", type: "cylinder", params: { radius: "40", height: "200", x: "0", y: "0", z: "35", axis: "z", op: "cut" } },
      { type: "linearPattern", params: { feature: "bore", direction: "X", reverse: "no", count: "3", spacing: "20", direction2: "", count2: "1", spacing2: "0" } },
    ]),
  "linear pattern with a single instance": () =>
    doc([plate, pocket, { type: "linearPattern", params: { feature: "pk", direction: "X", reverse: "no", count: "1", spacing: "20", direction2: "", count2: "1", spacing2: "0" } }]),
  "circular pattern": () =>
    doc([
      { type: "cylinder", params: { radius: "50", height: "10", x: "0", y: "0", z: "0", axis: "z", op: "add" } },
      { id: "h", type: "cylinder", params: { radius: "4", height: "10", x: "35", y: "0", z: "0", axis: "z", op: "cut" } },
      { type: "circularPattern", params: { feature: "h", axis: "Z", count: "6", angle: "360" } },
    ]),
  "circular pattern over 90°": () =>
    doc([
      { type: "cylinder", params: { radius: "50", height: "10", x: "0", y: "0", z: "0", axis: "z", op: "add" } },
      { id: "h", type: "cylinder", params: { radius: "4", height: "10", x: "35", y: "0", z: "0", axis: "z", op: "cut" } },
      { type: "circularPattern", params: { feature: "h", axis: "Z", count: "3", angle: "90" } },
    ]),
  "IPE 200 profile": () => doc([{ id: "sk", type: "sketch", params: {}, sketch: lineSketch() }, { type: "profile", params: { path: "sk", family: "IPE", size_IPE: "200", rotation: "0" } }]),
  "rotated square tube profile": () =>
    doc([{ id: "sk", type: "sketch", params: {}, sketch: lineSketch() }, { type: "profile", params: { path: "sk", family: "squareTube", size_squareTube: "40x3", rotation: "30" } }]),
  "profile of unknown family": () => doc([{ id: "sk", type: "sketch", params: {}, sketch: lineSketch() }, { type: "profile", params: { path: "sk", family: "XYZ", rotation: "0" } }]),
  "sketch on a reference plane": () => doc([p1, onDatum(), ex4], [{ name: "H", expr: "30" }]),
  "mirror about a reference plane": () =>
    doc(
      [
        p1,
        onDatum(),
        ex4,
        { id: "p2", type: "plane", params: {}, datum: { method: "offset" as const, refs: [{ kind: "base" as const, name: "YZ" as const }], distance: "-5" } },
        { type: "mirror", params: { feature: "ex", plane: "p2", offset: "0" } },
      ],
      [{ name: "H", expr: "30" }],
    ),
  "reference plane in error": () =>
    doc([{ id: "p1", type: "plane", params: {}, datum: { method: "parallel" as const, refs: [{ kind: "base" as const, name: "XY" as const }, null] } }, onDatum(), ex4]),
  "mitered frame with posts": () => doc([frameStep("s1", rectFrame), frameStep("s2", posts)]),
  "butt-jointed frame": () =>
    doc([frameStep("s", [seg("a", [0, 0, 0], [1000, 0, 0]), seg("b", [1000, 0, 0], [1000, 500, 0])], { corner: "butt" })]),
  "frame with a missing line": () => {
    const s = frameStep("s1", rectFrame);
    s.frame.segments.push("gone");
    return doc([s]);
  },
  // Plugin features: geometry recipes (packages/sdk/src/geometry.ts).
  "plugin: extruded profile with hole, revolved cone": () =>
    doc([
      recipe({
        solid: {
          op: "extrude",
          h: 10,
          plane: { origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 1, 0] },
          profile: { outer: { kind: "polygon", points: [[0, 0], [50, 0], [50, 30], [0, 30]] }, holes: [{ kind: "circle", center: [25, 15], r: 5 }] },
        },
      }),
      recipe({ solid: { op: "cone", r1: 10, r2: 5, h: 30, at: [100, 0, 0], dir: [1, 0, 0] } }),
    ]),
  "plugin: pocket in the body, booleans and transforms": () =>
    doc(
      [
        block,
        recipe({ mode: "cut", solid: { op: "rotate", axis: [0, 0, 1], angle: 10, solid: { op: "translate", by: [10, 10, 30], solid: { op: "box", size: [20, 20, 10] } } } }),
        recipe({ mode: "add", solid: { op: "union", solids: [{ op: "sphere", r: 8, at: [0, 0, 40] }, { op: "cylinder", r: 4, h: 20, at: [L0, 60, 40], dir: [0, 1, 0] }] } }),
      ],
      L(100),
    ),
  "plugin: replace with an intersection with the body": () =>
    doc([block, recipe({ mode: "replace", solid: { op: "intersect", solids: [{ op: "body" }, { op: "sphere", r: 30 }] } })], L(100)),
  "plugin: errors (plugin, missing, invalid recipe)": () =>
    doc([block, recipe(undefined, "module bloqué"), recipe(), recipe({ solid: { op: "box", size: [1, -1, 1] } })], L(100)),
};
