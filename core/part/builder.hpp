// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Registry of feature builders. To add a feature:
//   1. write `FeatureOutput buildXxx(const BuildContext&)` in core/part/xxx.cpp and declare it in features.hpp;
//   2. register it in registerPartFeatures() (core/part/registry.cpp).
#pragma once

#include "naming/naming.hpp"

#include <nlohmann/json.hpp>

#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax3.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec2d.hxx>

#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace cad {

using Json = nlohmann::ordered_json;

/// Error attributed to a feature: its message is displayed as is in the tree.
class FeatureError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

/// Volume added (or removed) by a feature, before combination with the body: mirror and pattern features repeat it.
struct Tool {
  TopoDS_Shape shape;
  TopoNames names;
  bool cut = false;
};

struct SheetState;

/// Kind of a body: closed volume (solid) or surface (open shell, no volume).
enum class BodyKind { Solid, Surface };

/// Body produced by a feature: the shape and the topological names of its faces.
struct Body {
  TopoDS_Shape shape;
  TopoNames names;
  /// Tool of the feature (set by combine()), or nullptr.
  std::shared_ptr<const Tool> tool;
  /// Sheet metal: new sheet state left by the feature, or nullptr (the previous state is kept).
  std::shared_ptr<const SheetState> sheet;
  /// New body ("new" operation): added to the part instead of replacing the target body.
  bool created = false;
  BodyKind kind = BodyKind::Solid;
};

/// Output of a feature acting on several bodies (combine, delete, split, move as a copy).
/// Created bodies take the identifier of the feature, then "<id>#2", "<id>#3"...
struct BodyChanges {
  /// New shape of the target body, or nothing (unchanged).
  std::optional<Body> target;
  /// The target body is removed from the part (after applying `target`, no effect then).
  bool removeTarget = false;
  std::vector<Body> created;
  /// Other bodies removed (tools consumed by a combination).
  std::vector<std::string> removed;
  /// Bodies used by the feature and kept in the part, hidden by default (thickened surface, cutter…).
  std::vector<std::string> consumed;
};

/// Built sketch: faces of the closed regions, wires of the open chains, in the frame of the plane.
struct SketchProfile {
  gp_Ax3 frame;
  std::vector<TopoDS_Face> faces;
  /// Stable key of each region (identifier of the first curve of its outline), to name the faces.
  std::vector<std::string> regionKeys;
  std::vector<TopoDS_Wire> wires;
  /// Edge → identifier of the sketch curve it comes from.
  std::unordered_map<TopoDS_Shape, std::string, TopTools_ShapeMapHasher, TopTools_ShapeMapHasher> edgeCurves;
  /// Sketch lines (including construction lines), usable as axes.
  std::map<std::string, std::pair<gp_Pnt2d, gp_Pnt2d>, std::less<>> lines;
  /// Isolated points (not construction, not connected to any curve), in sketch order: hole positions.
  struct Point {
    std::string id;
    gp_Pnt2d p;
  };
  std::vector<Point> isolated;
  /// Non-construction segments, in sketch order: slot axes, bend line on a line.
  struct Segment {
    std::string id;
    gp_Pnt2d a, b;
  };
  std::vector<Segment> segments;
  /// Start of the first open chain: point and tangent (sketch frame), for sweeps.
  std::optional<std::pair<gp_Pnt2d, gp_Vec2d>> pathStart;
  /// 3D sketch: its curves are in space (no plane, `faces` empty, `frame` = part frame). Start of the first chain,
  /// point and unit tangent in the part frame (`pathStart` is not used).
  bool space = false;
  std::optional<std::pair<gp_Pnt, gp_Dir>> spaceStart;
  /// First open chain as a polyline (sheet metal from profile): ordered points; `polylineLinesOnly` is false if it
  /// contains an arc. Empty if there is no chain.
  std::vector<gp_Pnt2d> polyline;
  bool polylineLinesOnly = true;

  gp_Pnt toWorld(const gp_Pnt2d& p) const;
};

using FeatureOutput = std::variant<Body, SketchProfile, BodyChanges>;

/// Parameters of a feature, as sent by the client: raw expression and resolved value (or error).
struct FeatureParams {
  std::map<std::string, std::string, std::less<>> exprs;
  std::map<std::string, double, std::less<>> values;
  std::map<std::string, std::string, std::less<>> errors;
};

