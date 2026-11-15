export type V2 = [number, number];

/** Gear representation: detailed (actual teeth) or simplified (volume at the pitch diameter). */
export type Representation = "detailed" | "simplified";

export class GearError extends Error {}
