// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-Solidus-Plugin-Exception
// cad-kernel: native cad-core in a separate process (sidecar of the desktop application, apps/desktop).
//
// Protocol over stdin / stdout, in binary frames: [u32 length][payload], little-endian integers.
//  - Client → kernel: payload = JSON (UTF-8).
//      { "type": "request", "kind": "recompute" | "export" | …, … }   request
//      { "type": "reply", "result": … }                                 reply to a callback (deferred preparation)
//  - Kernel → client: payload = [u32 header length][JSON header][padding to 4 bytes][binary data].
//      { "type": "result", …, "buffers": [{ "name", "type", "length" }] }   result; binary arrays follow
//      { "type": "callback", "featureId", "payload" }                        the kernel waits for a "reply" frame
//      { "type": "error", "message" }
// One request at a time: the client waits for the result (or answers the callbacks) before sending the next one.
// OCCT sometimes writes to stdout (STEP statistics): the protocol goes through a copy of stdout, and stdout is
// redirected to stderr. Request and result format: packages/kernel-wasm/src/native.ts.
#include "document/engine.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define cad_read _read
#define cad_write _write
#define cad_dup _dup
#define cad_dup2 _dup2
#else
#include <unistd.h>
#define cad_read read
#define cad_write write
#define cad_dup dup
#define cad_dup2 dup2
#endif

