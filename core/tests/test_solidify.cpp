// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// From surface to solid: thicken, close into a volume, cut with a surface, replace a face.
#include "part/features.hpp"
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <BRepCheck_Analyzer.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>

#include <algorithm>
#include <array>
#include <numbers>
#include <set>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::ContainsSubstring;
using Catch::Matchers::WithinAbs;

namespace {

/// Sketch plane XY, or XZ-like plane (u = x, v = -z, normal +y): its curves extrude along y.
Json planeXY() { return {{"origin", {0, 0, 0}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 1, 0}}, {"normal", {0, 0, 1}}}; }
Json planeXZ() { return {{"origin", {0, 0, 0}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 0, -1}}, {"normal", {0, 1, 0}}}; }

Json line(const char* p1, const char* p2) { return {{"type", "line"}, {"p1", p1}, {"p2", p2}}; }
Json chain(std::initializer_list<const char*> ids) {
  Json c = Json::array();
  for (const char* id : ids) c.push_back({{"id", id}, {"reversed", false}});
  return c;
}

Json sketchOf(std::string id, Json frame, Json points, Json curves, Json chains, Json regions = Json::array()) {
  Json f = feature(std::move(id), "sketch", {});
  f["sketch"] = {{"frame", std::move(frame)}, {"points", std::move(points)}, {"curves", std::move(curves)}, {"regions", std::move(regions)}, {"chains", std::move(chains)}};
  return f;
}

/// Sketch of a single segment.
Json segment(std::string id, Json frame, std::array<double, 2> a, std::array<double, 2> b) {
  return sketchOf(std::move(id), std::move(frame), {{"a", {a[0], a[1]}}, {"b", {b[0], b[1]}}}, {{"l1", line("a", "b")}}, Json::array({chain({"l1"})}));
}

Json extruded(std::string id, const char* sketch, double depth, const char* mode = "blind") {
  return feature(std::move(id), "surfaceExtrude", {{"sketch", sketch}, {"mode", mode}, {"depth", depth}, {"depth2", 0.0}, {"reverse", "no"}});
}

/// Plane z = `z`, from x = -200 to x = 300 (reversed: opposite normal), wide enough to cross the block.
Json planeSketch(double z, bool reversed = false) {
  return reversed ? segment("sk", planeXZ(), {300, -z}, {-200, -z}) : segment("sk", planeXZ(), {-200, -z}, {300, -z});
}
Json planeSurface() { return extruded("sx", "sk", 400, "symmetric"); }

