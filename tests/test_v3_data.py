# V3 — dados que o painel desenha: índices de array, ponteiros nulo/inválido, contêiner vazio.

from pathlib import Path

from engine.parser import subscript_indices
from engine.tracer import run_trace


def _trace(name: str):
    return run_trace(Path(f"samples/{name}").read_text(encoding="utf-8"), cap=300, step_into=True)


def test_parser_collects_variable_index_expressions():
    source = "void f(int* a, int n) { a[0] = a[n - 1]; a[n - 1] = a[0]; }"
    assert subscript_indices(source) == {"f": {"a": ["n - 1"]}}


def test_bubble_sort_array_carries_index_values_and_type():
    steps = [s for s in _trace("bubble_sort.cpp").steps if s.func == "bubbleSort"]
    marked = [s for s in steps if s.structures["arr"].indices]
    assert marked
    for s in marked:
        ix = {i["expr"]: i["value"] for i in s.structures["arr"].indices}
        assert ix["j"] == s.scalars["j"] and ix["j + 1"] == s.scalars["j"] + 1
    assert steps[0].structures["arr"].type == "int *"


def test_null_and_invalid_pointers_are_structures():
    steps = [s for s in _trace("invalid_pointer.cpp").steps if s.func == "wild"]
    pointed = next(s for s in steps if s.structures["p"].nodes)
    assert pointed.structures["p"].nodes[0].fields["value"] in {1, 2}
    last = steps[-1].structures
    assert last["p"].root is None and not last["p"].nodes
    assert last["q"].root == "invalid" and last["q"].note == "0x10"


def test_empty_std_container_has_no_values():
    # Antes da linha 4 (std::stack<int> st;) a memória ainda não foi construída: é lixo.
    steps = [s for s in _trace("stack_demo.cpp").steps if "st" in s.structures and s.line > 4]
    seen = [(s.i, s.line, s.structures["st"].values) for s in steps]
    assert all(isinstance(v, int) for _, _, values in seen for v in values), seen
    assert [s.structures["st"].values for s in steps][:2] == [[], [1]]
