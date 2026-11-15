// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Recompute engine: same scenarios as packages/kernel-wasm/test/engine.test.ts, on the C++ side.
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <BRepPrimAPI_MakeBox.hxx>

#include <numbers>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::WithinAbs;

namespace {
constexpr double kPi = std::numbers::pi;
const double kBlock = 100.0 * 60 * 40;
const double kHole = kPi * 15 * 15 * 40;

bool allOk(const RecomputeOutput& r) {
  for (const FeatureStatus& s : r.statuses)
    if (!s.ok) return false;
  return true;
}
}  // namespace

TEST_CASE("computes a drilled box", "[engine]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({block(), hole()}));
  REQUIRE(allOk(r));
  REQUIRE(r.mass);
  CHECK_THAT(r.mass->volume, WithinAbs(kBlock - kHole, 0.5));
  CHECK_THAT(r.mass->center[2], WithinAbs(20, 1e-6));
  const MeshData& m = e.mesh();
  CHECK(!m.indices.empty());
  CHECK(m.faceGroups.size() % 3 == 0);
  CHECK(m.positions.size() == m.normals.size());
  CHECK(m.edgeGroups.size() % 3 == 0);
  CHECK(m.edges.size() % 6 == 0);  // segments: two xyz points
  // The face groups cover the whole index, without gaps or overlaps.
  size_t next = 0;
  for (size_t i = 0; i < m.faceGroups.size(); i += 3) {
    CHECK(size_t(m.faceGroups[i]) == next);
    next += size_t(m.faceGroups[i + 1]);
  }
  CHECK(next == m.indices.size());
  CHECK(r.faceNames.size() == 7);  // 6 faces of the block + wall of the hole
}

TEST_CASE("reuses the cache and only recomputes downstream", "[engine]") {
  Engine e;
  CHECK(e.recompute(document({block(), hole()})).rebuilt == 2);
  CHECK(e.recompute(document({block(), hole()})).rebuilt == 0);
  CHECK(e.recompute(document({block(), hole(20)})).rebuilt == 1);
  // A change of a global parameter invalidates the whole tree.
  CHECK(e.recompute(document({block(), hole(20)}, Json::array({Json::array({"L", 1})}))).rebuilt == 2);
}

TEST_CASE("isolates a feature in error without losing the body", "[engine]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({block(), fillet(500)}));
  REQUIRE(r.statuses.size() == 2);
  CHECK(r.statuses[0].ok);
  CHECK_FALSE(r.statuses[1].ok);
  CHECK_FALSE(r.statuses[1].error.empty());
  REQUIRE(r.mass);
  CHECK_THAT(r.mass->volume, WithinAbs(kBlock, 0.5));
}

