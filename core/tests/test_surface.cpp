// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Surface bodies: surface extrude and revolve, naming of free edges, solid target, mass, STEP export.
#include "part/features.hpp"
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>

#include <algorithm>
#include <numbers>
#include <set>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::WithinAbs;

namespace {

/// Sketch in the XY plane: points and lines (id, p1, p2), open chains (lists of ids), an optional closed region.
Json sketchOf(std::string id, Json points, Json curves, Json chains, Json regions = Json::array()) {
  Json f = feature(std::move(id), "sketch", {});
  f["sketch"] = {{"frame", {{"origin", {0, 0, 0}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 1, 0}}, {"normal", {0, 0, 1}}}},
                 {"points", std::move(points)},
                 {"curves", std::move(curves)},
                 {"regions", std::move(regions)},
                 {"chains", std::move(chains)}};
  return f;
}

Json line(const char* p1, const char* p2) { return {{"type", "line"}, {"p1", p1}, {"p2", p2}}; }
Json chain(std::initializer_list<const char*> ids) {
  Json c = Json::array();
  for (const char* id : ids) c.push_back({{"id", id}, {"reversed", false}});
  return c;
}

/// Open L-shaped chain: l1 from (0,0) to (w,0), l2 from (w,0) to (w,40).
Json elbow(double w = 60) {
  return sketchOf("sk", {{"O", {0, 0}}, {"b", {w, 0}}, {"c", {w, 40}}}, {{"l1", line("O", "b")}, {"l2", line("b", "c")}},
                  Json::array({chain({"l1", "l2"})}));
}

/// Closed rectangle 60 × 40 (region l1..l4).
Json rectangle() {
  Json region = {{"outer", {{"reverse", false}, {"curves", chain({"l1", "l2", "l3", "l4"})}}}, {"holes", Json::array()}};
  return sketchOf("sk", {{"O", {0, 0}}, {"b", {60, 0}}, {"c", {60, 40}}, {"d", {0, 40}}},
                  {{"l1", line("O", "b")}, {"l2", line("b", "c")}, {"l3", line("c", "d")}, {"l4", line("d", "O")}}, Json::array(),
                  Json::array({region}));
}

Json extrudeSurface(std::string mode = "blind", double depth = 30, double depth2 = 10) {
  return feature("sx", "surfaceExtrude", {{"sketch", "sk"}, {"mode", std::move(mode)}, {"depth", depth}, {"depth2", depth2}, {"reverse", "no"}});
}

bool allOk(const RecomputeOutput& r) {
  return std::all_of(r.statuses.begin(), r.statuses.end(), [](const FeatureStatus& s) { return s.ok; });
}

std::set<std::string> asSet(const std::vector<std::string>& v) { return {v.begin(), v.end()}; }

std::string errorOf(const RecomputeOutput& r, const std::string& id) {
  for (const FeatureStatus& s : r.statuses)
    if (s.id == id) return s.error;
  return "?";
}

size_t occurrences(const std::string& text, const std::string& word) {
  size_t n = 0;
  for (size_t at = text.find(word); at != std::string::npos; at = text.find(word, at + 1)) n++;
  return n;
}

}  // namespace

TEST_CASE("surface extrude of an open chain: one face per curve, no solid", "[surface]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({elbow(), extrudeSurface()}));
  REQUIRE(allOk(r));
  REQUIRE(r.bodies.size() == 1);
  CHECK(r.bodies[0].id == "sx");
  CHECK(r.bodies[0].kind == BodyKind::Surface);
  CHECK(asSet(r.faceNames) == std::set<std::string>{"sx/side(l1)", "sx/side(l2)"});
  // Free edges: start and end through a virtual end face, lateral edges through "~"; ordinary shared edge.
  // Face names sorted: "sx/end" comes before "sx/side(…)".
  CHECK(asSet(r.edgeNames) == std::set<std::string>{"e(sx/side(l1)|sx/side(l2))", "e(sx/side(l1)|sx/start)", "e(sx/end|sx/side(l1))",
                                                    "e(sx/side(l2)|sx/start)", "e(sx/end|sx/side(l2))", "e(sx/side(l1)|~)",
                                                    "e(sx/side(l2)|~)"});
  // Part without a solid: no volume, the area of the surfaces; no shape for the drawing or CAM.
  REQUIRE(r.mass);
  CHECK(r.mass->volume == 0);
  CHECK_THAT(r.mass->area, WithinAbs((60 + 40) * 30, 1e-6));
  CHECK_FALSE(e.partShape(""));
  CHECK(r.activeBody.empty());
}

