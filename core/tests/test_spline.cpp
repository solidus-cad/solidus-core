// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Sketch splines: B-spline edges in regions and open chains, rational and periodic splines.
#include "part/features.hpp"
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <BRepCheck_Analyzer.hxx>

#include <algorithm>
#include <cmath>
#include <numbers>
#include <set>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::WithinAbs;
using Catch::Matchers::WithinRel;

namespace {

Json planeXY() { return {{"origin", {0, 0, 0}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 1, 0}}, {"normal", {0, 0, 1}}}; }

Json sketchOf(Json points, Json curves, Json regions, Json chains = Json::array()) {
  Json f = feature("sk", "sketch", {});
  f["sketch"] = {{"frame", planeXY()}, {"points", std::move(points)}, {"curves", std::move(curves)}, {"regions", std::move(regions)}, {"chains", std::move(chains)}};
  return f;
}

Json ref(const char* id, bool reversed = false) { return {{"id", id}, {"reversed", reversed}}; }
Json loop(Json curves) { return {{"reverse", false}, {"curves", std::move(curves)}}; }
Json region(Json curves) { return {{"outer", loop(std::move(curves))}, {"holes", Json::array()}}; }

/** Parabola arch: quadratic spline (0,0) → (100,0) through the middle pole; archPoints(h) puts it at (50, 2h). */
Json arch() {
  return {{"type", "bspline"}, {"poles", {"a", "m", "b"}}, {"degree", 2}, {"knots", {0, 1}}, {"mults", {3, 3}}};
}
Json archPoints(double h = 50) { return {{"a", {0, 0}}, {"m", {50, 2 * h}}, {"b", {100, 0}}}; }

Json extrude(double depth) {
  return feature("ex", "extrude", {{"sketch", "sk"}, {"mode", "blind"}, {"depth", depth}, {"depth2", 0.0}, {"reverse", "no"}, {"op", "add"}, {"draft", 0.0}});
}

bool allOk(const RecomputeOutput& r) {
  return std::all_of(r.statuses.begin(), r.statuses.end(), [](const FeatureStatus& s) { return s.ok; });
}

std::string errorOf(const RecomputeOutput& r, const std::string& id) {
  for (const FeatureStatus& s : r.statuses)
    if (s.id == id) return s.error;
  return "?";
}

}  // namespace

TEST_CASE("spline region: parabola arch closed by its chord, exact volume and names", "[spline]") {
  Engine e;
  // Region: the arch from a to b, then the line back from b to a (counterclockwise: the arch is above the chord, so it is
  // traversed from b to a).
  Json sk = sketchOf(archPoints(), {{"s", arch()}, {"l", {{"type", "line"}, {"p1", "a"}, {"p2", "b"}}}}, Json::array({region({ref("l"), ref("s", true)})}));
  const RecomputeOutput r = e.recompute(document({sk, extrude(10)}));
  REQUIRE(allOk(r));
  // Area between a parabola arch and its chord: 2/3 of the triangle of the poles (100 × 100 / 2).
  CHECK_THAT(r.mass->volume, WithinRel(2.0 / 3 * 5000 * 10, 1e-9));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());
  const std::set<std::string> faces(r.faceNames.begin(), r.faceNames.end());
  CHECK(faces.count("ex/side(s)") == 1);
  CHECK(faces.count("ex/side(l)") == 1);

  // A different height keeps the names, the volume follows.
  Json higher = sketchOf(archPoints(80), {{"s", arch()}, {"l", {{"type", "line"}, {"p1", "a"}, {"p2", "b"}}}}, Json::array({region({ref("l"), ref("s", true)})}));
  const RecomputeOutput h = e.recompute(document({higher, extrude(10)}));
  REQUIRE(allOk(h));
  CHECK_THAT(h.mass->volume, WithinRel(2.0 / 3 * 8000 * 10, 1e-9));
  CHECK(std::set<std::string>(h.faceNames.begin(), h.faceNames.end()) == faces);
}

