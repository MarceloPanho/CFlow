from pathlib import Path

from engine.cfg import build_all_cfgs, build_cfg


def _has_cycle(cfg) -> bool:
    adj: dict[str, list[str]] = {n["id"]: [] for n in cfg.nodes}
    for edge in cfg.edges:
        adj.setdefault(edge["from"], []).append(edge["to"])
    visiting: set[str] = set()
    seen: set[str] = set()

    def dfs(u: str) -> bool:
        if u in visiting:
            return True
        if u in seen:
            return False
        visiting.add(u)
        for v in adj.get(u, []):
            if dfs(v):
                return True
        visiting.remove(u)
        seen.add(u)
        return False

    return any(dfs(n["id"]) for n in cfg.nodes)


def test_bubble_sort_cfg_has_decisions_and_back_edge():
    source = Path("samples/bubble_sort.cpp").read_text(encoding="utf-8")
    cfg = build_cfg(source, "bubbleSort")
    kinds = {n["kind"] for n in cfg.nodes}
    assert "decision" in kinds
    assert any(n["kind"] == "block" for n in cfg.nodes)
    assert _has_cycle(cfg)
    # inner swap lives on lines 5-7
    swap_nodes = [n for n in cfg.nodes if 5 in n["lines"] or 6 in n["lines"]]
    assert swap_nodes
    decision_lines = [n for n in cfg.nodes if n["kind"] == "decision"]
    assert any(2 in n["lines"] or 3 in n["lines"] or 4 in n["lines"] for n in decision_lines)


def test_factorial_cfg_has_if_and_return():
    source = Path("samples/factorial.cpp").read_text(encoding="utf-8")
    cfg = build_cfg(source, "factorial")
    kinds = {n["kind"] for n in cfg.nodes}
    assert "decision" in kinds
    assert "return" in kinds
    assert any(e.get("label") == "true" for e in cfg.edges)
    assert any(e.get("label") == "false" for e in cfg.edges)


def test_switch_and_ternary_constructs():
    source = """
int classify(int n) {
    int k = 0;
    switch (n) {
        case 1: k = 1; break;
        case 2: k = 2;
        default: k = 3;
    }
    return n > 0 ? k : -k;
}
int main() { return classify(2); }
"""
    cfg = build_cfg(source, "classify")
    labels = {e.get("label") for e in cfg.edges}
    assert "1" in labels or "2" in labels
    assert any(n["kind"] == "decision" for n in cfg.nodes)
    assert any(n["kind"] == "return" for n in cfg.nodes)


def test_build_all_cfgs_includes_main():
    source = Path("samples/sum_loop.cpp").read_text(encoding="utf-8")
    all_cfgs = build_all_cfgs(source)
    assert set(all_cfgs) >= {"sum_to", "main"}


def test_cfg_start_implicit_return_and_back_edges():
    source = Path("samples/bubble_sort.cpp").read_text(encoding="utf-8")
    cfg = build_cfg(source, "bubbleSort")
    label = {n["id"]: n["label"] for n in cfg.nodes}
    start = cfg.nodes[0]
    assert start["kind"] == "start" and start["label"] == "bubbleSort(arr, n)"
    assert sum(e["from"] == start["id"] for e in cfg.edges) == 1
    # void: cair do fim leva ao return implícito na linha da chave de fechamento
    end = next(n for n in cfg.nodes if n["kind"] == "return")
    assert end["label"] == "return" and end["lines"] == [11]
    back = {(label[e["from"]], label[e["to"]]) for e in cfg.edges if e.get("back")}
    assert back == {("j++", "j < n - i - 1"), ("i++", "i < n - 1")}
    swap = next(n for n in cfg.nodes if 5 in n["lines"])
    assert swap["label"].split("\n") == ["int tmp = arr[j]", "arr[j] = arr[j + 1]", "arr[j + 1] = tmp"]


def test_do_while_true_edge_returns_to_body_start():
    source = """
int f(int n) {
    int s = 0;
    do {
        s += n;
        n--;
    } while (n > 0);
    return s;
}
"""
    cfg = build_cfg(source, "f")
    label = {n["id"]: n["label"] for n in cfg.nodes}
    loop = [(label[e["from"]], label[e["to"]]) for e in cfg.edges if e.get("back")]
    assert loop == [("n > 0", "s += n\nn--")]
