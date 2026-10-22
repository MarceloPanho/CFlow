# V1 — dados corretos do motor: chamadas irmãs, ids de frame, retorno e struct por valor.

from pathlib import Path

from engine.tracer import run_trace


def _trace(name: str):
    return run_trace(Path(f"samples/{name}").read_text(encoding="utf-8"), cap=300, step_into=True)


def test_fib5_call_tree_has_15_calls_with_right_parents_and_returns():
    steps = _trace("fibonacci.cpp").steps
    calls = [s for s in steps if s.event == "call" and s.func == "fib"]
    assert len(calls) == 15
    n_of = {s.frame_id: s.args["n"] for s in calls}
    for s in calls:
        parent = s.call_stack[-2]
        assert s.call_stack[-1].frame_id == s.frame_id
        if parent.func == "main":
            assert s.args["n"] == 5
        else:
            assert n_of[parent.frame_id] - s.args["n"] in {1, 2}
    # O retorno chega no passo seguinte, no quadro de quem chamou.
    returned = {
        prev.frame_id: cur.return_value
        for prev, cur in zip(steps, steps[1:])
        if cur.event == "return" and cur.return_value is not None
    }
    fib = lambda n: n if n <= 1 else fib(n - 1) + fib(n - 2)  # noqa: E731
    assert {fid: returned.get(fid) for fid in n_of} == {fid: fib(n) for fid, n in n_of.items()}


def test_graph_cycle_struct_values_share_nodes_and_form_a_cycle():
    steps = _trace("graph_cycle.cpp").steps
    loop = [s for s in steps if s.func == "cycle_sum" and "i" in s.scalars]
    assert loop
    st = loop[-1].structures
    assert {"a", "b", "c", "p"} <= set(st)
    p = st["p"]
    assert p.kind == "graph"
    addrs = {n.addr for n in p.nodes}
    assert len(addrs) == 3
    nxt = {e.frm: e.to for e in p.edges if e.field == "next"}
    assert len(nxt) == 3 and set(nxt.values()) == addrs
    for name in "abc":
        assert st[name].by_value and st[name].root in addrs
    assert p.root in addrs and not p.by_value


def test_call_stack_carries_args_of_every_frame():
    steps = _trace("fibonacci.cpp").steps
    deepest = max(steps, key=lambda s: len(s.call_stack))
    assert [f.func for f in deepest.call_stack] == ["main"] + ["fib"] * 5
    assert [f.args.get("n") for f in deepest.call_stack[1:]] == [5, 4, 3, 2, 1]
