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
  let speed = 1;
  let proven = false;
  const BASE_MS = 320; // 1×

  const els = {};
  function bind() {
    ["scrubber", "step-label", "btn-play", "btn-back", "btn-fwd", "btn-prev-call", "btn-next-call", "speed", "status",
      "codeview", "func-title", "stack-view-toggle", "frame-vars", "marks"].forEach((id) => {
      els[id] = document.getElementById(id);
    });
    els["btn-play"].addEventListener("click", toggle);
    els["btn-back"].addEventListener("click", () => seek(cursor - 1));
    els["btn-fwd"].addEventListener("click", () => seek(cursor + 1));
    els["btn-prev-call"].addEventListener("click", () => jump(-1));
    els["btn-next-call"].addEventListener("click", () => jump(1));
    els.scrubber.addEventListener("input", () => seek(Number(els.scrubber.value)));
    els.speed.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (btn) setSpeed(Number(btn.dataset.speed));
    });
    els["stack-view-toggle"].addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      view = btn.dataset.view;
      els["stack-view-toggle"].querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      show();
    });
    els["func-title"].addEventListener("click", (ev) => {
      const chip = ev.target.closest("button");
      if (!chip) return;
      const id = Number(chip.dataset.frame);
      pinned = id === current().frame_id ? null : id;
      show();
    });
    // Clique numa linha: vai para a próxima execução dela (dá a volta no fim).
    els.codeview.addEventListener("click", (ev) => {
      const row = ev.target.closest(".line");
      if (!row || !trace) return;
      const n = Number(row.dataset.line);
      const hits = trace.steps.filter((s) => s.line === n && s.event !== "return").map((s) => s.i);
      const next = hits.find((i) => i > cursor);
      if (next !== undefined || hits.length) seek(next !== undefined ? next : hits[0]);
    });
  }

  function load(payload) {
    stop();
    trace = payload.trace;
    cfgs = payload.cfgs || {};
    source = payload.source || "";
    cursor = 0;
    shown = -1;
    lastFunc = null;
    pinned = null;
    const steps = trace.steps || [];
    els.scrubber.max = Math.max(0, steps.length - 1);
    els.scrubber.value = 0;
    const recursive = steps.some((s) => (s.call_stack || []).filter((f) => f.func === s.func).length > 1);
    els["stack-view-toggle"].hidden = !recursive;
    proven = trace.hit_cap && hasRepeatedState(steps);
    renderMarks(steps);
    show();
  }

  function clear() {
    stop();
    trace = null;
    els.scrubber.max = 0;
    els.scrubber.value = 0;
    els.marks.innerHTML = "";
    els["func-title"].innerHTML = "";
    els["step-label"].textContent = "0 / 0";
    els["stack-view-toggle"].hidden = true;
    els["frame-vars"].hidden = true;
  }

  function hasRepeatedState(steps) {
    const seen = new Set();
    for (const s of steps) {
      const key = JSON.stringify([s.line, s.func, s.frame_id, s.scalars, s.structures]);
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }

  // Marcas no scrubber: chamada em cima, retorno embaixo, teto no fim.
  function renderMarks(steps) {
    const n = Math.max(1, steps.length - 1);
    els.marks.innerHTML = steps
      .filter((s) => s.i > 0 && (s.event === "call" || s.event === "return"))
      .map((s) => `<i class="${s.event}" style="left:${(s.i / n) * 100}%"></i>`)
      .join("") + (trace.hit_cap ? '<i class="cap" style="left:100%"></i>' : "");
  }

  function current() {
    return trace && trace.steps ? trace.steps[cursor] : null;
  }

  function seek(i) {
    if (!trace || !trace.steps.length) return;
    cursor = Math.max(0, Math.min(trace.steps.length - 1, i));
    els.scrubber.value = cursor;
    show();
  }

  function jump(dir) {
    if (!trace) return;
    const steps = trace.steps;
    for (let i = cursor + dir; i >= 0 && i < steps.length; i += dir) {
      if (steps[i].event === "call" || steps[i].event === "return") {
        seek(i);
        return;
      }
    }
    seek(dir < 0 ? 0 : steps.length - 1);
  }

  function setSpeed(mult) {
    speed = mult;
    els.speed.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === mult)));
  }

  function stop() {
    playing = false;
    clearTimeout(timer);
    timer = null;
    els["btn-play"].classList.remove("playing");
    els["btn-play"].setAttribute("aria-label", "Reproduzir");
  }

  function toggle() {
    if (!trace) return;
    if (playing) {
      stop();
      return;
    }
    if (cursor >= trace.steps.length - 1) seek(0);
    playing = true;
    els["btn-play"].classList.add("playing");
    els["btn-play"].setAttribute("aria-label", "Pausar");
    tick();
  }

  function tick() {
    if (!playing) return;
    if (cursor >= trace.steps.length - 1) {
      stop();
      return;
    }
    seek(cursor + 1);
    timer = setTimeout(tick, BASE_MS / speed);
  }

  function lineCounts() {
    const counts = new Map();
    for (let i = 0; i <= cursor; i += 1) {
      const s = trace.steps[i];
      if (s.event !== "return") counts.set(s.line, (counts.get(s.line) || 0) + 1);
    }
    return counts;
  }

  function show() {
    const step = current();
    const total = trace && trace.steps ? trace.steps.length : 0;
    els["step-label"].textContent = `${total ? cursor + 1 : 0} / ${total}`;
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
    const prev = cursor > 0 ? trace.steps[cursor - 1] : null;
    Code.renderView(els.codeview, source, {
      line: step.line,
      prevLine: prev && prev.line !== step.line ? prev.line : null,
      counts: lineCounts(),
    });
    renderStatus(step);

    const tree = view === "tree" && !els["stack-view-toggle"].hidden;
    document.getElementById("array-mode").classList.toggle("off", tree);
    els["frame-vars"].hidden = !tree;
    if (tree) {
      CallTree.render(document.getElementById("datapanel"), trace.steps, cursor);
      document.getElementById("frame-label").textContent = "a árvore cresce conforme as chamadas acontecem";
      renderFrameVars(step);
    } else {
      // Quadro escolhido na trilha: seus dados no último passo em que ele executou.
      let at = cursor;
      if (pinned !== null) while (at > 0 && trace.steps[at].frame_id !== pinned) at -= 1;
      DataPanel.render(trace.steps, at, at !== cursor);
      if (at !== cursor) document.getElementById("frame-label").textContent = `quadro: ${trace.steps[at].func} · valores de quando parou na linha ${trace.steps[at].line}`;
    }
    if (trace.hit_cap) document.getElementById("datapanel").prepend(capBanner());
  }

  function renderStatus(step) {
    els.status.className = "status";
    els.status.textContent = `${trace.steps.length} passos · ${step.func} · linha ${step.line}`;
  }

  // Aviso de teto: "provável" por padrão, "comprovado" se um estado inteiro se repetiu.
  function capBanner() {
    const box = document.createElement("div");
    box.className = "cap-banner";
    const tail = trace.steps.slice(-Math.min(60, trace.steps.length));
    const func = tail[tail.length - 1].func;
    const lines = tail.filter((s) => s.func === func).map((s) => s.line);
    const lo = Math.min(...lines);
    const hi = Math.max(...lines);
    const where = lo === hi ? `A linha ${lo}` : `As linhas ${lo} a ${hi}`;
    box.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"></path></svg>
      <div><strong></strong><p></p></div>
      <button type="button" class="tool">Ir para o último passo</button>`;
    box.querySelector("strong").textContent = `Teto de ${trace.cap} passos atingido · ${proven ? "loop infinito comprovado" : "provável loop infinito"}`;
    box.querySelector("p").textContent = proven
      ? `${where} de ${func} voltam a um estado idêntico: o programa nunca termina.`
      : `${where} de ${func} se repetem até o teto. Se o estado inteiro se repetir, o aviso passa a "loop infinito comprovado".`;
    box.querySelector("button").addEventListener("click", () => seek(trace.steps.length - 1));
    return box;
  }

  function renderTrail(stack, currentId) {
    const nav = els["func-title"];
    nav.innerHTML = "";
    // Recursão funda: main, reticências e os quatro quadros mais internos.
    const frames = stack.length > 6 ? [stack[0], null, ...stack.slice(-4)] : stack;
    frames.forEach((f, i) => {
      if (i) nav.appendChild(Object.assign(document.createElement("span"), { className: "sep", textContent: "›" }));
      if (!f) {
        nav.appendChild(Object.assign(document.createElement("span"), { className: "sep", textContent: "…" }));
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
      nav.appendChild(chip);
    });
  }

  function renderFrameVars(step) {
    const row = els["frame-vars"].querySelector(".scalar-row");
    row.innerHTML = "";
    Object.entries(step.scalars || {}).forEach(([k, v]) => {
      const chip = document.createElement("span");
      chip.className = "chip paper";
      chip.append(Object.assign(document.createElement("span"), { className: "k", textContent: k }), ` ${v}`);
      row.appendChild(chip);
    });
  }

  return {
    bind, load, clear, seek, jump, toggle, stop, setSpeed, show, current,
    get cursor() { return cursor; },
    get loaded() { return Boolean(trace); },
    get speed() { return speed; },
  };
})();
