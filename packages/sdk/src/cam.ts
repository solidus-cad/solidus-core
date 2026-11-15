import type { Matrix4 } from "./assembly.ts";
import type { Expr, GeomRef } from "./document.ts";

/**
 * CAM workbench (manufacturing): types shared with the CAM module of the official builds.
 *
 * Four objects, four lifetimes:
 *  - the tool library (`ToolLibrary`): shared between programs, specific to the workbench or to the user;
 *  - the machining material database (`MachiningMaterial`): cutting data per ISO group;
 *  - the machine (`MachineDefinition`): carried by an assembly, so it can be imported and edited as one;
 *  - the program (`CamDocument`): part + stock + setups + operations + tool magazine assignment.
 */

export type Point3 = [number, number, number];

// --- Machining materials -------------------------------------------------------------------

/** ISO 513 groups: P steels, M stainless steels, K cast irons, N non-ferrous, S superalloys/titanium, H hardened steels, O plastics/wood. */
export type IsoGroup = "P" | "M" | "K" | "N" | "S" | "H" | "O";

export interface MachiningMaterial {
  id: string;
  name: string;
  group: IsoGroup;
  /** Density (g/cm³), consistent with `PartDocument.material`. */
  density: number;
  /** Brinell hardness (HB), optional. */
  hardness?: number;
  /** Specific cutting force kc1.1 (N/mm²) and exponent mc (Kienzle): spindle power and force. */
  kc11?: number;
  mc?: number;
}

/** Starting material database. Cutting data is carried by the tools (per ISO group). */
export const MACHINING_MATERIALS: MachiningMaterial[] = [
  { id: "s235", name: "Acier S235", group: "P", density: 7.85, hardness: 120, kc11: 1500, mc: 0.25 },
  { id: "c45", name: "Acier C45", group: "P", density: 7.85, hardness: 200, kc11: 1700, mc: 0.25 },
  { id: "42crmo4", name: "Acier 42CrMo4 traité", group: "P", density: 7.85, hardness: 300, kc11: 2000, mc: 0.25 },
  { id: "304l", name: "Acier inoxydable 304L", group: "M", density: 7.9, hardness: 180, kc11: 2100, mc: 0.21 },
  { id: "gjl250", name: "Fonte EN-GJL-250", group: "K", density: 7.2, hardness: 220, kc11: 1100, mc: 0.28 },
  { id: "al6061", name: "Aluminium 6061", group: "N", density: 2.7, hardness: 95, kc11: 700, mc: 0.25 },
  { id: "al5083", name: "Aluminium 5083", group: "N", density: 2.66, hardness: 75, kc11: 650, mc: 0.25 },
  { id: "cuzn39pb3", name: "Laiton CuZn39Pb3", group: "N", density: 8.47, hardness: 110, kc11: 780, mc: 0.18 },
  { id: "ti6al4v", name: "Titane Ti-6Al-4V", group: "S", density: 4.43, hardness: 330, kc11: 1450, mc: 0.23 },
  { id: "pom", name: "POM", group: "O", density: 1.41, kc11: 200, mc: 0.2 },
  { id: "pa6", name: "PA6", group: "O", density: 1.14, kc11: 220, mc: 0.2 },
];

// --- Stock ----------------------------------------------------------------------------------

/**
 * Stock shape. Dimensions are expressions: they may use the part parameters
 * ("L + 5") and therefore follow the active part family.
 */
