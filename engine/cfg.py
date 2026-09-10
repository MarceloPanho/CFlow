"""Control-flow graph of basic blocks from a tree-sitter C++ function.

The CFG *is* the flowchart. Each node carries the source lines that map
a GDB step onto the box that should light up.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from tree_sitter import Node, Tree

from engine.parser import list_functions, node_lines, node_text, parse_cpp


Exit = tuple[str, str | None]  # (from_id, edge_label)


@dataclass
class Cfg:
    function: str
    nodes: list[dict[str, Any]] = field(default_factory=list)
    edges: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"function": self.function, "nodes": self.nodes, "edges": self.edges}


class _Loop:
    def __init__(self, header: str):
        self.header = header
        self.breaks: list[str] = []


class _Switch:
    def __init__(self):
        self.breaks: list[str] = []


class CfgBuilder:
    def __init__(self, source: str):
        self.source = source
        self.raw = source.encode("utf-8")
        self.nodes: list[dict[str, Any]] = []
        self.edges: list[dict[str, Any]] = []
        self._n = 0
        self._loops: list[_Loop] = []
        self._switches: list[_Switch] = []

    def _id(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}{self._n}"

    def _text(self, node: Node) -> str:
        return node_text(self.raw, node)

    def _label(self, text: str, limit: int = 42) -> str:
        compact = " ".join(text.split())
        compact = compact.strip().rstrip(";")
        if len(compact) > limit:
            return compact[: limit - 1] + "…"
        return compact

    def add(self, kind: str, node: Node | list[Node], label: str, prefix: str) -> str:
        if isinstance(node, list):
            lines: list[int] = []
            for item in node:
                lines.extend(node_lines(item))
            lines = sorted(set(lines))
        else:
            lines = node_lines(node)
        nid = self._id(prefix)
        self.nodes.append({"id": nid, "kind": kind, "lines": lines, "label": self._label(label)})
        return nid

    def edge(self, frm: str, to: str, label: str | None = None) -> None:
        payload: dict[str, Any] = {"from": frm, "to": to}
        if label:
            payload["label"] = label
        self.edges.append(payload)

    def wire(self, incoming: list[Exit], target: str) -> None:
        for frm, label in incoming:
            self.edge(frm, target, label)

    def _stmt_list(self, node: Node | None) -> list[Node]:
        if node is None:
            return []
        if node.type == "compound_statement":
            return [c for c in node.children if c.type not in ("{", "}")]
        if node.type == "else_clause":
            body = None
            for child in node.children:
                if child.type != "else":
                    body = child
                    break
            return self._stmt_list(body)
        return [node]

    def _contains_type(self, node: Node, t: str) -> Node | None:
        if node.type == t:
            return node
        for child in node.children:
            found = self._contains_type(child, t)
            if found is not None:
                return found
        return None

    def _is_call_stmt(self, node: Node) -> bool:
        if node.type != "expression_statement" or not node.children:
            return False
        expr = node.children[0]
        if expr.type == "call_expression":
            return True
        if expr.type == "assignment_expression":
            rhs = expr.child_by_field_name("right")
            return rhs is not None and rhs.type == "call_expression"
        return False

    def _top_ternary(self, node: Node) -> Node | None:
        if node.type == "return_statement":
            for child in node.children:
                if child.type == "conditional_expression":
                    return child
        if node.type == "expression_statement" and node.children:
            expr = node.children[0]
            if expr.type == "conditional_expression":
                return expr
            if expr.type == "assignment_expression":
                rhs = expr.child_by_field_name("right")
                if rhs is not None and rhs.type == "conditional_expression":
                    return rhs
        return None

    def seq(self, stmts: list[Node], incoming: list[Exit]) -> list[Exit]:
        pending: list[Node] = []
        exits = incoming

        def flush() -> None:
            nonlocal pending, exits
            if not pending:
                return
            groups: list[tuple[str, list[Node]]] = []
            buf: list[Node] = []
            for item in pending:
                if self._is_call_stmt(item):
                    if buf:
                        groups.append(("block", buf))
                        buf = []
                    groups.append(("call", [item]))
                else:
                    buf.append(item)
            if buf:
                groups.append(("block", buf))
            for kind, group in groups:
                label = "; ".join(self._text(x).strip().rstrip(";") for x in group)
                nid = self.add(kind, group, label, "c" if kind == "call" else "b")
                self.wire(exits, nid)
                exits = [(nid, None)]
            pending = []

        control = {
            "if_statement",
            "while_statement",
            "for_statement",
            "switch_statement",
            "return_statement",
            "break_statement",
            "continue_statement",
            "do_statement",
        }
        for stmt in stmts:
            if stmt.type in ("comment", "preproc_directive", "preproc_include", ";", "{" ,"}"):
                continue
            if stmt.type == "compound_statement":
                flush()
                exits = self.seq(self._stmt_list(stmt), exits)
                continue
            if stmt.type in control:
                flush()
                exits = self.control(stmt, exits)
                continue
            ternary = self._top_ternary(stmt)
            if ternary is not None and stmt.type != "return_statement":
                flush()
                exits = self._ternary(stmt, ternary, exits)
                continue
            if stmt.type == "return_statement" and self._top_ternary(stmt) is not None:
                flush()
                exits = self.control(stmt, exits)
                continue
            pending.append(stmt)
        flush()
        return exits

    def control(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        t = stmt.type
        if t == "if_statement":
            return self._if(stmt, incoming)
        if t == "while_statement":
            return self._while(stmt, incoming)
        if t == "for_statement":
            return self._for(stmt, incoming)
        if t == "do_statement":
            return self._do(stmt, incoming)
        if t == "switch_statement":
            return self._switch(stmt, incoming)
        if t == "return_statement":
            return self._return(stmt, incoming)
        if t == "break_statement":
            return self._break(stmt, incoming)
        if t == "continue_statement":
            return self._continue(stmt, incoming)
        nid = self.add("block", stmt, self._text(stmt), "b")
        self.wire(incoming, nid)
        return [(nid, None)]

    def _if(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        cond = stmt.child_by_field_name("condition") or stmt
        then = stmt.child_by_field_name("consequence")
        alt = stmt.child_by_field_name("alternative")
        d = self.add("decision", cond, self._text(cond).strip("()"), "d")
        self.wire(incoming, d)
        then_exits = self.seq(self._stmt_list(then), [(d, "true")])
        if alt is not None:
            else_exits = self.seq(self._stmt_list(alt), [(d, "false")])
            return then_exits + else_exits
        return then_exits + [(d, "false")]

    def _while(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        cond = stmt.child_by_field_name("condition") or stmt
        body = stmt.child_by_field_name("body")
        d = self.add("decision", cond, self._text(cond).strip("()"), "d")
        self.wire(incoming, d)
        loop = _Loop(d)
        self._loops.append(loop)
        body_exits = self.seq(self._stmt_list(body), [(d, "true")])
        self._loops.pop()
        for frm, label in body_exits:
            self.edge(frm, d, label)
        exits: list[Exit] = [(d, "false")]
        for brk in loop.breaks:
            exits.append((brk, None))
        return exits

    def _for(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        init = stmt.child_by_field_name("initializer")
        cond = stmt.child_by_field_name("condition")
        update = stmt.child_by_field_name("update")
        body = stmt.child_by_field_name("body")
        after_init = incoming
        if init is not None:
            nid = self.add("block", init, self._text(init), "b")
            self.wire(incoming, nid)
            after_init = [(nid, None)]
        cond_node = cond if cond is not None else stmt
        cond_label = self._text(cond).strip("()") if cond is not None else "true"
        d = self.add("decision", cond_node, cond_label, "d")
        self.wire(after_init, d)
        loop = _Loop(d)
        self._loops.append(loop)
        body_exits = self.seq(self._stmt_list(body), [(d, "true")])
        self._loops.pop()
        if update is not None:
            u = self.add("block", update, self._text(update), "b")
            self.wire(body_exits, u)
            self.edge(u, d)
            loop.header = d
        else:
            for frm, label in body_exits:
                self.edge(frm, d, label)
        exits: list[Exit] = [(d, "false")]
        for brk in loop.breaks:
            exits.append((brk, None))
        return exits

    def _do(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        body = stmt.child_by_field_name("body")
        cond = stmt.child_by_field_name("condition") or stmt
        d = self.add("decision", cond, self._text(cond).strip("()"), "d")
        loop = _Loop(d)
        self._loops.append(loop)
        body_exits = self.seq(self._stmt_list(body), incoming)
        self._loops.pop()
        self.wire(body_exits, d)
        self.edge(d, body_exits[0][0] if body_exits else d, "true")
        # true should go back to body start — we need the first body node.
        # The edge above is a fallback; find nodes created in body via first incoming wire.
        # Simpler: create a dummy entry for body by processing with a synthetic start.
        exits: list[Exit] = [(d, "false")]
        for brk in loop.breaks:
            exits.append((brk, None))
        return exits

    def _switch(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        cond = stmt.child_by_field_name("condition") or stmt
        body = stmt.child_by_field_name("body")
        d = self.add("decision", cond, self._text(cond).strip("()"), "d")
        self.wire(incoming, d)
        ctx = _Switch()
        self._switches.append(ctx)
        cases = [c for c in (body.children if body else []) if c.type == "case_statement"]
        fall: list[Exit] = []
        all_exits: list[Exit] = []
        has_default = False
        for case in cases:
            label = "default"
            value = case.child_by_field_name("value")
            if value is not None:
                label = self._text(value)
            else:
                has_default = True
            stmts = [
                c
                for c in case.children
                if c.type not in ("case", "default", ":", "comment") and c != value
            ]
            incoming_case: list[Exit] = [(d, label)] + fall
            case_exits = self.seq(stmts, incoming_case)
            # Fallthrough if this case still has exits (no break/return consumed them).
            fall = case_exits
        self._switches.pop()
        all_exits.extend(fall)
        for brk in ctx.breaks:
            all_exits.append((brk, None))
        if not has_default:
            all_exits.append((d, "default"))
        return all_exits

    def _return(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        ternary = self._top_ternary(stmt)
        if ternary is not None:
            return self._ternary_return(stmt, ternary, incoming)
        nid = self.add("return", stmt, self._text(stmt), "r")
        self.wire(incoming, nid)
        return []

    def _ternary_return(self, stmt: Node, ternary: Node, incoming: list[Exit]) -> list[Exit]:
        cond = ternary.child_by_field_name("condition") or ternary
        yes = ternary.child_by_field_name("consequence")
        no = ternary.child_by_field_name("alternative")
        d = self.add("decision", cond, self._text(cond), "d")
        self.wire(incoming, d)
        r_yes = self.add("return", yes or stmt, f"return {self._text(yes)}" if yes else "return", "r")
        r_no = self.add("return", no or stmt, f"return {self._text(no)}" if no else "return", "r")
        self.edge(d, r_yes, "true")
        self.edge(d, r_no, "false")
        return []

    def _ternary(self, stmt: Node, ternary: Node, incoming: list[Exit]) -> list[Exit]:
        cond = ternary.child_by_field_name("condition") or ternary
        yes = ternary.child_by_field_name("consequence")
        no = ternary.child_by_field_name("alternative")
        d = self.add("decision", cond, self._text(cond), "d")
        self.wire(incoming, d)
        y = self.add("block", yes or stmt, self._text(yes) if yes else "true", "b")
        n = self.add("block", no or stmt, self._text(no) if no else "false", "b")
        self.edge(d, y, "true")
        self.edge(d, n, "false")
        return [(y, None), (n, None)]

    def _break(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        nid = self.add("block", stmt, "break", "k")
        self.wire(incoming, nid)
        if self._switches:
            self._switches[-1].breaks.append(nid)
        elif self._loops:
            self._loops[-1].breaks.append(nid)
        return []

    def _continue(self, stmt: Node, incoming: list[Exit]) -> list[Exit]:
        nid = self.add("block", stmt, "continue", "k")
        self.wire(incoming, nid)
        if self._loops:
            self.edge(nid, self._loops[-1].header)
        return []

    def build(self, func: Node, name: str) -> Cfg:
        body = func.child_by_field_name("body")
        self.seq(self._stmt_list(body), [])
        return Cfg(function=name, nodes=self.nodes, edges=self.edges)


def build_cfg(source: str, function: str | None = None) -> Cfg:
    tree: Tree = parse_cpp(source)
    functions = list_functions(tree, source)
    if not functions:
        return Cfg(function=function or "")
    chosen = None
    if function:
        for info in functions:
            if info.name == function:
                chosen = info
                break
    if chosen is None:
        chosen = next((f for f in functions if f.name != "main"), functions[0])
    builder = CfgBuilder(source)
    return builder.build(chosen.node, chosen.name)


def build_all_cfgs(source: str) -> dict[str, Cfg]:
    tree = parse_cpp(source)
    out: dict[str, Cfg] = {}
    for info in list_functions(tree, source):
        builder = CfgBuilder(source)
        out[info.name] = builder.build(info.node, info.name)
    return out
