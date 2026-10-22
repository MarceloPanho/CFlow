(() => {
  const $ = (id) => document.getElementById(id);
  const editor = $("editor");
  const sampleSelect = $("sample-select");
  const status = $("status");
  const watchPop = $("watch-pop");
  const watchAs = {};
  let watchTarget = null;
  let editorApi = null;
  let samples = [];
  const OWN = "__own__";

  // O que cada sample demonstra (os nomes vêm do motor; sample novo aparece sem descrição).
  const ABOUT = {
    "bubble_sort.cpp": "array e trocas",
    "fibonacci.cpp": "árvore de recursão",
    "binary_tree.cpp": "ponteiros e árvore",
    "graph_cycle.cpp": "grafo com ciclo",
    "stack_demo.cpp": "pilha: push e pop",
    "queue_demo.cpp": "fila: enqueue e dequeue",
    "infinite_loop.cpp": "teto e loop infinito",
    "invalid_pointer.cpp": "nulo e ponteiro inválido",
    "factorial.cpp": "recursão e pilha",
    "sum_loop.cpp": "laço simples",
  };

  // Preferências entre sessões; o app funciona igual se o armazenamento falhar.
  const prefs = (() => {
    let data = {};
    try {
      data = JSON.parse(localStorage.getItem("cflow.prefs") || "{}");
    } catch (_) {
      data = {};
    }
    return {
      get: (k, d) => (k in data ? data[k] : d),
      set(k, v) {
        data[k] = v;
        try {
          localStorage.setItem("cflow.prefs", JSON.stringify(data));
        } catch (_) {
          /* sem armazenamento: só não lembra */
        }
      },
    };
  })();

  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function setEditMode(on) {
    $("editor-wrap").hidden = !on;
    $("codeview").hidden = on;
    $("code-legend").hidden = on;
    $("btn-edit").hidden = on || !Player.loaded;
    $("code-mode-label").innerHTML = `código · <em>${on ? "edição" : "visualização"}</em>`;
    $("code-hint").textContent = on ? "Tab insere 4 espaços · Esc e Tab saem do editor" : "clique numa linha para ir à próxima execução dela";
    $("run-label").textContent = on || !Player.loaded ? "Rodar" : "Rodar de novo";
    $("run-kbd").hidden = !on;
    if (on) {
      $("frame-vars").hidden = true;
      editorApi.sync();
    }
  }

  async function loadSample(name) {
    sampleSelect.value = name;
    editor.value = await Bridge.readSample(name);
    editorApi.setDiagnostics([]);
    setEditMode(true);
  }

  function emptyState(note) {
    Player.clear();
    Flowchart.clear();
    $("flow-tools").hidden = true;
    $("frame-label").textContent = note || "nada executado ainda. Comece por um sample ou cole um programa C++ com main.";
    $("array-mode").hidden = true;
    $("data-hint").hidden = true;
    const host = $("datapanel");
    host.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "sample-grid";
    samples.forEach((name) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "sample-card";
      card.append(Object.assign(document.createElement("strong"), { textContent: name.replace(/\.cpp$/, "") }));
      if (ABOUT[name]) card.append(Object.assign(document.createElement("span"), { textContent: ABOUT[name] }));
      card.addEventListener("click", async () => {
        await loadSample(name);
        run();
      });
      grid.appendChild(card);
    });
    const steps = document.createElement("ol");
    steps.className = "how";
    ["Escolha um sample ou cole um programa completo, com main.",
      "Ajuste o teto de passos e se o depurador entra nas chamadas.",
      "Rode: o motor compila com -O0 -g e grava a execução pelo GDB."].forEach((t) => {
      steps.appendChild(Object.assign(document.createElement("li"), { textContent: t }));
    });
    host.append(grid, steps);
  }

  function compileError(result) {
    const diags = result.diagnostics || [];
    editorApi.setDiagnostics(diags);
    emptyState();
    const first = diags[0];
    const card = document.createElement("div");
    card.className = "error-card";
    card.innerHTML = `
      <h2><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6M12 16.5v.5"></path></svg><span></span></h2>
      <p>O g++ parou antes de gerar o executável. O fluxograma e o rastro aparecem depois de uma compilação bem-sucedida.</p>
      <pre></pre>
      <div class="error-actions"></div>`;
    card.querySelector("h2 span").textContent = diags.length
      ? `A compilação falhou: ${diags.length} erro${diags.length > 1 ? "s" : ""}`
      : "A compilação falhou";
    card.querySelector("pre").textContent = (result.compiler_output || result.error || "").trim();
    const actions = card.querySelector(".error-actions");
    if (first) {
      const go = Object.assign(document.createElement("button"), { type: "button", className: "btn-error", textContent: `Ir para a linha ${first.line}` });
      go.addEventListener("click", () => editorApi.goToLine(first.line));
      actions.appendChild(go);
      if (first.suggestion && first.token) {
        const fix = Object.assign(document.createElement("button"), { type: "button", className: "btn-error ghost", textContent: `Aplicar sugestão: ${first.suggestion}` });
        fix.addEventListener("click", () => editorApi.applySuggestion(first) && fix.remove());
        actions.appendChild(fix);
      }
    }
    $("flowchart").appendChild(card);
    setStatus(first ? `Compilação falhou: corrija a linha ${first.line} e rode de novo.` : "Compilação falhou.", "err");
  }

  async function run() {
    const btn = $("btn-run");
    btn.disabled = true;
    Player.stop();
    setStatus("Compilando e rastreando…");
    try {
      const cap = Number($("cap-input").value) || 4000;
      const stepInto = $("step-into").checked;
      const result = await Bridge.analyze(editor.value, cap, stepInto, watchAs);
      if (!result.ok) {
        setEditMode(true);
        if (result.compiler_output !== undefined) compileError(result);
        else setStatus(result.error, "err");
        return;
      }
      editorApi.setDiagnostics([]);
      $("data-hint").hidden = false;
      $("flow-tools").hidden = false;
      Player.load(result);
      setEditMode(false);
    } catch (err) {
      setStatus(String(err), "err");
    } finally {
      btn.disabled = false;
    }
  }

  // Teclado: o app inteiro sem mouse. Campos de texto ficam com as próprias teclas.
  function onKey(ev) {
    const t = ev.target;
    const typing = t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && t.type !== "range" && t.type !== "checkbox");
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      run();
      return;
    }
    if (typing || ev.altKey || ev.ctrlKey || ev.metaKey || !Player.loaded) return;
    const keys = {
      " ": () => Player.toggle(),
      ArrowLeft: () => (ev.shiftKey ? Player.jump(-1) : Player.seek(Player.cursor - 1)),
      ArrowRight: () => (ev.shiftKey ? Player.jump(1) : Player.seek(Player.cursor + 1)),
      Home: () => Player.seek(0),
      End: () => Player.seek(1e9),
      "+": () => Flowchart.zoomBy(1.2),
      "=": () => Flowchart.zoomBy(1.2),
      "-": () => Flowchart.zoomBy(1 / 1.2),
      0: () => Flowchart.fit(),
    };
    const action = keys[ev.key];
    if (!action) return;
    ev.preventDefault();
    action();
  }

  function setupSplits() {
    const col = $("col-flow");
    const data = $("data-pane");
    const sizes = prefs.get("sizes", null);
    if (sizes) {
      col.style.width = `${sizes.col}px`;
      data.style.height = `${sizes.data}px`;
    }
    const save = () => prefs.set("sizes", { col: col.getBoundingClientRect().width, data: data.getBoundingClientRect().height });
    drag($("v-split"), (dx) => {
      col.style.width = `${Math.max(280, col.getBoundingClientRect().width + dx)}px`;
    }, save);
    drag($("h-split"), (_dx, dy) => {
      data.style.height = `${Math.max(120, data.getBoundingClientRect().height - dy)}px`;
    }, save);
  }

  function drag(el, onmove, done) {
    el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const move = (e) => onmove(e.movementX, e.movementY);
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        done();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  function restorePrefs() {
    $("step-into").checked = prefs.get("stepInto", true);
    $("cap-input").value = prefs.get("cap", 4000);
    Player.setSpeed(prefs.get("speed", 1));
    Flowchart.setFollow(prefs.get("follow", true));
    const mode = prefs.get("arrayMode", "cells");
    DataPanel.setArrayMode(mode);
    $("array-mode").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    $("step-into").addEventListener("change", () => prefs.set("stepInto", $("step-into").checked));
    $("cap-input").addEventListener("change", () => prefs.set("cap", Number($("cap-input").value) || 4000));
    $("speed").addEventListener("click", () => prefs.set("speed", Player.speed));
    $("follow").addEventListener("click", () => prefs.set("follow", $("follow").getAttribute("aria-pressed") === "true"));
  }

  async function boot() {
    Flowchart.mount();
    Player.bind();
    editorApi = Code.mountEditor({ onRun: run });
    restorePrefs();
    DataPanel.onWatch((name, ev) => {
      watchTarget = name;
      watchPop.hidden = false;
      watchPop.style.left = `${ev.clientX}px`;
      watchPop.style.top = `${ev.clientY}px`;
    });
    watchPop.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn || !watchTarget) return;
      let as = btn.dataset.as;
      if (as === "array[n]") {
        const n = window.prompt("Comprimento (número ou variável)", "n");
        as = n ? `array[${n}]` : "";
      }
      if (as) watchAs[watchTarget] = as;
      else delete watchAs[watchTarget];
      watchPop.hidden = true;
      await run();
    });
    document.addEventListener("click", (ev) => {
      if (!watchPop.contains(ev.target)) watchPop.hidden = true;
    });
    document.addEventListener("keydown", onKey);
    $("array-mode").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      ev.currentTarget.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      DataPanel.setArrayMode(btn.dataset.mode);
      prefs.set("arrayMode", btn.dataset.mode);
      Player.show();
    });
    $("btn-run").addEventListener("click", run);
    $("btn-edit").addEventListener("click", () => {
      setEditMode(true);
      editor.focus();
    });
    sampleSelect.addEventListener("change", () => sampleSelect.value !== OWN && loadSample(sampleSelect.value));
    editor.addEventListener("input", () => {
      sampleSelect.value = OWN;
    });
    setupSplits();

    try {
      const tc = await Bridge.toolchain();
      samples = await Bridge.listSamples();
      sampleSelect.innerHTML = samples.map((s) => `<option value="${s}">${s}</option>`).join("") + `<option value="${OWN}" hidden>código próprio</option>`;
      await loadSample(samples.includes("bubble_sort.cpp") ? "bubble_sort.cpp" : samples[0]);
      emptyState();
      if (!tc.ok) setStatus(tc.error, "err");
      else setStatus("Pronto. Escolha um sample ou edite o código e rode.");
    } catch (err) {
      setStatus("Abra o app pelo host Python (pywebview).", "err");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
