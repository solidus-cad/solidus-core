// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Sheet state passed from one sheet metal feature to the next (port of SheetState, sheetmetal.ts).
//
// Model: the sheet is a sequence of flat "plates" connected by bends. Each plate is defined in the
// flat pattern (flat frame) and carries the rigid transformation flat pattern -> folded. A bend is an annular sector
// (inner radius R, thickness T); its developed length is the elongation BA = θ·(R + K·T).
// The flat pattern is therefore exact by construction, without unfolding the B-Rep geometry.
// OCCT shapes are shared (reference counted): copying the state is cheap, no shape is modified.
#pragma once

#include <TopoDS_Shape.hxx>
#include <gp_Trsf.hxx>
#include <gp_XYZ.hxx>

#include <array>
#include <vector>

namespace cad {

/// Geometry of a bent zone (folded frame): bend axis (c, axis), start radius `r0`, start edge `q` on the face with
/// normal `n`, edge direction `u` (length `len`), unfolding direction `w`, angle (rad), radius of the neutral fibre,
/// depth of the neutral fibre below the face of `q`, and folded -> flat transform `toFlat`.
struct ZoneGeo {
  gp_XYZ c, axis, r0, q, u, w, n;
  double len = 0, angle = 0, neutral = 0, depth = 0;
  gp_Trsf toFlat;
};

struct SheetState {
  double thickness = 0, radius = 0, k = 0;
  /// Frame of the flat pattern: the flat sheet lies in the (x, y) plane, thickness along ±n.
  gp_XYZ origin, x, y, n;
  /// Point on the mid-plane of the flat pattern.
  gp_XYZ mid;
  struct Plate {
    TopoDS_Shape flat;
    gp_Trsf fold;
  };
  std::vector<Plate> plates;
  /// Complete flat pattern (plates, bends and cuts).
  TopoDS_Shape flat;
  /// Bend lines in the flat pattern (world frame of the flat pattern), angle in degrees.
  struct Bend {
    gp_XYZ a, b;
    double angle = 0;
    bool up = true;
  };
  std::vector<Bend> bends;
  /// Bent zones: flat shape and folded shape (to rebuild the body after a sketched bend).
  struct Zone {
    TopoDS_Shape flat, folded;
    ZoneGeo geo;
  };
  std::vector<Zone> zones;
  /// Body flattened (sheetFlat): the following features apply to the flat pattern.
  bool flattened = false;
};

/// State after a material removal `tool` (body frame: folded, or flat after a flattening), carried over into the
/// flat pattern. Used by the sheet metal cut and by the Part features that remove material.
SheetState sheetAfterCut(const SheetState& sheet, const TopoDS_Shape& tool);

/// 2D flat pattern (flat pattern frame) in the FlatPattern format of @solidus-cad/sdk.
struct FlatPatternData {
  std::vector<float> outline, circles;
  std::vector<SheetState::Bend> bends;  // a, b expressed in the flat pattern frame (z ignored)
  std::array<double, 4> bounds{};
  double thickness = 0, radius = 0, kFactor = 0;
};

FlatPatternData flatPattern(const SheetState& s);

}  // namespace cad