Json box(double height = 40, double width = 100) {
  return feature("bx", "box", {{"width", width}, {"depth", 60.0}, {"height", height}, {"x", 0.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
}

Json thicken(const char* side, double t = 2, const char* op = "new", const char* surfaces = "sx") {
  return feature("th", "thicken", {{"surfaces", surfaces}, {"thickness", t}, {"side", side}, {"op", op}});
}

Json cutBy(const char* keep, const char* surface = "sx") { return feature("cs", "cutWithSurface", {{"surface", surface}, {"keep", keep}}); }

/// Reference by name: the point is far away, so a name that no longer resolves is an error instead of a geometric match.
Json named(const char* kind, const std::string& name, const char* group = nullptr) {
  Json r = {{"kind", kind}, {"name", name}, {"p", {1e5, 1e5, 1e5}}, {"size", 1}};
  if (group) r["group"] = group;
  return r;
}

Json replaceTop() {
  Json f = feature("rp", "replaceFace", {});
  f["refs"] = Json::array({named("face", "bx/top", "faces"), named("face", "sx/side(l1)", "surface")});
  return f;
}

Json filletOn(const std::string& edge, double radius = 2) {
  Json f = feature("fl", "fillet", {{"radius", radius}});
  f["refs"] = Json::array({named("edge", edge)});
  return f;
}

bool allOk(const RecomputeOutput& r) {
  return std::all_of(r.statuses.begin(), r.statuses.end(), [](const FeatureStatus& s) { return s.ok; });
}

std::string errorOf(const RecomputeOutput& r, const std::string& id) {
  for (const FeatureStatus& s : r.statuses)
    if (s.id == id) return s.error;
  return "?";
}

bool hasName(const std::vector<std::string>& names, const std::string& word) {
  return std::any_of(names.begin(), names.end(), [&](const std::string& n) { return n.find(word) != std::string::npos; });
}

/// First edge whose name contains `word` (and `other`, if given).
std::string edgeWith(const RecomputeOutput& r, const std::string& word, const std::string& other = "") {
  for (const std::string& n : r.edgeNames)
    if (n.find(word) != std::string::npos && n.find(other) != std::string::npos) return n;
  return "";
}

int solidCount(const Engine& e) {
  TopTools_IndexedMapOfShape solids;
  TopExp::MapShapes(*e.partShape(""), TopAbs_SOLID, solids);
  return solids.Extent();
}

}  // namespace

TEST_CASE("thicken: a plane gives a box, on the chosen side", "[solidify]") {
  Engine e;
  Json sk = segment("sk", planeXY(), {0, 0}, {60, 0});
  const RecomputeOutput r = e.recompute(document({sk, extruded("sx", "sk", 30), thicken("normal", 2)}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(60.0 * 30 * 2, 1e-6));
  const double normalSide = r.mass->center[1];
  CHECK_THAT(std::abs(normalSide), WithinAbs(1, 1e-6));
  REQUIRE(e.partShape(""));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());

  const RecomputeOutput rev = e.recompute(document({sk, extruded("sx", "sk", 30), thicken("reverse", 2)}));
  REQUIRE(allOk(rev));
  CHECK_THAT(rev.mass->center[1], WithinAbs(-normalSide, 1e-6));

  const RecomputeOutput sym = e.recompute(document({sk, extruded("sx", "sk", 30), thicken("symmetric", 3)}));
  REQUIRE(allOk(sym));
  CHECK_THAT(sym.mass->volume, WithinAbs(60.0 * 30 * 3, 1e-6));
  CHECK_THAT(sym.mass->center[1], WithinAbs(0, 1e-6));
}

TEST_CASE("thicken: names of the skins and walls, consumed surface", "[solidify]") {
  Engine e;
  Json sk = segment("sk", planeXY(), {0, 0}, {60, 0});
  const RecomputeOutput r = e.recompute(document({sk, extruded("sx", "sk", 30), thicken("normal", 2)}));
  REQUIRE(allOk(r));
  CHECK(hasName(r.faceNames, "th/base(sx/side(l1))"));
  CHECK(hasName(r.faceNames, "th/thick(sx/side(l1))"));
  CHECK(hasName(r.faceNames, "th/wall(e(sx/side(l1)|sx/start))"));
  CHECK(hasName(r.faceNames, "th/wall(e(sx/end|sx/side(l1)))"));
  // The surface stays in the part, consumed: outside the part as seen from outside.
  REQUIRE(r.bodies.size() == 2);
  const auto surface = std::find_if(r.bodies.begin(), r.bodies.end(), [](const auto& b) { return b.id == "sx"; });
  REQUIRE(surface != r.bodies.end());
  CHECK(surface->consumed);
  CHECK(solidCount(e) == 1);
  CHECK(r.activeBody == "th");
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(*e.partShape(""), TopAbs_FACE, faces);
  CHECK(faces.Extent() == 6);
}

TEST_CASE("thicken: sharp corner of an L, cylinder, add and cut", "[solidify]") {
  Engine e;
  // L of 60 + 40, 30 high, 2 thick: the mitred corner adds or removes a 2 × 2 square depending on the side.
  Json elbow = sketchOf("sk", planeXY(), {{"O", {0, 0}}, {"b", {60, 0}}, {"c", {60, 40}}}, {{"l1", line("O", "b")}, {"l2", line("b", "c")}}, Json::array({chain({"l1", "l2"})}));
  const RecomputeOutput n = e.recompute(document({elbow, extruded("sx", "sk", 30), thicken("normal", 2)}));
  REQUIRE(allOk(n));
  const RecomputeOutput v = e.recompute(document({elbow, extruded("sx", "sk", 30), thicken("reverse", 2)}));
  REQUIRE(allOk(v));
  const double inner = (60.0 * 2 + 40 * 2 - 4) * 30, outer = (60.0 * 2 + 40 * 2 + 4) * 30;
  CHECK_THAT(std::min(n.mass->volume, v.mass->volume), WithinAbs(inner, 1e-3));
  CHECK_THAT(std::max(n.mass->volume, v.mass->volume), WithinAbs(outer, 1e-3));
  const double area = 2 * (60.0 * 30 + 40 * 30);
  CHECK(n.mass->area > area);
  CHECK(hasName(n.faceNames, "th/thick(sx/side(l2))"));

  // Line x = 20 revolved around y: tube of radius 20 to 22, or 18 to 20.
  Json sk = segment("sk", planeXY(), {20, 0}, {20, 40});
  Json revolve = feature("sx", "surfaceRevolve", {{"sketch", "sk"}, {"axis", "axis:V"}, {"angle", 360.0}});
  const RecomputeOutput c = e.recompute(document({sk, revolve, thicken("normal", 2)}));
  const RecomputeOutput d = e.recompute(document({sk, revolve, thicken("reverse", 2)}));
  REQUIRE(allOk(c));
  REQUIRE(allOk(d));
  const double small = std::numbers::pi * (400.0 - 324) * 40, large = std::numbers::pi * (484.0 - 400) * 40;
  CHECK_THAT(std::min(c.mass->volume, d.mass->volume), WithinAbs(small, 1e-1));
  CHECK_THAT(std::max(c.mass->volume, d.mass->volume), WithinAbs(large, 1e-1));

  // Plate of the plane z = 40, added on top of the block (reversed or not, the sum tells the side), or removed from it.
  Json plate = segment("sk", planeXZ(), {0, -40}, {100, -40});
  Json inPlace = feature("sx", "surfaceExtrude", {{"sketch", "sk"}, {"mode", "blind"}, {"depth", 60.0}, {"depth2", 0.0}, {"reverse", "no"}});
  const RecomputeOutput up = e.recompute(document({box(), plate, inPlace, thicken("normal", 5, "add")}));
  const RecomputeOutput dn = e.recompute(document({box(), plate, inPlace, thicken("reverse", 5, "add")}));
  REQUIRE(allOk(up));
  REQUIRE(allOk(dn));
  CHECK_THAT(up.mass->volume + dn.mass->volume, WithinAbs(2 * 100.0 * 60 * 40 + 100.0 * 60 * 5, 1e-3));
  const RecomputeOutput cut = e.recompute(document({box(), plate, inPlace, thicken("normal", 5, "cut")}));
  const RecomputeOutput cut2 = e.recompute(document({box(), plate, inPlace, thicken("reverse", 5, "cut")}));
  REQUIRE(allOk(cut));
  REQUIRE(allOk(cut2));
  CHECK_THAT(cut.mass->volume + cut2.mass->volume, WithinAbs(2 * 100.0 * 60 * 40 - 100.0 * 60 * 5, 1e-3));
}

TEST_CASE("thicken: explicit errors", "[solidify]") {
  Engine e;
  Json sk = segment("sk", planeXY(), {0, 0}, {60, 0});
  Json farSketch = segment("sk2", planeXY(), {0, 500}, {60, 500});
  CHECK(errorOf(e.recompute(document({box(), thicken("normal", 2, "new", "")})), "th") == "Choisissez au moins une surface");
  CHECK(errorOf(e.recompute(document({box(), thicken("normal", 2, "new", "bx")})), "th") == "Un corps choisi n'est pas une surface");
  CHECK(errorOf(e.recompute(document({sk, thicken("normal", 2, "new", "gone")})), "th") == "Corps introuvable");
  CHECK(errorOf(e.recompute(document({sk, farSketch, extruded("sx", "sk", 30), extruded("sy", "sk2", 30), thicken("normal", 2, "new", "sx,sy")})), "th") ==
        "Les surfaces à épaissir doivent former un seul morceau");
  // Thicker than the radius of a tube, inwards.
  Json tube = segment("sk", planeXY(), {20, 0}, {20, 40});
  Json revolve = feature("sx", "surfaceRevolve", {{"sketch", "sk"}, {"axis", "axis:V"}, {"angle", 360.0}});
  const RecomputeOutput a = e.recompute(document({tube, revolve, thicken("normal", 30)}));
  const RecomputeOutput b = e.recompute(document({tube, revolve, thicken("reverse", 30)}));
  CHECK((errorOf(a, "th").rfind("L'épaississement a échoué", 0) == 0 || errorOf(b, "th").rfind("L'épaississement a échoué", 0) == 0));
}

namespace {

/// Open tube 60 × 40, z from 0 to 30 (body "tb"), with its bottom and top caps (bodies "lo" and "hi").
std::vector<Json> tubeAndCaps(bool withTop = true) {
  Json region = {{"outer", {{"reverse", false}, {"curves", chain({"l1", "l2", "l3", "l4"})}}}, {"holes", Json::array()}};
  Json outline = sketchOf("sk", planeXY(), {{"O", {0, 0}}, {"b", {60, 0}}, {"c", {60, 40}}, {"d", {0, 40}}},
                          {{"l1", line("O", "b")}, {"l2", line("b", "c")}, {"l3", line("c", "d")}, {"l4", line("d", "O")}}, Json::array(),
                          Json::array({region}));
  std::vector<Json> out{outline, extruded("tb", "sk", 30), segment("kl", planeXZ(), {0, 0}, {60, 0}), extruded("lo", "kl", 40)};
  if (withTop) {
    out.push_back(segment("kh", planeXZ(), {0, -30}, {60, -30}));
    out.push_back(extruded("hi", "kh", 40));
  }
  return out;
}

Json docOf(std::vector<Json> features) {
  Json d = document({});
  for (Json& f : features) d["features"].push_back(std::move(f));
  d["rollback"] = d["features"].size();
  return d;
}

}  // namespace

TEST_CASE("close: a tube and two caps give a solid", "[solidify]") {
  Engine e;
  std::vector<Json> doc = tubeAndCaps();
  doc.push_back(feature("cl", "closeSurface", {{"surfaces", "tb,lo,hi"}, {"op", "new"}}));
  const RecomputeOutput r = e.recompute(docOf(doc));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(60.0 * 40 * 30, 1e-6));
  CHECK(solidCount(e) == 1);
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());
  CHECK(hasName(r.faceNames, "cl/closed(tb/side(l1))"));
  CHECK(hasName(r.faceNames, "cl/closed(hi/side(l1))"));
  CHECK(r.activeBody == "cl");

  std::vector<Json> open = tubeAndCaps(false);
  open.push_back(feature("cl", "closeSurface", {{"surfaces", "tb,lo"}, {"op", "new"}}));
  CHECK(errorOf(e.recompute(docOf(open)), "cl") == "Les surfaces ne ferment pas un volume : 4 bord(s) libre(s)");
}

