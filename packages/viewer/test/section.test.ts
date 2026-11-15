import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { inLamp, LAMP_SIDES, lampPlanes } from "../src/section.ts";

describe("section lamp", () => {
  // Camera looking down -Z (back = +Z), lamp aimed at the origin.
  const right = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const back = new THREE.Vector3(0, 0, 1);
  const planes = Array.from({ length: LAMP_SIDES + 1 }, () => new THREE.Plane());
  const bottom = lampPlanes(new THREE.Vector3(0, 0, 0), right, up, back, { radius: 5, depth: 10 }, planes);

  it("removes the material inside the hole, from the camera down to the depth", () => {
    expect(bottom.toArray()).toEqual([0, 0, -10]);
    expect(inLamp(planes, new THREE.Vector3(0, 0, 100))).toBe(true);
    expect(inLamp(planes, new THREE.Vector3(3, -3, -9.9))).toBe(true);
    expect(inLamp(planes, new THREE.Vector3(0, 0, -10.1))).toBe(false);
  });

  it("keeps the material outside the radius", () => {
    expect(inLamp(planes, new THREE.Vector3(4.9, 0, 0))).toBe(true);
    expect(inLamp(planes, new THREE.Vector3(5.1, 0, 0))).toBe(false);
    expect(inLamp(planes, new THREE.Vector3(0, -5.1, -2))).toBe(false);
  });

  it("follows the camera axes", () => {
    // Camera looking along +X: the hole runs along X.
    const out = Array.from({ length: LAMP_SIDES + 1 }, () => new THREE.Plane());
    lampPlanes(new THREE.Vector3(10, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), { radius: 2, depth: 4 }, out);
    expect(inLamp(out, new THREE.Vector3(13.9, 1, 1))).toBe(true);
    expect(inLamp(out, new THREE.Vector3(14.1, 0, 0))).toBe(false);
    expect(inLamp(out, new THREE.Vector3(-50, 0, 0))).toBe(true);
    expect(inLamp(out, new THREE.Vector3(12, 0, 2.1))).toBe(false);
  });

  it("clamps a negative depth to the surface", () => {
    const out = Array.from({ length: LAMP_SIDES + 1 }, () => new THREE.Plane());
    expect(lampPlanes(new THREE.Vector3(1, 2, 3), right, up, back, { radius: 1, depth: -5 }, out).toArray()).toEqual([1, 2, 3]);
  });
});
