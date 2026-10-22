const DataPanel = (() => {
  const host = () => document.getElementById("datapanel");
  const hidden = new Set();
  const pos = new Map();
  let watchHandler = null;

  function onWatch(fn) {
    watchHandler = fn;
  }

  function toggleHidden(name) {
    if (hidden.has(name)) hidden.delete(name);
    else hidden.add(name);
  }

  function render(step, prev, opts) {
    const el = host();
    el.innerHTML = "";
    if (!step) return;
    opts = opts || {};
    const scalars = document.createElement("div");
    scalars.className = "scalar-row";
    Object.entries(step.scalars || {}).forEach(([k, v]) => {
      if (hidden.has(k)) return;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.innerHTML = `<span class="k">${k}</span> ${fmt(v)}`;
      chip.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        if (watchHandler) watchHandler(k, ev);
      });
      chip.addEventListener("dblclick", () => {
        toggleHidden(k);
        render(step, prev, opts);
      });
      scalars.appendChild(chip);
    });
    if (scalars.childNodes.length) el.appendChild(scalars);

    Object.entries(step.structures || {}).forEach(([name, st]) => {
      if (hidden.has(name)) return;
      const box = document.createElement("div");
      box.className = "struct";
      const h = document.createElement("h2");
      h.textContent = `${name} · ${st.kind}`;
      h.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        if (watchHandler) watchHandler(name, ev);
      });
      box.appendChild(h);
      const prevSt = prev && prev.structures ? prev.structures[name] : null;
      if (st.kind === "array" || st.kind === "stack" || st.kind === "queue") {
        box.appendChild(linear(st, prevSt));
      } else {
        box.appendChild(boxPointer(st, prevSt, name));
      }
      el.appendChild(box);
    });
  }

  function fmt(v) {
    if (v === null || v === undefined) return "∅";
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
  }

  function linear(st, prev) {
    const row = document.createElement("div");
    row.className = "cells" + (st.kind === "stack" ? " stack-cells" : st.kind === "queue" ? " queue-cells" : "");
    const values = st.values || [];
    const prevVals = (prev && prev.values) || [];
    values.forEach((v, i) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.textContent = fmt(v);
      if (prevVals[i] !== undefined && String(prevVals[i]) !== String(v)) cell.classList.add("flash");
      if (prevVals.length && i >= prevVals.length) cell.classList.add("flash");
      row.appendChild(cell);
    });
    return row;
  }

  function boxPointer(st, prev, key) {
    const svgNS = "http://www.w3.org/2000/svg";
    const nodes = st.nodes || [];
    const edges = st.edges || [];
    const wrap = document.createElement("div");
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "bp-canvas");
    svg.innerHTML = `<defs><marker id="arrow-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#6fae9a"></path></marker></defs>`;

    const hint = st.layout_hint || (st.kind === "tree" ? "tree" : "graph");
    const laid = layoutGraph(nodes, edges, hint, key);
    let maxX = 200;
    let maxY = 120;
    const prevAddrs = new Set(((prev && prev.nodes) || []).map((n) => n.addr));
    const prevFields = {};
    ((prev && prev.nodes) || []).forEach((n) => {
      prevFields[n.addr] = n.fields || {};
    });

    laid.forEach((n) => {
      const g = document.createElementNS(svgNS, "g");
      const rect = document.createElementNS(svgNS, "rect");
      const w = 92;
      const h = 36 + Object.keys(n.fields || {}).length * 14;
      rect.setAttribute("x", n.x);
      rect.setAttribute("y", n.y);
      rect.setAttribute("width", w);
      rect.setAttribute("height", h);
      rect.setAttribute("class", n.addr === "invalid" ? "bp-invalid" : "bp-node");
      if (!prevAddrs.has(n.addr) && prevAddrs.size) rect.classList.add("flash");
      g.appendChild(rect);
      const title = document.createElementNS(svgNS, "text");
      title.setAttribute("class", "bp-label");
      title.setAttribute("x", n.x + 6);
      title.setAttribute("y", n.y + 14);
      title.textContent = n.addr === "invalid" ? "⚠ inválido" : n.addr.slice(-6);
      g.appendChild(title);
      let yy = n.y + 28;
      Object.entries(n.fields || {}).forEach(([k, v]) => {
        const t = document.createElementNS(svgNS, "text");
        t.setAttribute("class", "bp-label");
        t.setAttribute("x", n.x + 6);
        t.setAttribute("y", yy);
        t.textContent = `${k}: ${fmt(v)}`;
        if (prevFields[n.addr] && String(prevFields[n.addr][k]) !== String(v)) {
          t.setAttribute("fill", "#e6b84a");
        }
        g.appendChild(t);
        yy += 14;
      });
      svg.appendChild(g);
      n._cx = n.x + w / 2;
      n._cy = n.y + 12;
      n._w = w;
      n._h = h;
      maxX = Math.max(maxX, n.x + w + 24);
      maxY = Math.max(maxY, n.y + h + 24);
    });

    const byAddr = Object.fromEntries(laid.map((n) => [n.addr, n]));
    edges.forEach((e) => {
      const a = byAddr[e.from];
      if (!a) return;
      const path = document.createElementNS(svgNS, "path");
      let x2;
      let y2;
      if (e.to === "invalid") {
        x2 = a.x + 140;
        y2 = a.y + 8;
        if (!byAddr.invalid) {
          const inv = document.createElementNS(svgNS, "text");
          inv.setAttribute("class", "bp-label");
          inv.setAttribute("x", x2);
          inv.setAttribute("y", y2);
          inv.setAttribute("fill", "#c96b5a");
          inv.textContent = "⚠ inválido";
          svg.appendChild(inv);
        }
      } else if (!e.to) {
        x2 = a.x + a._w + 28;
        y2 = a.y + 18;
        const nl = document.createElementNS(svgNS, "text");
        nl.setAttribute("class", "bp-label");
        nl.setAttribute("x", x2);
        nl.setAttribute("y", y2);
        nl.textContent = "null";
        svg.appendChild(nl);
      } else {
        const b = byAddr[e.to];
        if (!b) return;
        x2 = b.x;
        y2 = b._cy;
      }
      path.setAttribute("d", `M ${a.x + a._w} ${a._cy} C ${a.x + a._w + 24} ${a._cy}, ${x2 - 24} ${y2}, ${x2} ${y2}`);
      path.setAttribute("class", e.to === "invalid" ? "bp-edge invalid" : "bp-edge");
      svg.appendChild(path);
    });
    svg.setAttribute("width", maxX);
    svg.setAttribute("height", maxY);
    wrap.appendChild(svg);
    return wrap;
  }

  function layoutGraph(nodes, edges, hint, key) {
    const copy = nodes.map((n) => ({ ...n }));
    if (!copy.length) return copy;
    if (hint === "tree" || hint === "list") {
      const children = {};
      const indeg = {};
      copy.forEach((n) => {
        children[n.addr] = [];
        indeg[n.addr] = 0;
      });
      edges.forEach((e) => {
        if (e.to && e.to !== "invalid" && children[e.from]) {
          children[e.from].push(e.to);
          indeg[e.to] = (indeg[e.to] || 0) + 1;
        }
      });
      const roots = copy.filter((n) => !indeg[n.addr]).map((n) => n.addr);
      const start = roots[0] || copy[0].addr;
      const levels = {};
      const q = [[start, 0]];
      const seen = new Set();
      while (q.length) {
        const [u, d] = q.shift();
        if (seen.has(u)) continue;
        seen.add(u);
        levels[u] = d;
        (children[u] || []).forEach((v) => q.push([v, d + 1]));
      }
      const buckets = {};
      copy.forEach((n) => {
        const d = levels[n.addr] || 0;
        buckets[d] = buckets[d] || [];
        buckets[d].push(n);
      });
      Object.keys(buckets).forEach((d) => {
        buckets[d].forEach((n, i) => {
          const fresh = { x: 16 + i * 120, y: 8 + Number(d) * 88 };
          const old = pos.get(key + n.addr);
          n.x = old ? old.x : fresh.x;
          n.y = old ? old.y : fresh.y;
          if (!old) {
            n.x = fresh.x;
            n.y = fresh.y;
          }
          pos.set(key + n.addr, { x: fresh.x, y: fresh.y });
          n.x = fresh.x;
          n.y = fresh.y;
        });
      });
      return copy;
    }
    if (window.dagre) {
      const g = new dagre.graphlib.Graph({ multigraph: true });
      g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 48 });
      g.setDefaultEdgeLabel(() => ({}));
      copy.forEach((n) => g.setNode(n.addr, { width: 92, height: 48 }));
      edges.forEach((e, i) => {
        if (e.to && e.to !== "invalid") g.setEdge(e.from, e.to, {}, `e${i}`);
      });
      dagre.layout(g);
      copy.forEach((n) => {
        const gn = g.node(n.addr);
        if (gn) {
          n.x = gn.x - 46;
          n.y = gn.y - 24;
          pos.set(key + n.addr, { x: n.x, y: n.y });
        }
      });
    }
    return copy;
  }

  function renderRecursion(steps, cursor) {
    const el = host();
    const nodes = [];
    const edges = [];
    const stack = [];
    const byId = {};
    steps.slice(0, cursor + 1).forEach((s) => {
      if (s.event === "call" || (s.call_stack && s.call_stack.length && !byId[s.frame_id])) {
        const node = {
          addr: String(s.frame_id),
          fields: { fn: s.func, ...(s.args || {}) },
        };
        if (s.return_value !== undefined && s.return_value !== null) node.fields.ret = s.return_value;
        nodes.push(node);
        byId[s.frame_id] = node;
        const parent = (s.call_stack || []).filter((f) => f.frame_id !== s.frame_id).slice(-1)[0];
        if (parent) edges.push({ from: String(parent.frame_id), field: "call", to: String(s.frame_id) });
        stack.push(s.frame_id);
      } else if (byId[s.frame_id] && s.event === "return") {
        byId[s.frame_id].fields.ret = s.return_value ?? byId[s.frame_id].fields.ret;
      } else if (byId[s.frame_id] && s.args) {
        Object.assign(byId[s.frame_id].fields, s.args);
      }
    });
    const unique = [];
    const seen = new Set();
    nodes.forEach((n) => {
      if (seen.has(n.addr)) return;
      seen.add(n.addr);
      unique.push(n);
    });
    el.innerHTML = "";
    const fake = { kind: "tree", layout_hint: "tree", nodes: unique, edges };
    const box = document.createElement("div");
    box.className = "struct";
    const h = document.createElement("h2");
    h.textContent = "árvore de chamadas";
    box.appendChild(h);
    box.appendChild(boxPointer(fake, null, "rec"));
    el.appendChild(box);
  }

  return { render, onWatch, toggleHidden, renderRecursion };
})();
