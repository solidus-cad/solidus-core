import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { faceZone } from "../src/viewcube.ts";

describe("faceZone", () => {
  it("returns the face at its center", () => {
    expect(faceZone(new THREE.Vector3(0, 0, 1)).toArray()).toEqual([0, 0, 1]);
    expect(faceZone(new THREE.Vector3(0, -1, 0)).toArray()).toEqual([0, -1, 0]);
  });

  it("stays on a single face next to an edge or a corner", () => {
    for (const p of [new THREE.Vector3(1, 0.99, 0), new THREE.Vector3(0.99, 1, -0.99), new THREE.Vector3(-1, 0.98, 0.98)]) {
      expect(faceZone(p).toArray().filter((v) => v !== 0)).toHaveLength(1);
    }
  });
});
