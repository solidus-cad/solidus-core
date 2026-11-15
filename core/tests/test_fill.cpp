// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Planar surface and fill surface: holes plugged then closed into a solid, G1 fill between four surfaces, naming, errors.
#include "part/features.hpp"
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
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
Json region(std::initializer_list<const char*> ids) { return {{"outer", {{"reverse", false}, {"curves", chain(ids)}}}, {"holes", Json::array()}}; }

/// Rectangle 60 × 40 (region l1..l4).
Json rectangle() {
  return sketchOf("sk", {{"O", {0, 0}}, {"b", {60, 0}}, {"c", {60, 40}}, {"d", {0, 40}}},
                  {{"l1", line("O", "b")}, {"l2", line("b", "c")}, {"l3", line("c", "d")}, {"l4", line("d", "O")}}, Json::array(),
                  Json::array({region({"l1", "l2", "l3", "l4"})}));
}

/// Circle of radius 10 at the origin (region c1).
Json circle() {
  return sketchOf("sk", {{"O", {0, 0}}}, {{"c1", {{"type", "circle"}, {"c", "O"}, {"r", 10}}}}, Json::array(), Json::array({region({"c1"})}));
}

Json tube(double depth = 30, std::string id = "tb", std::string sketch = "sk") {
  return feature(std::move(id), "surfaceExtrude", {{"sketch", std::move(sketch)}, {"mode", "blind"}, {"depth", depth}, {"depth2", 0.0}, {"reverse", "no"}});
}

/// Reference by name in a group; `choice`: per-element setting.
Json named(const char* kind, const std::string& name, const char* group, const char* choice = nullptr) {
  Json r = {{"kind", kind}, {"name", name}, {"p", {1e5, 1e5, 1e5}}, {"size", 1}, {"group", group}};
  if (choice) r["choice"] = choice;
  return r;
}

/// Top (end) and bottom (start) edges of the tube `tb` from the curves `curves`.
std::vector<std::string> rim(const std::vector<std::string>& curves, bool top, const std::string& id = "tb") {
  std::vector<std::string> out;
  for (const std::string& c : curves)
    out.push_back(top ? "e(" + id + "/end|" + id + "/side(" + c + "))" : "e(" + id + "/side(" + c + ")|" + id + "/start)");
  return out;
}

Json onEdges(std::string id, std::string type, const std::vector<std::string>& edges, const char* choice = nullptr, Json params = Json::object()) {
  Json f = feature(std::move(id), std::move(type), {});
  for (const auto& [k, v] : params.items()) f["params"][k] = v;
  f["refs"] = Json::array();
  for (const std::string& e : edges) f["refs"].push_back(named("edge", e, "edges", choice));
  return f;
}

Json planar(std::string id, const std::vector<std::string>& edges) { return onEdges(std::move(id), "planarSurface", edges, nullptr, {{"source", "edges"}}); }
Json filled(std::string id, const std::vector<std::string>& edges, const char* choice) {
  return onEdges(std::move(id), "fillSurface", edges, choice, {{"usePoints", "no"}, {"quality", "normal"}});
}

bool allOk(const RecomputeOutput& r) {
  return std::all_of(r.statuses.begin(), r.statuses.end(), [](const FeatureStatus& s) { return s.ok; });
}

std::string errorOf(const RecomputeOutput& r, const std::string& id) {
  for (const FeatureStatus& s : r.statuses)
    if (s.id == id) return s.error;
  return "?";
}

bool has(const std::vector<std::string>& names, const std::string& n) { return std::find(names.begin(), names.end(), n) != names.end(); }

const std::vector<std::string> kRect{"l1", "l2", "l3", "l4"};

}  // namespace

TEST_CASE("rectangular hole plugged by planar surfaces on the free edges, then closed into a solid", "[fill]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({rectangle(), tube(), planar("pt", rim(kRect, true)), planar("pb", rim(kRect, false))}));
  INFO(errorOf(r, "pt") << " / " << errorOf(r, "pb"));
  REQUIRE(allOk(r));
  CHECK(has(r.faceNames, "pt/plane"));
  CHECK(has(r.edgeNames, "e(pt/plane|pt/rim(e(tb/end|tb/side(l1))))"));
  const RecomputeOutput closed = e.recompute(document({rectangle(), tube(), planar("pt", rim(kRect, true)), planar("pb", rim(kRect, false)),
                                                       feature("cl", "closeSurface", {{"surfaces", "tb,pt,pb"}, {"op", "new"}})}));
  INFO(errorOf(closed, "cl"));
  REQUIRE(allOk(closed));
  CHECK_THAT(closed.mass->volume, WithinRel(60 * 40 * 30.0, 1e-6));
}

