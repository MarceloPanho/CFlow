"""pywebview host. Exposes a JSON API; never draws, never lets JS talk to GDB."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    ROOT = Path(sys._MEIPASS)
else:
    ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.cfg import build_all_cfgs
from engine.tracer import CompileError, ToolchainError, discover_toolchain, parse_diagnostics, run_trace


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


class JsApi:
    def __init__(self, root: Path | None = None):
        self.root = root or ROOT
        self.samples_dir = self.root / "samples"

    def list_samples(self) -> list[str]:
        return sorted(p.name for p in self.samples_dir.glob("*.cpp"))

    def read_sample(self, name: str) -> str:
        safe = Path(name).name
        path = self.samples_dir / safe
        if not path.is_file():
            raise FileNotFoundError(safe)
        return path.read_text(encoding="utf-8")

    def toolchain_status(self) -> dict[str, Any]:
        try:
            tc = discover_toolchain()
            return {"ok": True, "gxx": str(tc.gxx), "gdb": str(tc.gdb)}
        except ToolchainError as exc:
            return {"ok": False, "error": str(exc)}

    def analyze(
        self,
        source: str,
        cap: int = 8000,
        step_into: bool = True,
        watch_as: dict[str, str] | None = None,
        function: str | None = None,
    ) -> dict[str, Any]:
        try:
            cfgs = {name: cfg.to_dict() for name, cfg in build_all_cfgs(source).items()}
            trace = run_trace(
                source,
                cap=int(cap),
                step_into=bool(step_into),
                watch_as=watch_as or {},
                function=function,
            )
            return _jsonable({"ok": True, "cfgs": cfgs, "trace": trace.to_dict(), "source": source})
        except CompileError as exc:
            return {
                "ok": False,
                "error": f"Compilação falhou:\n{exc}",
                "compiler_output": str(exc),
                "diagnostics": parse_diagnostics(str(exc)),
            }
        except ToolchainError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 — surface to the UI
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _ensure_system_gi() -> None:
    """Allow a venv to see distro PyGObject (WebKitGTK) on Linux."""
    if sys.platform.startswith("linux"):
        for candidate in (
            Path("/usr/lib/python3/dist-packages"),
            Path("/usr/lib/python3.12/dist-packages"),
        ):
            if candidate.is_dir() and str(candidate) not in sys.path:
                sys.path.append(str(candidate))


def main() -> None:
    _ensure_system_gi()
    import webview

    index = ROOT / "frontend" / "index.html"
    api = JsApi(ROOT)
    webview.create_window(
        "CFlow",
        url=str(index),
        js_api=api,
        width=1440,
        height=920,
        min_size=(960, 640),
        background_color="#10161F",
    )
    gui = "gtk" if sys.platform.startswith("linux") else None
    webview.start(gui=gui)


if __name__ == "__main__":
    main()
