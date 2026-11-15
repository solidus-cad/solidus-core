// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Body imported from a STEP file embedded in the document (base64), added to the previous body. Read in memory
// (ReadStream), without a temporary file; units converted to mm by the reader.
// Naming: the k-th face of the file (TopExp::MapShapes order) is "<id>/face(k)".
#include "part/features.hpp"

#include <STEPControl_Reader.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>

#include <array>
#include <sstream>

namespace cad {
namespace {

std::string fromBase64(const std::string& in) {
  static const std::array<int, 256> table = [] {
    std::array<int, 256> t{};
    t.fill(-1);
    const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) t[static_cast<unsigned char>(chars[i])] = i;
    return t;
  }();
  std::string out;
  out.reserve(in.size() * 3 / 4);
  int acc = 0, bits = 0;
  for (unsigned char c : in) {
    const int v = table[c];
    if (v < 0) continue;  // padding "=", line breaks
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((acc >> bits) & 0xff));
    }
  }
  return out;
}

}  // namespace

FeatureOutput buildImportStep(const BuildContext& ctx) {
  const Json& imported = ctx.feature().imported;
  const auto data = imported.find("data");
  if (data == imported.end() || !data->is_string() || data->get_ref<const std::string&>().empty())
    throw FeatureError("Fichier importé manquant");
  std::istringstream stream(fromBase64(data->get<std::string>()));
  STEPControl_Reader reader;
  if (reader.ReadStream("import.step", stream) != IFSelect_RetDone) throw FeatureError("Fichier STEP illisible");
  if (reader.TransferRoots() == 0) throw FeatureError("Le fichier STEP ne contient aucune forme");
  Body tool;
  tool.shape = reader.OneShape();
  if (tool.shape.IsNull()) throw FeatureError("Le fichier STEP ne contient aucune forme");
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(tool.shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); i++) tool.names.set(faces(i), ctx.name("face(" + std::to_string(i) + ")"));
  return combine(ctx, std::move(tool), false);
}

}  // namespace cad
