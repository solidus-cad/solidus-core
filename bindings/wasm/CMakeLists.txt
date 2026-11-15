# kernel.js + kernel.wasm: ES6 module (browser, Worker and Node), loaded by packages/kernel-wasm.
add_executable(kernel kernel_bindings.cpp)
target_link_libraries(kernel PRIVATE cadcore)
set_target_properties(kernel PROPERTIES SUFFIX ".js")
target_link_options(kernel PRIVATE
  -lembind
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createKernel
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=32MB
  -sMAXIMUM_MEMORY=4GB
  # OCCT is very recursive (booleans, fillets): the default Emscripten stack (64 KB) is not enough.
  -sSTACK_SIZE=4MB
  -sFILESYSTEM=1
  --emit-tsd "$<TARGET_FILE_DIR:kernel>/kernel.d.ts")
if(CAD_PTHREADS)
  target_link_options(kernel PRIVATE -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency)
endif()