/// Feature of the tree, ready to build (see the input format in core/README.md).
struct FeatureInput {
  std::string id;
  std::string type;
  bool suppressed = false;
  FeatureParams params;
  /// Sketch resolved by the client (null if the feature is not a sketch).
  Json sketch;
  /// Geometric references (GeomRef) to edges or faces.
  Json refs;
  /// Data computed by the client for the builder (thickened outlines of thinExtrude…), null otherwise.
  Json prepared;
  /// Imported file (importStep): { hash, data (base64) }; only the fingerprint enters the cache key.
  Json imported;
  /// Deferred preparation: the client completes the feature when it is built, with data from the current body
  /// (`edges`: edges projected into a sketch, GeomRef to resolve). See Engine::Resolver.
  Json deferred;
  /// Error detected by the client before the kernel (unresolved sketch, invalid dimension…).
  std::string error;
  /// Target body (body identifier, `Feature.body`); empty: the active body (last created or modified).
  std::string body;
  /// Canonical content of the feature, for the cache key.
  std::string canonical;
};

/// Bodies of the part at the time of a feature, in creation order: (identifier, body).
using BodyList = std::vector<std::pair<std::string, const Body*>>;

class BuildContext {
public:
  using SketchLookup = std::function<const SketchProfile*(std::string_view featureId)>;
  using ToolLookup = std::function<std::shared_ptr<const Tool>(std::string_view featureId)>;

  BuildContext(const FeatureInput& feature, const Body* prev, SketchLookup sketches, ToolLookup tools = {},
               const SheetState* sheet = nullptr, const BodyList* bodies = nullptr, std::string targetId = {})
      : feature_(feature), prev_(prev), sketches_(std::move(sketches)), tools_(std::move(tools)), sheet_(sheet),
        bodies_(bodies), targetId_(std::move(targetId)) {}

  /// Target body of the feature (the active body, or `Feature.body`), or nullptr if there is no body yet.
  const Body* prev() const { return prev_; }
  /// Identifier of the target body ("" if no body).
  const std::string& targetId() const { return targetId_; }
  /// All bodies of the part (multi-body).
  const BodyList& bodies() const;
  /// Body designated by its identifier; throws "Corps introuvable" if it does not exist (or no longer).
  const Body& body(std::string_view id) const;
  /// Sheet metal: sheet state left by the previous features (nullptr if the part is not sheet metal).
  const SheetState* sheet() const { return sheet_; }
  const FeatureInput& feature() const { return feature_; }
  std::string_view featureId() const { return feature_.id; }

  /// Numeric value of a parameter (expression already evaluated by the client).
  double num(std::string_view key) const;
  /// Strictly positive value.
  double positive(std::string_view key) const;
  /// Raw value of a parameter (enumeration, reference…), or "" if it is absent.
  std::string str(std::string_view key) const;
  bool has(std::string_view key) const { return feature_.params.exprs.find(key) != feature_.params.exprs.end(); }
  /// Sketch computed earlier in the tree, referenced by the parameter `key`.
  const SketchProfile& sketch(std::string_view key) const;
  /// Sketches referenced by the parameter `key` (comma-separated identifiers, in their order); empty if it is empty.
  std::vector<const SketchProfile*> sketches(std::string_view key) const;
  /// Tool of an earlier feature, referenced by the parameter `key`.
  std::shared_ptr<const Tool> featureTool(std::string_view key) const;

  /// Topological name of a face created by this feature: "<feature id>/<role>".
  std::string name(std::string_view role) const;

private:
  const FeatureInput& feature_;
  const Body* prev_;
  SketchLookup sketches_;
  ToolLookup tools_;
  const SheetState* sheet_;
  const BodyList* bodies_;
  std::string targetId_;
};

using FeatureBuilder = std::function<FeatureOutput(const BuildContext&)>;

/// Body a feature accepts as target: a solid only (volume operations), or any body.
enum class TargetKind { Solid, Any };

class FeatureRegistry {
public:
  void add(std::string type, FeatureBuilder builder, TargetKind target = TargetKind::Solid);
  const FeatureBuilder* find(std::string_view type) const;
  /// Kind of target accepted by the feature (Solid for an unknown type).
  TargetKind target(std::string_view type) const;

private:
  std::map<std::string, std::pair<FeatureBuilder, TargetKind>, std::less<>> builders_;
};

/// Registers the features of the Part workbench.
void registerPartFeatures(FeatureRegistry& registry);

}  // namespace cad
