# Cross-compilation of the native kernel (cad-kernel.exe) for Windows x64 from Linux, with MinGW-w64 (posix threads).
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc-posix)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++-posix)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)
set(CMAKE_FIND_ROOT_PATH /usr/x86_64-w64-mingw32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
# OCCT and cad-core exceed the default COFF section limit (MSVC /bigobj equivalent).
set(CMAKE_C_FLAGS_INIT "-Wa,-mbig-obj")
set(CMAKE_CXX_FLAGS_INIT "-Wa,-mbig-obj")
# Self-contained executable: no libstdc++, libgcc or winpthread DLL to ship.
set(CMAKE_EXE_LINKER_FLAGS_INIT "-static -static-libgcc -static-libstdc++")
