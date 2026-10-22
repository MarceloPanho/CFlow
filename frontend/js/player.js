const Player = (() => {
  let trace = null;
  let cfgs = {};
  let source = "";
  let cursor = 0;
  let playing = false;
  let timer = null;
  let lastFunc = null;
  let shown = -1;
  let view = "stack";
  const speeds = [900, 550, 320, 180, 90];

  const els = {};
  function bind() {
    els.scrub = document.getElementById("scrubber");
    els.label = document.getElementById("step-label");
    els.play = document.getElementById("btn-play");
    els.back = document.getElementById("btn-back");
    els.fwd = document.getElementById("btn-fwd");
    els.speed = document.getElementById("speed");
    els.status = document.getElementById("status");
    els.codeview = document.getElementById("codeview");
    els.editor = document.getElementById("editor");
    els.funcTitle = document.getElementById("func-title");
    els.stackToggle = document.getElementById("stack-view-toggle");
    els.play.addEventListener("click", toggle);
    els.back.addEventListener("click", () => seek(cursor - 1));
    els.fwd.addEventListener("click", () => seek(cursor + 1));
    els.scrub.addEventListener("input", () => seek(Number(els.scrub.value)));
    els.stackToggle.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      view = btn.dataset.view;
      els.stackToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
      show();
    });
  }

  function load(payload) {
    trace = payload.trace;
    cfgs = payload.cfgs || {};
    source = payload.source || "";
    cursor = 0;
    shown = -1;
    lastFunc = null;
    els.scrub.max = Math.max(0, (trace.steps || []).length - 1);
    els.scrub.value = 0;
    const recursive = (trace.steps || []).some((s) => s.stack_depth > 2 || (s.call_stack || []).filter((f) => f.func === s.func).length > 1);
    els.stackToggle.hidden = !recursive;
    statusFor(trace);
    show();
  }

  function statusFor(t) {
    if (!t) return;
    if (t.hit_cap) {
      const proven = hasRepeatedState(t.steps);
      els.status.textContent = proven
        ? "Teto atingido — loop infinito comprovado (estado idêntico se repete)."
        : "Teto atingido — provável loop infinito. O rastro parcial ainda anima.";
      els.status.className = "status warn";
    } else {
      els.status.textContent = `${t.steps.length} passos · ${t.function}`;
      els.status.className = "status";
    }
  }

  function hasRepeatedState(steps) {
    const seen = new Set();
    for (const s of steps) {
      const key = JSON.stringify([s.line, s.func, s.scalars, s.structures]);
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }

  function current() {
    return trace && trace.steps ? trace.steps[cursor] : null;
  }

  function seek(i) {
    if (!trace || !trace.steps.length) return;
    cursor = Math.max(0, Math.min(trace.steps.length - 1, i));
    els.scrub.value = cursor;
    show();
  }

  function toggle() {
    playing = !playing;
    els.play.textContent = playing ? "❚❚" : "▶";
    if (playing) tick();
    else if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function tick() {
    if (!playing) return;
    if (cursor >= (trace.steps.length - 1)) {
      playing = false;
      els.play.textContent = "▶";
      return;
    }
    seek(cursor + 1);
    const ms = speeds[Number(els.speed.value)] || 320;
    timer = setTimeout(tick, ms);
  }

  function renderCode(line) {
    const lines = source.split(/\n/);
    els.codeview.innerHTML = lines
      .map((text, i) => {
        const n = i + 1;
        const cur = n === line ? " current" : "";
        const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        return `<div class="line${cur}"><span class="ln">${n}</span><span>${escaped || " "}</span></div>`;
      })
      .join("");
    const cur = els.codeview.querySelector(".line.current");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function show() {
    const step = current();
    const total = trace && trace.steps ? trace.steps.length : 0;
    els.label.textContent = `${total ? cursor + 1 : 0} / ${total}`;
    if (!step) return;
    const cfg = cfgs[step.func];
    els.funcTitle.textContent = step.func;
    if (step.func !== lastFunc) {
      Flowchart.render(cfg);
      lastFunc = step.func;
    }
    // Token só anima num passo à frente; scrub e volta trocam o estado direto.
    Flowchart.update(Flowchart.flowState(cfg, trace.steps, cursor), cursor === shown + 1);
    shown = cursor;
    renderCode(step.line);
    if (view === "tree") DataPanel.renderRecursion(trace.steps, cursor);
    else DataPanel.render(trace.steps, cursor);
  }

  function setEditMode(on) {
    els.editor.hidden = !on;
    els.codeview.hidden = on;
    document.getElementById("code-mode-label").textContent = on ? "código · edição" : "código · visualização";
  }

  return { bind, load, seek, toggle, setEditMode, current, show, get cursor() { return cursor; } };
})();