TEST_CASE("cut with a surface: volumes on each side, side given by the normal", "[solidify]") {
  Engine e;
  const double total = 100.0 * 60 * 40, under = 100.0 * 60 * 15;
  const RecomputeOutput n = e.recompute(document({box(), planeSketch(15), planeSurface(), cutBy("normal")}));
  const RecomputeOutput v = e.recompute(document({box(), planeSketch(15), planeSurface(), cutBy("reverse")}));
  REQUIRE(allOk(n));
  REQUIRE(allOk(v));
  CHECK_THAT(n.mass->volume + v.mass->volume, WithinAbs(total, 1e-6));
  CHECK_THAT(std::min(n.mass->volume, v.mass->volume), WithinAbs(under, 1e-6));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());
  CHECK(hasName(n.faceNames, "cs/cut(sx/side(l1))"));

  // The opposite curve direction flips the normal, so the side kept.
  const RecomputeOutput flipped = e.recompute(document({box(), planeSketch(15, true), planeSurface(), cutBy("normal")}));
  REQUIRE(allOk(flipped));
  CHECK_THAT(flipped.mass->volume, WithinAbs(v.mass->volume, 1e-6));

  // Both sides: two bodies, the target keeps the normal side.
  const RecomputeOutput both = e.recompute(document({box(), planeSketch(15), planeSurface(), cutBy("both")}));
  REQUIRE(allOk(both));
  CHECK_THAT(both.mass->volume, WithinAbs(total, 1e-6));
  CHECK(both.partBodies == std::vector<std::string>{"bx", "sx", "cs"});
  REQUIRE(both.bodyMass.size() >= 2);
  CHECK_THAT(both.bodyMass[0].second.volume, WithinAbs(n.mass->volume, 1e-6));
  CHECK(solidCount(e) == 2);
}

