import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { networkAllowed, validateManifest } from "@solidus-cad/sdk";
import { readPluginPackage } from "../src/plugins/package.ts";

const manifest = {
  id: "com.exemple.test",
  name: { fr: "Test", en: "Test" },
  version: "1.0.0",
  sdkVersion: 1,
  entry: "index.js",
  permissions: ["document.read", "network:api.exemple.com"],
};

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

describe("plugin packages", () => {
  it("reads a valid package, manifest at the root or in a folder", () => {
    const code = "export default { activate() {} };";
    expect(readPluginPackage(zip({ "plugin.json": JSON.stringify(manifest), "index.js": code })).code).toBe(code);
    expect(readPluginPackage(zip({ "test/plugin.json": JSON.stringify(manifest), "test/index.js": code })).manifest.id).toBe("com.exemple.test");
  });

  it("rejects an invalid manifest, a missing module and an application that is too old", () => {
    expect(() => readPluginPackage(zip({ "index.js": "" }))).toThrow(/plugin.json absent/);
    expect(() => readPluginPackage(zip({ "plugin.json": JSON.stringify(manifest) }))).toThrow(/absent du paquet/);
    expect(() => readPluginPackage(zip({ "plugin.json": JSON.stringify({ ...manifest, minAppVersion: "2.0.0" }), "index.js": "" }), "1.4.0")).toThrow(/2.0.0/);
    expect(validateManifest({ ...manifest, id: "Test", permissions: ["root"], entry: "../x.js" })).toHaveLength(3);
  });

  it("limits network access to the declared domains, over HTTPS", () => {
    const perms = manifest.permissions;
    expect(networkAllowed(perms, "https://api.exemple.com/v1")).toBe(true);
    expect(networkAllowed(perms, "http://api.exemple.com/v1")).toBe(false);
    expect(networkAllowed(perms, "https://evil.com/?api.exemple.com")).toBe(false);
    expect(networkAllowed(["network:*.exemple.com"], "https://a.b.exemple.com")).toBe(true);
    expect(networkAllowed(["network:*.exemple.com"], "https://notexemple.com")).toBe(false);
  });
});