TEST_CASE("planar surface of the regions of a sketch", "[fill]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({rectangle(), feature("ps", "planarSurface", {{"source", "sketch"}, {"sketch", "sk"}})}));
  REQUIRE(allOk(r));
  CHECK(r.bodies[0].kind == BodyKind::Surface);
  CHECK(r.faceNames == std::vector<std::string>{"ps/plane(l1)"});
  CHECK(has(r.edgeNames, "e(ps/plane(l1)|ps/rim(l3))"));
  CHECK_THAT(r.mass->area, WithinRel(60 * 40.0, 1e-9));
}

TEST_CASE("circular hole plugged by fills at both ends, then closed into a solid", "[fill]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({circle(), tube(), filled("ft", rim({"c1"}, true), "G0"), filled("fb", rim({"c1"}, false), "G0")}));
  INFO(errorOf(r, "ft"));
  REQUIRE(allOk(r));
  CHECK(has(r.faceNames, "ft/fill"));
  CHECK(has(r.edgeNames, "e(ft/fill|ft/rim(e(tb/end|tb/side(c1))))"));
  // A G0 fill of a planar circle is the disc.
  const RecomputeOutput closed = e.recompute(document({circle(), tube(), filled("ft", rim({"c1"}, true), "G0"), filled("fb", rim({"c1"}, false), "G0"),
                                                       feature("cl", "closeSurface", {{"surfaces", "tb,ft,fb"}, {"op", "new"}})}));
  INFO(errorOf(closed, "cl"));
  REQUIRE(allOk(closed));
  CHECK_THAT(closed.mass->volume, WithinRel(std::numbers::pi * 100 * 30, 1e-3));
}

TEST_CASE("G1 fill between four surfaces: tangent to the walls, bulging above the flat G0 patch", "[fill]") {
  Engine e;
  // Four quarters of a cone frustum (radius 20 at z = 0, 15 at z = 10), each one a surface revolved by 90° around Z
  // from a sketch turned by k × 90°. Their top arcs bound a circular opening of radius 15.
  std::vector<Json> features;
  Json refs = Json::array();
  for (int k = 0; k < 4; k++) {
    const double a = k * std::numbers::pi / 2;
    const std::string id = std::to_string(k + 1);
    Json sk = feature("sk" + id, "sketch", {});
    sk["sketch"] = {{"frame", {{"origin", {0, 0, 0}}, {"xDir", {std::cos(a), std::sin(a), 0}}, {"yDir", {0, 0, 1}}, {"normal", {std::sin(a), -std::cos(a), 0}}}},
                    {"points", {{"a", {20, 0}}, {"b", {15, 10}}}},
                    {"curves", {{"g", line("a", "b")}}},
                    {"regions", Json::array()},
                    {"chains", Json::array({chain({"g"})})}};
    features.push_back(sk);
    features.push_back(feature("rv" + id, "surfaceRevolve", {{"sketch", "sk" + id}, {"axis", "axis:V"}, {"angle", 90.0}}));
    // Top arc of the quarter, designated by its geometry (midpoint, length).
    const double m = a + std::numbers::pi / 4;
    refs.push_back({{"kind", "edge"}, {"p", {15 * std::cos(m), 15 * std::sin(m), 10}}, {"size", 15 * std::numbers::pi / 2}, {"group", "edges"}});
  }
  auto withFill = [&](const char* choice) {
    Json doc = document({});
    for (const Json& f : features) doc.at("features").push_back(f);
    Json fl = filled("fl", {}, choice);
    fl["refs"] = refs;
    for (Json& r : fl["refs"]) r["choice"] = choice;
    doc.at("features").push_back(fl);
    doc["rollback"] = doc.at("features").size();
    return doc;
  };
  const RecomputeOutput flat = e.recompute(withFill("G0"));
  INFO(errorOf(flat, "fl"));
  REQUIRE(allOk(flat));
  REQUIRE(flat.bodyMass.size() == 5);
  const double disc = std::numbers::pi * 15 * 15;
  CHECK_THAT(flat.bodyMass.back().second.area, WithinRel(disc, 1e-3));
  const auto t0 = std::chrono::steady_clock::now();
  const RecomputeOutput tangent = e.recompute(withFill("G1"));
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  INFO(errorOf(tangent, "fl"));
  REQUIRE(allOk(tangent));
  REQUIRE(tangent.bodyMass.size() == 5);
  // Tangent to walls leaning inward (slope 2): a dome, larger than the disc.
  CHECK(tangent.bodyMass.back().second.area > disc * 1.05);
  WARN("G1 fill: " << ms << " ms");
}

