"""Harness visual: grava traces dos samples como fixtures e captura a tela.

    python tools/capture.py record          # motor -> tests/fixtures/<sample>.json
    python tools/capture.py shots [--out D] # Chromium headless + bridge falsa -> PNGs

O frontend roda sem pywebview: uma bridge falsa devolve os traces gravados,
então as capturas são determinísticas e não dependem de g++/gdb.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FIXTURES = ROOT / "tests" / "fixtures"
INDEX = ROOT / "frontend" / "index.html"
# Teto baixo: o infinite_loop bate nele e a fixture continua pequena.
RECORD_CAP = 300
FRACTIONS = (0.0, 0.25, 0.5, 0.75, 1.0)
VIEWPORT = {"width": 1440, "height": 900}

FAKE_BRIDGE = """
(() => {
  const fixtures = %s;
  const api = {
    list_samples: async () => Object.keys(fixtures).sort(),
    read_sample: async (name) => fixtures[name].source,
    toolchain_status: async () => ({ ok: true, gxx: "g++", gdb: "gdb" }),
    analyze: async (source) =>
      Object.values(fixtures).find((f) => f.source === source) ||
      { ok: false, error: "sem fixture para este código" },
  };
  window.pywebview = { api };
})();
"""


# Checagens visuais no passo atual; cada string devolvida é uma falha.
CHECKS = """
() => {
  const fails = [];
  document.querySelectorAll("#flowchart .cfg-node").forEach((g) => {
    const shape = g.querySelector(".shape").getBBox();
    const text = g.querySelector(".node-label").getBBox();
    const inside = g.dataset.kind === "decision"
      ? text.width / shape.width + text.height / shape.height <= 1
      : text.x >= shape.x && text.x + text.width <= shape.x + shape.width &&
        text.y >= shape.y && text.y + text.height <= shape.y + shape.height;
    if (!inside) fails.push(`rótulo fora da forma: ${g.querySelector("title").textContent.split("\\n")[0]}`);
  });
  const cur = document.querySelector("#flowchart .cfg-node.current");
  if (cur) {
    const a = cur.getBoundingClientRect();
    const b = document.getElementById("flowchart").getBoundingClientRect();
    if (a.left < b.left || a.right > b.right || a.top < b.top || a.bottom > b.bottom) fails.push("nó atual fora da vista");
  }
  return fails;
}
"""


def record() -> None:
    from engine.app import JsApi

    api = JsApi(ROOT)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name in api.list_samples():
        result = api.analyze(api.read_sample(name), cap=RECORD_CAP, step_into=True)
        if not result.get("ok"):
            raise SystemExit(f"{name}: {result.get('error')}")
        out = FIXTURES / f"{Path(name).stem}.json"
        out.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"{out.relative_to(ROOT)}: {len(result['trace']['steps'])} passos")


def load_fixtures() -> dict[str, dict]:
    found = {f"{p.stem}.cpp": json.loads(p.read_text(encoding="utf-8")) for p in sorted(FIXTURES.glob("*.json"))}
    if not found:
        raise SystemExit("Nenhuma fixture. Rode antes: python tools/capture.py record")
    return found


def shots(out: Path) -> int:
    from playwright.sync_api import sync_playwright

    fixtures = load_fixtures()
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        # Movimento reduzido: sem tween, cada captura mostra o estado final do passo.
        page = browser.new_page(viewport=VIEWPORT, reduced_motion="reduce")
        page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.add_init_script(FAKE_BRIDGE % json.dumps(fixtures))
        page.goto(INDEX.as_uri())
        page.wait_for_function("document.querySelectorAll('#sample-select option').length > 0")
        for name, fixture in fixtures.items():
            stem = Path(name).stem
            page.select_option("#sample-select", name)
            page.wait_for_function("(src) => document.getElementById('editor').value === src", arg=fixture["source"])
            page.click("#btn-run")
            page.wait_for_function("() => !document.getElementById('codeview').hidden")
            total = len(fixture["trace"]["steps"])
            for frac in FRACTIONS:
                idx = round(frac * (total - 1))
                try:
                    page.evaluate("(i) => Player.seek(i)", idx)
                except Exception as exc:  # noqa: BLE001 — registra e segue para os outros passos
                    errors.append(f"{stem} passo {idx}: {str(exc).splitlines()[0]}")
                errors.extend(f"{stem} passo {idx}: {msg}" for msg in page.evaluate(CHECKS))
                path = out / f"{stem}-{idx:04d}.png"
                page.screenshot(path=str(path))
                print(path.relative_to(ROOT) if path.is_relative_to(ROOT) else path)
            page.click("#btn-edit")
        browser.close()
    for err in errors:
        print(err, file=sys.stderr)
    return 1 if errors else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("record", help="grava os traces dos samples em tests/fixtures/")
    shot = sub.add_parser("shots", help="captura a tela em passos fixos de cada sample")
    shot.add_argument("--out", type=Path, default=ROOT / "build" / "capture")
    args = parser.parse_args()
    if args.cmd == "record":
        record()
    else:
        raise SystemExit(shots(args.out.resolve()))


if __name__ == "__main__":
    main()
