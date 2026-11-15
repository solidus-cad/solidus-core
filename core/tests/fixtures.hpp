// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Test documents, in the engine input format (parameters already resolved, as sent by the client).
#pragma once

#include "document/engine.hpp"

#include <initializer_list>
#include <string>
#include <utility>
#include <variant>

namespace cad::test {

/// Parameter: number (expression = value) or raw string (enumeration).
using Param = std::variant<double, std::string>;

Json feature(std::string id, std::string type, std::initializer_list<std::pair<std::string, Param>> params);
Json document(std::initializer_list<Json> features, Json scope = Json::array());

/// Block 100 × 60 × 40 at the origin, and a Ø30 through hole at the centre.
Json block(double width = 100, std::string id = "f0");
Json hole(double radius = 15, double width = 100, std::string id = "f1");
Json fillet(double radius, std::string id = "f2");

}  // namespace cad::test