TEST_CASE("fill: names stable when the tube height changes", "[fill]") {
  Engine e;
  const RecomputeOutput a = e.recompute(document({circle(), tube(30), filled("ft", rim({"c1"}, true), "G0")}));
  const RecomputeOutput b = e.recompute(document({circle(), tube(55), filled("ft", rim({"c1"}, true), "G0")}));
  REQUIRE(allOk(a));
  REQUIRE(allOk(b));
  CHECK(std::set<std::string>(a.edgeNames.begin(), a.edgeNames.end()) == std::set<std::string>(b.edgeNames.begin(), b.edgeNames.end()));
}

TEST_CASE("planar and fill surfaces: explicit errors", "[fill]") {
  Engine e;
  // Three edges out of four: open contour.
  std::vector<std::string> three = rim(kRect, true);
  three.pop_back();
  CHECK(errorOf(e.recompute(document({rectangle(), tube(), planar("pt", three)})), "pt") == "Les arêtes désignées ne forment pas un seul contour fermé");
  CHECK(errorOf(e.recompute(document({rectangle(), tube(), filled("ft", three, "G1")})), "ft") == "Les arêtes désignées ne forment pas un seul contour fermé");
  // Tangency to a wall perpendicular to the boundary (vertical tube): out of reach of the filling, reported.
  const std::string wall = errorOf(e.recompute(document({circle(), tube(), filled("ft", rim({"c1"}, true), "G1")})), "ft");
  INFO(wall);
  CHECK(wall.rfind("Tangence (G1) impossible (écart ", 0) == 0);
  // Edge of a solid in G1: two faces, the support must be designated. Solid cone frustum (revolved trapezoid):
  // the fill over its top follows the slanted side.
  Json trapezoid = feature("sk", "sketch", {});
  trapezoid["sketch"] = {{"frame", {{"origin", {0, 0, 0}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 0, 1}}, {"normal", {0, -1, 0}}}},
                         {"points", {{"a", {0, 0}}, {"b", {20, 0}}, {"c", {15, 10}}, {"d", {0, 10}}}},
                         {"curves", {{"t1", line("a", "b")}, {"t2", line("b", "c")}, {"t3", line("c", "d")}, {"t4", line("d", "a")}}},
                         {"regions", Json::array({region({"t1", "t2", "t3", "t4"})})},
                         {"chains", Json::array()}};
  Json cone = feature("cn", "revolve", {{"sketch", "sk"}, {"axis", "axis:V"}, {"angle", 360.0}, {"op", "add"}});
  // Top circle and slanted side, designated by their geometry.
  Json unsupported = filled("ft", {}, "G1");
  unsupported["refs"] = Json::array({{{"kind", "edge"}, {"p", {15, 0, 10}}, {"size", 2 * std::numbers::pi * 15}, {"group", "edges"}, {"choice", "G1"}}});
  CHECK(errorOf(e.recompute(document({trapezoid, cone, unsupported})), "ft") ==
        "Arête entre deux faces : désignez sa face d'appui pour la tangence (G1), ou passez-la en G0");
  Json supported = unsupported;
  supported["refs"].push_back({{"kind", "face"}, {"p", {17.5, 0, 5}}, {"size", std::numbers::pi * (20 + 15) * std::sqrt(125.0)}, {"group", "supports"}});
  const RecomputeOutput ok = e.recompute(document({trapezoid, cone, supported}));
  INFO(errorOf(ok, "ft"));
  CHECK(allOk(ok));
  CHECK(ok.bodyMass.back().second.area > std::numbers::pi * 15 * 15 * 1.05);
  CHECK(errorOf(e.recompute(document({rectangle(), tube(), planar("pt", {})})), "pt") == "Désignez les arêtes du contour à fermer");
}

