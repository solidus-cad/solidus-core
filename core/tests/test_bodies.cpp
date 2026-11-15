// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Multi-body: target body, new body, combination, deletion, move, split, mesh and names per body.
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <algorithm>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::WithinAbs;

namespace {

const double kBlock = 100.0 * 60 * 40;

/// Box of side `w` × 60 × 40 placed at x, with its operation.
Json box(std::string id, double x, std::string op, double w = 100) {
  return feature(std::move(id), "box", {{"width", w}, {"depth", 60.0}, {"height", 40.0}, {"x", x}, {"y", 0.0}, {"z", 0.0}, {"op", std::move(op)}});
}

Json on(Json f, const std::string& body) {
  f["body"] = body;
  return f;
}

Json combine(std::string id, const std::string& target, const std::string& tools, std::string op, std::string keep = "no") {
  return on(feature(std::move(id), "combineBodies", {{"tools", tools}, {"op", std::move(op)}, {"keep", std::move(keep)}}), target);
}

/// Cutting plane x = `x` (frame resolved by the client, as for the mirror).
Json split(std::string id, double x) {
  Json f = feature(std::move(id), "splitBody", {{"plane", "YZ"}, {"offset", x}});
  f["prepared"] = {{"frame", {{"origin", {x, 0, 0}}, {"normal", {1, 0, 0}}}}};
  return f;
}

bool allOk(const RecomputeOutput& r) {
  return std::all_of(r.statuses.begin(), r.statuses.end(), [](const FeatureStatus& s) { return s.ok; });
}

std::vector<std::string> ids(const RecomputeOutput& r) {
  std::vector<std::string> out;
  for (const auto& b : r.bodies) out.push_back(b.id);
  return out;
}

double bodyVolume(const RecomputeOutput& r, const std::string& id) {
  for (const auto& [bid, m] : r.bodyMass)
    if (bid == id) return m.volume;
  return -1;
}

}  // namespace

TEST_CASE("a single-body part is unchanged", "[bodies]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({block(), hole()}));
  REQUIRE(allOk(r));
  CHECK(ids(r) == std::vector<std::string>{"f0"});
  CHECK(r.bodies[0].faceCount == 7);
  CHECK(r.bodyMass.empty());
  // The part as seen from outside is the body shape itself (exports and drawings unchanged).
  REQUIRE(e.partShape(""));
  CHECK(e.partShape("")->IsSame(e.current()->shape));
}

TEST_CASE("op \"new\" creates a body, without touching the active body", "[bodies]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box("a", 0, "add"), box("b", 50, "new")}));
  REQUIRE(allOk(r));
  CHECK(ids(r) == std::vector<std::string>{"a", "b"});
  // Two overlapping boxes, not merged: the mass is the sum of both.
  CHECK_THAT(r.mass->volume, WithinAbs(2 * kBlock, 1e-3));
  CHECK_THAT(bodyVolume(r, "a"), WithinAbs(kBlock, 1e-3));
  CHECK(r.faceNames.size() == 12);
  // Mesh identifiers contiguous per body.
  CHECK(r.bodies[0].faceStart == 0);
  CHECK(r.bodies[1].faceStart == r.bodies[0].faceCount);
  CHECK(r.bodies[1].edgeStart == r.bodies[0].edgeCount);
  CHECK(e.mesh().faceGroups.size() / 3 == 12);
  CHECK(e.partShape("")->ShapeType() == TopAbs_COMPOUND);
  // A name of the second body resolves after the faces of the first.
  const int top = e.resolveName("b/top");
  REQUIRE(top >= 6);
  CHECK(r.faceNames[top] == "b/top");
}

TEST_CASE("a feature acts on its target body", "[bodies]") {
  Engine e;
  // The hole targets body "a" while "b" is the active body.
  const RecomputeOutput r = e.recompute(document({box("a", 0, "add"), box("b", 200, "new"), on(hole(15, 100, "h"), "a")}));
  REQUIRE(allOk(r));
  CHECK(bodyVolume(r, "a") < kBlock - 1);
  CHECK_THAT(bodyVolume(r, "b"), WithinAbs(kBlock, 1e-3));
  // Without a designated body, the next feature targets the active body, here "a" (last modified).
  const RecomputeOutput r2 = e.recompute(document({box("a", 0, "add"), box("b", 200, "new"), on(hole(15, 100, "h"), "a"), fillet(2, "f")}));
  REQUIRE(allOk(r2));
  CHECK_THAT(bodyVolume(r2, "b"), WithinAbs(kBlock, 1e-3));
  CHECK(bodyVolume(r2, "a") < bodyVolume(r, "a"));
}