TEST_CASE("surface extrude: names stable when a dimension changes", "[surface]") {
  Engine e;
  const RecomputeOutput a = e.recompute(document({elbow(60), extrudeSurface("blind", 30)}));
  const RecomputeOutput b = e.recompute(document({elbow(90), extrudeSurface("blind", 55)}));
  REQUIRE(allOk(a));
  REQUIRE(allOk(b));
  CHECK(asSet(a.faceNames) == asSet(b.faceNames));
  CHECK(asSet(a.edgeNames) == asSet(b.edgeNames));
  CHECK(e.resolveName("e(sx/end|sx/side(l2))") >= 0);
}

TEST_CASE("surface extrude of a closed outline: an open tube, symmetric or in two directions", "[surface]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({rectangle(), extrudeSurface("symmetric", 30)}));
  REQUIRE(allOk(r));
  CHECK(r.faceNames.size() == 4);
  CHECK_THAT(r.mass->area, WithinAbs(2 * (60 + 40) * 30, 1e-6));
  // Four start edges, four end edges, four shared vertical edges: no free lateral edge.
  CHECK(r.edgeNames.size() == 12);
  CHECK(std::none_of(r.edgeNames.begin(), r.edgeNames.end(), [](const std::string& n) { return n.find("~") != std::string::npos; }));
  CHECK_THAT(r.mass->center[2], WithinAbs(0, 1e-6));

  const RecomputeOutput two = e.recompute(document({rectangle(), extrudeSurface("twoSides", 30, 10)}));
  REQUIRE(allOk(two));
  CHECK_THAT(two.mass->area, WithinAbs(2 * (60 + 40) * 40, 1e-6));
  CHECK_THAT(two.mass->center[2], WithinAbs(10, 1e-6));  // from z = -10 to z = 30
}

TEST_CASE("surface revolve: full or partial cylinder", "[surface]") {
  Engine e;
  // Vertical line x = 20 revolved around the V (y) axis: cylinder of radius 20, height 40.
  Json sk = sketchOf("sk", {{"a", {20, 0}}, {"b", {20, 40}}}, {{"l1", line("a", "b")}}, Json::array({chain({"l1"})}));
  Json full = feature("rv", "surfaceRevolve", {{"sketch", "sk"}, {"axis", "axis:V"}, {"angle", 360.0}});
  const RecomputeOutput r = e.recompute(document({sk, full}));
  REQUIRE(allOk(r));
  CHECK(r.bodies[0].kind == BodyKind::Surface);
  CHECK_THAT(r.mass->area, WithinAbs(2 * std::numbers::pi * 20 * 40, 1e-3));
  // Full revolution: no start or end edges, two free circles.
  CHECK(std::none_of(r.edgeNames.begin(), r.edgeNames.end(), [](const std::string& n) { return n.find("rv/start") != std::string::npos; }));

  Json quarter = feature("rv", "surfaceRevolve", {{"sketch", "sk"}, {"axis", "axis:V"}, {"angle", 90.0}});
  const RecomputeOutput q = e.recompute(document({sk, quarter}));
  REQUIRE(allOk(q));
  CHECK_THAT(q.mass->area, WithinAbs(std::numbers::pi / 2 * 20 * 40, 1e-3));
  const std::set<std::string> edges = asSet(q.edgeNames);
  CHECK(edges.count("e(rv/side(l1)|rv/start)") == 1);
  CHECK(edges.count("e(rv/end|rv/side(l1))") == 1);
}

