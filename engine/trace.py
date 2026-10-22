"""Trace schema — the contract between the engine and the frontend.

The engine never draws; the frontend never talks to GDB. Everything that
animates on screen is derived from a serializable Trace.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


LINEAR_KINDS = ("array", "stack", "queue")
GRAPH_KINDS = ("graph", "tree")


def _clean(value: Any) -> Any:
    """Make a GDB value JSON-serializable."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    return str(value)


@dataclass
class GraphNode:
    addr: str
    fields: dict[str, Any] = field(default_factory=dict)
    note: str | None = None
    type: str | None = None  # struct/pointee type name, e.g. "Node"

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"addr": self.addr, "fields": _clean(self.fields)}
        if self.note:
            out["note"] = self.note
        if self.type:
            out["type"] = self.type
        return out


@dataclass
class GraphEdge:
    frm: str
    field: str
    to: str | None  # addr | None (null pointer) | "invalid"
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"from": self.frm, "field": self.field, "to": self.to}
        if self.note:
            out["note"] = self.note
        return out


@dataclass
class Structure:
    kind: str  # array | stack | queue | graph | tree
    values: list[Any] | None = None
    layout_hint: str | None = None
    nodes: list[GraphNode] | None = None
    edges: list[GraphEdge] | None = None
    watch_as: str | None = None
    root: str | None = None  # addr the variable reaches: its own (by_value) or the pointee
    by_value: bool = False  # struct living in the variable itself, not behind a pointer
    type: str | None = None  # declared C++ type of the variable
    indices: list[dict[str, Any]] | None = None  # [{"expr": "j + 1", "value": 4}] from arr[...] in the source
    note: str | None = None  # e.g. the raw address when root is "invalid"

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind, "layout_hint": self.layout_hint}
        if self.watch_as:
            out["watch_as"] = self.watch_as
        if self.type:
            out["type"] = self.type
        if self.note:
            out["note"] = self.note
        if self.indices:
            out["indices"] = _clean(self.indices)
        if self.kind in LINEAR_KINDS:
            out["values"] = _clean(self.values or [])
        if self.kind in GRAPH_KINDS:
            out["nodes"] = [n.to_dict() for n in (self.nodes or [])]
            out["edges"] = [e.to_dict() for e in (self.edges or [])]
            out["root"] = self.root
            if self.by_value:
                out["by_value"] = True
        return out


@dataclass
class FrameInfo:
    func: str
    line: int
    args: dict[str, Any] = field(default_factory=dict)
    frame_id: int = 0
    level: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "func": self.func,
            "line": self.line,
            "args": _clean(self.args),
            "frame_id": self.frame_id,
            "level": self.level,
        }


@dataclass
class TraceStep:
    i: int
    line: int
    func: str
    stack_depth: int
    scalars: dict[str, Any] = field(default_factory=dict)
    structures: dict[str, Structure] = field(default_factory=dict)
    args: dict[str, Any] = field(default_factory=dict)
    call_stack: list[FrameInfo] = field(default_factory=list)
    event: str = "line"  # line | call | return
    return_value: Any | None = None
    frame_id: int = 0

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "i": self.i,
            "line": self.line,
            "func": self.func,
            "stack_depth": self.stack_depth,
            "scalars": _clean(self.scalars),
            "structures": {k: v.to_dict() for k, v in self.structures.items()},
            "args": _clean(self.args),
            "call_stack": [f.to_dict() for f in self.call_stack],
            "event": self.event,
            "frame_id": self.frame_id,
        }
        if self.return_value is not None:
            out["return_value"] = _clean(self.return_value)
        return out


@dataclass
class Trace:
    function: str
    cap: int
    hit_cap: bool
    steps: list[TraceStep] = field(default_factory=list)
    source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "function": self.function,
            "cap": self.cap,
            "hit_cap": self.hit_cap,
            "steps": [s.to_dict() for s in self.steps],
            "source": self.source,
        }


def structure_from_dict(data: dict[str, Any]) -> Structure:
    nodes = None
    edges = None
    if data.get("nodes") is not None:
        nodes = [
            GraphNode(addr=n["addr"], fields=n.get("fields") or {}, note=n.get("note"), type=n.get("type"))
            for n in data["nodes"]
        ]
    if data.get("edges") is not None:
        edges = [
            GraphEdge(
                frm=e["from"],
                field=e.get("field", ""),
                to=e.get("to"),
                note=e.get("note"),
            )
            for e in data["edges"]
        ]
    return Structure(
        kind=data["kind"],
        values=data.get("values"),
        layout_hint=data.get("layout_hint"),
        nodes=nodes,
        edges=edges,
        watch_as=data.get("watch_as"),
        root=data.get("root"),
        by_value=bool(data.get("by_value")),
        type=data.get("type"),
        indices=data.get("indices"),
        note=data.get("note"),
    )


def trace_from_dict(data: dict[str, Any]) -> Trace:
    steps: list[TraceStep] = []
    for raw in data.get("steps") or []:
        structures = {
            k: structure_from_dict(v) for k, v in (raw.get("structures") or {}).items()
        }
        call_stack = [
            FrameInfo(
                func=f["func"],
                line=int(f.get("line") or 0),
                args=f.get("args") or {},
                frame_id=int(f.get("frame_id") or 0),
                level=int(f.get("level") or 0),
            )
            for f in (raw.get("call_stack") or [])
        ]
        steps.append(
            TraceStep(
                i=int(raw["i"]),
                line=int(raw["line"]),
                func=str(raw["func"]),
                stack_depth=int(raw["stack_depth"]),
                scalars=raw.get("scalars") or {},
                structures=structures,
                args=raw.get("args") or {},
                call_stack=call_stack,
                event=raw.get("event") or "line",
                return_value=raw.get("return_value"),
                frame_id=int(raw.get("frame_id") or 0),
            )
        )
    return Trace(
        function=data.get("function") or "",
        cap=int(data.get("cap") or 0),
        hit_cap=bool(data.get("hit_cap")),
        steps=steps,
        source=data.get("source"),
    )
