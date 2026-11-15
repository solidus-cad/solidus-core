// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// 3D sketches as paths, surface sweep, surface and solid loft (with and without guides), naming, errors.
#include "part/features.hpp"
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <algorithm>
#include <numbers>
#include <set>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::WithinAbs;
using Catch::Matchers::WithinRel;

namespace {

/// Sketch in the plane z = `z` (parallel to XY).
Json sketchAt(std::string id, double z, Json points, Json curves, Json chains, Json regions = Json::array()) {
  Json f = feature(std::move(id), "sketch", {});
  f["sketch"] = {{"frame", {{"origin", {0, 0, z}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 1, 0}}, {"normal", {0, 0, 1}}}},
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

/// Square of side `a` centred on the axis, in the plane z = `z` (region q1..q4).
Json square(std::string id, double z, double a = 20) {
  const double h = a / 2;
  Json region = {{"outer", {{"reverse", false}, {"curves", chain({"q1", "q2", "q3", "q4"})}}}, {"holes", Json::array()}};
  return sketchAt(std::move(id), z, {{"A", {-h, -h}}, {"B", {h, -h}}, {"C", {h, h}}, {"D", {-h, h}}},
                  {{"q1", line("A", "B")}, {"q2", line("B", "C")}, {"q3", line("C", "D")}, {"q4", line("D", "A")}}, Json::array(),
                  Json::array({region}));
}

/// Open segment from (-w/2, 0) to (w/2, 0) in the plane z = `z` (curve s1).
Json segment(std::string id, double z, double w = 10) {
  return sketchAt(std::move(id), z, {{"a", {-w / 2, 0}}, {"b", {w / 2, 0}}}, {{"s1", line("a", "b")}}, Json::array({chain({"s1"})}));
}

/// 3D sketch: points, curves and chains as prepared by the client (`prepared.curves3d`).
Json sketch3d(std::string id, Json points, Json curves, Json chains) {
  Json f = feature(std::move(id), "sketch3d", {});
  f["prepared"] = {{"curves3d", {{"points", std::move(points)}, {"curves", std::move(curves)}, {"chains", std::move(chains)}}}};
  return f;
}

/// Cubic 3D path from the origin, leaving along +Z: (0,0,0) (0,0,`h`) (30,0,60) (60,20,80).
Json splinePath(double h = 30) {
  Json poles = Json::array({Json::array({0, 0, 0}), Json::array({0, 0, h}), Json::array({30, 0, 60}), Json::array({60, 20, 80})});
  Json spline = {{"type", "bspline"}, {"poles", poles}, {"degree", 3}, {"knots", {0, 1}}, {"mults", {4, 4}}, {"a", "P0"}, {"b", "P1"}};
  return sketch3d("p3", {{"P0", {0, 0, 0}}, {"P1", {60, 20, 80}}}, {{"sp", spline}}, Json::array({chain({"sp"})}));
}

/// 3D polyline leaving the origin along +Z, then going along +X: (0,0,0) → (0,0,40) → (30,0,40) (lines k1, k2).
Json elbowPath() {
  return sketch3d("p3", {{"P0", {0, 0, 0}}, {"P1", {0, 0, 40}}, {"P2", {30, 0, 40}}}, {{"k1", line("P0", "P1")}, {"k2", line("P1", "P2")}},
                  Json::array({chain({"k1", "k2"})}));
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

bool has(const std::vector<std::string>& names, const std::string& n) { return std::find(names.begin(), names.end(), n) != names.end(); }

Json surfaceSweep(std::string orientation = "corrected") {
  return feature("sw", "surfaceSweep", {{"profile", "pr"}, {"path", "p3"}, {"orientation", std::move(orientation)}});
}

Json loft(std::string type, std::string sections, std::string guides = "", std::string ruled = "no") {
  return feature("lf", std::move(type), {{"sections", std::move(sections)}, {"guides", std::move(guides)}, {"ruled", std::move(ruled)}, {"op", "new"}});
}

}  // namespace

TEST_CASE("3D sketch: always valid, even without prepared curves (skeleton of an older client)", "[loft]") {
  Engine e;
  Json bare = feature("p3", "sketch3d", {});
  const RecomputeOutput r = e.recompute(document({bare, square("s0", 0), feature("f", "extrude", {{"sketch", "s0"}, {"mode", "blind"}, {"depth", 10.0}, {"reverse", "no"}, {"op", "add"}})}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinRel(4000.0, 1e-9));
  // A 3D sketch has no region: an extrusion of it reports the missing outline.
  const RecomputeOutput bad = e.recompute(document({elbowPath(), feature("f", "extrude", {{"sketch", "p3"}, {"mode", "blind"}, {"depth", 10.0}, {"reverse", "no"}, {"op", "add"}})}));
  CHECK(errorOf(bad, "f") == "L'esquisse ne contient aucun contour fermé");
}

TEST_CASE("surface sweep along a 3D polyline: one face per path curve, named by path and profile curve", "[loft]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({segment("pr", 0), elbowPath(), surfaceSweep()}));
  INFO(errorOf(r, "sw"));
  REQUIRE(allOk(r));
  REQUIRE(r.bodies.size() == 1);
  CHECK(r.bodies[0].kind == BodyKind::Surface);
  CHECK(asSet(r.faceNames) == std::set<std::string>{"sw/side(k1|s1)", "sw/side(k2|s1)"});
  // Ribbon 10 wide: straight part 40 long, then a mitred elbow, then 30.
  CHECK(r.mass->area > 10 * 60);
  CHECK(r.mass->area < 10 * 80);
  CHECK(has(r.edgeNames, "e(sw/side(k1|s1)|sw/start)"));
  CHECK(has(r.edgeNames, "e(sw/end|sw/side(k2|s1))"));
}

TEST_CASE("surface sweep along a 3D spline: valid surface, names stable when the path changes", "[loft]") {
  Engine e;
  const RecomputeOutput a = e.recompute(document({segment("pr", 0), splinePath(30), surfaceSweep()}));
  REQUIRE(allOk(a));
  CHECK(asSet(a.faceNames) == std::set<std::string>{"sw/side(sp|s1)"});
  CHECK(a.mass->area > 10 * 100);
  const RecomputeOutput b = e.recompute(document({segment("pr", 0, 16), splinePath(45), surfaceSweep("frenet")}));
  REQUIRE(allOk(b));
  CHECK(asSet(a.faceNames) == asSet(b.faceNames));
  CHECK(asSet(a.edgeNames) == asSet(b.edgeNames));
  CHECK(e.resolveName("e(sw/end|sw/side(sp|s1))") >= 0);

  const RecomputeOutput fixedMode = e.recompute(document({segment("pr", 0), splinePath(30), surfaceSweep("fixed")}));
  CHECK(allOk(fixedMode));
  // Constant binormal: that of a 3D sketch (Z) is tangent to the start of the elbow; a 2D path in the XZ plane (normal -Y).
  CHECK(errorOf(e.recompute(document({segment("pr", 0), elbowPath(), surfaceSweep("binormal")})), "sw") ==
        "La binormale (normale de l'esquisse du chemin) est parallèle au chemin");
  Json xz = feature("p3", "sketch", {});
  xz["sketch"] = {{"frame", {{"origin", {0, 0, 0}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 0, 1}}, {"normal", {0, -1, 0}}}},
                  {"points", {{"a", {0, 0}}, {"b", {0, 40}}, {"c", {30, 70}}}},
                  {"curves", {{"k1", line("a", "b")}, {"k2", line("b", "c")}}},
                  {"regions", Json::array()},
                  {"chains", Json::array({chain({"k1", "k2"})})}};
  const RecomputeOutput binormal = e.recompute(document({segment("pr", 0), xz, surfaceSweep("binormal")}));
  INFO(errorOf(binormal, "sw"));
  CHECK(allOk(binormal));
  CHECK(asSet(binormal.faceNames) == std::set<std::string>{"sw/side(k1|s1)", "sw/side(k2|s1)"});
}

TEST_CASE("solid sweep: a 3D sketch as the path of a tube", "[loft]") {
  Engine e;
  // Oblique straight 3D line of length 50: tube Ø10/Ø6 = π (25 - 9) × 50.
  Json path = sketch3d("p3", {{"P0", {0, 0, 0}}, {"P1", {30, 0, 40}}}, {{"k1", line("P0", "P1")}}, Json::array({chain({"k1"})}));
  Json sweep = feature("sw", "sweep", {{"path", "p3"}, {"profile", "circle"}, {"diameter", 10.0}, {"inner", 6.0}, {"profileSketch", ""}, {"op", "add"}});
  const RecomputeOutput r = e.recompute(document({path, sweep}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinRel(std::numbers::pi * 16 * 50, 1e-6));
  CHECK(has(r.faceNames, "sw/side(k1|outer)"));
}

TEST_CASE("solid loft of three equal squares: the volume of a prism, end faces named", "[loft]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({square("s0", 0), square("s1", 20), square("s2", 40), loft("loft", "s0,s1,s2")}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinRel(20 * 20 * 40.0, 1e-6));
  CHECK(has(r.faceNames, "lf/start"));
  CHECK(has(r.faceNames, "lf/end"));
  CHECK(has(r.faceNames, "lf/side(q1)"));
  // Ruled loft: one face per span between two sections.
  const RecomputeOutput ruled = e.recompute(document({square("s0", 0), square("s1", 20, 30), square("s2", 40), loft("loft", "s0,s1,s2", "", "yes")}));
  REQUIRE(allOk(ruled));
  CHECK(has(ruled.faceNames, "lf/side(q1.0)"));
  CHECK(has(ruled.faceNames, "lf/side(q1.1)"));
}

TEST_CASE("surface loft: open tube or ribbon, names stable when a section moves", "[loft]") {
  Engine e;
  const RecomputeOutput a = e.recompute(document({square("s0", 0), square("s1", 20, 30), square("s2", 40), loft("surfaceLoft", "s0,s1,s2")}));
  REQUIRE(allOk(a));
  CHECK(a.bodies[0].kind == BodyKind::Surface);
  CHECK(a.mass->volume == 0);
  CHECK(asSet(a.faceNames) == std::set<std::string>{"lf/side(q1)", "lf/side(q2)", "lf/side(q3)", "lf/side(q4)"});
  CHECK(has(a.edgeNames, "e(lf/side(q1)|lf/start)"));
  CHECK(has(a.edgeNames, "e(lf/end|lf/side(q3))"));
  const RecomputeOutput b = e.recompute(document({square("s0", 0), square("s1", 35, 12), square("s2", 60), loft("surfaceLoft", "s0,s1,s2")}));
  REQUIRE(allOk(b));
  CHECK(asSet(a.faceNames) == asSet(b.faceNames));
  CHECK(asSet(a.edgeNames) == asSet(b.edgeNames));

  const RecomputeOutput ribbon = e.recompute(document({segment("s0", 0), segment("s1", 20, 20), loft("surfaceLoft", "s0,s1")}));
  REQUIRE(allOk(ribbon));
  // Planar trapezoid between the widths 10 and 20, 20 apart.
  CHECK_THAT(ribbon.mass->area, WithinRel(20 * (10 + 20) / 2.0, 1e-6));
}

TEST_CASE("loft of three sections guided by a 3D curve", "[loft]") {
  Engine e;
  // Equal squares at z = 0, 30, 60, guide straight along Z through their centres: the prism 20 × 20 × 60.
  Json guide = sketch3d("g", {{"G0", {0, 0, 0}}, {"G1", {0, 0, 60}}}, {{"k1", line("G0", "G1")}}, Json::array({chain({"k1"})}));
  const RecomputeOutput r = e.recompute(document({square("s0", 0), square("s1", 30), square("s2", 60), guide, loft("loft", "s0,s1,s2", "g")}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinRel(20 * 20 * 60.0, 1e-3));
  CHECK(has(r.faceNames, "lf/side(q1)"));
  CHECK(has(r.faceNames, "lf/start"));

  // Curved guide (spline in the XZ plane) and growing sections: valid surface, every face named.
  Json poles = Json::array({Json::array({0, 0, 0}), Json::array({0, 0, 20}), Json::array({10, 0, 40}), Json::array({10, 0, 60})});
  Json curved = sketch3d("g", {{"G0", {0, 0, 0}}, {"G1", {10, 0, 60}}},
                         {{"sp", {{"type", "bspline"}, {"poles", poles}, {"degree", 3}, {"knots", {0, 1}}, {"mults", {4, 4}}, {"a", "G0"}, {"b", "G1"}}}},
                         Json::array({chain({"sp"})}));
  const RecomputeOutput s = e.recompute(document({segment("s0", 0), segment("s1", 30, 16), segment("s2", 60, 12), curved, loft("surfaceLoft", "s0,s1,s2", "g")}));
  REQUIRE(allOk(s));
  CHECK(s.mass->area > 0);
  CHECK(std::none_of(s.faceNames.begin(), s.faceNames.end(), [](const std::string& n) { return n.find('#') != std::string::npos; }));
}

TEST_CASE("loft errors are explicit", "[loft]") {
  Engine e;
  CHECK(errorOf(e.recompute(document({square("s0", 0), loft("loft", "s0")})), "lf") == "Choisissez au moins deux esquisses de section");
  CHECK(errorOf(e.recompute(document({square("s0", 0), segment("s1", 20), loft("surfaceLoft", "s0,s1")})), "lf") ==
        "Les sections doivent être toutes ouvertes ou toutes fermées");
  CHECK(errorOf(e.recompute(document({square("s0", 0), segment("s1", 20), loft("loft", "s0,s1")})), "lf") ==
        "Le lissage volumique demande des sections fermées");
  CHECK(errorOf(e.recompute(document({square("s0", 0), loft("loft", "s0,nope")})), "lf") == "Esquisse introuvable ou en erreur");
  CHECK(errorOf(e.recompute(document({square("pr", 0), feature("sw", "surfaceSweep", {{"profile", "pr"}, {"path", "pr"}, {"orientation", "corrected"}})})), "sw") ==
        "Le chemin doit être une chaîne de l'esquisse (lignes, arcs ou splines bout à bout)");
}
