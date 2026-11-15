// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#pragma once

#include <TopoDS_Shape.hxx>

#include <cstdint>
#include <string_view>
#include <vector>

namespace cad {

/// Exports a shape to STEP (AP214, mm) or to STL (ASCII, from the existing mesh).
/// Throws std::runtime_error on failure.
std::vector<uint8_t> exportShape(const TopoDS_Shape& shape, std::string_view format);

}  // namespace cad
