const Code = (() => {
  const KEYWORDS = new Set(
    ("auto bool break case char class const continue default delete do double else enum false float for if " +
      "int long namespace new nullptr private public return short signed sizeof static struct switch template " +
      "this true typename unsigned using void while").split(" "),
  );
  const TOKEN = /(\/\/.*$|\/\*.*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|(#\s*\w+)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/g;
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Realce leve sem etapa de build: palavra-chave, função, número, string e comentário.
  function highlight(line) {
    let out = "";
    let last = 0;
    line.replace(TOKEN, (m, com, str, num, pre, fn, id, offset) => {
      out += esc(line.slice(last, offset));
      const word = fn || id;
      const cls = com ? "t-com" : str ? "t-str" : num ? "t-num" : pre || KEYWORDS.has(word) ? "t-kw" : fn ? "t-fn" : "";
      out += cls ? `<span class="${cls}">${esc(m)}</span>` : esc(m);
      last = offset + m.length;
      return m;
    });
    return out + esc(line.slice(last));
  }

  function renderView(el, source, { line, prevLine, counts }) {
    el.innerHTML = source
      .replace(/\n$/, "")
      .split("\n")
      .map((text, i) => {
        const n = i + 1;
        const cls = n === line ? " current" : n === prevLine ? " prev" : "";
        const c = counts.get(n);
        return `<div class="line${cls}" data-line="${n}"><span class="ln">${n}</span><span class="cnt">${c ? `×${c}` : ""}</span><span class="src">${highlight(text) || " "}</span></div>`;
      })
      .join("");
    const cur = el.querySelector(".line.current");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  // Editor: textarea com numeração ao lado e uma camada por trás, alinhada, que marca o erro.
  function mountEditor({ onRun }) {
    const ta = document.getElementById("editor");
    const gutter = document.getElementById("gutter");
    const backdrop = document.getElementById("backdrop");
    let diags = [];
    let tabLeaves = false; // depois de Esc, Tab volta a mover o foco

    const live = (lines) => diags.filter((d) => lines[d.line - 1] === d.text);

    function sync() {
      const lines = ta.value.split("\n");
      const marks = live(lines);
      gutter.innerHTML = lines
        .map((_, i) => {
          const d = marks.find((x) => x.line === i + 1);
          return d ? `<span class="err" title="${esc(d.message)}">${i + 1}<i></i></span>` : String(i + 1);
        })
        .join("\n");
      backdrop.innerHTML = `${lines
        .map((text, i) => {
          const d = marks.find((x) => x.line === i + 1);
          if (!d) return esc(text);
          const at = Math.max(0, d.col - 1);
          const len = d.token && text.substr(at, d.token.length) === d.token ? d.token.length : (text.slice(at).match(/^\w+|^\S/) || [" "])[0].length;
          return `<span class="err-line">${esc(text.slice(0, at))}<span class="err-tok">${esc(text.slice(at, at + len))}</span>${esc(text.slice(at + len))}</span>`;
        })
        .join("\n")}\n`;
      scroll();
    }

    function scroll() {
      gutter.scrollTop = ta.scrollTop;
      backdrop.scrollTop = ta.scrollTop;
      backdrop.scrollLeft = ta.scrollLeft;
    }

    ta.addEventListener("input", sync);
    ta.addEventListener("scroll", scroll);
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") tabLeaves = true;
      else if (ev.key === "Tab" && !tabLeaves && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end");
        sync();
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        onRun();
      }
      if (ev.key !== "Escape" && ev.key !== "Tab" && ev.key !== "Shift") tabLeaves = false;
    });

    function setDiagnostics(list) {
      const lines = ta.value.split("\n");
      diags = (list || []).map((d) => ({ ...d, text: lines[d.line - 1] }));
      sync();
    }

    function goToLine(n) {
      const lines = ta.value.split("\n");
      const start = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(start, start + (lines[n - 1] || "").length);
      const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      ta.scrollTop = Math.max(0, (n - 1) * lineH - ta.clientHeight / 3);
      scroll();
    }

    function applySuggestion(d) {
      const lines = ta.value.split("\n");
      const text = lines[d.line - 1] || "";
      const at = d.col - 1;
      if (!d.token || !d.suggestion || text.substr(at, d.token.length) !== d.token) return false;
      lines[d.line - 1] = text.slice(0, at) + d.suggestion + text.slice(at + d.token.length);
      ta.value = lines.join("\n");
      sync();
      goToLine(d.line);
      return true;
    }

    return { sync, setDiagnostics, goToLine, applySuggestion };
  }

  return { highlight, renderView, mountEditor };
})();
