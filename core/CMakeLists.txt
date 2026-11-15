# cad-core: parametric C++20 engine on OCCT (pruned, static).
#   WASM   : tools/build-kernel.sh wasm    (Emscripten → packages/kernel-wasm/dist/kernel.{js,wasm})
#   Native : tools/build-kernel.sh native  (MSVC on Windows, gcc on Linux)
cmake_minimum_required(VERSION 3.24)
project(cad-core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

get_filename_component(CAD_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(OCCT_PREFIX "" CACHE PATH "Installation prefix of the pruned OCCT (tools/build-occt.sh)")
set(CAD_THIRD_PARTY "${CAD_ROOT}/third_party" CACHE PATH "Third-party sources (json, Catch2)")
option(CAD_BUILD_TESTS "Catch2 tests" ON)
option(CAD_PTHREADS "WASM multithread (pthreads)" OFF)

find_package(occt-cad CONFIG REQUIRED PATHS "${OCCT_PREFIX}/lib/cmake/occt-cad" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)

if(EMSCRIPTEN)
  set(CAD_WASM_FLAGS -fwasm-exceptions -msimd128)
  if(CAD_PTHREADS)
    list(APPEND CAD_WASM_FLAGS -pthread)
  endif()
  add_compile_options(${CAD_WASM_FLAGS})
  add_link_options(${CAD_WASM_FLAGS})
elseif(MSVC)
  add_compile_options(/EHa /bigobj /utf-8 /permissive-)
  add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX)
elseif(MINGW)
  # Cross build (tools/build-kernel.sh win64): M_PI in strict C++ mode, no min/max macros from windows.h.
  add_compile_definitions(_USE_MATH_DEFINES NOMINMAX)
endif()

add_library(cadcore STATIC
  analysis/mass.cpp
  analysis/projection.cpp
  analysis/surface.cpp
  part/advanced.cpp
  part/bodies.cpp
  part/draft.cpp
  document/engine.cpp
  io/export.cpp
  mesh/mesh.cpp
  naming/naming.cpp
  part/dressup.cpp
  part/fill.cpp
  part/frame.cpp
  part/import.cpp
  part/loft.cpp
  part/pattern.cpp
  part/primitives.cpp
  part/recipe.cpp
  part/refs.cpp
  part/registry.cpp
  part/sheetmetal.cpp
  part/sketch.cpp
  part/solidify.cpp
  part/surface.cpp
  part/surfedit.cpp
  part/sweep.cpp)
target_include_directories(cadcore PUBLIC "${CMAKE_CURRENT_LIST_DIR}" "${CAD_THIRD_PARTY}/nlohmann_json/include")
if(MSVC OR EMSCRIPTEN OR APPLE)
  foreach(tk IN LISTS OCCT_CAD_TOOLKITS)
    target_link_libraries(cadcore PUBLIC OCCT::${tk})
  endforeach()
else()
  # GNU ld resolves static libraries in command-line order, yet the OCCT toolkits
  # reference each other in both directions: a single group, scanned until everything is resolved.
  list(TRANSFORM OCCT_CAD_TOOLKITS PREPEND OCCT:: OUTPUT_VARIABLE occt_targets)
  string(REPLACE ";" "," occt_group "${occt_targets}")
  target_link_libraries(cadcore PUBLIC "$<LINK_GROUP:RESCAN,${occt_group}>")
endif()
if(WIN32)
  # System libraries used by TKernel (OSD), MSVC or MinGW.
  target_link_libraries(cadcore PUBLIC advapi32 user32 gdi32 ws2_32 psapi)
endif()
if(NOT EMSCRIPTEN AND NOT MSVC)
  find_package(Threads REQUIRED)
  target_link_libraries(cadcore PUBLIC Threads::Threads ${CMAKE_DL_LIBS})
endif()

if(CAD_BUILD_TESTS)
  add_library(catch2 STATIC "${CAD_THIRD_PARTY}/catch2/catch_amalgamated.cpp")
  target_include_directories(catch2 PUBLIC "${CAD_THIRD_PARTY}/catch2")
  add_executable(cadcore_tests tests/test_engine.cpp tests/test_naming.cpp tests/test_bodies.cpp tests/test_surface.cpp tests/test_solidify.cpp tests/test_spline.cpp tests/test_loft.cpp tests/test_fill.cpp tests/test_surfedit.cpp tests/test_analysis.cpp tests/test_draft.cpp tests/fixtures.cpp)
  target_link_libraries(cadcore_tests PRIVATE cadcore catch2)
  if(EMSCRIPTEN)
    # Node executable: `node cadcore_tests.js`.
    target_link_options(cadcore_tests PRIVATE -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4MB -sNODERAWFS=1 -sEXIT_RUNTIME=1)
  endif()
endif()

if(EMSCRIPTEN)
  add_subdirectory("${CAD_ROOT}/bindings/wasm" bindings)
else()
  add_subdirectory("${CAD_ROOT}/bindings/native" bindings)
endif()
