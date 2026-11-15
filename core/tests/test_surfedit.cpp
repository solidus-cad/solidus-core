// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Editing surfaces: extraction and knitting into a solid, offset, trim (plane, surface, mutual), extension then cut.
#include "part/features.hpp"
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <algorithm>
#include <numbers>
#include <set>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::WithinRel;

namespace {

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

/// Rectangle w × 40 at the origin (region l1..l4).
Json rectangle(double w = 60, std::string id = "rk") {
  Json region = {{"outer", {{"reverse", false}, {"curves", chain({"l1", "l2", "l3", "l4"})}}}, {"holes", Json::array()}};
  return sketchOf(std::move(id), {{"a", {0, 0}}, {"b", {w, 0}}, {"c", {w, 40}}, {"d", {0, 40}}},
                  {{"l1", line("a", "b")}, {"l2", line("b", "c")}, {"l3", line("c", "d")}, {"l4", line("d", "a")}}, Json::array(),
                  Json::array({region}));
}

/// Planar surface of the rectangle (body "ps", face "ps/plane(l1)").
Json plate() { return feature("ps", "planarSurface", {{"source", "sketch"}, {"sketch", "rk"}}); }

/// Open segment from (x, y0) to (x, y1) (curve m1), extruded symmetrically by `depth` along Z: vertical plane x = const.
std::vector<Json> wall(double x, double y0, double y1, double depth, std::string id = "sx") {
  Json sk = sketchOf("sk" + id, {{"p", {x, y0}}, {"q", {x, y1}}}, {{"m1", line("p", "q")}}, Json::array({chain({"m1"})}));
  return {sk, feature(id, "surfaceExtrude", {{"sketch", "sk" + id}, {"mode", "symmetric"}, {"depth", depth}, {"depth2", 0.0}, {"reverse", "no"}})};
}

Json named(const char* kind, const std::string& name, const char* group) {
  return {{"kind", kind}, {"name", name}, {"p", {1e5, 1e5, 1e5}}, {"size", 1}, {"group", group}};
}

Json docOf(const std::vector<Json>& features) {
  Json d = document({});
  for (const Json& f : features) d["features"].push_back(f);
  d["rollback"] = d["features"].size();
  return d;
}

bool allOk(const RecomputeOutput& r) {
  return std::all_of(r.statuses.begin(), r.statuses.end(), [](const FeatureStatus& s) { return s.ok; });
}

std::string errorOf(const RecomputeOutput& r, const std::string& id) {
  for (const FeatureStatus& s : r.statuses)
    if (s.id == id) return s.error;
  return "?";
}

double areaOf(const RecomputeOutput& r, const std::string& body) {
  for (const auto& [id, m] : r.bodyMass)
    if (id == body) return m.area;
  return -1;
}

bool has(const std::vector<std::string>& names, const std::string& n) { return std::find(names.begin(), names.end(), n) != names.end(); }

/// Trim of the plate by the plane x = 30 (`prepared.frame`, normal +X).
Json trimByPlane(const char* keep, double x = 30) {
  Json f = feature("tr", "trimSurface", {{"surface", "ps"}, {"toolKind", "plane"}, {"plane", "YZ"}, {"offset", x}, {"keep", keep}, {"mutual", "no"}});
  f["prepared"] = {{"frame", {{"origin", {x, 0, 0}}, {"normal", {1, 0, 0}}, {"xDir", {0, 1, 0}}, {"yDir", {0, 0, 1}}}}};
  return f;
}

}  // namespace

