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
