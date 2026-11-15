// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// Embind bindings of cad-core. The document and the result go through JSON (small); the mesh buffers and
// the exports are exposed as typed views on the WASM memory (typed_memory_view): no copy on the C++ side.
// The views are valid until the next call: the client copies them right away (slice) to transfer them.
#include "document/engine.hpp"

#include <emscripten/bind.h>
#include <emscripten/heap.h>
#include <malloc.h>
#include <emscripten/val.h>

#include <string>
#include <vector>

using emscripten::typed_memory_view;
using emscripten::val;

namespace {

/// Throws a JS Error. Called outside any catch block: the C++ exception has already been released.
[[noreturn]] void throwJs(const std::string& message) { val::global("Error").new_(message).throw_(); }

/// Copies a C++ buffer into a JS Float32Array (a single copy, from the WASM memory).
val floats(const std::vector<float>& v) { return val(typed_memory_view(v.size(), v.data())).call<val>("slice"); }

val bounds(const std::array<double, 4>& b) {
  val out = val::array();
  for (double x : b) out.call<void>("push", x);
  return out;
}

/// Placed occurrences: [{ key, docId, matrix: number[16], cut? }].
std::vector<cad::Engine::Placed> placedOf(const val& items) {
  std::vector<cad::Engine::Placed> out;
  const unsigned n = items["length"].as<unsigned>();
  for (unsigned i = 0; i < n; i++) {
    const val it = items[i];
    cad::Engine::Placed p;
    p.key = it["key"].as<std::string>();
    p.docId = it["docId"].as<std::string>();
    for (unsigned k = 0; k < 16; k++) p.matrix[k] = it["matrix"][k].as<double>();
    p.cut = !(it["cut"].isFalse());
    out.push_back(std::move(p));
  }
  return out;
}

class Kernel {
public:
  /// `resolver(featureId, payloadJson) → resultJson`: deferred preparation (Engine::Resolver). It must not throw:
  /// an error is returned in the result ({ error }).
  std::string recompute(const std::string& input, val resolver) {
    std::string error;
    cad::Engine::Resolver r;
    if (resolver.typeOf().as<std::string>() == "function") {
      r = [resolver](const std::string& id, const cad::Json& payload) {
        return cad::Json::parse(resolver(id, payload.dump()).as<std::string>());
      };
    }
    try {
      return engine_.recomputeJson(input, r);
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  /// Views on the buffers of the last mesh (null if no body).
  val mesh() const { return views(engine_.mesh()); }

  /// Fine mesh of the body of the document `docId` (`deflection` in mm; ≤ 0: default), for the CAM.
  /// Views valid until the next call.
  val camMesh(const std::string& docId, double deflection) {
    std::string error;
    try {
      camMesh_ = engine_.camMesh(docId, deflection);
      return views(camMesh_);
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  /// Exports the last body of the document `docId` (null: last recomputed document); returns a view on the
  /// file (valid until the next export).
  val exportShape(const std::string& format, val docId) {
    std::string error;
    try {
      exported_ = docId.isString() ? engine_.exportShape(format, docId.as<std::string>()) : engine_.exportShape(format);
      return val(typed_memory_view(exported_.size(), exported_.data()));
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  /// Exports several placed occurrences (documents already recomputed) into a single file; view valid until the next export.
  val exportPlaced(const std::string& format, val parts) {
    std::string error;
    try {
      exported_ = engine_.exportPlaced(format, placedOf(parts));
      return val(typed_memory_view(exported_.size(), exported_.data()));
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  /// Resolves a topological name of a face or edge of the document to a mesh identifier (-1 if not found).
  int resolveName(const std::string& name, const std::string& docId) const { return engine_.resolveName(name, docId); }

  /// Memory of the module: bytes allocated (`used`, malloc) and size of the WASM heap (`heap`, only grows).
  val memory() const {
    val out = val::object();
    out.set("used", double(mallinfo().uordblks));
    out.set("heap", double(emscripten_get_heap_size()));
    return out;
  }

  /// Curvature at each vertex of the display mesh of the document (`kind`: gaussian, mean, min, max), NaN where it
  /// is not defined.
  val surfaceAnalysis(const std::string& docId, const std::string& kind) {
    std::string error;
    try {
      return floats(engine_.surfaceAnalysis(docId, kind));
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  /// Continuity along the edge `edge` (topological name): [{ p, g0, g1, g2 }] (ContinuitySample of @solidus-cad/sdk).
  val continuity(const std::string& docId, const std::string& edge) {
    std::string error;
    try {
      val out = val::array();
      for (const cad::ContinuitySample& c : engine_.continuity(docId, edge)) {
        val o = val::object();
        val p = val::array();
        p.call<void>("push", c.p.X());
        p.call<void>("push", c.p.Y());
        p.call<void>("push", c.p.Z());
        o.set("p", p);
        o.set("g0", c.g0);
        o.set("g1", c.g1);
        o.set("g2", c.g2);
        out.call<void>("push", o);
      }
      return out;
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  /// Flat pattern of the sheet metal of the document (FlatPattern format of @solidus-cad/sdk).
  val flatPattern(const std::string& docId) {
    std::string error;
    try {
      const cad::FlatPatternData f = engine_.flatPattern(docId);
      val out = val::object();
      out.set("outline", floats(f.outline));
      out.set("circles", floats(f.circles));
      val bends = val::array();
      for (const auto& b : f.bends) {
        val o = val::object();
        o.set("x1", b.a.X());
        o.set("y1", b.a.Y());
        o.set("x2", b.b.X());
        o.set("y2", b.b.Y());
        o.set("angle", b.angle);
        o.set("up", b.up);
        bends.call<void>("push", o);
      }
      out.set("bends", bends);
      out.set("bounds", bounds(f.bounds));
      out.set("thickness", f.thickness);
      out.set("radius", f.radius);
      out.set("kFactor", f.kFactor);
      return out;
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  /// Interferences between placed occurrences (documents already recomputed).
  val interferences(val parts) {
    std::string error;
    try {
      val out = val::array();
      for (const auto& i : engine_.interferences(placedOf(parts))) {
        val o = val::object();
        o.set("a", i.a);
        o.set("b", i.b);
        o.set("volume", i.volume);
        out.call<void>("push", o);
      }
      return out;
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  /// Views of a scene: items [{ key, docId, matrix, cut? }], views [{ kind, section?: { depth } }] → ProjectedView[].
  val projectScene(val items, val views) {
    std::string error;
    try {
      std::vector<cad::Engine::SceneView> vs;
      const unsigned n = views["length"].as<unsigned>();
      for (unsigned i = 0; i < n; i++) {
        const val v = views[i];
        cad::Engine::SceneView sv{v["kind"].as<std::string>(), std::nullopt};
        if (!v["section"].isUndefined() && !v["section"].isNull()) sv.section = v["section"]["depth"].as<double>();
        vs.push_back(std::move(sv));
      }
      val out = val::array();
      for (const auto& r : engine_.projectScene(placedOf(items), vs)) {
        val o = val::object();
        o.set("visible", floats(r.view.visible));
        o.set("hidden", floats(r.view.hidden));
        o.set("circles", floats(r.view.circles));
        o.set("bounds", bounds(r.view.bounds));
        if (vs[out["length"].as<unsigned>()].section) {
          val hatches = val::array();
          for (const auto& [key, segs] : r.hatches) {
            val h = val::object();
            h.set("key", key);
            h.set("segments", floats(segs));
            hatches.call<void>("push", h);
          }
          o.set("hatches", hatches);
        }
        out.call<void>("push", o);
      }
      return out;
    } catch (...) {
      error = cad::describeCurrentException();
    }
    throwJs(error);
  }

  void forget(const std::string& docId) { engine_.forget(docId); }
  void trim() { engine_.trim(); }

private:
  static val views(const cad::MeshData& m) {
    if (m.indices.empty() && m.edges.empty()) return val::null();
    val out = val::object();
    out.set("positions", val(typed_memory_view(m.positions.size(), m.positions.data())));
    out.set("normals", val(typed_memory_view(m.normals.size(), m.normals.data())));
    out.set("indices", val(typed_memory_view(m.indices.size(), m.indices.data())));
    out.set("faceGroups", val(typed_memory_view(m.faceGroups.size(), m.faceGroups.data())));
    out.set("edges", val(typed_memory_view(m.edges.size(), m.edges.data())));
    out.set("edgeGroups", val(typed_memory_view(m.edgeGroups.size(), m.edgeGroups.data())));
    return out;
  }

  cad::Engine engine_;
  std::vector<uint8_t> exported_;
  cad::MeshData camMesh_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(cad_kernel) {
  emscripten::class_<Kernel>("Kernel")
      .constructor<>()
      .function("recompute", &Kernel::recompute)
      .function("mesh", &Kernel::mesh)
      .function("camMesh", &Kernel::camMesh)
      .function("exportShape", &Kernel::exportShape)
      .function("exportPlaced", &Kernel::exportPlaced)
      .function("resolveName", &Kernel::resolveName)
      .function("flatPattern", &Kernel::flatPattern)
      .function("surfaceAnalysis", &Kernel::surfaceAnalysis)
      .function("memory", &Kernel::memory)
      .function("continuity", &Kernel::continuity)
      .function("interferences", &Kernel::interferences)
      .function("projectScene", &Kernel::projectScene)
      .function("forget", &Kernel::forget)
      .function("trim", &Kernel::trim);
}
