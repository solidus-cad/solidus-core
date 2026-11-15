// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Draft: neutral plane (a face of the body or a plane), parting line, names of the drafted faces.
#include "part/features.hpp"
#include "tests/fixtures.hpp"

#include <catch_amalgamated.hpp>

#include <BRepCheck_Analyzer.hxx>

#include <algorithm>
#include <cmath>
#include <numbers>
#include <string>

using namespace cad;
using namespace cad::test;
using Catch::Matchers::ContainsSubstring;
using Catch::Matchers::WithinAbs;

namespace {

Json box() {
  return feature("bx", "box", {{"width", 100.0}, {"depth", 60.0}, {"height", 40.0}, {"x", 0.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
}

Json named(const std::string& name, const char* group) {
  return {{"kind", "face"}, {"name", name}, {"p", {1e5, 1e5, 1e5}}, {"size", 1}, {"group", group}};
}

/// Draft of the four sides of the block. `from`: "face" (neutral face `neutral`), "plane" (XY + `offset`) or "auto".
Json draft(double angle, const char* mode = "neutral", const char* from = "face", const char* neutral = "bx/bottom",
           const char* reverse = "no", double offset = 0) {
  Json f = feature("dr", "draft", {{"angle", angle}, {"mode", mode}, {"neutralFrom", from}, {"plane", "XY"}, {"offset", offset}, {"reverse", reverse}});
  f["refs"] = Json::array({named("bx/front", "faces"), named("bx/back", "faces"), named("bx/left", "faces"), named("bx/right", "faces")});
  if (std::string(from) == "face") f["refs"].push_back(named(neutral, "neutral"));
  if (std::string(from) == "plane") f["prepared"] = {{"frame", {{"origin", {0, 0, offset}}, {"normal", {0, 0, 1}}, {"xDir", {1, 0, 0}}, {"yDir", {0, 1, 0}}}}};
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

/// Volume of the block W × D × h whose sides narrow by h·tan(a) per side over the height h: the section at s is
/// (W − 2ks) × (D − 2ks), k = tan(a).
double frustum(double w, double d, double h, double deg) {
  const double k = std::tan(deg * std::numbers::pi / 180);
  return w * d * h - (w + d) * k * h * h + 4.0 / 3 * k * k * h * h * h;
}

}  // namespace

TEST_CASE("draft: neutral face at the bottom, the block narrows toward the top", "[draft]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box(), draft(5)}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(frustum(100, 60, 40, 5), 1e-3));
  REQUIRE(e.partShape(""));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());
  // The drafted faces keep their names: a fillet on them still finds them.
  for (const char* n : {"bx/front", "bx/back", "bx/left", "bx/right", "bx/top", "bx/bottom"})
    CHECK(std::find(r.faceNames.begin(), r.faceNames.end(), n) != r.faceNames.end());
}

TEST_CASE("draft: neutral face at the top, or reversed", "[draft]") {
  Engine e;
  // From the top face, pulled into the material (downward): the top is the widest section.
  const RecomputeOutput top = e.recompute(document({box(), draft(5, "neutral", "face", "bx/top")}));
  REQUIRE(allOk(top));
  CHECK_THAT(top.mass->volume, WithinAbs(frustum(100, 60, 40, 5), 1e-3));
  CHECK(top.mass->center[2] > 20);
  // Reversed: pulled upward, the block widens toward the bottom.
  const RecomputeOutput rev = e.recompute(document({box(), draft(5, "neutral", "face", "bx/top", "yes")}));
  REQUIRE(allOk(rev));
  const double t = 40 * std::tan(5 * std::numbers::pi / 180);
  CHECK_THAT(rev.mass->volume, WithinAbs(frustum(100 + 2 * t, 60 + 2 * t, 40, 5), 1e-3));
}

TEST_CASE("draft: from a base plane with an offset", "[draft]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box(), draft(3, "neutral", "plane", "", "no", 0)}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(frustum(100, 60, 40, 3), 1e-3));
  // Neutral plane at mid-height: the section there keeps its size; the volume stays that of the block.
  const RecomputeOutput mid = e.recompute(document({box(), draft(3, "neutral", "plane", "", "no", 20)}));
  REQUIRE(allOk(mid));
  const double t = 20 * std::tan(3 * std::numbers::pi / 180);
  CHECK_THAT(mid.mass->volume, WithinAbs(frustum(100 + 2 * t, 60 + 2 * t, 40, 3), 1e-3));
}

TEST_CASE("draft: parting line at mid-height, both halves narrow away from it", "[draft]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box(), draft(4, "parting", "plane", "", "no", 20)}));
  REQUIRE(allOk(r));
  REQUIRE(e.partShape(""));
  CHECK(BRepCheck_Analyzer(*e.partShape("")).IsValid());
  CHECK_THAT(r.mass->volume, WithinAbs(2 * frustum(100, 60, 20, 4), 1e-3));
  // Symmetric part: the centre of mass stays at mid-height.
  CHECK_THAT(r.mass->center[2], WithinAbs(20, 1e-6));
  // Each side split in two by the parting line.
  CHECK(std::find(r.faceNames.begin(), r.faceNames.end(), "bx/front#1") != r.faceNames.end());
  CHECK(std::find(r.faceNames.begin(), r.faceNames.end(), "bx/front#2") != r.faceNames.end());
}

TEST_CASE("draft: errors", "[draft]") {
  Engine e;
  CHECK_THAT(errorOf(e.recompute(document({box(), draft(0)})), "dr"), ContainsSubstring("entre 0 et 90"));
  CHECK_THAT(errorOf(e.recompute(document({box(), draft(5, "neutral", "face", "bx/front")})), "dr"), ContainsSubstring("dépouill"));
  Json noFace = draft(5);
  noFace["refs"] = Json::array({named("bx/bottom", "neutral")});
  CHECK_THAT(errorOf(e.recompute(document({box(), noFace})), "dr"), ContainsSubstring("faces à dépouiller"));
}

TEST_CASE("draft: cylinder side becomes a cone", "[draft]") {
  Engine e;
  Json cyl = feature("cy", "cylinder", {{"radius", 15.0}, {"height", 40.0}, {"axis", "z"}, {"x", 0.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
  const RecomputeOutput faces = e.recompute(document({cyl}));
  REQUIRE(allOk(faces));
  std::string side;
  for (const std::string& n : faces.faceNames)
    if (n != "cy/top" && n != "cy/bottom") side = n;
  REQUIRE_FALSE(side.empty());
  Json f = feature("dr", "draft", {{"angle", 5.0}, {"mode", "neutral"}, {"neutralFrom", "face"}, {"plane", "XY"}, {"offset", 0.0}, {"reverse", "no"}});
  f["refs"] = Json::array({named(side, "faces"), named("cy/bottom", "neutral")});
  const RecomputeOutput r = e.recompute(document({cyl, f}));
  REQUIRE(allOk(r));
  const double r2 = 15 - 40 * std::tan(5 * std::numbers::pi / 180);
  CHECK_THAT(r.mass->volume, WithinAbs(std::numbers::pi * 40 / 3 * (15 * 15 + 15 * r2 + r2 * r2), 1e-2));
}

TEST_CASE("draft: parting plane on an edge of the faces drafts them on one side", "[draft]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box(), draft(5, "parting", "plane", "", "no", 0)}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(frustum(100, 60, 40, 5), 1e-3));
  CHECK(std::find(r.faceNames.begin(), r.faceNames.end(), "bx/front") != r.faceNames.end());
}

TEST_CASE("draft: automatic, each side keeps its size at its base", "[draft]") {
  Engine e;
  const RecomputeOutput r = e.recompute(document({box(), draft(5, "neutral", "auto")}));
  REQUIRE(allOk(r));
  CHECK_THAT(r.mass->volume, WithinAbs(frustum(100, 60, 40, 5), 1e-3));
  // Narrower at the top: the centre of mass goes down.
  CHECK(r.mass->center[2] < 20);
  // Reversed: the top keeps its size, the block narrows toward the bottom.
  const RecomputeOutput rev = e.recompute(document({box(), draft(5, "neutral", "auto", "", "yes")}));
  REQUIRE(allOk(rev));
  CHECK_THAT(rev.mass->volume, WithinAbs(frustum(100, 60, 40, 5), 1e-3));
  CHECK(rev.mass->center[2] > 20);
}

TEST_CASE("draft: automatic on a single wall, pulled along the vertical", "[draft]") {
  Engine e;
  Json f = draft(5, "neutral", "auto");
  f["refs"] = Json::array({named("bx/front", "faces")});
  const RecomputeOutput r = e.recompute(document({box(), f}));
  REQUIRE(allOk(r));
  // Wedge 100 long, 40 high, 40·tan(5°) thick at the top.
  CHECK_THAT(r.mass->volume, WithinAbs(100.0 * 60 * 40 - 100 * 40 * 40 / 2.0 * std::tan(5 * std::numbers::pi / 180), 1e-3));
}

TEST_CASE("draft: automatic parting line in the middle of the faces", "[draft]") {
  Engine e;
  // "reverse" is ignored on a parting line (it would make an undercut).
  for (const char* reverse : {"no", "yes"}) {
    const RecomputeOutput r = e.recompute(document({box(), draft(4, "parting", "auto", "", reverse)}));
    REQUIRE(allOk(r));
    CHECK_THAT(r.mass->volume, WithinAbs(2 * frustum(100, 60, 20, 4), 1e-3));
    CHECK_THAT(r.mass->center[2], WithinAbs(20, 1e-6));
  }
}

TEST_CASE("draft: automatic on a cylinder, pulled along its axis", "[draft]") {
  Engine e;
  Json cyl = feature("cy", "cylinder", {{"radius", 15.0}, {"height", 40.0}, {"axis", "x"}, {"x", 0.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
  const RecomputeOutput faces = e.recompute(document({cyl}));
  REQUIRE(allOk(faces));
  std::string side;
  for (const std::string& n : faces.faceNames)
    if (n != "cy/top" && n != "cy/bottom") side = n;
  REQUIRE_FALSE(side.empty());
  Json f = feature("dr", "draft", {{"angle", 5.0}, {"mode", "neutral"}, {"neutralFrom", "auto"}, {"plane", "XY"}, {"offset", 0.0}, {"reverse", "no"}});
  f["refs"] = Json::array({named(side, "faces")});
  const RecomputeOutput r = e.recompute(document({cyl, f}));
  REQUIRE(allOk(r));
  const double r2 = 15 - 40 * std::tan(5 * std::numbers::pi / 180);
  CHECK_THAT(r.mass->volume, WithinAbs(std::numbers::pi * 40 / 3 * (15 * 15 + 15 * r2 + r2 * r2), 1e-2));
}

TEST_CASE("draft: automatic without a common pull direction", "[draft]") {
  Engine e;
  Json f = draft(5, "neutral", "auto");
  f["refs"] = Json::array({named("bx/front", "faces"), named("bx/top", "faces"), named("bx/right", "faces")});
  CHECK_THAT(errorOf(e.recompute(document({box(), f})), "dr"), ContainsSubstring("direction de démoulage commune"));
}
