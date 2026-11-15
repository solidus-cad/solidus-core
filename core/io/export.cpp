// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "io/export.hpp"

#include <IFSelect_ReturnStatus.hxx>
#include <STEPControl_Writer.hxx>
#include <StlAPI_Writer.hxx>

#include <atomic>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>

namespace cad {
namespace {

std::vector<uint8_t> toBytes(const std::string& s) { return std::vector<uint8_t>(s.begin(), s.end()); }

std::vector<uint8_t> exportStep(const TopoDS_Shape& shape) {
  STEPControl_Writer writer;
  if (writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone) throw std::runtime_error("Échec de la conversion STEP");
  std::ostringstream out;
  if (writer.WriteStream(out) != IFSelect_RetDone) throw std::runtime_error("Échec de l'écriture STEP");
  return toBytes(out.str());
}

/// StlAPI_Writer only writes to a file: temporary file (MEMFS in WASM).
std::vector<uint8_t> exportStl(const TopoDS_Shape& shape) {
  static std::atomic<int> counter{0};
  const std::filesystem::path path =
      std::filesystem::temp_directory_path() / ("cad-export-" + std::to_string(counter++) + ".stl");
  StlAPI_Writer writer;
  const bool ok = writer.Write(shape, path.string().c_str());
  std::vector<uint8_t> data;
  if (ok) {
    std::ifstream in(path, std::ios::binary);
    data.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  }
  std::error_code ec;
  std::filesystem::remove(path, ec);
  if (!ok) throw std::runtime_error("Échec de l'écriture STL");
  return data;
}

}  // namespace

std::vector<uint8_t> exportShape(const TopoDS_Shape& shape, std::string_view format) {
  if (format == "step") return exportStep(shape);
  if (format == "stl") return exportStl(shape);
  throw std::runtime_error("Format d'export inconnu « " + std::string(format) + " »");
}

}  // namespace cad