TEST_CASE("reports invalid expressions and unknown features", "[engine]") {
  Engine e;
  Json f = feature("f0", "box", {{"depth", 60.0}, {"height", 40.0}, {"x", 0.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
  f["params"]["width"] = "L";
  f["errors"]["width"] = "Paramètre inconnu « L »";
  RecomputeOutput r = e.recompute(document({f}));
  REQUIRE_FALSE(r.statuses[0].ok);
  CHECK(r.statuses[0].error == "width : Paramètre inconnu « L »");
  CHECK_FALSE(r.mass);
  CHECK(e.mesh().indices.empty());

  r = e.recompute(document({feature("f0", "teapot", {})}));
  CHECK(r.statuses[0].error == "Fonction inconnue « teapot »");
}

TEST_CASE("applies fillets and chamfers", "[engine]") {
  Engine e;
  RecomputeOutput r = e.recompute(document({block(), hole(), fillet(3)}));
  CHECK(allOk(r));
  r = e.recompute(document({block(), feature("f1", "chamfer", {{"distance", 2.0}})}));
  CHECK(allOk(r));
  REQUIRE(r.mass);
  CHECK(r.mass->volume < kBlock);
}

namespace {
Json withRef(Json f, const char* kind, double x, double y, double z, double size) {
  f["refs"] = Json::array({Json{{"kind", kind}, {"p", {x, y, z}}, {"size", size}}});
  return f;
}
}  // namespace

TEST_CASE("rounds a single designated edge", "[engine][refs]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({block(), withRef(fillet(5, "f1"), "edge", 50, 0, 40, 100)}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(kBlock - (1 - kPi / 4) * 25 * 100, 0.05));
}

TEST_CASE("reports an edge that no longer exists", "[engine][refs]") {
  Engine e;
  const RecomputeOutput r =
      e.recompute(document({block(), withRef(feature("f1", "chamfer", {{"distance", 2.0}}), "edge", 500, 0, 40, 100)}));
  REQUIRE_FALSE(r.statuses[1].ok);
  CHECK(r.statuses[1].error == "Arête introuvable : le modèle a changé en amont, sélectionnez-la à nouveau");
}

TEST_CASE("resolves a reference by its topological name", "[engine][refs]") {
  Engine e;
  // Wrong point, correct name: the name wins.
  Json f = withRef(fillet(5, "f1"), "edge", 500, 0, 40, 100);
  f["refs"][0]["name"] = "e(f0/front|f0/top)";  // edge y = 0, z = 40
  const RecomputeOutput r = e.recompute(document({block(), f}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(kBlock - (1 - kPi / 4) * 25 * 100, 0.05));
}

TEST_CASE("hollows out the body by opening the top face", "[engine][shell]") {
  Engine e;
  const Json shell = feature("f1", "shell", {{"thickness", 2.0}, {"direction", "inside"}});
  const RecomputeOutput r = e.recompute(document({block(), withRef(shell, "face", 50, 30, 40, 6000)}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(kBlock - 96.0 * 56 * 38, 0.5));
  // 5 outer faces, 5 inner faces and the edge of the opening, all named.
  CHECK(r.faceNames.size() == 11);
  for (const std::string& n : r.faceNames) CHECK_FALSE(n.empty());
  CHECK(e.recompute(document({feature("f0", "shell", {{"thickness", 2.0}})})).statuses[0].error == "Aucun corps à évider");
}

TEST_CASE("honours the rollback bar and suppression", "[engine]") {
  Engine e;
  Json d = document({block(), hole()});
  d["rollback"] = 1;
  CHECK_THAT(e.recompute(d).mass->volume, WithinAbs(kBlock, 0.5));
  d["rollback"] = 2;
  d["features"][1]["suppressed"] = true;
  const RecomputeOutput r = e.recompute(d);
  CHECK(r.statuses.size() == 1);
  CHECK_THAT(r.mass->volume, WithinAbs(kBlock, 0.5));
}

TEST_CASE("exports to STEP and STL", "[engine]") {
  Engine e;
  CHECK_THROWS(e.exportShape("step"));
  e.recompute(document({block()}));
  const std::vector<uint8_t> step = e.exportShape("step");
  CHECK(std::string(step.begin(), step.begin() + 12) == "ISO-10303-21");
  CHECK(e.exportShape("stl").size() > 100);
  CHECK_THROWS(e.exportShape("obj"));
}

TEST_CASE("fine mesh for CAM, independent of the display", "[engine][mesh]") {
  Engine e;
  CHECK_THROWS(e.camMesh("", 0.01));
  const RecomputeOutput r = e.recompute(document({block(), hole()}));
  REQUIRE(allOk(r));
  const size_t shown = e.mesh().indices.size();
  const MeshData fine = e.camMesh("", 0.005);
  CHECK(fine.indices.size() > shown);
  // The display mesh did not change, and the next recompute gives it back identically.
  CHECK(e.mesh().indices.size() == shown);
  e.recompute(document({block(), hole()}));
  CHECK(e.mesh().indices.size() == shown);
}

TEST_CASE("accepts new features in the registry", "[engine]") {
  Engine e;
  e.registry().add("slab", [](const BuildContext& ctx) -> FeatureOutput {
    Body b;
    b.shape = BRepPrimAPI_MakeBox(ctx.positive("w"), 60, 40).Shape();
    return b;
  });
  const RecomputeOutput r = e.recompute(document({feature("p", "slab", {{"w", 10.0}})}));
  CHECK(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(10.0 * 60 * 40, 0.5));
}