TEST_CASE("a designated body that does not exist is an error of the feature", "[bodies]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({block(), on(hole(), "inconnu")}));
  REQUIRE(r.statuses.size() == 2);
  CHECK(r.statuses[1].ok == false);
  CHECK(r.statuses[1].error == "Corps introuvable");
  CHECK_THAT(r.mass->volume, WithinAbs(kBlock, 1e-3));
}

TEST_CASE("combines bodies: union, subtraction, intersection", "[bodies]") {
  Engine e;
  const auto run = [&](std::string op, std::string keep = "no") {
    return e.recompute(document({box("a", 0, "add"), box("b", 50, "new"), combine("c", "a", "b", std::move(op), std::move(keep))}));
  };
  RecomputeOutput r = run("add");
  REQUIRE(allOk(r));
  CHECK(ids(r) == std::vector<std::string>{"a"});
  CHECK_THAT(r.mass->volume, WithinAbs(150.0 * 60 * 40, 1e-3));
  r = run("cut");
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(50.0 * 60 * 40, 1e-3));
  r = run("intersect");
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(50.0 * 60 * 40, 1e-3));
  r = run("cut", "yes");
  REQUIRE(allOk(r));
  CHECK(ids(r) == std::vector<std::string>{"a", "b"});
  CHECK_THAT(bodyVolume(r, "a"), WithinAbs(50.0 * 60 * 40, 1e-3));
  // A body cannot be its own tool.
  r = e.recompute(document({box("a", 0, "add"), combine("c", "a", "a", "add")}));
  CHECK(r.statuses[1].error == "Un corps ne peut pas se combiner avec lui-même");
}

TEST_CASE("deletes a body", "[bodies]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box("a", 0, "add"), box("b", 200, "new"), on(feature("d", "deleteBody", {}), "a")}));
  REQUIRE(allOk(r));
  CHECK(ids(r) == std::vector<std::string>{"b"});
}

TEST_CASE("moves a body, or makes a copy of it", "[bodies]") {
  Engine e;
  const auto move = [](std::string copy) {
    return on(feature("m", "moveBody", {{"dx", 0.0}, {"dy", 0.0}, {"dz", 100.0}, {"axis", "Z"}, {"angle", 0.0}, {"copy", std::move(copy)}}), "a");
  };
  RecomputeOutput r = e.recompute(document({box("a", 0, "add"), move("no")}));
  REQUIRE(allOk(r));
  CHECK(ids(r) == std::vector<std::string>{"a"});
  CHECK_THAT(r.mass->center[2], WithinAbs(120, 1e-6));
  // The names follow the moved body.
  CHECK(e.resolveName("a/top") >= 0);
  r = e.recompute(document({box("a", 0, "add"), move("yes")}));
  REQUIRE(allOk(r));
  CHECK(ids(r) == std::vector<std::string>{"a", "m"});
  CHECK_THAT(bodyVolume(r, "m"), WithinAbs(kBlock, 1e-3));
  CHECK(std::count(r.faceNames.begin(), r.faceNames.end(), "m/copy(a/top)") == 1);
}

TEST_CASE("splits a body by a plane", "[bodies]") {
  Engine e;
  RecomputeOutput r = e.recompute(document({block(), split("s", 30)}));
  REQUIRE(allOk(r));
  CHECK(ids(r) == std::vector<std::string>{"f0", "s"});
  // Order of the pieces: the smallest x first, it keeps the identifier of the split body.
  CHECK_THAT(bodyVolume(r, "f0"), WithinAbs(30.0 * 60 * 40, 1e-3));
  CHECK_THAT(bodyVolume(r, "s"), WithinAbs(70.0 * 60 * 40, 1e-3));
  // Cut faces named after the plane, one per piece.
  CHECK(std::count_if(r.faceNames.begin(), r.faceNames.end(), [](const std::string& n) { return n.starts_with("s/plane"); }) == 2);
  // The names stay the same when the dimension of the plane changes.
  const RecomputeOutput r2 = e.recompute(document({block(), split("s", 40)}));
  std::vector<std::string> a = r.faceNames, b = r2.faceNames;
  std::sort(a.begin(), a.end());
  std::sort(b.begin(), b.end());
  CHECK(a == b);
  // A plane outside the body is an error.
  r = e.recompute(document({block(), split("s", 500)}));
  CHECK(r.statuses[1].error == "Le plan ne coupe pas le corps");
}

TEST_CASE("the cache replays the state of all bodies", "[bodies]") {
  Engine e;
  const Json doc = document({box("a", 0, "add"), box("b", 200, "new"), on(hole(15, 100, "h"), "a")});
  const RecomputeOutput r1 = e.recompute(doc);
  const RecomputeOutput r2 = e.recompute(doc);
  CHECK(r2.rebuilt == 0);
  CHECK(ids(r2) == ids(r1));
  CHECK_THAT(r2.mass->volume, WithinAbs(r1.mass->volume, 1e-9));
}
