// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
#include "part/builder.hpp"
#include "part/features.hpp"

#include <algorithm>

namespace cad {

double BuildContext::num(std::string_view key) const {
  const FeatureParams& p = feature_.params;
  if (auto it = p.values.find(key); it != p.values.end()) return it->second;
  const std::string k(key);
  if (!has(key)) throw FeatureError("Paramètre « " + k + " » manquant");
  if (auto it = p.errors.find(key); it != p.errors.end()) throw FeatureError(k + " : " + it->second);
  throw FeatureError(k + " : valeur non résolue");
}

double BuildContext::positive(std::string_view key) const {
  const double v = num(key);
  if (v <= 0) throw FeatureError("« " + std::string(key) + " » doit être strictement positif");
  return v;
}

std::string BuildContext::str(std::string_view key) const {
  auto it = feature_.params.exprs.find(key);
  return it == feature_.params.exprs.end() ? std::string() : it->second;
}

const SketchProfile& BuildContext::sketch(std::string_view key) const {
  const SketchProfile* s = sketches_ ? sketches_(str(key)) : nullptr;
  if (!s) throw FeatureError("Esquisse introuvable ou en erreur");
  return *s;
}

std::vector<const SketchProfile*> BuildContext::sketches(std::string_view key) const {
  std::vector<const SketchProfile*> out;
  const std::string list = str(key);
  for (size_t at = 0; at <= list.size();) {
    const size_t comma = std::min(list.find(',', at), list.size());
    if (comma > at) {
      const SketchProfile* s = sketches_ ? sketches_(std::string_view(list).substr(at, comma - at)) : nullptr;
      if (!s) throw FeatureError("Esquisse introuvable ou en erreur");
      out.push_back(s);
    }
    at = comma + 1;
  }
  return out;
}

std::shared_ptr<const Tool> BuildContext::featureTool(std::string_view key) const {
  std::shared_ptr<const Tool> t = tools_ ? tools_(str(key)) : nullptr;
  if (!t) throw FeatureError("Fonction de référence introuvable, en erreur, ou sans volume à répéter");
  return t;
}

const BodyList& BuildContext::bodies() const {
  static const BodyList none;
  return bodies_ ? *bodies_ : none;
}

const Body& BuildContext::body(std::string_view id) const {
  for (const auto& [bid, b] : bodies())
    if (bid == id) return *b;
  throw FeatureError("Corps introuvable");
}

std::string BuildContext::name(std::string_view role) const {
  std::string out(feature_.id);
  out += '/';
  out += role;
  return out;
}

void FeatureRegistry::add(std::string type, FeatureBuilder builder, TargetKind target) {
  builders_[std::move(type)] = {std::move(builder), target};
}

const FeatureBuilder* FeatureRegistry::find(std::string_view type) const {
  auto it = builders_.find(type);
  return it == builders_.end() ? nullptr : &it->second.first;
}

TargetKind FeatureRegistry::target(std::string_view type) const {
  auto it = builders_.find(type);
  return it == builders_.end() ? TargetKind::Solid : it->second.second;
}

void registerPartFeatures(FeatureRegistry& r) {
  r.add("box", buildBox);
  r.add("cylinder", buildCylinder);
  r.add("fillet", buildFillet);
  r.add("chamfer", buildChamfer);
  r.add("shell", buildShell);
  r.add("draft", buildDraft);
  r.add("sketch", buildSketch, TargetKind::Any);
  r.add("sketch3d", buildSketch3D, TargetKind::Any);
  r.add("extrude", buildExtrude);
  r.add("twistExtrude", buildTwistExtrude);
  r.add("thinExtrude", buildThinExtrude);
  r.add("revolve", buildRevolve);
  r.add("mirror", buildMirror);
  r.add("linearPattern", buildLinearPattern);
  r.add("circularPattern", buildCircularPattern);
  r.add("importStep", buildImportStep);
  r.add("sweep", buildSweep);
  r.add("loft", buildLoft);
  r.add("hole", buildHole);
  r.add("slot", buildSlot);
  r.add("profile", buildProfile);
  r.add("frameMembers", buildFrameMembers);
  r.add("sheetBase", buildSheetBase);
  r.add("edgeFlange", buildEdgeFlange);
  r.add("sheetCut", buildSheetCut);
  r.add("sketchedBend", buildSketchedBend);
  r.add("sheetFlat", buildSheetFlat);
  r.add("pluginRecipe", buildPluginRecipe);
  r.add("combineBodies", buildCombineBodies);
  r.add("deleteBody", buildDeleteBody, TargetKind::Any);
  r.add("moveBody", buildMoveBody, TargetKind::Any);
  r.add("splitBody", buildSplitBody);
  // Surfaces always create a new body, whatever the target.
  r.add("surfaceExtrude", buildSurfaceExtrude, TargetKind::Any);
  r.add("surfaceRevolve", buildSurfaceRevolve, TargetKind::Any);
  r.add("surfaceSweep", buildSurfaceSweep, TargetKind::Any);
  r.add("surfaceLoft", buildSurfaceLoft, TargetKind::Any);
  r.add("planarSurface", buildPlanarSurface, TargetKind::Any);
  r.add("fillSurface", buildFillSurface, TargetKind::Any);
  r.add("offsetSurface", buildOffsetSurface, TargetKind::Any);
  r.add("knitSurface", buildKnitSurface, TargetKind::Any);
  r.add("trimSurface", buildTrimSurface, TargetKind::Any);
  r.add("extendSurface", buildExtendSurface, TargetKind::Any);
  r.add("extractFaces", buildExtractFaces, TargetKind::Any);
  r.add("thicken", buildThicken);
  r.add("closeSurface", buildCloseSurface);
  r.add("cutWithSurface", buildCutWithSurface);
  r.add("replaceFace", buildReplaceFace);
}

}  // namespace cad
