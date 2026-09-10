from pathlib import Path

import pytest

from engine.parser import list_functions, parse_cpp
from engine.tracer import discover_toolchain


ROOT = Path(__file__).resolve().parent.parent


def test_discover_toolchain_finds_gxx_and_gdb():
    tc = discover_toolchain()
    assert tc.gxx.exists()
    assert tc.gdb.exists()
    assert "g++" in tc.gxx.name or tc.gxx.suffix == ".exe"
    assert "gdb" in tc.gdb.name


def test_tree_sitter_parses_bubble_sort():
    source = (ROOT / "samples" / "bubble_sort.cpp").read_text(encoding="utf-8")
    tree = parse_cpp(source)
    names = [f.name for f in list_functions(tree, source)]
    assert "bubbleSort" in names
    assert "main" in names


def test_compile_and_gdb_launch_sum_loop(tmp_path):
    from engine.tracer import compile_source
    from pygdbmi.gdbcontroller import GdbController

    source = (ROOT / "samples" / "sum_loop.cpp").read_text(encoding="utf-8")
    tc = discover_toolchain()
    binary = compile_source(source, tmp_path / "sum", tc)
    assert binary.exists()
    gdb = GdbController(
        command=[str(tc.gdb), "--nx", "--quiet", "--interpreter=mi3"],
        time_to_check_for_additional_output_sec=0.05,
    )
    try:
        gdb.write("-gdb-set pagination off")
        gdb.write("-gdb-set debuginfod enabled off")
        gdb.write(f"-file-exec-and-symbols {binary}")
        gdb.write("-break-insert main")
        responses = gdb.write("-exec-run")
        extra = gdb.get_gdb_response(timeout_sec=2.0, raise_error_on_timeout=False)
        responses = list(responses) + list(extra or [])
        stopped = any(
            (r.get("type") == "notify" and r.get("message") == "stopped")
            or (isinstance(r.get("payload"), dict) and str((r.get("payload") or {}).get("reason", "")).startswith("exited"))
            for r in responses
            if isinstance(r, dict)
        )
        assert stopped
    finally:
        gdb.exit()
