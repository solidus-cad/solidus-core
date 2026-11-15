// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#pragma once

#include <TopoDS_Shape.hxx>

#include <array>
#include <optional>

namespace cad {

/// Moments (xx, yy, zz) and products (xy, xz, yz) of inertia of the volume (unit density, mm⁵), at the centre of gravity,
/// axes parallel to the absolute frame. Products in the sense ∫xy dV (the tensor has -xy off the diagonal), as Inertia in @solidus-cad/sdk.
struct Inertia {
  double xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
};

struct MassProperties {
  double volume = 0;
  double area = 0;
  std::array<double, 3> center{};
  /// Absent for a body without volume.
  std::optional<Inertia> inertia;
};

/// Volume, area, centre of gravity and inertia (exact geometry, not the mesh).
MassProperties massProperties(const TopoDS_Shape& shape);
/// Surface (open shell): area and centroid of the area, zero volume, no inertia.
MassProperties surfaceProperties(const TopoDS_Shape& shape);

}  // namespace cad