TEST_CASE("cut with a curved surface", "[solidify]") {
  Engine e;
  // Arc-free bent surface: V-shaped profile crossing the block.
  Json vee = sketchOf("sk", planeXZ(), {{"a", {-100, -30}}, {"b", {50, -10}}, {"c", {200, -30}}}, {{"l1", line("a", "b")}, {"l2", line("b", "c")}}, Json::array({chain({"l1", "l2"})}));
  const RecomputeOutput n = e.recompute(document({box(), vee, planeSurface(), cutBy("normal")}));
  const RecomputeOutput v = e.recompute(document({box(), vee, planeSurface(), cutBy("reverse")}));
  REQUIRE(allOk(n));
  REQUIRE(allOk(v));
  // z under the V at x: 10 + (|x - 50| / 150) * 20; mean over the block (|x - 50| from 0 to 50): 10 + 10 / 3.
  const double under = 100.0 * 60 * (10 + 10.0 / 3);
  CHECK_THAT(n.mass->volume + v.mass->volume, WithinAbs(100.0 * 60 * 40, 1e-6));
  CHECK_THAT(std::min(n.mass->volume, v.mass->volume), WithinAbs(under, 1e-3));
}

TEST_CASE("cut with a surface: explicit errors", "[solidify]") {
  Engine e;
  const char* notCrossing = "La surface ne traverse pas le solide : prolongez-la au-delà de ses bords";
  // Stops in the middle of the block, or misses it.
  Json part = segment("sk", planeXZ(), {-50, -15}, {50, -15});
  CHECK(errorOf(e.recompute(document({box(), part, planeSurface(), cutBy("normal")})), "cs") == notCrossing);
  CHECK(errorOf(e.recompute(document({box(), planeSketch(100), planeSurface(), cutBy("normal")})), "cs") == notCrossing);
  CHECK(errorOf(e.recompute(document({box(), planeSketch(15), planeSurface(), cutBy("normal", "")})), "cs") == "Choisissez au moins une surface");
  CHECK(errorOf(e.recompute(document({box(), planeSketch(15), planeSurface(), cutBy("normal", "bx")})), "cs") == "Un corps choisi n'est pas une surface");
  Json other = segment("sk2", planeXZ(), {-200, -20}, {300, -20});
  CHECK(errorOf(e.recompute(document({box(), planeSketch(15), planeSurface(), other, extruded("sy", "sk2", 400, "symmetric"), cutBy("normal", "sx,sy")})), "cs") ==
        "Choisissez une seule surface");
}

