// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Drawing views: orthographic projection with hidden-line removal (OCCT HLR), section by a plane.
// Result in the ProjectedView format of @solidus-cad/sdk.
#pragma once

#include <TopoDS_Shape.hxx>
#include <gp_Dir.hxx>

#include <array>
#include <string>
#include <string_view>
#include <vector>

namespace cad {

/// Projected view: 2D segments (x1, y1, x2, y2...) visible and hidden, recognized circles (cx, cy, r...), bounding box.
struct ProjectedView {
  std::vector<float> visible;
  std::vector<float> hidden;
  std::vector<float> circles;
  std::array<double, 4> bounds{};
};

/// Axes of a view: normal (toward the observer), horizontal and vertical of the projection. Throws if `kind` is unknown.
struct ViewAxes {
  gp_Dir n, x, y;
};
ViewAxes viewAxes(std::string_view kind);

/// HLR projection of `shape` in view `kind` (front, back, top, bottom, right, left, iso).
ProjectedView projectShape(const TopoDS_Shape& shape, std::string_view kind);

/// Section of a shape by the plane {p · n = depth} (n: toward the observer): the part behind the plane, and the section
/// outlines projected in the view frame (2D segments). `size`: scene size.
struct Section {
  TopoDS_Shape kept;
  std::vector<float> segments;
};
Section sectionShape(const TopoDS_Shape& shape, std::string_view kind, double depth, double size);

}  // namespace cad
