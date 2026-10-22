"""Harness visual: grava traces dos samples como fixtures e captura a tela.

    python tools/capture.py record          # motor -> tests/fixtures/<sample>.json
    python tools/capture.py shots [--out D] # Chromium headless + bridge falsa -> PNGs + checagens
    python tools/capture.py docs            # imagens e GIF do README em docs/img/

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
DOCS = ROOT / "docs" / "img"
GIF_MAX_BYTES = 3_000_000
INDEX = ROOT / "frontend" / "index.html"
# Teto baixo: o infinite_loop bate nele e a fixture continua pequena.
RECORD_CAP = 300
FRACTIONS = (0.0, 0.25, 0.5, 0.75, 1.0)
VIEWPORT = {"width": 1440, "height": 900}

FAKE_BRIDGE = """
(() => {
  const fixtures = %s;
  const api = {
    list_samples: async () => Object.keys(fixtures).filter((k) => !k.startsWith("_")).sort(),
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
    # Erro de compilação do protótipo ('ar' no lugar de 'arr'), para a tela de edição.
    broken = api.read_sample("bubble_sort.cpp").replace("arr[j] = arr[j + 1];", "arr[j] = ar[j + 1];")
    result = api.analyze(broken)
    out = FIXTURES / "_compile_error.json"
    out.write_text(json.dumps({**result, "source": broken}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{out.relative_to(ROOT)}: {len(result['diagnostics'])} erro(s)")


def load_fixtures() -> dict[str, dict]:
    found = {f"{p.stem}.cpp": json.loads(p.read_text(encoding="utf-8")) for p in sorted(FIXTURES.glob("*.json"))}
    if not found:
        raise SystemExit("Nenhuma fixture. Rode antes: python tools/capture.py record")
    return found


def open_app(browser, fixtures: dict[str, dict], errors: list[str], **page_kwargs):
    """Página do app com a bridge falsa, pronta para escolher um sample."""
    page_kwargs.setdefault("viewport", VIEWPORT)
    page = browser.new_page(**page_kwargs)
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.add_init_script(FAKE_BRIDGE % json.dumps(fixtures))
    page.goto(INDEX.as_uri())
    page.wait_for_function("document.querySelectorAll('#sample-select option').length > 0")
    return page


def run_sample(page, name: str, source: str) -> None:
    if not page.locator("#editor").is_visible():
        page.click("#btn-edit")
    page.select_option("#sample-select", name)
    page.wait_for_function("(src) => document.getElementById('editor').value === src", arg=source)
    page.click("#btn-run")
    page.wait_for_function("() => !document.getElementById('codeview').hidden")


def show_compile_error(page, source: str) -> None:
    if not page.locator("#editor").is_visible():
        page.click("#btn-edit")
    page.fill("#editor", source)
    page.click("#btn-run")
    page.wait_for_selector(".error-card")


def shots(out: Path) -> int:
    from playwright.sync_api import sync_playwright

    fixtures = load_fixtures()
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        # Movimento reduzido: sem tween, cada captura mostra o estado final do passo.
        page = open_app(browser, fixtures, errors, reduced_motion="reduce")
        for name, fixture in fixtures.items():
            if name.startswith("_"):
                continue
            stem = Path(name).stem
            run_sample(page, name, fixture["source"])
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
        if "_compile_error.cpp" in fixtures:
            show_compile_error(page, fixtures["_compile_error.cpp"]["source"])
            path = out / "compile_error.png"
            page.screenshot(path=str(path))
            print(path.relative_to(ROOT) if path.is_relative_to(ROOT) else path)
        browser.close()
    for err in errors:
        print(err, file=sys.stderr)
    return 1 if errors else 0


def _first(steps: list[dict], test) -> int:
    return next(s["i"] for s in steps if test(s))


def docs() -> int:
    """Imagens do README, sempre geradas daqui: nunca capturadas à mão."""
    from io import BytesIO

    from PIL import Image
    from playwright.sync_api import sync_playwright

    fixtures = load_fixtures()
    DOCS.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    bubble = fixtures["bubble_sort.cpp"]
    tree = fixtures["binary_tree.cpp"]["trace"]["steps"]
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = open_app(browser, fixtures, errors, reduced_motion="reduce", device_scale_factor=2)

        def snap(name: str, selector: str | None = None) -> None:
            path = DOCS / f"{name}.png"
            (page.locator(selector) if selector else page).screenshot(path=str(path))
            print(path.relative_to(ROOT))

        run_sample(page, "bubble_sort.cpp", bubble["source"])
        page.evaluate("Player.seek(32)")
        snap("screen")
        snap("flowchart", "#flow-pane")
        page.evaluate("Player.seek(9)")  # troca concluída: arr[0] e arr[1]
        snap("array", "#data-pane")

        page.evaluate("document.getElementById('data-pane').style.height = '520px'")
        run_sample(page, "binary_tree.cpp", fixtures["binary_tree.cpp"]["source"])
        full = _first(tree, lambda s: s["func"] == "main" and len((s["structures"].get("root") or {}).get("nodes") or []) == 4)
        page.evaluate("(i) => Player.seek(i)", full)
        snap("tree", "#data-pane")
        # Árvore inteira com o resumo (que quebra para baixo quando não cabe ao lado).
        page.evaluate("document.getElementById('col-flow').style.width = '1140px'; document.getElementById('data-pane').style.height = '780px'")
        run_sample(page, "fibonacci.cpp", fixtures["fibonacci.cpp"]["source"])
        page.evaluate("Player.seek(1e9)")
        page.click("#stack-view-toggle button[data-view=tree]")
        snap("recursion", "#data-pane")
        page.click("#stack-view-toggle button[data-view=stack]")
        page.evaluate("['data-pane', 'col-flow'].forEach((id) => { const s = document.getElementById(id).style; s.height = ''; s.width = ''; })")
        show_compile_error(page, fixtures["_compile_error.cpp"]["source"])
        snap("compile-error")

        # GIF: o bubble sort inteiro, um quadro por passo, com paleta única (sem cintilar).
        gif = open_app(browser, fixtures, errors, reduced_motion="reduce")
        run_sample(gif, "bubble_sort.cpp", bubble["source"])
        frames = []
        for i in range(len(bubble["trace"]["steps"])):
            gif.evaluate("(i) => Player.seek(i)", i)
            shot = Image.open(BytesIO(gif.screenshot())).convert("RGB")
            frames.append(shot.resize((1200, round(shot.height * 1200 / shot.width)), Image.LANCZOS))
        palette = frames[len(frames) // 2].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
        frames = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
        durations = [400] * len(frames)
        durations[-1] = 2000
        path = DOCS / "cflow.gif"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
        print(f"{path.relative_to(ROOT)}: {len(frames)} quadros, {sum(durations) / 1000:.1f} s, {path.stat().st_size / 1e6:.2f} MB")
        if path.stat().st_size > GIF_MAX_BYTES:
            errors.append(f"GIF com {path.stat().st_size / 1e6:.2f} MB passa de 3 MB")
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
    sub.add_parser("docs", help="regenera as imagens e o GIF do README em docs/img/")
    args = parser.parse_args()
    if args.cmd == "record":
        record()
    elif args.cmd == "docs":
        raise SystemExit(docs())
    else:
        raise SystemExit(shots(args.out.resolve()))


if __name__ == "__main__":
    main()
