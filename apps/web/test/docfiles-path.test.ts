import { describe, expect, it } from "vitest";
import { basename, commonDir, dirname, extname, isSafeEntry, join, normalize, relative, safeFileName, samePath } from "../src/docfiles/path.ts";

describe("document paths", () => {
  it("normalizes separators, '.' and '..'", () => {
    expect(normalize("C:\\Projets\\bati\\..\\vis.vpart")).toBe("C:/Projets/vis.vpart");
    expect(normalize("/home/x/./a//b.vasm")).toBe("/home/x/a/b.vasm");
    expect(normalize("a/../../b.vpart")).toBe("../b.vpart");
    expect(normalize("/../a.vpart")).toBe("/a.vpart");
  });

  it("folder, name and extension", () => {
    expect(dirname("C:/Projets/bati.vasm")).toBe("C:/Projets");
    expect(dirname("C:/bati.vasm")).toBe("C:/");
    expect(dirname("/bati.vasm")).toBe("/");
    expect(dirname("bati.vasm")).toBe("");
    expect(dirname("sous/bati.vasm")).toBe("sous");
    expect(basename("C:\\Projets\\Vis M6.vpart")).toBe("Vis M6.vpart");
    expect(extname("x/Vis.VPART")).toBe(".vpart");
    expect(extname("x.dir/sans")).toBe("");
  });

  it("join resolves a relative path, keeps an absolute one", () => {
    expect(join("C:/Projets/bati", "../pieces/vis.vpart")).toBe("C:/Projets/pieces/vis.vpart");
    expect(join("sous", "vis.vpart")).toBe("sous/vis.vpart");
    expect(join("", "vis.vpart")).toBe("vis.vpart");
    expect(join("/a", "D:/b/vis.vpart")).toBe("D:/b/vis.vpart");
  });

  it("relative: round trip with join, other drive impossible", () => {
    const cases: [string, string][] = [
      ["C:/Projets/bati", "C:/Projets/bati/vis.vpart"],
      ["C:/Projets/bati", "C:/Projets/pieces/vis.vpart"],
      ["/home/x/a/b", "/home/x/c.vpart"],
      ["", "sous/vis.vpart"],
      ["sous", "autre/vis.vpart"],
    ];
    for (const [dir, file] of cases) expect(join(dir, relative(dir, file)!)).toBe(file);
    expect(relative("C:/Projets/bati", "C:/Projets/pieces/vis.vpart")).toBe("../pieces/vis.vpart");
    expect(relative("c:/projets", "C:/Projets/vis.vpart")).toBe("vis.vpart");
    expect(relative("C:/Projets", "D:/vis.vpart")).toBeNull();
  });

  it("comparison and safe file names", () => {
    expect(samePath("C:/A/b.vpart", "c:\\a\\B.vpart")).toBe(true);
    expect(samePath("/a/b.vpart", "/a/B.vpart")).toBe(false);
    expect(safeFileName('Vis M6 <2>: "test"?')).toBe("Vis M6 _2__ _test__");
    expect(safeFileName(" . ")).toBe("document");
  });

  it("common folder of a set of files", () => {
    expect(commonDir(["C:/p/a/x.vasm", "C:/p/b/y.vpart"])).toBe("C:/p");
    expect(commonDir(["/home/x/a.vasm", "/home/x/a.vpart"])).toBe("/home/x");
    expect(commonDir(["/a/x.vasm", "/b/y.vpart"])).toBe("/");
    expect(commonDir(["C:/a/x.vasm", "D:/a/y.vpart"])).toBe("");
    expect(commonDir(["x.vasm", "pieces/y.vpart"])).toBe("");
    expect(commonDir([])).toBe("");
  });

  it("archive entries stay inside the extraction folder", () => {
    expect(isSafeEntry("pieces/vis.vpart")).toBe(true);
    expect(isSafeEntry("vis..v2.vpart")).toBe(true);
    for (const p of ["../x.vpart", "a/../../x.vpart", "a\\..\\x.vpart", "/etc/x.vpart", "\\x.vpart", "C:/x.vpart", "C:x.vpart"]) expect(isSafeEntry(p)).toBe(false);
  });
});