TEST_CASE("cut with a surface: a fillet on the cut survives a dimension change", "[solidify]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box(), planeSketch(15), planeSurface(), cutBy("normal")}));
  REQUIRE(allOk(r));
  const std::string edge = edgeWith(r, "cs/cut(");
  REQUIRE(!edge.empty());
  const RecomputeOutput a = e.recompute(document({box(), planeSketch(15), planeSurface(), cutBy("normal"), filletOn(edge)}));
  const RecomputeOutput b = e.recompute(document({box(40, 130), planeSketch(25), planeSurface(), cutBy("normal"), filletOn(edge)}));
  REQUIRE(allOk(a));
  REQUIRE(allOk(b));
  CHECK(a.mass->volume < r.mass->volume);
  CHECK(b.mass->volume != a.mass->volume);
}

TEST_CASE("replace a face: surface above, below, crossing", "[solidify]") {
  Engine e;
  const double base = 100.0 * 60;
  const RecomputeOutput up = e.recompute(document({box(), planeSketch(50), planeSurface(), replaceTop()}));
  REQUIRE(allOk(up));
  CHECK_THAT(up.mass->volume, WithinAbs(base * 50, 1e-6));
  CHECK(hasName(up.faceNames, "rp/replace(bx/top)"));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());
  // The block stays a box: the side walls of the column merge with the sides of the block.
  CHECK(std::count_if(up.faceNames.begin(), up.faceNames.end(), [](const std::string& n) { return n.rfind("bx/", 0) == 0; }) == 5);

  const RecomputeOutput dn = e.recompute(document({box(), planeSketch(30), planeSurface(), replaceTop()}));
  REQUIRE(allOk(dn));
  CHECK_THAT(dn.mass->volume, WithinAbs(base * 30, 1e-6));
  CHECK(hasName(dn.faceNames, "rp/replace(bx/top)"));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());

  // Plane through the middle of the top, sloping 1 in 5: as much added on one side as removed on the other.
  Json slope = segment("sk", planeXZ(), {-200, 10}, {300, -90});
  const RecomputeOutput across = e.recompute(document({box(), slope, planeSurface(), replaceTop()}));
  REQUIRE(allOk(across));
  CHECK_THAT(across.mass->volume, WithinAbs(base * 40, 1e-6));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());
  // The two pieces of a plane are coplanar: they merge into a single face, and the block keeps six faces.
  CHECK(hasName(across.faceNames, "rp/replace(bx/top)"));
  CHECK(across.faceNames.size() == 7);
  CHECK(solidCount(e) == 1);
  // The surface is consumed.
  const auto surface = std::find_if(across.bodies.begin(), across.bodies.end(), [](const auto& b) { return b.id == "sx"; });
  REQUIRE(surface != across.bodies.end());
  CHECK(surface->consumed);
}