export type StockShape =
  /** Block with the given dimensions, placed by `Stock.placement` in the part coordinate system. */
  | { kind: "box"; x: Expr; y: Expr; z: Expr }
  /** Part envelope enlarged by an allowance per face (the most common). */
  | { kind: "boxOffset"; xMin: Expr; xMax: Expr; yMin: Expr; yMax: Expr; zMin: Expr; zMax: Expr }
  /** Round bar (or tube if `bore` is non-zero), along the X, Y or Z axis. */
  | { kind: "cylinder"; diameter: Expr; length: Expr; axis: "x" | "y" | "z"; bore?: Expr }
  /**
   * Rough part: any part document (casting, forging, imported STEP, pre-machined part).
   * - `upTo`: part tree stopped BEFORE this feature, so the rough part is the part itself without its finishing
   *   (e.g. without the holes and fillets), always up to date if the part changes;
   * - `configuration`: row of the part family to use (otherwise the active configuration).
   */
  | { kind: "part"; partId: string; upTo?: string; configuration?: string }
  /** Resumption: the stock is the simulated result of the given setup (same program), with its material removed. */
  | { kind: "fromSetup"; setupId: string };

/**
 * Stock placement. The stock has its own coordinate system (corner or center, see `anchor`), positioned:
 *  - relative to the part (usual case: the part is "inside" the stock);
 *  - or relative to the machine table (stock placed, part then repositioned inside it).
 * The final transform = `matrix` · anchor; `matrix` is editable with the 3D manipulator and by dimensions.
 */
export interface StockPlacement {
  relativeTo: "part" | "table";
  /** Point of the stock that coincides with the origin of `matrix`: bottom face center, min corner, volume center. */
  anchor: "bottomCenter" | "minCorner" | "center";
  /** Free translation and rotation (4×4 matrix, column-major). */
  matrix: Matrix4;
  /** Optional automatic alignment: recomputes `matrix` to center the stock on the part envelope. */
  autoAlign?: { x?: "min" | "center" | "max"; y?: "min" | "center" | "max"; z?: "min" | "center" | "max" };
}

export interface Stock {
  shape: StockShape;
  /** Identifier in the material database (`MachiningMaterial.id`); taken from the rough part if absent. */
  material: string;
  /** If absent: stock centered on the part in X/Y, top face at the zMax allowance (boxOffset) or flush. */
  placement?: StockPlacement;
  /** Catalog entry the stock comes from (Ø40 bar, 50×20 flat...), for the cut list. */
  catalogRef?: string;
}

/** Entry of the standard stock catalog: a `StockShape` template whose some dimensions remain to be entered. */
export interface StockCatalogEntry {
  id: string;
  label: { fr: string; en: string };
  shape: StockShape;
  /** Dimensions offered in a list (e.g. usual drawn diameters); the others are free. */
  sizes?: Record<string, number[]>;
}

export const STOCK_CATALOG: StockCatalogEntry[] = [
  {
    id: "envelope",
    label: { fr: "Enveloppe + surépaisseurs", en: "Envelope + offsets" },
    shape: { kind: "boxOffset", xMin: "2", xMax: "2", yMin: "2", yMax: "2", zMin: "0", zMax: "2" },
  },
  {
    id: "flat",
    label: { fr: "Plat étiré", en: "Flat bar" },
    shape: { kind: "box", x: "100", y: "50", z: "20" },
    sizes: { y: [10, 15, 20, 25, 30, 40, 50, 60, 80, 100], z: [5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50] },
  },
  {
    id: "plate",
    label: { fr: "Tôle forte / bloc scié", en: "Plate / sawn block" },
    shape: { kind: "box", x: "200", y: "150", z: "30" },
    sizes: { z: [8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100] },
  },
  {
    id: "round",
    label: { fr: "Rond étiré", en: "Round bar" },
    shape: { kind: "cylinder", diameter: "40", length: "100", axis: "z" },
    sizes: { diameter: [6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100] },
  },
  {
    id: "tube",
    label: { fr: "Tube", en: "Tube" },
    shape: { kind: "cylinder", diameter: "60", length: "100", axis: "z", bore: "40" },
  },
  {
    id: "roughPart",
    label: { fr: "Pièce ébauchée (fonderie, forge, pré-usinée)", en: "Rough part (casting, forging, pre-machined)" },
    shape: { kind: "part", partId: "" },
  },
];

// --- Tools ----------------------------------------------------------------------------------