namespace {

using cad::Json;

int protocolOut = 1;

bool readAll(void* data, size_t size) {
  auto* p = static_cast<char*>(data);
  while (size > 0) {
    const int n = cad_read(0, p, static_cast<unsigned>(size > (1u << 30) ? (1u << 30) : size));
    if (n <= 0) return false;
    p += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}

void writeAll(const void* data, size_t size) {
  const auto* p = static_cast<const char*>(data);
  while (size > 0) {
    const int n = cad_write(protocolOut, p, static_cast<unsigned>(size > (1u << 30) ? (1u << 30) : size));
    if (n <= 0) std::exit(2);  // client gone
    p += n;
    size -= static_cast<size_t>(n);
  }
}

uint32_t le32(const unsigned char* b) { return uint32_t(b[0]) | uint32_t(b[1]) << 8 | uint32_t(b[2]) << 16 | uint32_t(b[3]) << 24; }

void putLe32(std::string& out, uint32_t v) {
  for (int i = 0; i < 4; i++) out.push_back(static_cast<char>((v >> (8 * i)) & 0xff));
}

/// Next client frame (JSON), or nothing at end of stream.
std::optional<Json> readFrame() {
  unsigned char len[4];
  if (!readAll(len, 4)) return std::nullopt;
  std::string payload(le32(len), '\0');
  if (!readAll(payload.data(), payload.size())) return std::nullopt;
  return Json::parse(payload);
}

/// Binary array attached to a result.
struct Buffer {
  std::string name;
  std::string type;  // f32, u32, i32, u8
  const void* data;
  size_t length;     // in elements
  size_t elementSize;
};

void writeFrame(Json header, const std::vector<Buffer>& buffers = {}) {
  Json list = Json::array();
  for (const Buffer& b : buffers) list.push_back({{"name", b.name}, {"type", b.type}, {"length", b.length}});
  if (!buffers.empty()) header["buffers"] = std::move(list);
  const std::string h = header.dump();
  std::string body;
  putLe32(body, static_cast<uint32_t>(h.size()));
  body += h;
  while (body.size() % 4) body.push_back(' ');  // binary data aligned on 4 bytes (typed views on the client side)
  for (const Buffer& b : buffers) body.append(static_cast<const char*>(b.data), b.length * b.elementSize);
  std::string frame;
  putLe32(frame, static_cast<uint32_t>(body.size()));
  writeAll(frame.data(), frame.size());
  writeAll(body.data(), body.size());
}

Json floats(const std::vector<float>& v) { return Json(v); }

std::vector<cad::Engine::Placed> placedOf(const Json& items) {
  std::vector<cad::Engine::Placed> out;
  for (const Json& it : items) {
    cad::Engine::Placed p;
    p.key = it.at("key").get<std::string>();
    p.docId = it.at("docId").get<std::string>();
    for (size_t k = 0; k < 16; k++) p.matrix[k] = it.at("matrix").at(k).get<double>();
    p.cut = it.value("cut", true);
    out.push_back(std::move(p));
  }
  return out;
}

void handle(cad::Engine& engine, const Json& req) {
  const std::string kind = req.at("kind").get<std::string>();
  if (kind == "recompute") {
    // Deferred preparation: callback to the client, which answers with a "reply" frame.
    const cad::Engine::Resolver resolver = [](const std::string& featureId, const Json& payload) -> Json {
      writeFrame({{"type", "callback"}, {"featureId", featureId}, {"payload", payload}});
      const std::optional<Json> reply = readFrame();
      if (!reply || reply->value("type", "") != "reply") std::exit(3);  // broken protocol
      return reply->value("result", Json::object());
    };
    Json header = engine.recompute(req.at("input"), resolver).toJson();
    header["type"] = "result";
    const cad::MeshData& m = engine.mesh();
    std::vector<Buffer> buffers;
    if (!m.indices.empty() || !m.edges.empty()) {
      buffers = {{"positions", "f32", m.positions.data(), m.positions.size(), 4},
                 {"normals", "f32", m.normals.data(), m.normals.size(), 4},
                 {"indices", "u32", m.indices.data(), m.indices.size(), 4},
                 {"faceGroups", "i32", m.faceGroups.data(), m.faceGroups.size(), 4},
                 {"edges", "f32", m.edges.data(), m.edges.size(), 4},
                 {"edgeGroups", "i32", m.edgeGroups.data(), m.edgeGroups.size(), 4}};
    }
    writeFrame(std::move(header), buffers);
  } else if (kind == "export") {
    const std::vector<uint8_t> data = req.contains("docId") && req.at("docId").is_string()
                                          ? engine.exportShape(req.at("format").get<std::string>(), req.at("docId").get<std::string>())
                                          : engine.exportShape(req.at("format").get<std::string>());
    writeFrame({{"type", "result"}}, {{"data", "u8", data.data(), data.size(), 1}});
  } else if (kind == "exportPlaced") {
    const std::vector<uint8_t> data = engine.exportPlaced(req.at("format").get<std::string>(), placedOf(req.at("parts")));
    writeFrame({{"type", "result"}}, {{"data", "u8", data.data(), data.size(), 1}});
  } else if (kind == "camMesh") {
    // Fine mesh for the CAM: same arrays as the result of a recomputation.
    const cad::MeshData m = engine.camMesh(req.at("docId").get<std::string>(), req.value("deflection", 0.0));
    std::vector<Buffer> buffers;
    if (!m.indices.empty() || !m.edges.empty()) {
      buffers = {{"positions", "f32", m.positions.data(), m.positions.size(), 4},
                 {"normals", "f32", m.normals.data(), m.normals.size(), 4},
                 {"indices", "u32", m.indices.data(), m.indices.size(), 4},
                 {"faceGroups", "i32", m.faceGroups.data(), m.faceGroups.size(), 4},
                 {"edges", "f32", m.edges.data(), m.edges.size(), 4},
                 {"edgeGroups", "i32", m.edgeGroups.data(), m.edgeGroups.size(), 4}};
    }
    writeFrame({{"type", "result"}}, buffers);
  } else if (kind == "surfaceAnalysis") {
    const std::vector<float> v = engine.surfaceAnalysis(req.at("docId").get<std::string>(), req.at("analysis").get<std::string>());
    writeFrame({{"type", "result"}}, {{"values", "f32", v.data(), v.size(), 4}});
  } else if (kind == "continuity") {
    Json out = Json::array();
    for (const cad::ContinuitySample& c : engine.continuity(req.at("docId").get<std::string>(), req.at("edge").get<std::string>()))
      out.push_back({{"p", {c.p.X(), c.p.Y(), c.p.Z()}}, {"g0", c.g0}, {"g1", c.g1}, {"g2", c.g2}});
    writeFrame({{"type", "result"}, {"value", out}});
  } else if (kind == "flatPattern") {
    const cad::FlatPatternData f = engine.flatPattern(req.at("docId").get<std::string>());
    Json bends = Json::array();
    for (const auto& b : f.bends)
      bends.push_back({{"x1", b.a.X()}, {"y1", b.a.Y()}, {"x2", b.b.X()}, {"y2", b.b.Y()}, {"angle", b.angle}, {"up", b.up}});
    writeFrame({{"type", "result"},
                {"value",
                 {{"outline", floats(f.outline)}, {"circles", floats(f.circles)}, {"bends", bends}, {"bounds", f.bounds},
                  {"thickness", f.thickness}, {"radius", f.radius}, {"kFactor", f.kFactor}}}});
  } else if (kind == "interferences") {
    Json out = Json::array();
    for (const auto& i : engine.interferences(placedOf(req.at("parts")))) out.push_back({{"a", i.a}, {"b", i.b}, {"volume", i.volume}});
    writeFrame({{"type", "result"}, {"value", out}});
  } else if (kind == "projectScene") {
    std::vector<cad::Engine::SceneView> views;
    for (const Json& v : req.at("views")) {
      cad::Engine::SceneView sv{v.at("kind").get<std::string>(), std::nullopt};
      if (const auto s = v.find("section"); s != v.end() && s->is_object()) sv.section = s->at("depth").get<double>();
      views.push_back(std::move(sv));
    }
    Json out = Json::array();
    const auto results = engine.projectScene(placedOf(req.at("items")), views);
    for (size_t i = 0; i < results.size(); i++) {
      const auto& r = results[i];
      Json o = {{"visible", floats(r.view.visible)}, {"hidden", floats(r.view.hidden)}, {"circles", floats(r.view.circles)}, {"bounds", r.view.bounds}};
      if (views[i].section) {
        Json hatches = Json::array();
        for (const auto& [key, segs] : r.hatches) hatches.push_back({{"key", key}, {"segments", floats(segs)}});
        o["hatches"] = std::move(hatches);
      }
      out.push_back(std::move(o));
    }
    writeFrame({{"type", "result"}, {"value", out}});
  } else if (kind == "resolveName") {
    writeFrame({{"type", "result"}, {"value", engine.resolveName(req.at("name").get<std::string>(), req.at("docId").get<std::string>())}});
  } else if (kind == "forget") {
    engine.forget(req.at("docId").get<std::string>());
    writeFrame({{"type", "result"}, {"value", nullptr}});
  } else if (kind == "trim") {
    engine.trim();
    writeFrame({{"type", "result"}, {"value", nullptr}});
  } else if (kind == "ping") {
    writeFrame({{"type", "result"}, {"value", "cad-core"}});
  } else {
    writeFrame({{"type", "error"}, {"message", "Unknown request: " + kind}});
  }
}

}  // namespace

int main() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  // The protocol keeps the real stdout; anything OCCT would write to it goes to stderr.
  std::fflush(stdout);
  protocolOut = cad_dup(1);
  cad_dup2(2, 1);
#ifdef _WIN32
  _setmode(protocolOut, _O_BINARY);
#endif

  cad::Engine engine;
  while (const std::optional<Json> req = readFrame()) {
    if (req->value("type", "") != "request") {
      writeFrame({{"type", "error"}, {"message", "Unexpected frame: a request was expected"}});
      continue;
    }
    std::string error;
    try {
      handle(engine, *req);
      continue;
    } catch (...) {
      error = cad::describeCurrentException();
    }
    writeFrame({{"type", "error"}, {"message", error}});
  }
  return 0;
}