TEST_CASE("a surface is not a solid target; the active body remains the last solid", "[surface]") {
  Engine e;
  Json box = feature("bx", "box", {{"width", 100.0}, {"depth", 60.0}, {"height", 40.0}, {"x", 0.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
  Json onSurface = feature("f", "fillet", {{"radius", 2.0}});
  onSurface["body"] = "sx";
  Json cyl = feature("cy", "cylinder", {{"radius", 10.0}, {"height", 40.0}, {"x", 50.0}, {"y", 30.0}, {"z", 0.0}, {"axis", "z"}, {"op", "cut"}});
  Json combine = feature("cb", "combineBodies", {{"tools", "sx"}, {"op", "add"}, {"keep", "no"}});
  combine["body"] = "bx";
  const RecomputeOutput r = e.recompute(document({box, elbow(), extrudeSurface(), onSurface, cyl, combine}));
  CHECK(errorOf(r, "f") == "Le corps cible est une surface : choisissez un corps solide");
  CHECK(errorOf(r, "cb") == "Un corps outil est une surface : choisissez des corps solides");
  // The cylinder without a target body removes material from the box, not from the surface created after it.
  CHECK(errorOf(r, "cy").empty());
  CHECK(r.activeBody == "bx");
  CHECK_THAT(r.mass->volume, WithinAbs(100.0 * 60 * 40 - std::numbers::pi * 100 * 40, 1e-3));
  REQUIRE(r.bodyMass.size() == 2);
  CHECK(r.bodyMass[1].second.volume == 0);
  CHECK_THAT(r.bodyMass[1].second.area, WithinAbs((60 + 40) * 30, 1e-6));
  // The part as seen from outside contains only the solid.
  REQUIRE(e.partShape(""));
  TopTools_IndexedMapOfShape solids, faces;
  TopExp::MapShapes(*e.partShape(""), TopAbs_SOLID, solids);
  TopExp::MapShapes(*e.partShape(""), TopAbs_FACE, faces);
  CHECK(solids.Extent() == 1);
  CHECK(faces.Extent() == 7);
}

TEST_CASE("STEP export: solids and surfaces (shell_based_surface_model)", "[surface]") {
  Engine e;
  Json box = feature("bx", "box", {{"width", 10.0}, {"depth", 10.0}, {"height", 10.0}, {"x", 200.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
  REQUIRE(allOk(e.recompute(document({box, elbow(), extrudeSurface()}))));
  const std::vector<uint8_t> data = e.exportShape("step");
  const std::string step(data.begin(), data.end());
  CHECK(occurrences(step, "MANIFOLD_SOLID_BREP") == 1);
  CHECK(occurrences(step, "SHELL_BASED_SURFACE_MODEL") >= 1);
}

TEST_CASE("moving a surface keeps its kind and the names of its edges", "[surface]") {
  Engine e;
  Json move = feature("mv", "moveBody", {{"dx", 0.0}, {"dy", 0.0}, {"dz", 100.0}, {"axis", "Z"}, {"angle", 0.0}, {"copy", "no"}});
  move["body"] = "sx";
  const RecomputeOutput r = e.recompute(document({elbow(), extrudeSurface(), move}));
  REQUIRE(allOk(r));
  REQUIRE(r.bodies.size() == 1);
  CHECK(r.bodies[0].kind == BodyKind::Surface);
  CHECK(asSet(r.edgeNames).count("e(sx/side(l1)|sx/start)") == 1);
  CHECK_THAT(r.mass->center[2], WithinAbs(115, 1e-6));
}

TEST_CASE("reference groups: elements of several bodies, filtered by group", "[surface]") {
  Engine e;
  // Test feature: resolves the group "edges" (edges) and the group "faces" (faces), and describes what it found.
  std::string found;
  e.registry().add(
      "probe",
      [&found](const BuildContext& ctx) -> FeatureOutput {
        found.clear();
        for (const GroupRef& r : resolveGroup(ctx, TopAbs_EDGE, "edges")) found += "edge@" + r.body + ";";
        for (const GroupRef& r : resolveGroup(ctx, TopAbs_FACE, "faces")) found += "face@" + r.body + ";";
        return BodyChanges{};
      },
      TargetKind::Any);
  Json box = feature("bx", "box", {{"width", 10.0}, {"depth", 10.0}, {"height", 10.0}, {"x", 200.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
  Json probe = feature("pr", "probe", {});
  probe["refs"] = Json::array({
      {{"kind", "edge"}, {"name", "e(sx/side(l1)|sx/start)"}, {"p", {0, 0, 0}}, {"size", 1}, {"group", "edges"}},
      {{"kind", "face"}, {"name", "bx/top"}, {"p", {0, 0, 0}}, {"size", 1}, {"group", "faces"}, {"body", "bx"}},
      // Reference of the default group: ignored by the groups.
      {{"kind", "face"}, {"name", "sx/side(l2)"}, {"p", {0, 0, 0}}, {"size", 1}},
  });
  const RecomputeOutput r = e.recompute(document({box, elbow(), extrudeSurface(), probe}));
  REQUIRE(allOk(r));
  CHECK(found == "edge@sx;face@bx;");

  // A missing element is reported.
  probe["refs"][0]["name"] = "e(sx/side(l9)|sx/start)";
  probe["refs"][0]["p"] = {1000, 1000, 1000};
  CHECK(errorOf(e.recompute(document({box, elbow(), extrudeSurface(), probe})), "pr").rfind("Arête introuvable", 0) == 0);
}
