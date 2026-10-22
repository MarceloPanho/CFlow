# Frontend contra os traces gravados (bridge falsa, Chromium headless). Pula sem Playwright.

import pytest

pytest.importorskip("playwright.sync_api")

from playwright.sync_api import sync_playwright  # noqa: E402

from tools.capture import load_fixtures, open_app, run_sample  # noqa: E402


@pytest.fixture(scope="module")
def app():
    fixtures = load_fixtures()
    errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = open_app(browser, fixtures, errors, reduced_motion="reduce")
        yield page, fixtures, errors
        browser.close()
    assert not errors


def test_fib5_recursion_tree(app):
    page, fixtures, _ = app
    run_sample(page, "fibonacci.cpp", fixtures["fibonacci.cpp"]["source"])
    page.evaluate("Player.seek(1e9)")
    page.click("#stack-view-toggle button[data-view=tree]")
    nodes = page.eval_on_selector_all(
        ".ct-node",
        "els => els.map(e => [e.querySelector('.ct-label').textContent, e.querySelector('.ct-sub').textContent, e.classList.contains('repeated')])",
    )
    assert len(nodes) == 15
    fib = lambda n: n if n <= 1 else fib(n - 1) + fib(n - 2)  # noqa: E731
    for label, sub, _ in nodes:
        assert sub == f"= {fib(int(label[4:-1]))}", (label, sub)
    assert [rep for label, _, rep in nodes if label == "fib(2)"] == [True, True, True]
    page.click("#stack-view-toggle button[data-view=stack]")


def test_call_trail_and_pinned_frame(app):
    page, fixtures, _ = app
    run_sample(page, "fibonacci.cpp", fixtures["fibonacci.cpp"]["source"])
    page.evaluate("Player.seek(9)")
    assert page.inner_text("#func-title").split() == ["main()", "›", "fib(5)", "›", "fib(4)", "›", "fib(3)", "›", "fib(2)", "›", "fib(1)"]
    page.click("#func-title button >> text=fib(4)")
    assert "fib" in page.inner_text("#frame-label") and page.inner_text("#datapanel .chip").split() == ["n", "4"]


def test_compile_error_marks_line_and_applies_suggestion(app):
    from tools.capture import show_compile_error

    page, fixtures, _ = app
    show_compile_error(page, fixtures["_compile_error.cpp"]["source"])
    assert page.inner_text("#gutter .err") == "6"
    assert page.inner_text("#backdrop .err-tok") == "ar"
    assert "corrija a linha 6" in page.inner_text("#status")
    page.click(".error-card >> text=Aplicar sugestão: arr")
    assert "arr[j] = arr[j + 1];" in page.input_value("#editor")
    assert page.locator("#gutter .err").count() == 0


def test_keyboard_drives_the_timeline(app):
    page, fixtures, _ = app
    run_sample(page, "fibonacci.cpp", fixtures["fibonacci.cpp"]["source"])
    total = len(fixtures["fibonacci.cpp"]["trace"]["steps"])
    label = lambda: page.inner_text("#step-label").replace(" ", "")  # noqa: E731
    page.keyboard.press("End")
    assert label() == f"{total}/{total}"
    page.keyboard.press("Home")
    page.keyboard.press("ArrowRight")
    assert label() == f"2/{total}"
    page.keyboard.press("Shift+ArrowRight")  # próxima chamada: fib(4)
    assert page.inner_text("#func-title .crumb.current") == "fib(4)"
    page.keyboard.press("Space")
    assert "playing" in page.get_attribute("#btn-play", "class")
    page.keyboard.press("Space")
    assert "playing" not in page.get_attribute("#btn-play", "class")


def test_click_on_code_line_goes_to_its_next_execution(app):
    page, fixtures, _ = app
    run_sample(page, "bubble_sort.cpp", fixtures["bubble_sort.cpp"]["source"])
    steps = fixtures["bubble_sort.cpp"]["trace"]["steps"]
    page.click("#codeview .line[data-line='6']")
    first = next(s["i"] for s in steps if s["line"] == 6)
    assert page.inner_text("#step-label").split("/")[0].strip() == str(first + 1)
    assert page.get_attribute("#codeview .line.current", "data-line") == "6"
