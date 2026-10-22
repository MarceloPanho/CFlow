from engine.app import JsApi


def test_js_api_lists_and_reads_samples():
    api = JsApi()
    names = api.list_samples()
    assert "bubble_sort.cpp" in names
    text = api.read_sample("bubble_sort.cpp")
    assert "bubbleSort" in text


def test_js_api_rejects_path_escape(tmp_path):
    api = JsApi()
    try:
        api.read_sample("../engine/app.py")
    except FileNotFoundError:
        return
    raise AssertionError("expected path escape to fail")


def test_compile_error_returns_translated_diagnostics():
    api = JsApi()
    broken = api.read_sample("bubble_sort.cpp").replace("arr[j] = arr[j + 1];", "arr[j] = ar[j + 1];")
    result = api.analyze(broken)
    assert result["ok"] is False
    assert result["compiler_output"].startswith("main.cpp")
    (diag,) = result["diagnostics"]
    assert (diag["line"], diag["col"], diag["token"], diag["suggestion"]) == (6, 26, "ar", "arr")
    assert diag["message"] == "'ar' não foi declarado neste escopo. Você quis dizer 'arr'?"
