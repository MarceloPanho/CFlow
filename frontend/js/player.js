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
  let pinned = null; // frame_id escolhido na trilha; null = quadro atual
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
    els.frameVars = document.getElementById("frame-vars");
    els.play.addEventListener("click", toggle);
    els.back.addEventListener("click", () => seek(cursor - 1));
    els.fwd.addEventListener("click", () => seek(cursor + 1));
    els.scrub.addEventListener("input", () => seek(Number(els.scrub.value)));
    els.stackToggle.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      view = btn.dataset.view;
      els.stackToggle.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      show();
    });
    els.funcTitle.addEventListener("click", (ev) => {
      const chip = ev.target.closest("button");
      if (!chip) return;
      const id = Number(chip.dataset.frame);
      pinned = id === current().frame_id ? null : id;
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
    pinned = null;
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
    const stack = step.call_stack && step.call_stack.length ? step.call_stack : [{ func: step.func, frame_id: step.frame_id, args: step.args }];
    if (pinned !== null && !stack.some((f) => f.frame_id === pinned)) pinned = null;
    renderTrail(stack, step.frame_id);
    if (step.func !== lastFunc) {
      Flowchart.render(cfg);
      lastFunc = step.func;
    }
    // Token só anima num passo à frente; scrub e volta trocam o estado direto.
    Flowchart.update(Flowchart.flowState(cfg, trace.steps, cursor), cursor === shown + 1);
    shown = cursor;
    renderCode(step.line);
    const tree = view === "tree" && !els.stackToggle.hidden;
    document.getElementById("array-mode").classList.toggle("off", tree);
    els.frameVars.hidden = !tree;
    if (tree) {
      CallTree.render(document.getElementById("datapanel"), trace.steps, cursor);
      document.getElementById("frame-label").textContent = "a árvore cresce conforme as chamadas acontecem";
      renderFrameVars(step);
      return;
    }
    // Quadro escolhido na trilha: seus dados no último passo em que ele executou.
    let at = cursor;
    if (pinned !== null) while (at > 0 && trace.steps[at].frame_id !== pinned) at -= 1;
    DataPanel.render(trace.steps, at, at !== cursor);
    if (at !== cursor) document.getElementById("frame-label").textContent = `quadro: ${trace.steps[at].func} · valores de quando parou na linha ${trace.steps[at].line}`;
  }

  function renderTrail(stack, currentId) {
    els.funcTitle.innerHTML = "";
    // Recursão funda: main, reticências e os quatro quadros mais internos.
    const shownFrames = stack.length > 6 ? [stack[0], null, ...stack.slice(-4)] : stack;
    shownFrames.forEach((f, i) => {
      if (i) els.funcTitle.appendChild(Object.assign(document.createElement("span"), { className: "sep", textContent: "›" }));
      if (!f) {
        els.funcTitle.appendChild(Object.assign(document.createElement("span"), { className: "sep", textContent: "…" }));
        return;
      }
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "crumb";
      chip.dataset.frame = f.frame_id;
      chip.textContent = CallTree.label(f.func, f.args);
      if (f.frame_id === currentId) chip.classList.add("current");
      if (f.frame_id === pinned) chip.classList.add("pinned");
      chip.title = f.frame_id === currentId ? "quadro atual" : "mostrar os dados deste quadro";
      els.funcTitle.appendChild(chip);
    });
  }

  function renderFrameVars(step) {
    const row = els.frameVars.querySelector(".scalar-row");
    row.innerHTML = "";
    Object.entries(step.scalars || {}).forEach(([k, v]) => {
      const chip = document.createElement("span");
      chip.className = "chip paper";
      chip.innerHTML = `<span class="k"></span> `;
      chip.querySelector(".k").textContent = k;
      chip.append(String(v));
      row.appendChild(chip);
    });
  }

  function setEditMode(on) {
    els.editor.hidden = !on;
    els.codeview.hidden = on;
    document.getElementById("code-mode-label").textContent = on ? "código · edição" : "código · visualização";
  }

  return { bind, load, seek, toggle, setEditMode, current, show, get cursor() { return cursor; } };
})();
