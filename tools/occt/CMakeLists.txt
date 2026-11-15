# Pruned build of OCCT 7.9 as static libraries, for cad-core (WASM and native).
#
# OCCT's own CMake is not used: in OCCT 7.9, TKDESTEP depends on TKXCAF, which pulls in
# Visualization (TKService, TKV3d) and ApplicationFramework (TKCAF, TKLCAF). The wanted toolkits are built here
# by reading their PACKAGES and FILES files, and the XCAF/DE packages that create these dependencies are removed
# (see OCCT_EXCLUDED_PACKAGES and OCCT_PARTIAL_PACKAGES).
#
# Usage: cmake -S tools/occt -B build/occt-wasm -DOCCT_SOURCE_DIR=third_party/occt [toolchain]
#         cmake --build build/occt-wasm && cmake --install build/occt-wasm --prefix <prefix>
cmake_minimum_required(VERSION 3.24)
project(occt-cad LANGUAGES C CXX)

set(OCCT_SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}/../../third_party/occt" CACHE PATH "OCCT sources")
get_filename_component(OCCT_SOURCE_DIR "${OCCT_SOURCE_DIR}" ABSOLUTE)
set(OCCT_SRC "${OCCT_SOURCE_DIR}/src")
if(NOT EXISTS "${OCCT_SRC}/TKernel/PACKAGES")
  message(FATAL_ERROR "OCCT sources not found in ${OCCT_SOURCE_DIR}")
endif()

option(OCCT_WITH_IGES "Build the IGES exchange" ON)

# Toolkits, in dependency order (one static library per toolkit).
set(OCCT_TOOLKITS
  TKernel TKMath                                                   # FoundationClasses
  TKG2d TKG3d TKGeomBase TKBRep                                    # ModelingData
  TKGeomAlgo TKTopAlgo TKPrim TKBO TKBool TKHLR TKFillet TKOffset  # ModelingAlgorithms
  TKFeat TKMesh TKShHealing
  TKDE TKXSBase TKDESTEP TKDESTL)                                  # DataExchange
if(OCCT_WITH_IGES)
  list(APPEND OCCT_TOOLKITS TKDEIGES)
endif()

# Excluded packages: tied to XCAF / OCAF, hence to Visualization and ApplicationFramework.
set(OCCT_EXCLUDED_PACKAGES STEPCAFControl IGESCAFControl DESTL)
# Packages of which only some files are kept (parameters used by STEPControl and IGESControl).
set(OCCT_PARTIAL_DESTEP DESTEP_Parameters.cxx)
set(OCCT_PARTIAL_DEIGES DEIGES_Parameters.cxx)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE OFF)

if(MSVC)
  add_compile_options(/fp:precise /EHa /bigobj /wd4996 /wd26812)
  add_compile_definitions(_CRT_SECURE_NO_WARNINGS _CRT_NONSTDC_NO_DEPRECATE)
elseif(EMSCRIPTEN)
  # Native WASM exceptions and SIMD. OCC_CONVERT_SIGNALS is not defined: no signals in WASM,
  # and OCC_CATCH_SIGNALS becomes empty (no setjmp in every try block).
  add_compile_options(-fwasm-exceptions -msimd128 -Wno-deprecated-declarations -Wno-unused-command-line-argument)
  if(OCCT_PTHREADS)
    add_compile_options(-pthread)
  endif()
else()
  add_compile_options(-fexceptions -Wno-deprecated-declarations)
  add_compile_definitions(OCC_CONVERT_SIGNALS)
endif()

# Headers: copied into a single include/opencascade folder, as in the OCCT installation.
set(OCCT_INCLUDE_DIR "${CMAKE_BINARY_DIR}/include/opencascade")
set(OCC_VERSION_MAJOR 7)
set(OCC_VERSION_MINOR 9)
set(OCC_VERSION_MAINTENANCE 3)
set(SET_OCC_VERSION_DEVELOPMENT "")
string(TIMESTAMP OCCT_VERSION_DATE "%Y-%m-%d")
configure_file("${OCCT_SOURCE_DIR}/adm/templates/Standard_Version.hxx.in" "${OCCT_INCLUDE_DIR}/Standard_Version.hxx" @ONLY)

set(OCCT_ALL_SOURCES "")
foreach(tk IN LISTS OCCT_TOOLKITS)
  file(STRINGS "${OCCT_SRC}/${tk}/PACKAGES" packages)
  set(sources "")
  foreach(pkg IN LISTS packages)
    string(STRIP "${pkg}" pkg)
    if(pkg STREQUAL "" OR pkg IN_LIST OCCT_EXCLUDED_PACKAGES)
      continue()
    endif()
    file(STRINGS "${OCCT_SRC}/${pkg}/FILES" files)
    foreach(f IN LISTS files)
      string(STRIP "${f}" f)
      if(f MATCHES "\\.(cxx|cpp|c)$")
        if(DEFINED OCCT_PARTIAL_${pkg} AND NOT f IN_LIST OCCT_PARTIAL_${pkg})
          continue()
        endif()
        list(APPEND sources "${OCCT_SRC}/${pkg}/${f}")
      endif()
    endforeach()
  endforeach()
  add_library(${tk} STATIC ${sources})
  target_include_directories(${tk} PUBLIC "$<BUILD_INTERFACE:${OCCT_INCLUDE_DIR}>" "$<INSTALL_INTERFACE:include/opencascade>")
  list(APPEND OCCT_ALL_SOURCES ${sources})
  install(TARGETS ${tk} EXPORT OCCTCad ARCHIVE DESTINATION lib)
endforeach()

# Some headers of uncompiled packages remain included (for example Handle(TDocStd_Document) in
# the signatures of DE_Provider, never called here): all headers are copied, only the sources are pruned.
if(NOT EXISTS "${OCCT_INCLUDE_DIR}/Standard.hxx")
  file(GLOB headers "${OCCT_SRC}/*/*.hxx" "${OCCT_SRC}/*/*.lxx" "${OCCT_SRC}/*/*.gxx" "${OCCT_SRC}/*/*.pxx" "${OCCT_SRC}/*/*.h")
  file(COPY ${headers} DESTINATION "${OCCT_INCLUDE_DIR}")
endif()

list(LENGTH OCCT_ALL_SOURCES n)
message(STATUS "Pruned OCCT: ${n} source files, toolkits: ${OCCT_TOOLKITS}")

install(DIRECTORY "${OCCT_INCLUDE_DIR}/" DESTINATION include/opencascade)
install(EXPORT OCCTCad NAMESPACE OCCT:: DESTINATION lib/cmake/occt-cad FILE occt-cad-targets.cmake)
file(WRITE "${CMAKE_BINARY_DIR}/occt-cad-config.cmake"
  "include(\"\${CMAKE_CURRENT_LIST_DIR}/occt-cad-targets.cmake\")\nset(OCCT_CAD_TOOLKITS ${OCCT_TOOLKITS})\n")
install(FILES "${CMAKE_BINARY_DIR}/occt-cad-config.cmake" DESTINATION lib/cmake/occt-cad)
