# cad-kernel: native cad-core in a separate process, driven by stdin / stdout (sidecar of the desktop application).
add_executable(cad-kernel kernel_main.cpp)
target_link_libraries(cad-kernel PRIVATE cadcore)
if(MSVC)
  # OCCT is very recursive (booleans, fillets): 16 MB stack (1 MB by default on Windows).
  target_link_options(cad-kernel PRIVATE /STACK:16777216)
elseif(MINGW)
  # Same 16 MB stack for the MinGW-w64 cross build (tools/build-kernel.sh win64), symbols stripped.
  target_link_options(cad-kernel PRIVATE -Wl,--stack,16777216 $<$<CONFIG:Release>:-s>)
elseif(NOT APPLE)
  # -s: symbols stripped in Release (the binary goes from 42 to 34 MB on Linux).
  target_link_options(cad-kernel PRIVATE -Wl,-z,stacksize=16777216 $<$<CONFIG:Release>:-s>)
endif()