TEST_CASE("six faces of a box extracted one by one, then knitted into a solid", "[surfedit]") {
  Engine e;
  std::vector<Json> features{feature("bx", "box", {{"width", 20.0}, {"depth", 20.0}, {"height", 20.0}, {"x", 0.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}})};
  std::string ids;
  int k = 0;
  for (const char* face : {"bx/top", "bx/bottom", "bx/front", "bx/back", "bx/left", "bx/right"}) {
    const std::string id = "x" + std::to_string(++k);
    Json x = feature(id, "extractFaces", {});
    x["refs"] = Json::array({named("face", face, "faces")});
    features.push_back(x);
    ids += (ids.empty() ? "" : ",") + id;
  }
  features.push_back(feature("del", "deleteBody", {}));
  features.back()["body"] = "bx";
  features.push_back(feature("kn", "knitSurface", {{"surfaces", ids}, {"tolerance", 0.01}, {"solid", "yes"}}));
  const RecomputeOutput r = e.recompute(docOf(features));
  INFO(errorOf(r, "kn") << " / " << errorOf(r, "x1"));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinRel(8000.0, 1e-9));
  CHECK(has(r.faceNames, "kn/knit(x1/face(bx/top))"));
  CHECK(has(r.faceNames, "x1/face(bx/top)"));  // the extracted face stays in the part, consumed

  // Without the solid option: one closed surface; with five faces: open, no solid.
  features.back() = feature("kn", "knitSurface", {{"surfaces", ids.substr(0, ids.rfind(','))}, {"tolerance", 0.01}, {"solid", "yes"}});
  CHECK(errorOf(e.recompute(docOf(features)), "kn").rfind("La couture n'est pas fermée : 4 bord(s) libre(s)", 0) == 0);
  features.back() = feature("kn", "knitSurface", {{"surfaces", "x1"}, {"tolerance", 0.01}, {"solid", "no"}});
  CHECK(errorOf(e.recompute(docOf(features)), "kn") == "Choisissez au moins deux surfaces à coudre");
}

TEST_CASE("offset of a tube outward and inward", "[surfedit]") {
  Engine e;
  Json circle = sketchOf("sk", {{"o", {0, 0}}}, {{"c1", {{"type", "circle"}, {"c", "o"}, {"r", 10}}}}, Json::array(),
                         Json::array({{{"outer", {{"reverse", false}, {"curves", chain({"c1"})}}}, {"holes", Json::array()}}}));
  Json tube = feature("tb", "surfaceExtrude", {{"sketch", "sk"}, {"mode", "blind"}, {"depth", 30.0}, {"depth2", 0.0}, {"reverse", "no"}});
  for (const char* rev : {"no", "yes"}) {
    const RecomputeOutput r = e.recompute(docOf({circle, tube, feature("of", "offsetSurface", {{"surfaces", "tb"}, {"distance", 2.0}, {"reverse", rev}})}));
    INFO(errorOf(r, "of"));
    REQUIRE(allOk(r));
    CHECK(has(r.faceNames, "of/offset(tb/side(c1))"));
    // The side of the normal depends on the orientation of the tube: one offset is at radius 12, the other at 8.
    const double a = areaOf(r, "of");
    const bool outward = std::abs(a - 2 * std::numbers::pi * 12 * 30) < 1;
    const bool inward = std::abs(a - 2 * std::numbers::pi * 8 * 30) < 1;
    CHECK((outward || inward));
  }
}

TEST_CASE("trim by a plane: each side in turn, names and cut edge stable when the plate grows", "[surfedit]") {
  Engine e;
  const RecomputeOutput n = e.recompute(docOf({rectangle(), plate(), trimByPlane("normal")}));
  INFO(errorOf(n, "tr"));
  REQUIRE(allOk(n));
  CHECK_THAT(areaOf(n, "tr"), WithinRel(30 * 40.0, 1e-9));
  CHECK(n.faceNames.back() == "tr/trim(ps/plane(l1))");
  CHECK(has(n.edgeNames, "e(tr/cut(plane)|tr/trim(ps/plane(l1)))"));
  const RecomputeOutput r = e.recompute(docOf({rectangle(), plate(), trimByPlane("reverse")}));
  CHECK_THAT(areaOf(r, "tr"), WithinRel(30 * 40.0, 1e-9));

  const RecomputeOutput wide = e.recompute(docOf({rectangle(90), plate(), trimByPlane("normal")}));
  REQUIRE(allOk(wide));
  CHECK_THAT(areaOf(wide, "tr"), WithinRel(60 * 40.0, 1e-9));
  CHECK(std::set<std::string>(n.faceNames.begin(), n.faceNames.end()) == std::set<std::string>(wide.faceNames.begin(), wide.faceNames.end()));
  CHECK(std::set<std::string>(n.edgeNames.begin(), n.edgeNames.end()) == std::set<std::string>(wide.edgeNames.begin(), wide.edgeNames.end()));

  CHECK(errorOf(e.recompute(docOf({rectangle(), plate(), trimByPlane("normal", 200)})), "tr") == "L'outil ne coupe pas la surface");
}

