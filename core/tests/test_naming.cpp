// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Topological naming: names derived from the origin, stable when the dimensions change (core/NAMING.md).
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>

#include <algorithm>
#include <set>

using namespace cad;
using namespace cad::test;

namespace {

std::set<std::string> asSet(const std::vector<std::string>& v) { return {v.begin(), v.end()}; }

bool unique(const std::vector<std::string>& v) { return asSet(v).size() == v.size(); }

/// Centre of gravity of a face of the current body designated by its name.
gp_Pnt centerOf(const Engine& e, const std::string& name) {
  const Body* b = e.current();
  REQUIRE(b);
  const std::optional<TopoDS_Shape> f = b->names.find(b->shape, name);
  REQUIRE(f);
  GProp_GProps p;
  BRepGProp::SurfaceProperties(*f, p);
  return p.CentreOfMass();
}

/// Rectangle 60 × 40 (curves l1..l4) in the XY plane, already resolved, as sent by the client.
Json rectangleSketch(std::string id) {
  Json sketch = {
      {"frame", {{"origin", {0, 0, 0}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 1, 0}}, {"normal", {0, 0, 1}}}},
      {"points", {{"O", {0, 0}}, {"b", {60, 0}}, {"c", {60, 40}}, {"d", {0, 40}}}},
      {"curves",
       {{"l1", {{"type", "line"}, {"p1", "O"}, {"p2", "b"}}},
        {"l2", {{"type", "line"}, {"p1", "b"}, {"p2", "c"}}},
        {"l3", {{"type", "line"}, {"p1", "c"}, {"p2", "d"}}},
        {"l4", {{"type", "line"}, {"p1", "d"}, {"p2", "O"}}}}},
      {"regions",
       {{{"outer",
          {{"reverse", false},
           {"curves",
            {{{"id", "l1"}, {"reversed", false}},
             {{"id", "l2"}, {"reversed", false}},
             {{"id", "l3"}, {"reversed", false}},
             {{"id", "l4"}, {"reversed", false}}}}}},
         {"holes", Json::array()}}}},
      {"chains", Json::array()}};
  Json f = feature(std::move(id), "sketch", {});
  f["sketch"] = sketch;
  return f;
}

}  // namespace

TEST_CASE("box: six faces named by their role, edges by their faces", "[naming]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({block()}));
  CHECK(asSet(r.faceNames) == std::set<std::string>{"f0/back", "f0/bottom", "f0/front", "f0/left", "f0/right", "f0/top"});
  REQUIRE(r.edgeNames.size() == 12);
  CHECK(unique(r.edgeNames));
  CHECK(asSet(r.edgeNames).count("e(f0/front|f0/top)") == 1);
  CHECK(centerOf(e, "f0/top").Z() == Catch::Approx(40));
  CHECK(centerOf(e, "f0/bottom").Z() == Catch::Approx(0));
  // Resolution of a name to a mesh identifier.
  const int id = e.resolveName("e(f0/front|f0/top)");
  CHECK(id >= 0);
  CHECK(r.edgeNames[size_t(id)] == "e(f0/front|f0/top)");
  CHECK(e.resolveName("f0/nowhere") == -1);
}

TEST_CASE("cylinder: the wall of the hole is named, the pierced face keeps its name", "[naming]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({block(), hole()}));
  const std::set<std::string> faces = asSet(r.faceNames);
  CHECK(faces == std::set<std::string>{"f0/back", "f0/bottom", "f0/front", "f0/left", "f0/right", "f0/top", "f1/lateral"});
  CHECK(unique(r.edgeNames));
  const std::set<std::string> edges = asSet(r.edgeNames);
  CHECK(edges.count("e(f0/top|f1/lateral)") == 1);
  CHECK(edges.count("e(f0/bottom|f1/lateral)") == 1);
  CHECK(edges.count("e(f1/lateral)") == 1);  // seam of the cylinder
}

