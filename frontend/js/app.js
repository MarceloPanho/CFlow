(() => {
  const editor = document.getElementById("editor");
  const sampleSelect = document.getElementById("sample-select");
  const btnRun = document.getElementById("btn-run");
  const btnEdit = document.getElementById("btn-edit");
  const status = document.getElementById("status");
  const watchPop = document.getElementById("watch-pop");
  const watchAs = {};
  let watchTarget = null;

  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = "status" + (kind ? " " + kind : "");
  }

  async function boot() {
    Flowchart.mount();
    Player.bind();
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

    try {
      const tc = await Bridge.toolchain();
      if (!tc.ok) setStatus(tc.error, "err");
      const samples = await Bridge.listSamples();
      sampleSelect.innerHTML = samples.map((s) => `<option value="${s}">${s}</option>`).join("");
      const prefer = samples.includes("bubble_sort.cpp") ? "bubble_sort.cpp" : samples[0];
      sampleSelect.value = prefer;
      editor.value = await Bridge.readSample(prefer);
      Player.setEditMode(true);
    } catch (err) {
      setStatus("Abra o app pelo host Python (pywebview).", "err");
    }

    sampleSelect.addEventListener("change", async () => {
      editor.value = await Bridge.readSample(sampleSelect.value);
      Player.setEditMode(true);
      btnEdit.hidden = true;
    });
    btnRun.addEventListener("click", run);
    btnEdit.addEventListener("click", () => {
      Player.setEditMode(true);
      btnEdit.hidden = true;
    });
    setupSplits();
  }

  async function run() {
    btnRun.disabled = true;
    setStatus("Compilando e rastreando…");
    try {
      const cap = Number(document.getElementById("cap-input").value) || 4000;
      const stepInto = document.getElementById("step-into").checked;
      const result = await Bridge.analyze(editor.value, cap, stepInto, watchAs);
      if (!result.ok) {
        setStatus(result.error, "err");
        return;
      }
      Player.setEditMode(false);
      btnEdit.hidden = false;
      Player.load(result);
    } catch (err) {
      setStatus(String(err), "err");
    } finally {
      btnRun.disabled = false;
    }
  }

  function setupSplits() {
    const v = document.getElementById("v-split");
    const h = document.getElementById("h-split");
    const col = document.getElementById("col-flow");
    const data = document.getElementById("data-pane");
    drag(v, (dx) => {
      col.style.width = `${Math.max(280, col.getBoundingClientRect().width + dx)}px`;
    });
    drag(h, (_dx, dy) => {
      data.style.height = `${Math.max(120, data.getBoundingClientRect().height - dy)}px`;
    });
  }

  function drag(el, onmove) {
    el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const move = (e) => onmove(e.movementX, e.movementY);
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