export type ToolType =
  | "flat" // 2-flute end mill
  | "ball" // ball end mill
  | "bull" // bull nose end mill
  | "face" // face mill
  | "chamfer" // chamfer mill / engraving tip
  | "drill" // drill
  | "spotDrill" // spot drill
  | "reamer" // reamer
  | "tap" // tap
  | "threadMill" // thread mill
  | "slot" // slitting saw
  | "turn" // turning tool (insert, external)
  | "boringBar" // boring bar (insert, internal)
  | "groove" // grooving / parting blade
  | "threadTurn"; // threading tool

/**
 * Lathe insert. The driven point of a turning tool is its theoretical tip: the corner tangent to the nose
 * circle on the X and Z sides, the point that the tool setter measures.
 */
export interface TurningInsert {
  /** External: the tool cuts toward the axis. Internal: it cuts away from the axis, inside a bore. */
  side: "external" | "internal";
  /** Included angle of the insert (80° C, 55° D, 35° V) in degrees. */
  angle: number;
  /** Lead: tilt of the main edge from the radial direction toward +Z, in degrees (5° for κ = 95°). */
  lead: number;
  /** Cutting edge length. */
  edge: number;
  /** Blade width (grooving, parting). */
  width?: number;
}

/**
 * Cutting geometry, in mm. The exact revolution profile (`profile`) takes precedence when given:
 * it is what the simulation sweeps and what the toolpath calculations use.
 */
export interface ToolGeometry {
  diameter: number;
  /** Corner radius (bull nose), D/2 for a ball end mill. */
  cornerRadius?: number;
  /** Point angle (drill, chamfer mill) in degrees. */
  tipAngle?: number;
  /** Pitch (tap, thread mill). */
  pitch?: number;
  fluteLength: number;
  shankDiameter: number;
  /** Length beyond the tool holder (stickout). */
  stickout: number;
  flutes: number;
  /** Optional revolution profile: points (r, z) from the tip, z toward the spindle. */
  profile?: [number, number][];
  /** Lathe insert (turning tools): `cornerRadius` is its nose radius, `shankDiameter` its shank size or bar diameter. */
  insert?: TurningInsert;
}

/** Tool holder: revolution profile (r, z) from the holder nose up to the gauge line. */
export interface ToolHolder {
  id: string;
  name: string;
  /** Spindle taper (SK40, HSK-A63, BT30, ER for light machines...). */
  interface: string;
  profile: [number, number][];
  /** Distance from holder nose to gauge line. */
  gaugeLength: number;
}

/**
 * Recommended cutting conditions of a tool for an ISO group: values proposed for each pass.
 * Expressions may use D (diameter), R (corner radius), Z (number of teeth).
 */
export interface CuttingData {
  group: IsoGroup;
  /** Cutting speed (m/min). */
  vc: number;
  /** Feed per tooth (mm/tooth); per revolution for drills, spot drills, reamers and turning tools. Ignored for a tap (feed = pitch). */
  fz: number;
  /** Maximum axial depth of cut and radial engagement ("1*D", "0.5*D", "3"). */
  ap?: Expr;
  ae?: Expr;
}

export interface Tool {
  id: string;
  /** Tool number called in the program (T code). Unique within a library and within a program. */
  number: number;
  name: string;
  type: ToolType;
  geometry: ToolGeometry;
  /** Vmax: maximum rotation speed allowed for the tool (rpm, manufacturer data). Caps each pass. */
  maxRpm: number;
  /** Tool holder (`ToolHolder.id`) from the library. */
  holder?: string;
  cutting: CuttingData[];
  coolant?: "none" | "flood" | "mist" | "air" | "through";
  /** Manufacturer and commercial reference. */
  vendor?: string;
  reference?: string;
}

/** Tool library (.vtools): catalog shared between programs. */
export interface ToolLibrary {
  format: "cad.tools";
  formatVersion: 1;
  id: string;
  name: string;
  tools: Tool[];
  holders: ToolHolder[];
}