TEST_CASE("names are stable when the dimensions change", "[naming]") {
  Engine e;
  const RecomputeOutput a = e.recompute(document({block(100), hole(15, 100), fillet(3)}));
  const RecomputeOutput b = e.recompute(document({block(140), hole(22, 140), fillet(2)}));
  REQUIRE(a.statuses.size() == 3);
  CHECK(a.statuses[2].ok);
  CHECK(b.statuses[2].ok);
  CHECK(asSet(a.faceNames) == asSet(b.faceNames));
  CHECK(asSet(a.edgeNames) == asSet(b.edgeNames));
  CHECK(centerOf(e, "f0/right").X() == Catch::Approx(140));
}

TEST_CASE("fillet: faces named by the edge or vertex they come from", "[naming]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({block(), fillet(3, "f1")}));
  REQUIRE(r.statuses[1].ok);
  CHECK(r.faceNames.size() == 6 + 12 + 8);
  CHECK(unique(r.faceNames));
  CHECK(unique(r.edgeNames));
  const auto count = [&](std::string_view prefix) {
    return std::count_if(r.faceNames.begin(), r.faceNames.end(), [&](const std::string& n) { return n.rfind(prefix, 0) == 0; });
  };
  CHECK(count("f1/fillet(e(") == 12);
  CHECK(count("f1/fillet(v(") == 8);
  CHECK(asSet(r.faceNames).count("f1/fillet(e(f0/front|f0/top))") == 1);
  // The flat top face, trimmed by the fillets, keeps its name.
  CHECK(centerOf(e, "f0/top").Z() == Catch::Approx(40));
}

TEST_CASE("merge: the unified face keeps the smallest name, the other becomes an alias", "[naming]") {
  Engine e;
  Json second = feature("f1", "box",
                        {{"width", 50.0}, {"depth", 60.0}, {"height", 40.0}, {"x", 100.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
  const RecomputeOutput r = e.recompute(document({block(), second}));
  const std::set<std::string> faces = asSet(r.faceNames);
  CHECK(faces.count("f0/top") == 1);
  CHECK(faces.count("f1/top") == 0);
  CHECK(r.faceNames.size() == 6);
  // The absorbed name still resolves to the unified face.
  CHECK(e.resolveName("f1/top") == e.resolveName("f0/top"));
}

TEST_CASE("split face: pieces told apart geometrically", "[naming]") {
  Engine e;
  // Through slot in Y: the top face is cut in two.
  Json slot = feature("f1", "box",
                      {{"width", 20.0}, {"depth", 80.0}, {"height", 30.0}, {"x", 40.0}, {"y", -10.0}, {"z", 20.0}, {"op", "cut"}});
  const RecomputeOutput r = e.recompute(document({block(), slot}));
  REQUIRE(r.statuses[1].ok);
  const std::set<std::string> faces = asSet(r.faceNames);
  CHECK(faces.count("f0/top#1") == 1);
  CHECK(faces.count("f0/top#2") == 1);
  CHECK(centerOf(e, "f0/top#1").X() < centerOf(e, "f0/top#2").X());
  CHECK(faces.count("f1/bottom") == 1);  // bottom of the slot
  CHECK(unique(r.faceNames));
}

TEST_CASE("extrude: side faces named by the sketch curves", "[naming]") {
  Engine e;
  Json ex = feature("ex", "extrude", {{"sketch", "sk"}, {"mode", "blind"}, {"depth", 10.0}, {"reverse", "no"}, {"op", "add"}});
  const RecomputeOutput r = e.recompute(document({rectangleSketch("sk"), ex}));
  REQUIRE(r.statuses.size() == 2);
  REQUIRE(r.statuses[1].ok);
  CHECK_THAT(r.mass->volume, Catch::Matchers::WithinAbs(60 * 40 * 10, 1e-6));
  CHECK(asSet(r.faceNames) == std::set<std::string>{"ex/end(l1)", "ex/side(l1)", "ex/side(l2)", "ex/side(l3)", "ex/side(l4)",
                                                     "ex/start(l1)"});
  CHECK(centerOf(e, "ex/end(l1)").Z() == Catch::Approx(10));
  CHECK(centerOf(e, "ex/side(l2)").X() == Catch::Approx(60));
}