TEST_CASE("replace a face: top of a boss, bottom of a pocket", "[solidify]") {
  Engine e;
  // Boss 20 × 20 × 10 on the block: only its top goes up to the surface, z = 60.
  Json boss = feature("bs", "box", {{"width", 20.0}, {"depth", 20.0}, {"height", 10.0}, {"x", 40.0}, {"y", 20.0}, {"z", 40.0}, {"op", "add"}});
  Json onBoss = replaceTop();
  onBoss["refs"][0] = named("face", "bs/top", "faces");
  const RecomputeOutput r = e.recompute(document({box(), boss, planeSketch(60), planeSurface(), onBoss}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(100.0 * 60 * 40 + 20.0 * 20 * 20, 1e-6));

  // Pocket 20 × 20 × 10: its bottom rises to z = 35, its walls are kept.
  Json pocket = feature("bs", "box", {{"width", 20.0}, {"depth", 20.0}, {"height", 10.0}, {"x", 40.0}, {"y", 20.0}, {"z", 30.0}, {"op", "cut"}});
  Json onPocket = replaceTop();
  onPocket["refs"][0] = named("face", "bs/bottom", "faces");
  const RecomputeOutput q = e.recompute(document({box(), pocket, planeSketch(35), planeSurface(), onPocket}));
  REQUIRE(allOk(q));
  CHECK_THAT(q.mass->volume, WithinAbs(100.0 * 60 * 40 - 20.0 * 20 * 5, 1e-6));
}

TEST_CASE("replace a face: a fillet on the new face survives a dimension change", "[solidify]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box(), planeSketch(50), planeSurface(), replaceTop()}));
  REQUIRE(allOk(r));
  const std::string edge = edgeWith(r, "rp/replace(bx/top)");
  REQUIRE(!edge.empty());
  const RecomputeOutput a = e.recompute(document({box(), planeSketch(50), planeSurface(), replaceTop(), filletOn(edge)}));
  const RecomputeOutput b = e.recompute(document({box(30), planeSketch(55), planeSurface(), replaceTop(), filletOn(edge)}));
  REQUIRE(allOk(a));
  REQUIRE(allOk(b));
  CHECK(a.mass->volume < r.mass->volume);
  // Same fillet on the same edge, so the same material removed.
  CHECK_THAT(100.0 * 60 * 55 - b.mass->volume, WithinAbs(r.mass->volume - a.mass->volume, 1e-3));
}

TEST_CASE("replace a face: explicit errors", "[solidify]") {
  Engine e;
  const char* notCovered = "La surface ne couvre pas toute la face à remplacer : prolongez-la";
  // The surface covers only part of the top.
  Json part = segment("sk", planeXZ(), {10, -50}, {90, -50});
  CHECK(errorOf(e.recompute(document({box(), part, planeSurface(), replaceTop()})), "rp") == notCovered);
  // Narrow in y.
  Json narrow = extruded("sx", "sk", 20, "symmetric");
  CHECK(errorOf(e.recompute(document({box(), planeSketch(50), narrow, replaceTop()})), "rp") == notCovered);

  Json none = feature("rp", "replaceFace", {});
  CHECK(errorOf(e.recompute(document({box(), planeSketch(50), planeSurface(), none})), "rp") == "Choisissez les faces à remplacer");
  Json noSurface = replaceTop();
  noSurface["refs"].erase(1);
  CHECK(errorOf(e.recompute(document({box(), planeSketch(50), planeSurface(), noSurface})), "rp") == "Choisissez une seule surface de remplacement");
  Json onSolid = replaceTop();
  onSolid["refs"][1] = named("face", "bx/bottom", "surface");
  CHECK(errorOf(e.recompute(document({box(), planeSketch(50), planeSurface(), onSolid})), "rp") == "La face de remplacement doit appartenir à une surface");
  // The surface is on the plane of the face.
  CHECK_THAT(errorOf(e.recompute(document({box(), planeSketch(40), planeSurface(), replaceTop()})), "rp"), ContainsSubstring("La surface"));
}
