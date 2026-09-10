"""Compile with -O0 -g and capture an eager execution trace via GDB/MI."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pygdbmi.gdbcontroller import GdbController

from engine.trace import (
    FrameInfo,
    GraphEdge,
    GraphNode,
    Structure,
    Trace,
    TraceStep,
    _clean,
)


DEFAULT_CAP = 100_000
COMPILE_FLAGS = ["-O0", "-g", "-std=c++17", "-fno-omit-frame-pointer"]


class ToolchainError(RuntimeError):
    pass


class CompileError(RuntimeError):
    pass


@dataclass
class Toolchain:
    gxx: Path
    gdb: Path


def _which(name: str, extra_dirs: list[Path]) -> Path | None:
    found = shutil.which(name)
    if found:
        return Path(found)
    for directory in extra_dirs:
        candidate = directory / name
        if candidate.is_file():
            return candidate
    return None


def discover_toolchain() -> Toolchain:
    """Locate g++ and gdb. Never hardcode a single path; search PATH + MinGW."""
    extra: list[Path] = []
    if os.name == "nt":
        extra.extend(
            [
                Path(r"C:\msys64\mingw64\bin"),
                Path(r"C:\msys64\ucrt64\bin"),
                Path(r"C:\msys64\clang64\bin"),
                Path(r"C:\mingw64\bin"),
                Path(r"C:\TDM-GCC-64\bin"),
            ]
        )
        extra.extend(Path(p) for p in os.environ.get("PATH", "").split(os.pathsep) if p)

    gxx_names = ["g++.exe", "g++"] if os.name == "nt" else ["g++"]
    gdb_names = ["gdb.exe", "gdb"] if os.name == "nt" else ["gdb"]

    gxx = next((p for n in gxx_names if (p := _which(n, extra)) is not None), None)
    gdb = next((p for n in gdb_names if (p := _which(n, extra)) is not None), None)
    if gxx is None or gdb is None:
        missing = []
        if gxx is None:
            missing.append("g++")
        if gdb is None:
            missing.append("gdb")
        hint = (
            "Instale o MinGW-w64 (MSYS2) e coloque g++/gdb no PATH."
            if os.name == "nt"
            else "Instale g++ e gdb pelo gerenciador de pacotes."
        )
        raise ToolchainError(f"Toolchain ausente ({', '.join(missing)}). {hint}")
    return Toolchain(gxx=gxx, gdb=gdb)


def compile_source(source: str, output: Path, toolchain: Toolchain | None = None) -> Path:
    toolchain = toolchain or discover_toolchain()
    src = output.with_suffix(".cpp")
    src.write_text(source, encoding="utf-8")
    if os.name == "nt" and output.suffix.lower() != ".exe":
        output = output.with_suffix(".exe")
    cmd = [str(toolchain.gxx), *COMPILE_FLAGS, str(src), "-o", str(output)]
    import subprocess

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise CompileError(proc.stderr or proc.stdout or "falha ao compilar")
    return output


def _mi_results(responses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [r for r in responses if isinstance(r, dict)]


def _result(responses: list[dict[str, Any]]) -> tuple[str | None, Any]:
    for item in _mi_results(responses):
        if item.get("type") == "result":
            return item.get("message"), item.get("payload")
    return None, None


def _stopped(responses: list[dict[str, Any]]) -> dict[str, Any] | None:
    for item in _mi_results(responses):
        msg = item.get("message")
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        if item.get("type") == "notify" and msg == "stopped":
            return payload
        if msg in {"exited", "exited-normally", "exited-signalled"}:
            return {"reason": msg, **(payload or {})}
        if isinstance(payload, dict) and payload.get("reason") in {
            "exited",
            "exited-normally",
            "exited-signalled",
        }:
            return payload
    return None


def _exited(stop: dict[str, Any] | None) -> bool:
    if not stop:
        return False
    reason = str(stop.get("reason") or "")
    return reason.startswith("exited") or reason in {"exited-normally", "exited-signalled"}


def _write(gdb: GdbController, cmd: str, timeout: float = 1.5) -> list[dict[str, Any]]:
    return gdb.write(cmd, timeout_sec=timeout, raise_error_on_timeout=False)


def _wait_stop(
    gdb: GdbController,
    seed: list[dict[str, Any]] | None = None,
    timeout: float = 3.0,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    responses = list(seed or [])
    deadline = time.time() + timeout
    while True:
        stop = _stopped(responses)
        if stop is not None:
            return responses, stop
        remaining = deadline - time.time()
        if remaining <= 0:
            return responses, None
        extra = gdb.get_gdb_response(
            timeout_sec=min(0.2, remaining), raise_error_on_timeout=False
        )
        if extra:
            responses.extend(extra)


def _eval(gdb: GdbController, expr: str) -> str | None:
    quoted = expr.replace('"', '\\"')
    msg, payload = _result(_write(gdb, f'-data-evaluate-expression "{quoted}"'))
    if msg != "done" or not isinstance(payload, dict):
        return None
    return payload.get("value")


def _console(gdb: GdbController, cmd: str) -> str:
    responses = _write(gdb, f'-interpreter-exec console "{cmd.replace(chr(34), chr(92)+chr(34))}"')
    chunks: list[str] = []
    for item in _mi_results(responses):
        if item.get("type") == "console":
            payload = item.get("payload")
            if isinstance(payload, str):
                chunks.append(payload)
    return "".join(chunks)


def _as_int(raw: str | None) -> int | None:
    if raw is None:
        return None
    text = raw.strip().split(" ", 1)[0]
    try:
        return int(text, 0)
    except ValueError:
        return None


def _parse_brace_list(raw: str) -> list[Any]:
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return [raw]
    inner = raw[start + 1 : end].strip()
    if not inner:
        return []
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    in_str = False
    for ch in inner:
        if ch == '"' and (not buf or buf[-1] != "\\"):
            in_str = not in_str
        if not in_str:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            elif ch == "," and depth == 0:
                parts.append("".join(buf).strip())
                buf = []
                continue
        buf.append(ch)
    if buf:
        parts.append("".join(buf).strip())
    out: list[Any] = []
    for part in parts:
        if not part:
            continue
        if part.startswith("{"):
            out.append(_parse_brace_list(part))
            continue
        num = _as_int(part)
        out.append(num if num is not None else part.strip('"'))
    return out


def _coerce_scalar(raw: str | None) -> Any:
    if raw is None:
        return None
    text = raw.strip()
    if text in {"<optimized out>", "void"}:
        return None
    if " = " in text and text.split(" = ", 1)[0].endswith("repeating"):
        pass
    num = _as_int(text)
    if num is not None and not text.startswith('"'):
        # Avoid treating 0xaddr of pointers as the interesting value when type is pointer —
        # callers decide. For scalars this is fine.
        if not (text.startswith("0x") and len(text) > 6):
            return num
    if text.startswith("0x") and " " not in text:
        return text.split()[0]
    if "{" in text:
        parsed = _parse_brace_list(text)
        return parsed
    if text.startswith('"'):
        match = re.match(r'"(.*)"', text, re.DOTALL)
        if match:
            return match.group(1)
    # pretty-printer: std::vector of length N ... = {..}
    if "{" in text:
        return _parse_brace_list(text)
    return text


_SKIP_LOCALS = {"this", "__for_begin", "__for_end", "__begin", "__end"}


def _type_kind(type_str: str, watch_as: str | None) -> str:
    if watch_as:
        wa = watch_as.strip()
        if wa.startswith("array"):
            return "array"
        if wa in {"stack", "queue", "tree", "graph", "list"}:
            return wa if wa != "list" else "graph"
        if wa.endswith("*"):
            return "pointer"
    t = type_str or ""
    compact = t.replace(" ", "")
    if "std::stack" in t:
        return "stack"
    if "std::queue" in t:
        return "queue"
    if "std::vector" in t or "std::deque" in t or "std::array" in t:
        return "array"
    if re.search(r"\[[^\]]*\]", compact):
        return "array"
    if "std::string" in t or "basic_string" in t:
        return "scalar"
    if "*" in compact or compact.endswith("&"):
        return "pointer"
    return "scalar"


def _is_user_path(fullname: str | None, user_file: Path) -> bool:
    if not fullname:
        return False
    try:
        return Path(fullname).resolve() == user_file.resolve()
    except OSError:
        return Path(fullname).name == user_file.name


def _frame_from_payload(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and "frame" in payload:
        frame = payload["frame"]
        return frame if isinstance(frame, dict) else {}
    return payload if isinstance(payload, dict) else {}


def _list_as_dicts(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, dict)]
    return []


class _Session:
    def __init__(
        self,
        gdb: GdbController,
        source_path: Path,
        watch_as: dict[str, str],
        cap: int,
        step_into: bool,
    ):
        self.gdb = gdb
        self.source_path = source_path
        self.watch_as = watch_as
        self.cap = cap
        self.step_into = step_into
        self._type_fields: dict[str, list[tuple[str, str, bool]]] = {}
        self._frame_ids: list[int] = []
        self._next_frame_id = 0
        self._prev_depth = 0

    def stack_depth(self) -> int:
        msg, payload = _result(_write(self.gdb, "-stack-info-depth"))
        if msg == "done" and isinstance(payload, dict):
            try:
                return int(payload.get("depth") or 1)
            except (TypeError, ValueError):
                return 1
        return 1

    def current_frame(self) -> dict[str, Any]:
        msg, payload = _result(_write(self.gdb, "-stack-info-frame"))
        if msg == "done":
            return _frame_from_payload(payload)
        return {}

    def frames(self) -> list[dict[str, Any]]:
        msg, payload = _result(_write(self.gdb, "-stack-list-frames"))
        if msg == "done" and isinstance(payload, dict):
            return _list_as_dicts(payload.get("stack"))
        return []

    def in_user(self, frame: dict[str, Any] | None = None) -> bool:
        frame = frame or self.current_frame()
        fullname = frame.get("fullname") or frame.get("file")
        return _is_user_path(str(fullname) if fullname else None, self.source_path)

    def leave_foreign(self) -> bool:
        """Step/finish until we're back in user code or the process exits."""
        for _ in range(80):
            frame = self.current_frame()
            if not frame:
                return False
            if self.in_user(frame):
                return True
            _, stop = _wait_stop(self.gdb, _write(self.gdb, "-exec-finish"), timeout=2.0)
            if _exited(stop):
                return False
        return self.in_user()

    def locals_and_args(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        args: list[dict[str, Any]] = []
        msg, payload = _result(_write(self.gdb, "-stack-list-arguments --simple-values 0 0"))
        if msg == "done" and isinstance(payload, dict):
            stack = _list_as_dicts(payload.get("stack-args"))
            if stack:
                args = _list_as_dicts(stack[0].get("args"))
        msg, payload = _result(_write(self.gdb, "-stack-list-variables --simple-values"))
        variables: list[dict[str, Any]] = []
        if msg == "done" and isinstance(payload, dict):
            variables = _list_as_dicts(payload.get("variables"))
        return variables, args

    def _ptype_fields(self, type_name: str) -> list[tuple[str, str, bool]]:
        key = re.sub(r"\s+", " ", type_name).strip()
        if key in self._type_fields:
            return self._type_fields[key]
        dump = _console(self.gdb, f"ptype {key}")
        fields: list[tuple[str, str, bool]] = []
        for line in dump.splitlines():
            line = line.strip().rstrip(";")
            if not line or line.startswith("type") or line in "{}":
                continue
            # e.g. "int val" or "Node *left" or "Node* left"
            match = re.match(r"(.+?)\s+(\*?\s*)([A-Za-z_]\w*)$", line)
            if not match:
                continue
            ty, stars, name = match.group(1).strip(), match.group(2).strip(), match.group(3)
            is_ptr = "*" in stars or "*" in ty
            fields.append((name, (ty + (" *" if is_ptr and "*" not in ty else "")).strip(), is_ptr))
        self._type_fields[key] = fields
        return fields

    def _readable(self, addr: str) -> bool:
        if not addr or addr in {"0x0", "0", "nullptr", "NULL"}:
            return False
        msg, _payload = _result(_write(self.gdb, f"-data-read-memory-bytes {addr} 1"))
        return msg == "done"

    def _addr(self, expr: str) -> str | None:
        raw = _eval(self.gdb, f"(void*)({expr})")
        if raw is None:
            return None
        token = raw.strip().split()[0]
        if token in {"0x0", "0"}:
            return None
        return token

    def _walk_graph(self, root_expr: str, type_str: str, layout_hint: str | None) -> Structure:
        nodes: list[GraphNode] = []
        edges: list[GraphEdge] = []
        seen: set[str] = set()

        def pointee_type(ty: str) -> str:
            return re.sub(r"\s*\*+\s*$", "", ty).strip()

        def walk_ptr(expr: str, ty: str) -> str | None:
            addr = self._addr(expr)
            if addr is None:
                return None
            if not self._readable(addr):
                return "invalid"
            if addr in seen:
                return addr
            seen.add(addr)
            struct_ty = pointee_type(ty)
            fields_meta = self._ptype_fields(struct_ty)
            if not fields_meta:
                # opaque / primitive pointer
                val = _coerce_scalar(_eval(self.gdb, f"*({expr})"))
                nodes.append(GraphNode(addr=addr, fields={"value": val}))
                return addr
            field_vals: dict[str, Any] = {}
            deref = f"(*({expr}))"
            for fname, fty, is_ptr in fields_meta:
                access = f"({deref}).{fname}"
                if is_ptr:
                    dest = walk_ptr(access, fty)
                    edges.append(GraphEdge(frm=addr, field=fname, to=dest))
                else:
                    field_vals[fname] = _coerce_scalar(_eval(self.gdb, access))
            nodes.append(GraphNode(addr=addr, fields=field_vals))
            return addr

        kind = "tree" if (layout_hint == "tree" or "tree" in (self.watch_as.get(root_expr) or "")) else "graph"
        if layout_hint in {"tree", "graph", "list"}:
            kind = "tree" if layout_hint == "tree" else "graph"
        walk_ptr(root_expr, type_str)
        # Auto-detect tree: acyclic and ≤1 parent.
        if layout_hint is None and nodes:
            parents: dict[str, int] = {n.addr: 0 for n in nodes}
            cyclic = False
            adj: dict[str, list[str]] = {n.addr: [] for n in nodes}
            for edge in edges:
                if edge.to and edge.to not in {"invalid", None}:
                    adj.setdefault(edge.frm, []).append(str(edge.to))
                    if edge.to in parents:
                        parents[str(edge.to)] += 1
            # cycle check
            visiting: set[str] = set()
            visited: set[str] = set()

            def dfs(u: str) -> None:
                nonlocal cyclic
                if u in visiting:
                    cyclic = True
                    return
                if u in visited:
                    return
                visiting.add(u)
                for v in adj.get(u, []):
                    dfs(v)
                visiting.remove(u)
                visited.add(u)

            for n in nodes:
                dfs(n.addr)
            if not cyclic and all(p <= 1 for p in parents.values()):
                kind = "tree"
        return Structure(
            kind=kind,
            layout_hint=layout_hint,
            nodes=nodes,
            edges=edges,
            watch_as=self.watch_as.get(root_expr),
        )

    def _linear_values(self, name: str, type_str: str, kind: str) -> list[Any]:
        watch = self.watch_as.get(name, "")
        match = re.match(r"array\[(.+)\]", watch or "")
        if match:
            length_expr = match.group(1)
            length = _as_int(_eval(self.gdb, length_expr)) or _as_int(length_expr) or 0
            values = []
            for i in range(min(length, 256)):
                values.append(_coerce_scalar(_eval(self.gdb, f"{name}[{i}]")))
            return values
        raw = _eval(self.gdb, name)
        if raw is None:
            return []
        if kind in {"stack", "queue"} and "c =" in raw:
            # libstdc++ pretty printer sometimes nests the container
            inner = raw[raw.find("{") :] if "{" in raw else raw
            return _parse_brace_list(inner)
        parsed = _coerce_scalar(raw)
        if isinstance(parsed, list):
            return parsed
        # C array via indexed walk when pretty value is an address
        bound = re.search(r"\[(\d+)\]", type_str or "")
        if bound:
            n = int(bound.group(1))
            return [_coerce_scalar(_eval(self.gdb, f"{name}[{i}]")) for i in range(n)]
        return [parsed]

    def capture_vars(self) -> tuple[dict[str, Any], dict[str, Structure], dict[str, Any]]:
        variables, args = self.locals_and_args()
        scalars: dict[str, Any] = {}
        structures: dict[str, Structure] = {}
        arg_map: dict[str, Any] = {}
        known = {
            e.get("name")
            for e in (args + variables)
            if e.get("name") and e.get("name") not in _SKIP_LOCALS
        }

        def bound_for(name: str) -> str | None:
            watch = self.watch_as.get(name) or ""
            match = re.match(r"array\[(.+)\]", watch)
            if match:
                return match.group(1)
            for candidate in ("n", "size", "len", "count", "N", "length"):
                if candidate != name and candidate in known:
                    return candidate
            return None

        def consume(entry: dict[str, Any], is_arg: bool) -> None:
            name = entry.get("name")
            if not name or name in _SKIP_LOCALS or name.startswith("__"):
                return
            type_str = str(entry.get("type") or "")
            watch = self.watch_as.get(name)
            kind = _type_kind(type_str, watch)
            value = entry.get("value")
            bound = bound_for(name)
            if kind == "pointer" and bound and "char" not in type_str:
                raw = _eval(self.gdb, f"*{name}@{bound}")
                parsed = _parse_brace_list(raw) if raw and "{" in raw else None
                if parsed:
                    structures[name] = Structure(kind="array", values=parsed, watch_as=watch)
                    if is_arg:
                        arg_map[name] = parsed
                    return
            if kind in {"array", "stack", "queue"}:
                values = self._linear_values(name, type_str, kind)
                structures[name] = Structure(
                    kind=kind if kind != "array" or not (watch or "").startswith("stack") else "stack",
                    values=values,
                    watch_as=watch,
                )
                if watch in {"stack", "queue"}:
                    structures[name].kind = watch
            elif kind in {"pointer", "tree", "graph"}:
                hint = watch if watch in {"tree", "graph", "list"} else None
                if "char" in type_str and "*" in type_str:
                    scalars[name] = _coerce_scalar(value if isinstance(value, str) else _eval(self.gdb, name))
                else:
                    pointee = re.sub(r"\s*\*+\s*$", "", type_str).strip()
                    fields = self._ptype_fields(pointee) if "*" in type_str else []
                    if fields or kind in {"tree", "graph"}:
                        structures[name] = self._walk_graph(name, type_str, hint)
                    else:
                        addr = self._addr(name)
                        if addr and not self._readable(addr):
                            structures[name] = Structure(
                                kind="graph",
                                nodes=[GraphNode(addr="invalid", fields={}, note="ilegível")],
                                edges=[GraphEdge(frm="root", field=name, to="invalid")],
                            )
                        else:
                            scalars[name] = addr or _coerce_scalar(value if isinstance(value, str) else None)
            elif "*" in type_str and "char" not in type_str:
                # struct by pointer without classified kind
                structures[name] = self._walk_graph(name, type_str, None)
            else:
                coerced = _coerce_scalar(value if isinstance(value, str) else _eval(self.gdb, name))
                if isinstance(coerced, list) and len(coerced) > 1:
                    structures[name] = Structure(kind="array", values=coerced, watch_as=watch)
                else:
                    scalars[name] = coerced
            if is_arg:
                arg_map[name] = scalars.get(name)
                if name in structures and structures[name].values is not None:
                    arg_map[name] = structures[name].values

        for item in args:
            consume(item, True)
        for item in variables:
            consume(item, False)
        return scalars, structures, arg_map

    def assign_frame_id(self, depth: int) -> tuple[int, str]:
        event = "line"
        if depth > len(self._frame_ids):
            while len(self._frame_ids) < depth:
                self._next_frame_id += 1
                self._frame_ids.append(self._next_frame_id)
            event = "call" if depth > self._prev_depth else "line"
        elif depth < len(self._frame_ids):
            self._frame_ids = self._frame_ids[: max(depth, 0)]
            event = "return"
        self._prev_depth = depth
        fid = self._frame_ids[-1] if self._frame_ids else 0
        return fid, event

    def snapshot(self, index: int) -> TraceStep | None:
        frame = self.current_frame()
        if not frame or not self.in_user(frame):
            return None
        try:
            line = int(frame.get("line") or 0)
        except (TypeError, ValueError):
            line = 0
        if line <= 0:
            return None
        func = str(frame.get("func") or "?")
        depth = self.stack_depth()
        fid, event = self.assign_frame_id(depth)
        scalars, structures, args = self.capture_vars()
        call_stack: list[FrameInfo] = []
        for i, fr in enumerate(self.frames()):
            if not self.in_user(fr):
                continue
            try:
                fline = int(fr.get("line") or 0)
            except (TypeError, ValueError):
                fline = 0
            level = int(fr.get("level") or i)
            frame_id = self._frame_ids[level] if level < len(self._frame_ids) else 0
            call_stack.append(
                FrameInfo(
                    func=str(fr.get("func") or "?"),
                    line=fline,
                    frame_id=frame_id,
                    level=level,
                )
            )
        # Fill args on the current frame only (cheap).
        if call_stack:
            call_stack[0].args = args
        return TraceStep(
            i=index,
            line=line,
            func=func,
            stack_depth=depth,
            scalars=scalars,
            structures=structures,
            args=args,
            call_stack=list(reversed(call_stack)) if call_stack else [],
            event=event,
            frame_id=fid,
        )


def run_trace(
    source: str,
    *,
    cap: int = DEFAULT_CAP,
    step_into: bool = True,
    watch_as: dict[str, str] | None = None,
    function: str | None = None,
    toolchain: Toolchain | None = None,
) -> Trace:
    """Compile and eagerly step the program, returning a complete Trace."""
    toolchain = toolchain or discover_toolchain()
    watch_as = watch_as or {}
    with tempfile.TemporaryDirectory(prefix="cflow-") as tmp:
        tmp_path = Path(tmp)
        binary = tmp_path / ("prog.exe" if os.name == "nt" else "prog")
        binary = compile_source(source, binary, toolchain)
        source_path = binary.with_suffix(".cpp")
        os.environ.setdefault("DEBUGINFOD_URLS", "")
        gdb = GdbController(
            command=[str(toolchain.gdb), "--nx", "--quiet", "--interpreter=mi3"],
            time_to_check_for_additional_output_sec=0.05,
        )
        try:
            _write(gdb, "-gdb-set pagination off")
            _write(gdb, "-gdb-set confirm off")
            _write(gdb, "-gdb-set debuginfod enabled off")
            _write(gdb, "-enable-pretty-printing")
            _write(gdb, "-gdb-set print pretty on")
            _write(gdb, "-gdb-set print array on")
            _write(gdb, "-gdb-set print repeats 0")
            _write(gdb, "-gdb-set print elements 200")
            _write(gdb, f"-file-exec-and-symbols {binary}")
            _write(gdb, "-break-insert -f main")
            _, stop = _wait_stop(gdb, _write(gdb, "-exec-run"), timeout=5.0)
            if stop is None or _exited(stop):
                return Trace(function=function or "main", cap=cap, hit_cap=False, source=source, steps=[])

            session = _Session(gdb, source_path, watch_as, cap, step_into)
            session.leave_foreign()
            steps: list[TraceStep] = []
            hit_cap = False
            last_key: tuple[Any, ...] | None = None
            repeats = 0

            while len(steps) < cap:
                snap = session.snapshot(len(steps))
                if snap is not None:
                    key = (snap.line, snap.func, snap.stack_depth, tuple(sorted((k, str(v)) for k, v in snap.scalars.items())))
                    if key == last_key:
                        repeats += 1
                        if repeats > 8:
                            # identical state spinning in place — still record, but don't stall
                            pass
                    else:
                        repeats = 0
                        last_key = key
                    steps.append(snap)

                cmd = "-exec-step" if step_into else "-exec-next"
                _, stop = _wait_stop(gdb, _write(gdb, cmd, timeout=1.5), timeout=3.0)
                if stop is None:
                    _write(gdb, "-exec-interrupt")
                    _, stop = _wait_stop(gdb, timeout=2.0)
                    step_into = True
                if stop is None or _exited(stop):
                    break
                if not session.leave_foreign():
                    break
            else:
                hit_cap = True

            if steps:
                primary = function or next((s.func for s in steps if s.func != "main"), steps[0].func)
            else:
                primary = function or "main"
            # Reindex
            for i, step in enumerate(steps):
                step.i = i
            return Trace(
                function=primary,
                cap=cap,
                hit_cap=hit_cap,
                steps=steps,
                source=source,
            )
        finally:
            try:
                gdb.exit()
            except Exception:
                pass


# Keep _clean imported for trace serialization helpers used by tests via trace.py
_ = _clean
