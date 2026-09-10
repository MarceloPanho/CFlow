"""CFlow engine: parse C++, build a CFG, and capture an execution trace via GDB."""

from engine.trace import Trace, TraceStep, structure_from_dict, trace_from_dict
from engine.parser import parse_cpp, list_functions
from engine.cfg import build_cfg, build_all_cfgs
from engine.tracer import discover_toolchain, run_trace, ToolchainError

__all__ = [
    "Trace",
    "TraceStep",
    "structure_from_dict",
    "trace_from_dict",
    "parse_cpp",
    "list_functions",
    "build_cfg",
    "build_all_cfgs",
    "discover_toolchain",
    "run_trace",
    "ToolchainError",
]