TEST_CASE("trim by a surface, then mutual trim: an L of two half planes knitted together", "[surfedit]") {
  Engine e;
  std::vector<Json> base{rectangle(), plate()};
  for (Json& f : wall(30, -10, 50, 20)) base.push_back(f);
  auto with = [&](Json f) {
    std::vector<Json> all = base;
    all.push_back(std::move(f));
    return docOf(all);
  };
  const RecomputeOutput a = e.recompute(with(feature("tr", "trimSurface", {{"surface", "ps"}, {"toolKind", "body"}, {"tool", "sx"}, {"keep", "normal"}, {"mutual", "no"}})));
  const RecomputeOutput b = e.recompute(with(feature("tr", "trimSurface", {{"surface", "ps"}, {"toolKind", "body"}, {"tool", "sx"}, {"keep", "reverse"}, {"mutual", "no"}})));
  INFO(errorOf(a, "tr"));
  REQUIRE(allOk(a));
  REQUIRE(allOk(b));
  CHECK_THAT(areaOf(a, "tr") + areaOf(b, "tr"), WithinRel(60 * 40.0, 1e-9));
  CHECK(has(a.edgeNames, "e(tr/cut(sx/side(m1))|tr/trim(ps/plane(l1)))"));

  // Mutual: each surface must cross the other from edge to edge, here a wall as long as the plate (y from 0 to 40);
  // the wall is trimmed by the plate too (half of 40 × 20), both kept parts share the cut edge.
  base = {rectangle(), plate()};
  for (Json& f : wall(30, 0, 40, 20)) base.push_back(f);
  const RecomputeOutput m = e.recompute(with(feature("tr", "trimSurface", {{"surface", "ps"}, {"toolKind", "body"}, {"tool", "sx"}, {"keep", "normal"}, {"mutual", "yes"}, {"keepTool", "normal"}})));
  INFO(errorOf(m, "tr"));
  REQUIRE(allOk(m));
  CHECK_THAT(areaOf(m, "tr"), WithinRel(30 * 40.0 + 40 * 10.0, 1e-9));
  CHECK(has(m.faceNames, "tr/trim(sx/side(m1))"));
  CHECK(std::count_if(m.edgeNames.begin(), m.edgeNames.end(), [](const std::string& n) { return n == "e(tr/trim(ps/plane(l1))|tr/trim(sx/side(m1)))"; }) == 1);
}

TEST_CASE("a surface too short to cut a box, extended along its free side edges, then cuts it", "[surfedit]") {
  Engine e;
  // Box 100 × 60 × 40; vertical plane y = 30 from x = 20 to x = 80: it does not cross the box.
  std::vector<Json> features{block()};
  for (Json& f : wall(20, 30, 30, 100)) features.push_back(f);
  // The wall sketch is a segment along X here: from (20, 30) to (80, 30).
  features[1]["sketch"]["points"] = {{"p", {20, 30}}, {"q", {80, 30}}};
  const Json cut = feature("cs", "cutWithSurface", {{"surface", "sx"}, {"keep", "normal"}});
  std::vector<Json> short_ = features;
  short_.push_back(cut);
  CHECK_FALSE(errorOf(e.recompute(docOf(short_)), "cs").empty());

  // Free side edges at x = 20 and x = 80 (designated by their geometry), extended by 30 tangentially.
  Json ext = feature("ex", "extendSurface", {{"length", 30.0}, {"mode", "linear"}});
  ext["refs"] = Json::array({{{"kind", "edge"}, {"p", {20, 30, 0}}, {"size", 100}, {"group", "edges"}}, {{"kind", "edge"}, {"p", {80, 30, 0}}, {"size", 100}, {"group", "edges"}}});
  features.push_back(ext);
  const RecomputeOutput grown = e.recompute(docOf(features));
  INFO(errorOf(grown, "ex"));
  REQUIRE(allOk(grown));
  CHECK_THAT(areaOf(grown, "ex"), WithinRel(120 * 100.0, 1e-6));
  CHECK(has(grown.faceNames, "ex/extend(sx/side(m1))"));
  features.push_back(feature("cs", "cutWithSurface", {{"surface", "ex"}, {"keep", "normal"}}));
  const RecomputeOutput r = e.recompute(docOf(features));
  INFO(errorOf(r, "cs"));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinRel(100 * 30 * 40.0, 1e-6));

  // Natural extension of a plane: the same plane, larger.
  features[features.size() - 2]["params"]["mode"] = "natural";
  features.pop_back();
  CHECK_THAT(areaOf(e.recompute(docOf(features)), "ex"), WithinRel(120 * 100.0, 1e-6));
}
