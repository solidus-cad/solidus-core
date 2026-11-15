// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Recompute engine: rebuilds the tree, reusing cached intermediate results.
// Only the modified features and those that depend on them are recomputed
// (chained key = hash(previous key + feature content), see core/CONCEPTION.md).
#pragma once

#include "analysis/mass.hpp"
#include "analysis/surface.hpp"
#include "analysis/projection.hpp"
#include "mesh/mesh.hpp"
#include "part/builder.hpp"
#include "part/sheet.hpp"

#include <array>
#include <functional>

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace cad {

struct FeatureStatus {
  std::string id;
  bool ok = true;
  std::string error;
};

struct RecomputeOutput {
  std::vector<FeatureStatus> statuses;
  std::optional<MassProperties> mass;
  int rebuilt = 0;
  double ms = 0;
  /// Time breakdown (ms): feature construction, meshing, mass properties, names.
  struct Timings {
    double features = 0, mesh = 0, mass = 0, names = 0;
  } timings;
  /// Topological names, aligned with the faceGroups and edgeGroups identifiers of the mesh.
  std::vector<std::string> faceNames;
  std::vector<std::string> edgeNames;
  /// Bodies of the displayed mesh, in creation order: their faces and edges have contiguous mesh identifiers
  /// (first identifier and count).
  struct MeshedBody {
    std::string id;
    int faceStart = 0, faceCount = 0, edgeStart = 0, edgeCount = 0;
    BodyKind kind = BodyKind::Solid;
    /// Body used by a feature (thickened surface, cutter…): hidden by default in the view.
    bool consumed = false;
  };
  std::vector<MeshedBody> bodies;
  /// Mesh identifiers of the free edges (surface boundaries).
  std::vector<int> freeEdges;
  /// Active body at the end of the recompute (default target of the following features): the last solid body created
  /// or modified, "" if there is no solid.
  std::string activeBody;
  /// Bodies of the part at the end of the recompute, in creation order (the mesh may show an earlier state).
  std::vector<std::string> partBodies;
  /// Bodies of the part and active body just before the feature `bodiesBefore` of the input (editing a feature in the
  /// middle of the tree: bodies it can target); absent if it is not requested or not reached.
  struct BodiesSnapshot {
    std::vector<std::string> bodies;
    std::string active;
  };
  std::optional<BodiesSnapshot> bodiesBefore;
  /// Properties of each body, when the part has several or has a surface (area only for a surface).
  /// `mass` is the sum of the non-consumed solids; without solids, the area of the surfaces.
  std::vector<std::pair<std::string, MassProperties>> bodyMass;

  Json toJson() const;
};

class Engine {
public:
  Engine();

  /// Registry of builders: features can be added to it (plugins, tests).
  FeatureRegistry& registry() { return registry_; }

  /// Recomputes the document prepared by the client (format in core/README.md). Does not throw: errors
  /// are attributed to the features. The mesh is then available through mesh().
  /// One cache per document (`docId`): several open parts, assemblies.
  ///
  /// `resolver` completes the features marked `deferred` (deferred preparation): called when building them with
  /// (identifier, data of the current body), it returns what was missing (`sketch`, `prepared`) or `error`. Without a
  /// resolver, these features are reported as errors.
  using Resolver = std::function<Json(const std::string& featureId, const Json& payload)>;
  RecomputeOutput recompute(const Json& input, const Resolver& resolver = {});
  /// JSON to JSON variant (bindings).
  std::string recomputeJson(std::string_view input, const Resolver& resolver = {});

  const MeshData& mesh() const { return mesh_; }
  /// Active body (last created or modified) at the end of the last recompute of document `docId` (or of the last
  /// recomputed document), or nullptr.
  const Body* current() const { return current(lastDoc_); }
  const Body* current(std::string_view docId) const;
  /// The part as seen from outside (mass, drawing, interferences, CAM, assembly export): the shape of its single solid
  /// body, or a compound of its non-consumed solids. Empty if there is no solid.
  std::optional<TopoDS_Shape> partShape(std::string_view docId) const;
  /// Mesh identifier (rank in faceGroups or edgeGroups) of a face or edge of the final body,
  /// designated by its topological name; -1 if the name no longer exists.
  int resolveName(std::string_view name) const { return resolveName(name, lastDoc_); }
  int resolveName(std::string_view name, std::string_view docId) const;
  /// Fine mesh of the final body of the document (CAM: 3D toolpaths). `deflection`: linear deflection in mm;
  /// <= 0: default deflection. Independent of mesh() (display mesh). Throws std::runtime_error.
  MeshData camMesh(std::string_view docId, double deflection) const;
  /// Exports the part: its non-consumed solids and surfaces (STEP: surfaces as shell_based_surface_model);
  /// throws std::runtime_error.
  std::vector<uint8_t> exportShape(std::string_view format) const { return exportShape(format, lastDoc_); }
  std::vector<uint8_t> exportShape(std::string_view format, std::string_view docId) const;

  /// Surface analysis of the last recompute of the document: curvature (`kind`: "gaussian", "mean", "min", "max") at
  /// each vertex of the display mesh (all bodies, as tessellated by the recompute). Throws std::runtime_error.
  std::vector<float> surfaceAnalysis(std::string_view docId, std::string_view kind) const;
  /// Continuity along the edge `edgeName` (topological name) between its two faces: G0, G1, G2 deviations at points
  /// evenly spread along it. Throws std::runtime_error.
  std::vector<ContinuitySample> continuity(std::string_view docId, std::string_view edgeName) const;

  /// Sheet metal: flat pattern of the part (last recompute of the document). Throws if the part is not sheet metal.
  FlatPatternData flatPattern(std::string_view docId) const;

  /// Instance of an already recomputed part, placed by a 4×4 matrix (column-major, rigid motion).
  struct Placed {
    std::string key, docId;
    std::array<double, 16> matrix;
    /// Drawing: false for a part excluded from the section.
    bool cut = true;
  };
  struct Interference {
    std::string a, b;
    double volume;
  };
  /// Exports the placed instances (already recomputed documents) to a single file: a compound of solids.
  /// Throws std::runtime_error if there is no geometry.
  std::vector<uint8_t> exportPlaced(std::string_view format, const std::vector<Placed>& parts) const;
  /// Common volume of each pair of instances whose bounding boxes overlap (above minVolume).
  std::vector<Interference> interferences(const std::vector<Placed>& parts, double minVolume = 1e-3) const;

  /// View of a scene (drawing): `section` = depth of the section plane along the view normal.
  struct SceneView {
    std::string kind;
    std::optional<double> section;
  };
  struct SceneResult {
    ProjectedView view;
    /// Section outlines of each cut part (hatching), already included in view.visible.
    std::vector<std::pair<std::string, std::vector<float>>> hatches;
  };
  /// HLR of all placed parts, with optional section (projectScene request).
  std::vector<SceneResult> projectScene(const std::vector<Placed>& items, const std::vector<SceneView>& views) const;

  /// Releases the cache of a closed document.
  void forget(std::string_view docId);
  /// Releases the least recently used documents beyond maxCachedDocs (the WASM heap is limited): a released document
  /// is simply rebuilt at its next recompute. Call between two requests, never during one.
  void trim();
  size_t maxCachedDocs = 8;

  MeshOptions meshOptions;

private:
  /// Feature completed by the client (deferred preparation); throws FeatureError.
  static FeatureInput complete(const FeatureInput& f, const Body* prev, const Resolver& resolver);

  using OutputPtr = std::shared_ptr<const FeatureOutput>;
  /// Body of the part: identifier (that of the feature which created it), shape, and sheet state if it is sheet metal.
  struct BodyEntry {
    std::string id;
    std::shared_ptr<const Body> body;
    std::shared_ptr<const SheetState> sheet;
    /// Used by a feature (thickened surface…): outside the part as seen from outside, hidden by default.
    bool consumed = false;
    bool solid() const { return body->kind == BodyKind::Solid; }
  };
  struct DocState {
    std::unordered_map<std::string, OutputPtr> cache;
    std::vector<BodyEntry> bodies;
    std::string active;
    /// Last sheet state left by a feature (flat pattern of the part).
    std::shared_ptr<const SheetState> sheet;
  };
  FeatureRegistry registry_;
  std::unordered_map<std::string, DocState> docs_;
  /// Cached documents, from least to most recently recomputed.
  std::vector<std::string> recent_;
  std::string lastDoc_;
  MeshData mesh_;
};

/// Parses the features sent by the client.
std::vector<FeatureInput> parseFeatures(const Json& features);

/// Message of an exception (FeatureError, OCCT exception, std::exception).
std::string describeCurrentException();

}  // namespace cad
