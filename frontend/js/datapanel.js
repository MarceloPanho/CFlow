const DataPanel = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const host = () => document.getElementById("datapanel");
  const hidden = new Set();
  const pos = new Map(); // posição persistida por endereço, para o layout não saltar
  const NODE_W = 140;
  const HEAD_H = 22;
  const ROW_H = 20;
  const CELL = 56;
  const GAP = 4;
  const MOVE_MS = 250;
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let watchHandler = null;
  let arrayMode = "cells";
  const anims = new Set();

  function onWatch(fn) {
    watchHandler = fn;
  }

  function toggleHidden(name) {
    if (hidden.has(name)) hidden.delete(name);
    else hidden.add(name);
  }

  function setArrayMode(mode) {
    arrayMode = mode;
  }

  function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function s(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    if (parent) parent.appendChild(node);
    return node;
  }

  function fmt(v) {
    if (v === null || v === undefined) return "∅";
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
  }

  const short = (addr) => (!addr ? "" : String(addr).length > 6 ? `…${String(addr).slice(-4)}` : String(addr));
  const typeLabel = (t) => (t || "").replace(/\s+(?=[[*&])/g, "").replace(/std::allocator<[^>]*>\s*>?/g, "").trim();

  function watchable(el, name) {
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (watchHandler) watchHandler(name, ev);
    });
  }

  function heading(name, detail) {
    const head = h("div", "st-head");
    const n = h("span", "st-name", name);
    watchable(n, name);
    head.append(n, h("span", "st-type", detail));
    return head;
  }

  // ---- render principal ----

  // frozen: dados de um quadro escolhido na trilha, sem destaque de mudança.
  function render(steps, cursor, frozen = false) {
    anims.forEach((id) => cancelAnimationFrame(id));
    anims.clear();
    const el = host();
    el.innerHTML = "";
    const step = steps[cursor];
    document.getElementById("frame-label").textContent = step ? `quadro: ${step.func}` : "";
    if (!step) return;
    // Comparar só com o mesmo quadro: em outro quadro "n" é outra variável.
    const prev = !frozen && cursor > 0 && steps[cursor - 1].frame_id === step.frame_id ? steps[cursor - 1] : null;
    const structures = Object.entries(step.structures || {}).filter(([name]) => !hidden.has(name));
    const indexVars = new Set();
    structures.forEach(([, st]) => (st.indices || []).forEach((ix) => /^\w+$/.test(ix.expr) && indexVars.add(ix.expr)));

    el.appendChild(scalarRow(step, prev, indexVars));
    const numeric = structures.some(([, st]) => st.kind === "array" && st.values.length && st.values.every((v) => typeof v === "number"));
    document.getElementById("array-mode").hidden = !numeric;

    const graphs = [];
    structures.forEach(([name, st]) => {
      if (st.kind === "array") el.appendChild(arrayBlock(name, st, steps, cursor, prev));
      else if (st.kind === "stack" || st.kind === "queue") el.appendChild(linearBlock(name, st, prev && prev.structures[name]));
      else graphs.push([name, st]);
    });
    groups(graphs).forEach((group) => el.appendChild(graphBlock(group, steps, cursor, step.func)));
  }

  function scalarRow(step, prev, indexVars) {
    const row = h("div", "scalar-row");
    Object.entries(step.scalars || {}).forEach(([k, v]) => {
      if (hidden.has(k)) return;
      const chip = h("button", "chip");
      chip.type = "button";
      chip.append(h("span", "k", k), document.createTextNode(` ${fmt(v)}`));
      if (indexVars.has(k)) chip.classList.add("index");
      const before = prev && prev.scalars ? prev.scalars[k] : undefined;
      if (before !== undefined && String(before) !== String(v)) {
        chip.classList.add("changed");
        chip.title = `antes: ${fmt(before)}`;
      }
      watchable(chip, k);
      chip.addEventListener("dblclick", () => {
        toggleHidden(k);
        chip.remove();
      });
      row.appendChild(chip);
    });
    return row;
  }

  // ---- array: células ou barras, índices embaixo, marcadores em cima ----

  // Troca concluída neste passo: duas posições trocaram de valor em relação a um passo
  // recente (a troca com tmp leva dois ou três passos).
  function swapAt(steps, cursor, name, values) {
    const now = steps[cursor];
    for (let k = 1; k <= 3 && cursor - k >= 0; k += 1) {
      const old = steps[cursor - k];
      if (old.frame_id !== now.frame_id) break;
      const before = old.structures && old.structures[name];
      if (!before || before.values.length !== values.length) break;
      const diff = values.map((v, i) => (String(v) !== String(before.values[i]) ? i : -1)).filter((i) => i >= 0);
      if (diff.length === 2) {
        const [a, b] = diff;
        if (String(values[a]) === String(before.values[b]) && String(values[b]) === String(before.values[a])) return [a, b];
      }
    }
    return null;
  }

  function arrayBlock(name, st, steps, cursor, prev) {
    const values = st.values || [];
    const box = h("div", "struct");
    box.appendChild(heading(name, `${typeLabel(st.type) || `[${values.length}]`} · array`));
    const before = prev && prev.structures[name] ? prev.structures[name].values || [] : [];
    const changed = (i) => before.length === values.length && String(before[i]) !== String(values[i]);
    const swap = values.some((_, i) => changed(i)) ? swapAt(steps, cursor, name, values) : null;
    const numeric = values.length && values.every((v) => typeof v === "number");
    const bars = arrayMode === "bars" && numeric;
    const max = bars ? Math.max(1, ...values.map(Math.abs)) : 1;

    const marks = {};
    (st.indices || []).forEach((ix) => {
      if (ix.value >= 0 && ix.value < values.length) (marks[ix.value] = marks[ix.value] || []).push(ix.expr);
    });
    const strip = h("div", `arr ${bars ? "bars" : "cells"}`);
    strip.style.width = `${values.length * (CELL + GAP)}px`;
    values.forEach((v, i) => {
      const col = h("div", "arr-col");
      col.style.left = `${i * (CELL + GAP)}px`;
      const mark = h("div", "arr-mark", marks[i] ? marks[i].join(", ") : "");
      const cell = h("div", "cell", fmt(v));
      if (bars) cell.style.height = `${Math.max(4, (Math.abs(v) / max) * 90)}px`;
      if (changed(i) || (swap && swap.includes(i))) cell.classList.add("changed");
      col.append(mark, cell, h("div", "arr-idx", String(i)));
      strip.appendChild(col);
      if (swap && swap.includes(i) && !reduced()) {
        const other = swap[0] === i ? swap[1] : swap[0];
        const dx = (other - i) * (CELL + GAP);
        const lift = i === swap[0] ? -16 : 16;
        cell.animate(
          [{ transform: `translate(${dx}px, 0)` }, { transform: `translate(${dx / 2}px, ${lift}px)` }, { transform: "none" }],
          { duration: MOVE_MS, easing: "ease-in-out" },
        );
      }
    });
    box.appendChild(strip);
    if (swap) box.appendChild(h("p", "arr-note", `trocou ${name}[${swap[0]}] e ${name}[${swap[1]}] no último passo`));
    return box;
  }

  // ---- pilha (topo em cima) e fila (frente à esquerda) ----

  function linearBlock(name, st, prevSt) {
    const values = st.values || [];
    const before = prevSt ? prevSt.values || [] : values;
    const stack = st.kind === "stack";
    const box = h("div", "struct");
    const pushed = values.length === before.length + 1;
    const popped = values.length === before.length - 1;
    const op = pushed ? "push" : popped ? "pop" : "";
    box.appendChild(heading(name, `${stack ? "pilha" : "fila"}${op ? ` · ${op}` : ""}`));
    const row = h("div", stack ? "stack" : "queue");
    // Na pilha o fim do vetor é o topo; na fila, o começo é a frente.
    const shown = stack ? values.slice().reverse() : values;
    if (popped) {
      const gone = stack ? before[before.length - 1] : before[0];
      const ghost = h("div", "cell ghost", `${stack ? "" : "← "}${fmt(gone)}${stack ? " ↑" : ""}`);
      ghost.title = "saiu neste passo";
      row.appendChild(ghost);
    }
    shown.forEach((v, i) => {
      const cell = h("div", "cell", fmt(v));
      if (!stack) {
        // Fila: "frente" e "fim" presos à própria célula, não à posição na fileira.
        const end = i === 0 ? "frente" : i === shown.length - 1 ? "fim" : "";
        cell.dataset.end = end;
      }
      const fresh = pushed && (stack ? i === 0 : i === shown.length - 1);
      if (fresh) {
        cell.classList.add("changed");
        if (!reduced()) {
          cell.animate([{ transform: stack ? "translateY(-12px)" : "translateX(12px)", opacity: 0 }, { transform: "none", opacity: 1 }], {
            duration: 200, easing: "ease-out",
          });
        }
      }
      row.appendChild(cell);
    });
    if (!values.length && !popped) row.appendChild(h("span", "empty", "vazia"));
    box.appendChild(row);
    return box;
  }

  // ---- box-and-pointer ----

  // Estruturas que compartilham nós (a, b, c e p no ciclo) vão para a mesma tela.
  function groups(graphs) {
    const out = [];
    graphs.forEach(([name, st]) => {
      const addrs = new Set((st.nodes || []).map((n) => n.addr));
      const hit = out.find((g) => [...addrs].some((a) => g.addrs.has(a)));
      if (hit) {
        hit.members.push([name, st]);
        addrs.forEach((a) => hit.addrs.add(a));
      } else out.push({ members: [[name, st]], addrs });
    });
    return out;
  }

  function seenBefore(steps, cursor) {
    const seen = new Set();
    for (let i = 0; i < cursor; i += 1) {
      Object.values(steps[i].structures || {}).forEach((st) => (st.nodes || []).forEach((n) => seen.add(n.addr)));
    }
    return seen;
  }

  function graphBlock(group, steps, cursor, func) {
    const box = h("div", "struct");
    const names = group.members.map(([n]) => n);
    const nodes = new Map();
    const edges = new Map();
    // Raízes primeiro (o motor emite em pós-ordem): o layout segue a ordem do código, a → b → c.
    group.members.forEach(([, st]) => (st.nodes || []).forEach((n) => n.addr === st.root && nodes.set(n.addr, n)));
    group.members.forEach(([, st]) => {
      (st.nodes || []).forEach((n) => nodes.set(n.addr, n));
      (st.edges || []).forEach((e) => edges.set(`${e.from}.${e.field}`, e));
    });
    if (!nodes.size) {
      group.members.forEach(([name, st]) => box.appendChild(pointerRow(name, st)));
      return box;
    }
    const kinds = new Set(group.members.map(([, st]) => st.kind));
    box.appendChild(heading(names.join(", "), kinds.has("graph") ? "grafo" : "árvore"));
    const byValue = new Map(group.members.filter(([, st]) => st.by_value).map(([name, st]) => [st.root, name]));
    const pointers = group.members.filter(([, st]) => !st.by_value);
    const ptrFields = (addr) => [...edges.values()].filter((e) => e.from === addr);
    const isNew = cursor > 0 ? ((seen) => (addr) => !seen.has(addr))(seenBefore(steps, cursor)) : () => false;

    const sizes = new Map();
    nodes.forEach((n, addr) => sizes.set(addr, HEAD_H + (Object.keys(n.fields || {}).length + ptrFields(addr).length) * ROW_H));
    const tree = !kinds.has("graph") && [...nodes.keys()].some((a) => ptrFields(a).length >= 2);
    const target = tree ? treeLayout(nodes, edges, group, sizes) : graphLayout(nodes, edges, sizes);
    const chipH = pointers.length ? 34 : 0;
    let maxX = 0;
    let maxY = 0;
    target.forEach((p, addr) => {
      p.y += chipH;
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + sizes.get(addr));
    });
    const hasInvalid = [...edges.values()].some((e) => e.to === "invalid");
    const width = maxX + (hasInvalid ? 170 : 16);
    const height = maxY + 40;

    const svg = s("svg", { class: "bp-canvas", width, height });
    s("defs", {}, svg).innerHTML = `
      <marker id="bp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="bp-arrowhead"></path></marker>
      <marker id="bp-arrow-index" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="bp-arrowhead index"></path></marker>
      <marker id="bp-arrow-error" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="bp-arrowhead error"></path></marker>`;
    const edgeLayer = s("g", {}, svg);
    const nodeLayer = s("g", {}, svg);
    const chipLayer = s("g", {}, svg);

    const drawn = new Map();
    nodes.forEach((n, addr) => {
      const g = s("g", { class: "bp-node" }, nodeLayer);
      const fresh = isNew(addr);
      if (fresh) g.classList.add("fresh");
      const hgt = sizes.get(addr);
      s("rect", { x: 0, y: 0, width: NODE_W, height: hgt, rx: 4, class: "bp-box" }, g);
      s("line", { x1: 0, x2: NODE_W, y1: HEAD_H, y2: HEAD_H, class: "bp-rule" }, g);
      const title = byValue.get(addr) || `${fresh ? "novo" : n.type || "nó"} · ${short(addr)}`;
      s("text", { x: 8, y: HEAD_H / 2, class: "bp-head" }, g).textContent = title;
      s("title", {}, g).textContent = addr;
      const slots = {};
      let y = HEAD_H;
      Object.entries(n.fields || {}).forEach(([k, v]) => {
        rowCells(g, y, k, fmt(v));
        y += ROW_H;
      });
      ptrFields(addr).forEach((e) => {
        rowCells(g, y, e.field, "");
        if (e.to === null) s("line", { x1: 56, y1: y + ROW_H - 2, x2: NODE_W - 2, y2: y + 2, class: "bp-null" }, g);
        else s("circle", { cx: 56 + (NODE_W - 56) / 2, cy: y + ROW_H / 2, r: 3, class: "bp-dot" }, g);
        slots[e.field] = y + ROW_H / 2;
        y += ROW_H;
      });
      drawn.set(addr, { g, slots, h: hgt });
    });

    const key = (addr) => `${func}:${names.join(",")}:${addr}`;
    const from = new Map();
    target.forEach((p, addr) => from.set(addr, pos.get(key(addr)) || p));
    target.forEach((p, addr) => pos.set(key(addr), { ...p }));

    const place = (at) => {
      drawn.forEach((d, addr) => d.g.setAttribute("transform", `translate(${at.get(addr).x},${at.get(addr).y})`));
      edgeLayer.innerHTML = "";
      chipLayer.innerHTML = "";
      edges.forEach((e) => {
        const a = at.get(e.from);
        if (!a || e.to === null) return;
        const sx = a.x + 56 + (NODE_W - 56) / 2;
        const sy = a.y + drawn.get(e.from).slots[e.field];
        if (e.to === "invalid") {
          const tx = a.x + NODE_W + 40;
          s("path", { d: `M ${sx} ${sy} L ${tx} ${sy}`, class: "bp-edge invalid", "marker-end": "url(#bp-arrow-error)" }, edgeLayer);
          invalidTarget(edgeLayer, tx, sy, e.note);
          return;
        }
        const b = at.get(e.to);
        if (!b) return;
        s("path", { d: edgePath(a, sx, sy, b, height), class: "bp-edge", "marker-end": "url(#bp-arrow)" }, edgeLayer);
      });
      // Ponteiro escalar (p, root): rótulo azul acima do nó, com seta.
      const stacked = new Map();
      pointers.forEach(([name, st]) => {
        const b = at.get(st.root);
        if (!b) return;
        const i = stacked.get(st.root) || 0;
        stacked.set(st.root, i + 1);
        const cx = b.x + 18 + i * 44;
        const t = s("text", { x: cx, y: b.y - 24, class: "bp-var" }, chipLayer);
        t.textContent = name;
        s("path", { d: `M ${cx + 4} ${b.y - 16} L ${cx + 4} ${b.y - 2}`, class: "bp-edge index", "marker-end": "url(#bp-arrow-index)" }, chipLayer);
      });
    };

    const moved = [...target].some(([addr, p]) => from.get(addr).x !== p.x || from.get(addr).y !== p.y);
    if (!moved || reduced()) place(target);
    else {
      const t0 = performance.now();
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / MOVE_MS);
        const e = 1 - (1 - t) ** 3;
        const at = new Map();
        target.forEach((p, addr) => {
          const o = from.get(addr);
          at.set(addr, { x: o.x + (p.x - o.x) * e, y: o.y + (p.y - o.y) * e });
        });
        place(at);
        if (t < 1) anims.add(requestAnimationFrame(frame));
      };
      place(new Map([...from]));
      anims.add(requestAnimationFrame(frame));
    }
    box.appendChild(svg);
    pointers.filter(([, st]) => !nodes.has(st.root)).forEach(([name, st]) => box.appendChild(pointerRow(name, st)));
    return box;
  }

  function rowCells(g, y, k, v) {
    s("line", { x1: 0, x2: NODE_W, y1: y, y2: y, class: "bp-rule" }, g);
    s("line", { x1: 52, x2: 52, y1: y, y2: y + ROW_H, class: "bp-rule" }, g);
    s("text", { x: 8, y: y + ROW_H / 2, class: "bp-key" }, g).textContent = k;
    const t = s("text", { x: 60, y: y + ROW_H / 2, class: "bp-val" }, g);
    t.textContent = v.length > 10 ? `${v.slice(0, 9)}…` : v;
  }

  function invalidTarget(layer, x, y, note) {
    const g = s("g", { class: "bp-invalid" }, layer);
    s("rect", { x: x + 2, y: y - 11, width: 120, height: 22, rx: 3 }, g);
    s("text", { x: x + 10, y }, g).textContent = `⚠ inválido · ${short(note) || "?"}`;
  }

  // Filho abaixo: entra pelo topo. Vizinho à direita: pela esquerda. Volta (ciclo): por baixo.
  function edgePath(a, sx, sy, b, height) {
    const tx = b.x + NODE_W / 2;
    if (b.y > sy + 10) return `M ${sx} ${sy} C ${sx} ${sy + 30}, ${tx} ${b.y - 30}, ${tx} ${b.y}`;
    const ty = b.y + HEAD_H / 2;
    if (b.x > sx) return `M ${sx} ${sy} C ${sx + 40} ${sy}, ${b.x - 40} ${ty}, ${b.x} ${ty}`;
    const right = a.x + NODE_W + 14;
    const low = height - 12;
    return `M ${sx} ${sy} L ${right} ${sy} L ${right} ${low} L ${b.x - 16} ${low} L ${b.x - 16} ${ty} L ${b.x} ${ty}`;
  }

  // Árvore em ordem: a subárvore da esquerda fica à esquerda, e o nó entre as duas.
  function treeLayout(nodes, edges, group, sizes) {
    const kids = new Map();
    const indeg = new Map([...nodes.keys()].map((a) => [a, 0]));
    edges.forEach((e) => {
      if (!nodes.has(e.from)) return;
      if (!kids.has(e.from)) kids.set(e.from, []);
      kids.get(e.from).push(e.to);
      if (nodes.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1);
    });
    const roots = group.members.map(([, st]) => st.root).filter((a) => nodes.has(a));
    nodes.forEach((_, a) => indeg.get(a) === 0 && roots.push(a));
    const out = new Map();
    let slot = 0;
    const rowH = Math.max(...sizes.values()) + 44;
    const visit = (u, depth) => {
      if (out.has(u) || !nodes.has(u)) return;
      out.set(u, null);
      const ks = kids.get(u) || [];
      const half = Math.floor(ks.length / 2);
      ks.slice(0, half).forEach((v) => visit(v, depth + 1));
      out.set(u, { x: 8 + slot * (NODE_W + 20), y: 8 + depth * rowH });
      slot += 1;
      ks.slice(half).forEach((v) => visit(v, depth + 1));
    };
    roots.forEach((r) => visit(r, 0));
    return out;
  }

  function graphLayout(nodes, edges, sizes) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 70, marginx: 8, marginy: 8 });
    g.setDefaultEdgeLabel(() => ({}));
    nodes.forEach((_, a) => g.setNode(a, { width: NODE_W, height: sizes.get(a) }));
    [...edges.values()].forEach((e, i) => {
      if (nodes.has(e.from) && nodes.has(e.to)) g.setEdge(e.from, e.to, {}, `e${i}`);
    });
    dagre.layout(g);
    const out = new Map();
    nodes.forEach((_, a) => {
      const n = g.node(a);
      out.set(a, { x: n.x - NODE_W / 2, y: n.y - sizes.get(a) / 2 });
    });
    return out;
  }

  // Ponteiro sem nó: nulo (traço com batente) ou inválido (seta tracejada até o alvo).
  function pointerRow(name, st) {
    const row = h("div", "ptr-row");
    const chip = h("span", "chip", name);
    watchable(chip, name);
    row.appendChild(chip);
    const svg = s("svg", { width: 44, height: 16, class: "ptr-line" });
    if (st.root === "invalid") {
      s("path", { d: "M 2 8 L 36 8", class: "bp-edge invalid" }, svg);
      s("path", { d: "M 34 4 L 42 8 L 34 12 z", class: "bp-arrowhead error" }, svg);
      row.append(svg, h("span", "invalid-target", `⚠ inválido · ${short(st.note) || "?"}`));
    } else {
      s("path", { d: "M 2 8 L 38 8 M 38 2 L 38 14", class: "bp-stop" }, svg);
      row.append(svg, h("span", "null", "nullptr"));
    }
    return row;
  }

  return { render, onWatch, toggleHidden, setArrayMode };
})();
