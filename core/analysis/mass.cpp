// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "analysis/mass.hpp"

#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <gp_Mat.hxx>

namespace cad {

MassProperties massProperties(const TopoDS_Shape& shape) {
  GProp_GProps vol, surf;
  BRepGProp::VolumeProperties(shape, vol, false, false, false);
  BRepGProp::SurfaceProperties(shape, surf, false, false);
  const gp_Pnt c = vol.CentreOfMass();
  MassProperties out{vol.Mass(), surf.Mass(), {c.X(), c.Y(), c.Z()}, std::nullopt};
  if (out.volume > 0) {
    // Tensor at the centre of gravity: moments on the diagonal, negated products off the diagonal.
    const gp_Mat m = vol.MatrixOfInertia();
    out.inertia = Inertia{m(1, 1), m(2, 2), m(3, 3), -m(1, 2), -m(1, 3), -m(2, 3)};
  }
  return out;
}

MassProperties surfaceProperties(const TopoDS_Shape& shape) {
  GProp_GProps surf;
  BRepGProp::SurfaceProperties(shape, surf, false, false);
  const gp_Pnt c = surf.CentreOfMass();
  return MassProperties{0, surf.Mass(), {c.X(), c.Y(), c.Z()}, std::nullopt};
}

}  // namespace cad