// --- Machine --------------------------------------------------------------------------------

/**
 * Machine axis. The kinematics is a tree: each axis is carried by its parent (or by the frame).
 * The assembly is modeled at the zero position of all axes; an axis moves its `components`
 * and, by transitivity, everything carried by its child axes.
 */
export interface MachineAxis {
  /** CNC axis name: X, Y, Z, A, B, C, U, V, W. */
  id: string;
  kind: "linear" | "rotary";
  /** Parent axis; absent = mounted on the frame. */
  parent?: string;
  /** Assembly occurrences moved directly by the axis (parts or subassemblies). */
  components: string[];
  /**
   * Physical movement of the components for a positive value, in the assembly coordinate system (zero position).
   * Linear: direction of movement (unit vector). Rotary: axis of rotation (right-hand rule).
   * For an axis on the workpiece side (moving table), it is therefore opposed to the ISO-normalized direction of the tool.
   */
  direction: Point3;
  /** Point on the rotation axis (rotary), assembly coordinate system. */
  origin?: Point3;
  /** Travel limits (mm or °). A rotary axis without limits is continuous. */
  min?: number;
  max?: number;
  /** Rapid feed (mm/min or °/min) and acceleration (mm/s² or °/s²), for time estimation. */
  rapid: number;
  accel?: number;
}

/** Frame attached to an occurrence: matrix in the local coordinate system of the occurrence. */
export interface ComponentFrame {
  component: string;
  frame: Matrix4;
}

export interface ToolMagazine {
  kind: "carousel" | "chain" | "rack" | "manual";
  capacity: number;
  /** Chip-to-chip tool change time (s). */
  changeTime: number;
  maxToolDiameter?: number;
  maxToolLength?: number;
  /**
   * Display: magazine occurrence and pocket positions (local coordinate system of the occurrence).
   * Pocket k: rotation of `k * 360 / capacity` around `axis`, at `radius` from the center.
   */
  display?: { component: string; center: Point3; axis: Point3; radius: number; toolAxis: Point3 };
}

export interface MachineDefinition {
  kind: "mill" | "lathe" | "millTurn" | "router" | "thermalCut";
  /** Original architecture model ("vmc-cframe", "trunnion-ac"...): catalog filters. */
  architecture?: string;
  /** Vendor, model: informational. */
  vendor?: string;
  model?: string;
  axes: MachineAxis[];
  /** Spindle gauge line: +Z of the frame = tool axis, from the tip toward the spindle. */
  spindle: ComponentFrame & { maxRpm: number; power?: number; interface?: string };
  /** Clamping frame on the table: machine origin of fixtures and clamps. */
  table: ComponentFrame;
  magazine: ToolMagazine;
  /** Default post-processor (plugin identifier) and its options. */
  post: { id: string; options?: Record<string, string> };
  /** Lathe: main spindle (turning). `spindle` is then the live tool spindle and the tool reference point. */
  mainSpindle?: { maxRpm: number; power?: number };
}

// --- Fixturing ------------------------------------------------------------------------------

/**
 * Degree of freedom of a fixture: same model as a machine axis (tree, carried occurrences, physical direction),
 * with its role: `clamp` (movable jaw, clamping) or `index` (rotary 4th / 5th axis, positioned by the setup).
 */
export interface FixtureAxis extends MachineAxis {
  role: "clamp" | "index";
}

/**
 * Fixture (machining workholding): an assembly whose `AssemblyDocument.fixture` is set, like a machine.
 * It is placed on the machine table by its `mount` frame; the part (its stock) is clamped to the `work` frame.
 * The assembly is modeled at zero on all axes; for a vise, `jaw.closed` is the jaw opening at zero.
 */
