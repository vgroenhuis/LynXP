// Force-included into the freertos component (see main/CMakeLists.txt) so
// that tasks.c calls cpu_trace.c at every context switch. Identical copy in
// both firmwares. Only expands inside tasks.c, where pxCurrentTCBs exists.
#pragma once

#ifndef __ASSEMBLER__
void cpu_trace_switched_in(void *tcb);
#define traceTASK_SWITCHED_IN() cpu_trace_switched_in((void *) pxCurrentTCBs[portGET_CORE_ID()])
#endif
