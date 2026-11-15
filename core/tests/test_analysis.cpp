// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Surface analyses: curvature at the mesh nodes (sphere), continuity along an edge (fillet G1, sharp edge G0).
#include "part/features.hpp"
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <algorithm>
#include <cmath>
#include <numbers>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::WithinAbs;
using Catch::Matchers::WithinRel;

namespace {

/// Solid sphere of radius `r`: half disc (arc from (0, -r) to (0, r) through (r, 0), closed by the axis) revolved
/// around the vertical axis of its sketch.
Json sphere(double r) {
  Json sk = feature("sk", "sketch", {});
  Json region = {{"outer", {{"reverse", false}, {"curves", Json::array({{{"id", "a1"}, {"reversed", false}}, {{"id", "l1"}, {"reversed", false}}})}}},
                 {"holes", Json::array()}};
  sk["sketch"] = {{"frame", {{"origin", {0, 0, 0}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 0, 1}}, {"normal", {0, -1, 0}}}},
                  {"points", {{"o", {0, 0}}, {"s", {0, -r}}, {"n", {0, r}}}},
                  {"curves", {{"a1", {{"type", "arc"}, {"c", "o"}, {"start", "s"}, {"end", "n"}}}, {"l1", {{"type", "line"}, {"p1", "n"}, {"p2", "s"}}}}},
                  {"regions", Json::array({region})},
                  {"chains", Json::array()}};
  return document({sk, feature("rv", "revolve", {{"sketch", "sk"}, {"axis", "axis:V"}, {"angle", 360.0}, {"op", "add"}})});
}

bool allOk(const RecomputeOutput& r) {
  return std::all_of(r.statuses.begin(), r.statuses.end(), [](const FeatureStatus& s) { return s.ok; });
}

}  // namespace

TEST_CASE("curvature of a sphere at every mesh node: Gaussian 1/R², mean and principal ±1/R", "[analysis]") {
  Engine e;
  const double R = 25;
  const RecomputeOutput r = e.recompute(sphere(R));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinRel(4.0 / 3 * std::numbers::pi * R * R * R, 1e-3));
  const std::vector<float> g = e.surfaceAnalysis("", "gaussian");
  // One value per vertex of the display mesh.
  REQUIRE(g.size() == e.mesh().positions.size() / 3);
  size_t defined = 0;
  for (const float v : g) {
    if (std::isnan(v)) continue;  // poles of the revolved sphere
    defined++;
    CHECK_THAT(v, WithinRel(1 / (R * R), 0.01));
  }
  CHECK(defined > g.size() * 9 / 10);
  // Outward normals of a solid: the sphere bends away from them, mean and principal curvatures are -1/R.
  for (const char* kind : {"mean", "min", "max"})
    for (const float v : e.surfaceAnalysis("", kind))
      if (!std::isnan(v)) CHECK_THAT(std::abs(v), WithinRel(1 / R, 0.01));
  CHECK_THROWS_WITH(e.surfaceAnalysis("", "torsion"), "Analyse de courbure inconnue");
}

TEST_CASE("continuity: a fillet is tangent (G1) to its faces, a sharp edge only touches (G0)", "[analysis]") {
  Engine e;
  Json f = fillet(5);
  f["refs"] = Json::array({{{"kind", "edge"}, {"name", "e(f0/front|f0/top)"}, {"p", {50, 0, 40}}, {"size", 100}}});
  const RecomputeOutput r = e.recompute(document({block(), f}));
  REQUIRE(allOk(r));
  // Edge between the top face and the fillet (face names sorted).
  const std::string tangent = "e(f0/top|f2/fillet(e(f0/front|f0/top)))";
  REQUIRE(std::find(r.edgeNames.begin(), r.edgeNames.end(), tangent) != r.edgeNames.end());
  const std::vector<ContinuitySample> smooth = e.continuity("", tangent);
  REQUIRE(smooth.size() == 21);
  for (const ContinuitySample& s : smooth) {
    CHECK(s.g0 < 1e-6);
    CHECK(s.g1 < 0.1);
    // Curvature jump across the edge: 1/r on the fillet, 0 on the plane (G1 but not G2).
    CHECK_THAT(s.g2, WithinRel(1 / 5.0, 0.01));
  }
  const std::vector<ContinuitySample> sharp = e.continuity("", "e(f0/back|f0/top)");
  for (const ContinuitySample& s : sharp) {
    CHECK(s.g0 < 1e-6);
    CHECK_THAT(s.g1, WithinAbs(90, 1e-6));
  }
  CHECK_THROWS_WITH(e.continuity("", "e(nope|f0/top)"), "Arête introuvable : désignez-la à nouveau");
}