export interface FixtureDefinition {
  kind: "vise" | "rotary" | "trunnion" | "plate" | "other";
  vendor?: string;
  model?: string;
  axes: FixtureAxis[];
  /** Support frame on the table (+Z up, origin on the table). */
  mount: ComponentFrame;
  /** Clamping frame: the part is placed there (fixed jaw, plate). */
  work: ComponentFrame;
  /** Vise: clamping axis, opening direction in the `work` frame, opening at zero. */
  jaw?: { axis: string; direction: Point3; closed: number; max?: number };
}

// --- Program --------------------------------------------------------------------------------

/** Tool loaded in a magazine pocket. The program calls the tool by its T code (`Tool.number`). */
export interface MagazineSlot {
  pocket: number;
  /** Program tool (`CamDocument.tools[].id`). */
  tool: string;
  /** Length (H) and radius (D) offset numbers; by default equal to the T code. */
  h?: number;
  d?: number;
}

/**
 * Cutting conditions of a pass. Each absent field takes the tool's recommended value
 * for the stock material; each provided field replaces it. Speeds are capped by
 * the tool's Vmax and the spindle's max speed (see `resolveCutting`).
 * Expressions: D (diameter), R (corner radius), Z (teeth), and the part parameters.
 */
export interface PassCutting {
  /** Cutting speed (m/min) or rotation speed (rpm): the latter wins if both are given. */
  vc?: Expr;
  rpm?: Expr;
  /** Feed per tooth (mm/tooth) or feed (mm/min): the latter wins. */
  fz?: Expr;
  feed?: Expr;
  /** Plunge and entry feed (mm/min); by default half the feed (the feed for a drilling operation). */
  plungeFeed?: Expr;
  /** Axial depth of cut and radial engagement (mm). */
  ap?: Expr;
  ae?: Expr;
  /** Allowance left by the pass (mm), radial and axial. */
  stockRadial?: Expr;
  stockAxial?: Expr;
  coolant?: Tool["coolant"];
}

/** Machining operation: same model as a part feature (parameters declared by the workbench). */
export interface Operation {
  id: string;
  type: string;
  name: string;
  suppressed?: boolean;
  /** Program tool (`CamDocument.tools[].id`). */
  tool: string;
  params: Record<string, Expr>;
  /** Cutting conditions of the pass (roughing, or the only pass). */
  cutting: PassCutting;
  /** Optional finishing pass (contouring, pocket...): its own cutting conditions. */
  finish?: PassCutting;
  /** Faces, edges or contours selected on the part. */
  refs?: GeomRef[];
}

/** Setup: one part clamping, a work coordinate system, an ordered list of operations. */
export interface Setup {
  id: string;
  name: string;
  stock: Stock;
  /** Work coordinate system (program origin) in the part coordinate system: +Z = tool axis. */
  wcs: Matrix4;
  /** Work offset called (G54...G59). */
  workOffset: string;
  /** Position of the part on the machine table (`machine.table` frame). */
  mount: Matrix4;
  /** Fixture (vise, plate, tilting table): assembly whose `fixture` is set. */
  fixtureAssemblyId?: string;
  /**
   * Values of the fixture axes (jaws, rotary) and of the machine rotary axes for the setup (3+2).
   * A jaw that is absent: closed on the stock.
   */
  orientation?: Record<string, number>;
  /** Lathe setup: see `LatheSetup`. */
  lathe?: LatheSetup;
  operations: Operation[];
}

/**
 * Setup on a lathe. Turning work frame: +Z along the spindle axis, away from the chuck, origin on the axis at the
 * front of the stock, +X radial. Milling uses the same part clamping, the tool on a live station:
 *  - axial: tool parallel to Z, work frame = turning frame turned by C;
 *  - radial: tool along X, part indexed by C, work frame (x, y, z) = machine (Y, Z, X radius).
 */
export interface LatheSetup {
  mode: "turn" | "axial" | "radial";
  /** Turning frame in the part frame. */
  frame: Matrix4;
  /** Indexing of the C axis (°), milling. */
  c: number;
  /** Stock length held in the jaws, from the back of the stock. */
  grip: number;
  /** Outer diameter of the jaws (tool collision). */
  jawDiameter: number;
}