TEST_CASE("rational spline: exact quarter circle", "[spline]") {
  Engine e;
  // Quarter circle of radius 40: poles (40,0), (40,40), (0,40), weights 1, √2/2, 1; closed by the two radii.
  Json quarter = {{"type", "bspline"}, {"poles", {"a", "m", "b"}}, {"degree", 2}, {"knots", {0, 1}}, {"mults", {3, 3}}, {"weights", {1.0, std::sqrt(0.5), 1.0}}};
  Json sk = sketchOf({{"o", {0, 0}}, {"a", {40, 0}}, {"m", {40, 40}}, {"b", {0, 40}}},
                     {{"q", quarter}, {"r1", {{"type", "line"}, {"p1", "o"}, {"p2", "a"}}}, {"r2", {{"type", "line"}, {"p1", "b"}, {"p2", "o"}}}},
                     Json::array({region({ref("r1"), ref("q"), ref("r2")})}));
  const RecomputeOutput r = e.recompute(document({sk, extrude(5)}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinRel(std::numbers::pi * 1600 / 4 * 5, 1e-9));
}

TEST_CASE("periodic spline: closed region on its own", "[spline]") {
  Engine e;
  // Uniform periodic cubic on the four corners of a square: a rounded closed curve inside the square.
  Json closed = {{"type", "bspline"}, {"poles", {"p0", "p1", "p2", "p3"}}, {"degree", 3}, {"knots", {0, 1, 2, 3, 4}}, {"mults", {1, 1, 1, 1, 1}}, {"periodic", true}};
  Json sk = sketchOf({{"p0", {0, 0}}, {"p1", {60, 0}}, {"p2", {60, 60}}, {"p3", {0, 60}}}, {{"c", closed}}, Json::array({region({ref("c")})}));
  const RecomputeOutput r = e.recompute(document({sk, extrude(10)}));
  REQUIRE(allOk(r));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());
  CHECK(r.mass->volume > 0);
  CHECK(r.mass->volume < 60.0 * 60 * 10);
  // Symmetric about the centre of the square (mass properties of a B-spline face: integration precision of OCCT).
  CHECK_THAT(r.mass->center[0], WithinAbs(30, 1e-2));
  CHECK_THAT(r.mass->center[1], WithinAbs(30, 1e-2));
}

TEST_CASE("surface extrusion of an open spline: area and edge names", "[spline]") {
  Engine e;
  Json sk = sketchOf(archPoints(), {{"s", arch()}}, Json::array(), Json::array({Json::array({ref("s")})}));
  Json sx = feature("sx", "surfaceExtrude", {{"sketch", "sk"}, {"mode", "blind"}, {"depth", 20.0}, {"depth2", 0.0}, {"reverse", "no"}});
  const RecomputeOutput r = e.recompute(document({sk, sx}));
  REQUIRE(allOk(r));
  // Length of the arch x = 100 t, y = 200 t (1 - t): ∫ √(100² + (200 (1 - 2t))²) dt, by Simpson's rule.
  const int n = 20000;
  double length = 0;
  for (int i = 0; i <= n; i++) {
    const double t = static_cast<double>(i) / n;
    const double f = std::hypot(100.0, 200 * (1 - 2 * t));
    length += f * (i == 0 || i == n ? 1 : i % 2 ? 4 : 2);
  }
  length /= 3.0 * n;
  CHECK_THAT(r.mass->area, WithinRel(length * 20, 1e-6));
  const std::set<std::string> edges(r.edgeNames.begin(), r.edgeNames.end());
  CHECK(edges.count("e(sx/side(s)|sx/start)") == 1);
  CHECK(edges.count("e(sx/end|sx/side(s))") == 1);
}

TEST_CASE("invalid spline: explicit error", "[spline]") {
  Engine e;
  Json bad = arch();
  bad["mults"] = {3, 2};
  Json sk = sketchOf(archPoints(), {{"s", bad}, {"l", {{"type", "line"}, {"p1", "a"}, {"p2", "b"}}}}, Json::array({region({ref("l"), ref("s", true)})}));
  CHECK(errorOf(e.recompute(document({sk, extrude(10)})), "sk") == "Spline d'esquisse invalide");
}
