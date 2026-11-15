// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "tests/fixtures.hpp"

#include <sstream>

namespace cad::test {

Json feature(std::string id, std::string type, std::initializer_list<std::pair<std::string, Param>> params) {
  Json f = {{"id", std::move(id)}, {"type", std::move(type)}, {"params", Json::object()}, {"values", Json::object()}};
  for (const auto& [k, v] : params) {
    if (const double* d = std::get_if<double>(&v)) {
      std::ostringstream s;
      s << *d;
      f["params"][k] = s.str();
      f["values"][k] = *d;
    } else {
      f["params"][k] = std::get<std::string>(v);
    }
  }
  return f;
}

Json document(std::initializer_list<Json> features, Json scope) {
  Json fs = Json::array();
  for (const Json& f : features) fs.push_back(f);
  return {{"scope", std::move(scope)}, {"rollback", fs.size()}, {"features", std::move(fs)}};
}

Json block(double width, std::string id) {
  return feature(std::move(id), "box",
                 {{"width", width}, {"depth", 60.0}, {"height", 40.0}, {"x", 0.0}, {"y", 0.0}, {"z", 0.0}, {"op", "add"}});
}

Json hole(double radius, double width, std::string id) {
  return feature(std::move(id), "cylinder",
                 {{"radius", radius}, {"height", 40.0}, {"x", width / 2}, {"y", 30.0}, {"z", 0.0}, {"axis", "z"}, {"op", "cut"}});
}

Json fillet(double radius, std::string id) { return feature(std::move(id), "fillet", {{"radius", radius}}); }

}  // namespace cad::test