export interface CamDocument {
  format: "cad.cam";
  formatVersion: 1;
  id: string;
  name: string;
  /** Part to machine (part document); its parameters drive the stock dimensions. */
  partId: string;
  /** Machine: assembly whose `AssemblyDocument.machine` is set. */
  machineId: string;
  /** Frozen copy of the tools used (the program stays reproducible if the library changes). */
  tools: Tool[];
  holders: ToolHolder[];
  magazine: MagazineSlot[];
  setups: Setup[];
  /** Override of the machine post-processor options. */
  post?: { id?: string; options?: Record<string, string> };
}

// --- CAM kernel results ---------------------------------------------------------------------

/** Toolpath move types (field `flags` & 0xff). */
export const MOVE_RAPID = 0;
export const MOVE_FEED = 1;
export const MOVE_PLUNGE = 2;
export const MOVE_LEAD = 3;
/** Arc (helical if z changes) to the point, center in (i, j); `flags` & MOVE_CW = clockwise. */
export const MOVE_ARC = 4;
export const MOVE_CW = 0x100;

/**
 * Toolpath of an operation, as CL data (driven point = tool tip, setup work coordinate system).
 * `moves`: 8 floats per point: x, y, z, i, j, k, feed (mm/min, 0 = rapid), flags.
 * (i, j, k) = tool axis (arc center for MOVE_ARC). Transferred without copy from the Worker.
 */
export interface Toolpath {
  operation: string;
  tool: string;
  rpm: number;
  moves: Float32Array;
  /** Statistics: lengths (mm) and estimated time (s, including the machine axis dynamics). */
  stats: { feedLength: number; rapidLength: number; time: number };
  warnings: string[];
  /** Roughing or finishing pass (operation with a finish). */
  pass?: "rough" | "finish";
  /** Values retained for automatic parameters (top, bottom, clearance, ap, ae...), shown in the panel. */
  resolved?: Record<string, number>;
  /** Feed (mm/min) and coolant of the pass, for the post-processor. */
  feed?: number;
  coolant?: Tool["coolant"];
  /** Drilling cycle: the post outputs a fixed cycle (G81...G85) rather than the moves. */
  cycle?: DrillCycle;
  /** Turning: moves in the (x radius, z) plane of the turning frame, y = 0. */
  turning?: TurningPass;
}

/** Conditions of a turning pass, for the post-processor (constant surface speed, feed per revolution). */
export interface TurningPass {
  /** Constant surface speed (m/min); 0: constant rotation speed `Toolpath.rpm` (drilling, threading). */
  vc: number;
  /** Rotation speed limit of the pass (G50). */
  maxRpm: number;
  /** Feed per revolution (mm/rev). */
  feedRev: number;
  /** Threading cycle (G76): the post outputs it rather than the moves. */
  thread?: ThreadCycle;
}

export interface ThreadCycle {
  pitch: number;
  /** Start and end of the thread (Z), radius of the crest and depth of the thread (mm, on the radius). */
  zStart: number;
  zEnd: number;
  crest: number;
  depth: number;
  /** Depth of the first pass (mm) and of the last one. */
  firstCut: number;
  minCut: number;
  /** Insert angle (°). */
  angle: number;
}

/** Fixed drilling cycle, work coordinate system: points (x, y), bottom depth, retract plane R. */
export interface DrillCycle {
  kind: "drill" | "peck" | "tap" | "bore";
  points: [number, number][];
  /** Z depth of the bottom (tool tip). */
  bottom: number;
  /** Retract plane (R) and top of the hole depth. */
  retract: number;
  top: number;
  /** Peck depth (G83). */
  peck?: number;
  /** Dwell at the bottom (ms). */
  dwell?: number;
  /** Tap pitch (G84). */
  pitch?: number;
}

/** Machine position: value of each axis (mm or °), key = `MachineAxis.id`. */
export type AxisValues = Record<string, number>;
