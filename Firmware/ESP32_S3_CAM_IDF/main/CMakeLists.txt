idf_component_register(
    SRCS "main.c" "cpu_trace.c"
    INCLUDE_DIRS "."
    EMBED_TXTFILES "index.html" "settings.html" "diag.html"
)

# cpu_trace.c logs every context switch: the scheduler (tasks.c) must see
# its traceTASK_SWITCHED_IN.
idf_component_get_property(freertos_lib freertos COMPONENT_LIB)
target_compile_options(${freertos_lib} PRIVATE "SHELL:-include ${CMAKE_CURRENT_LIST_DIR}/cpu_trace_hook.h")
