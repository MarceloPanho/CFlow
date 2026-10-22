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
