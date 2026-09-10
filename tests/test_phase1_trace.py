import json
from pathlib import Path

from engine.trace import Trace, TraceStep, Structure, trace_from_dict


def test_trace_roundtrip_keeps_general_structures_field():
    step = TraceStep(
        i=0,
        line=7,
        func="bubbleSort",
        stack_depth=1,
        scalars={"i": 0, "j": 0, "n": 5},
        structures={
            "arr": Structure(kind="array", values=[3, 1, 2, 5, 4]),
            "root": Structure(
                kind="tree",
                nodes=[],
                edges=[],
            ),
        },
    )
    trace = Trace(function="bubbleSort", cap=100000, hit_cap=False, steps=[step])
    data = trace.to_dict()
    json.dumps(data)
    assert data["steps"][0]["structures"]["arr"]["kind"] == "array"
    assert data["steps"][0]["structures"]["root"]["kind"] == "tree"
    restored = trace_from_dict(data)
    assert restored.steps[0].structures["arr"].values == [3, 1, 2, 5, 4]


def test_sum_loop_trace_matches_hand_execution():
    source = Path("samples/sum_loop.cpp").read_text(encoding="utf-8")
    from engine.tracer import run_trace

    trace = run_trace(source, cap=200, step_into=True)
    assert trace.steps, "trace should not be empty"
    assert trace.hit_cap is False
    body_lines = [s.line for s in trace.steps if s.func == "sum_to"]
    assert body_lines, f"expected steps inside sum_to, got {[s.func for s in trace.steps[:8]]}"
    # s += i lives on line 4 of the sample
    assert body_lines.count(4) == 5
    last_sum = [s for s in trace.steps if s.func == "sum_to" and "s" in s.scalars]
    assert last_sum
    assert last_sum[-1].scalars["s"] in {15, "15", 15.0}


def test_step_cap_is_respected():
    source = Path("samples/infinite_loop.cpp").read_text(encoding="utf-8")
    from engine.tracer import run_trace

    trace = run_trace(source, cap=40, step_into=True)
    assert trace.hit_cap is True
    assert len(trace.steps) == 40
