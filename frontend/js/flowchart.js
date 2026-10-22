const Flowchart = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const CHAR = 7.2; // IBM Plex Mono 12px: avanço fixo de 0,6em
  const LINE_H = 16;
  const MAX_CHARS = 34;
  const MAX_LINES = { block: 3 };
  const MARGIN = 0.15; // a câmera só anda quando o nó entra nessa faixa da borda
  const TOKEN_MS = 280;
  const CAMERA_MS = 300;
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const els = {};
  let view = { x: 0, y: 0, k: 1 };
  let graph = null; // { cfg, g, nodes: Map(id -> {el, badge, kind}), edges: [path el] }
  let follow = true;
  let tokenAnim = 0;
  let cameraAnim = 0;

  // ---- estado de execução derivado do trace (sem C++: só o grafo e as linhas) ----

  const adjCache = new WeakMap();
  function adjacency(cfg) {
    let a = adjCache.get(cfg);
    if (a) return a;
    const out = new Map(cfg.nodes.map((n) => [n.id, []]));
    cfg.edges.forEach((e, i) => out.get(e.from) && out.get(e.from).push(i));
    const byLine = new Map();
    cfg.nodes.forEach((n) => {
      if (n.kind === "start") return;
      (n.lines || []).forEach((l) => {
        if (!byLine.has(l)) byLine.set(l, []);
        byLine.get(l).push(n.id);
      });
    });
    const start = (cfg.nodes.find((n) => n.kind === "start") || {}).id;
    a = { out, byLine, start };
    adjCache.set(cfg, a);
    return a;
  }

  // Várias caixas dividem uma linha (init, condição e incremento do for): escolhe a
  // mais próxima do nó anterior pelo grafo, e devolve as arestas atravessadas.
  function resolve(cfg, a, from, line) {
    const cands = a.byLine.get(line);
    if (!cands) return null;
    if (cands.includes(from)) return { node: from, path: [] };
    const via = new Map([[from, -1]]);
    const queue = [from];
    while (queue.length) {
      const u = queue.shift();
      for (const ei of a.out.get(u) || []) {
        const v = cfg.edges[ei].to;
        if (via.has(v)) continue;
        via.set(v, ei);
        if (cands.includes(v)) {
          const path = [];
          for (let w = v; via.get(w) !== -1; w = cfg.edges[via.get(w)].from) path.unshift(via.get(w));
          return { node: v, path };
        }
        queue.push(v);
      }
    }
    return { node: cands[0], path: [] };
  }

  function bump(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  function flowState(cfg, steps, cursor) {
    const st = { current: null, visits: new Map(), edgeVisits: new Map(), lastPath: [] };
    if (!cfg || !steps[cursor]) return st;
    const a = adjacency(cfg);
    const func = steps[cursor].func;
    const at = new Map(); // frame_id -> nó em que aquele quadro está
    for (let i = 0; i <= cursor; i += 1) {
      const s = steps[i];
      if (s.func !== func) continue;
      let from = at.get(s.frame_id);
      if (from === undefined) {
        from = a.start;
        bump(st.visits, a.start);
      }
      const r = resolve(cfg, a, from, s.line);
      const node = r ? r.node : from;
      const path = r ? r.path : [];
      path.forEach((ei) => {
        bump(st.edgeVisits, ei);
        bump(st.visits, cfg.edges[ei].to);
      });
      at.set(s.frame_id, node);
      if (i === cursor) {
        st.current = node === a.start ? null : node;
        st.lastPath = path;
      }
    }
    return st;
  }

  // ---- desenho ----

  function wrap(label, kind) {
    const lines = [];
    String(label || "").split("\n").forEach((stmt) => {
      let rest = stmt;
      while (rest.length > MAX_CHARS) {
        let cut = rest.lastIndexOf(" ", MAX_CHARS);
        if (cut < MAX_CHARS / 2) cut = MAX_CHARS;
        lines.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
      }
      lines.push(rest);
    });
    const max = MAX_LINES[kind] || 2;
    if (lines.length <= max) return lines;
    const kept = lines.slice(0, max);
    kept[max - 1] = kept[max - 1].slice(0, MAX_CHARS - 1) + "…";
    return kept;
  }

  function size(kind, lines) {
    const tw = Math.max(...lines.map((l) => l.length)) * CHAR;
    const th = lines.length * LINE_H;
    if (kind === "decision") return { w: Math.max(150, tw * 1.5 + 48), h: th * 2 + 20 };
    const h = th + 16;
    const pad = kind === "start" || kind === "return" ? h / 2 + 8 : kind === "call" ? 24 : 18;
    return { w: Math.max(140, tw + pad * 2), h };
  }

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    if (parent) parent.appendChild(node);
    return node;
  }

  function layout(cfg) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 24, edgesep: 18, marginx: 16, marginy: 16 });
    cfg.nodes.forEach((n) => {
      const lines = wrap(n.label, n.kind);
      const s = size(n.kind, lines);
      g.setNode(n.id, { width: s.w, height: s.h, lines, kind: n.kind, label: n.label, srcLines: n.lines || [] });
    });
    // Rótulos fora do dagre: como nós fictícios eles dobrariam o número de fileiras.
    cfg.edges.forEach((e, i) => g.setEdge(e.from, e.to, {}, `e${i}`));
    dagre.layout(g);
    return g;
  }

  // O dagre termina as arestas na caixa envolvente; no losango, corta na borda real.
  function clipToShape(n, p) {
    if (n.kind !== "decision") return p;
    const dx = p.x - n.x;
    const dy = p.y - n.y;
    const t = 1 / (Math.abs(dx) / (n.width / 2) + Math.abs(dy) / (n.height / 2) || 1);
    return t < 1 ? { x: n.x + dx * t, y: n.y + dy * t } : p;
  }

  function curve(points) {
    const p = points;
    let d = `M ${p[0].x} ${p[0].y}`;
    for (let i = 1; i < p.length - 1; i += 1) {
      d += ` Q ${p[i].x} ${p[i].y} ${(p[i].x + p[i + 1].x) / 2} ${(p[i].y + p[i + 1].y) / 2}`;
    }
    const last = p[p.length - 1];
    return `${d} L ${last.x} ${last.y}`;
  }

  function lineRange(lines) {
    if (!lines.length) return "";
    const a = lines[0];
    const b = lines[lines.length - 1];
    return a === b ? `linha ${a}` : `linhas ${a}–${b}`;
  }

  function drawNode(parent, id, n) {
    const x = n.x - n.width / 2;
    const y = n.y - n.height / 2;
    const group = el("g", { class: `cfg-node kind-${n.kind}`, "data-id": id, "data-kind": n.kind }, parent);
    el("title", {}, group).textContent = `${n.label}\n${lineRange(n.srcLines)}`;
    const shape = (cls) => {
      if (n.kind === "decision") {
        const pts = `${n.x},${y} ${x + n.width},${n.y} ${n.x},${y + n.height} ${x},${n.y}`;
        return el("polygon", { points: pts, class: cls }, group);
      }
      const rx = n.kind === "start" || n.kind === "return" ? n.height / 2 : n.kind === "call" ? 2 : 4;
      return el("rect", { x, y, width: n.width, height: n.height, rx, class: cls }, group);
    };
    shape("halo");
    shape("shape");
    if (n.kind === "call") {
      [x + 5, x + n.width - 5].forEach((bx) => el("line", { x1: bx, x2: bx, y1: y, y2: y + n.height, class: "bar" }, group));
    }
    const text = el("text", { class: "node-label", x: n.x, y: n.y }, group);
    n.lines.forEach((line, i) => {
      const t = el("tspan", { x: n.x, y: n.y + (i - (n.lines.length - 1) / 2) * LINE_H }, text);
      t.textContent = line;
    });
    let badge = null;
    if (n.kind !== "start") {
      const bx = n.kind === "decision" ? n.x + n.width * 0.22 : x + n.width - 8;
      const by = n.kind === "decision" ? y + n.height * 0.12 : y;
      badge = el("g", { class: "badge", transform: `translate(${bx},${by})`, visibility: "hidden" }, group);
      el("rect", { x: -4, y: -9, height: 18, rx: 9 }, badge);
      el("text", { x: 6, y: 0 }, badge);
    }
    return { el: group, badge, kind: n.kind };
  }

  function render(cfg) {
    cancelAnimationFrame(tokenAnim);
    els.host.innerHTML = "";
    graph = null;
    if (!cfg || !cfg.nodes || !cfg.nodes.length) {
      els.host.textContent = "Nenhum fluxograma para esta função.";
      return;
    }
    const g = layout(cfg);
    const svg = el("svg", { class: "flow-svg" });
    const defs = el("defs", {}, svg);
    ["idle", "trail", "amber"].forEach((name) => {
      const m = el("marker", {
        id: `arrow-${name}`, viewBox: "0 0 10 10", refX: 9, refY: 5,
        markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", class: `arrow-${name}`,
      }, defs);
      el("path", { d: "M 0 0 L 10 5 L 0 10 z" }, m);
    });
    const vp = el("g", { class: "viewport" }, svg);
    const edgeLayer = el("g", {}, vp);
    const nodeLayer = el("g", {}, vp);
    const labelLayer = el("g", {}, vp);
    const edges = [];
    g.edges().forEach((ek) => {
      const e = g.edge(ek);
      const i = Number(ek.name.slice(1));
      const pts = (e.points || []).slice();
      if (pts.length < 2) return;
      pts[0] = clipToShape(g.node(ek.v), pts[0]);
      pts[pts.length - 1] = clipToShape(g.node(ek.w), pts[pts.length - 1]);
      const back = cfg.edges[i].back ? " back" : "";
      const path = el("path", { d: curve(pts), class: `edge${back}`, "marker-end": "url(#arrow-idle)" }, edgeLayer);
      edges[i] = path;
      const label = cfg.edges[i].label;
      if (label) {
        // Junto da saída da decisão, do lado por onde a aresta sai: nunca sobre a linha.
        const src = g.node(ek.v);
        const a = path.getPointAtLength(Math.min(18, path.getTotalLength() / 2));
        const side = Math.abs(a.x - src.x) < 4 ? 1 : Math.sign(a.x - src.x);
        const kind = label === "true" || label === "false" ? ` ${label}` : "";
        const t = el("text", {
          class: `edge-label${kind}`, x: a.x + side * 8, y: a.y,
          "text-anchor": side < 0 ? "end" : "start",
        }, labelLayer);
        t.textContent = label;
      }
    });
    const nodes = new Map();
    g.nodes().forEach((id) => nodes.set(id, drawNode(nodeLayer, id, g.node(id))));
    const token = el("circle", { r: 6, class: "token", visibility: "hidden" }, vp);
    els.host.appendChild(svg);
    graph = { cfg, g, nodes, edges, vp, token };
    fit(false);
  }

  function update(st, animate) {
    if (!graph) return;
    const last = new Set(st.lastPath);
    graph.nodes.forEach((rec, id) => {
      const count = st.visits.get(id) || 0;
      rec.el.classList.toggle("visited", count > 0);
      rec.el.classList.toggle("current", id === st.current);
      if (!rec.badge) return;
      rec.badge.setAttribute("visibility", count > 0 ? "visible" : "hidden");
      const label = `×${count}`;
      rec.badge.querySelector("text").textContent = label;
      rec.badge.querySelector("rect").setAttribute("width", label.length * 6 + 8);
    });
    graph.edges.forEach((path, i) => {
      if (!path) return;
      const count = st.edgeVisits.get(i) || 0;
      const state = last.has(i) ? "amber" : count ? "trail" : "idle";
      path.classList.toggle("taken", count > 0);
      path.classList.toggle("last", last.has(i));
      path.style.strokeWidth = count ? Math.min(3, 1.6 + (count - 1) * 0.35) : "";
      path.setAttribute("marker-end", `url(#arrow-${state})`);
    });
    if (animate && st.lastPath.length) runToken(st.lastPath.map((i) => graph.edges[i]).filter(Boolean));
    if (follow && st.current) ensureVisible(st.current);
  }

  function runToken(paths) {
    cancelAnimationFrame(tokenAnim);
    const token = graph.token;
    if (reduced() || !paths.length) return;
    const lens = paths.map((p) => p.getTotalLength());
    const total = lens.reduce((s, l) => s + l, 0);
    const t0 = performance.now();
    token.setAttribute("visibility", "visible");
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / TOKEN_MS);
      let d = t * total;
      let i = 0;
      while (i < paths.length - 1 && d > lens[i]) d -= lens[i++];
      const pt = paths[i].getPointAtLength(Math.min(d, lens[i]));
      token.setAttribute("cx", pt.x);
      token.setAttribute("cy", pt.y);
      if (t < 1) tokenAnim = requestAnimationFrame(frame);
      else token.setAttribute("visibility", "hidden");
    };
    tokenAnim = requestAnimationFrame(frame);
  }

  // ---- viewport: zoom, pan, ajustar e câmera que segue ----

  function apply() {
    if (graph) graph.vp.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
    if (els.pct) els.pct.textContent = `${Math.round(view.k * 100)}%`;
  }

  function tweenTo(target, ms) {
    cancelAnimationFrame(cameraAnim);
    if (!ms || reduced()) {
      view = target;
      apply();
      return;
    }
    const from = { ...view };
    const t0 = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - t) ** 3;
      view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      apply();
      if (t < 1) cameraAnim = requestAnimationFrame(frame);
    };
    cameraAnim = requestAnimationFrame(frame);
  }

  function fit(animate = true) {
    if (!graph) return;
    const gg = graph.g.graph();
    const W = els.host.clientWidth || 800;
    const H = els.host.clientHeight || 500;
    const k = Math.max(0.3, Math.min(1, (W - 24) / gg.width, (H - 24) / gg.height));
    tweenTo({ k, x: (W - gg.width * k) / 2, y: Math.max(8, (H - gg.height * k) / 2) }, animate ? CAMERA_MS : 0);
  }

  function ensureVisible(id) {
    const n = graph.g.node(id);
    const W = els.host.clientWidth;
    const H = els.host.clientHeight;
    if (!n || !W || !H) return;
    const { k } = view;
    const left = (n.x - n.width / 2) * k + view.x;
    const right = (n.x + n.width / 2) * k + view.x;
    const top = (n.y - n.height / 2) * k + view.y;
    const bottom = (n.y + n.height / 2) * k + view.y;
    const gg = graph.g.graph();
    const whole = view.x >= 0 && view.y >= 0 && view.x + gg.width * k <= W && view.y + gg.height * k <= H;
    const mx = W * MARGIN;
    const my = H * MARGIN;
    if (whole || (left >= mx && right <= W - mx && top >= my && bottom <= H - my)) return;
    tweenTo({ k, x: W / 2 - n.x * k, y: H / 2 - n.y * k }, CAMERA_MS);
  }

  function zoomAt(factor, cx, cy) {
    const k = Math.max(0.25, Math.min(2.5, view.k * factor));
    const f = k / view.k;
    cancelAnimationFrame(cameraAnim);
    view = { k, x: cx - (cx - view.x) * f, y: cy - (cy - view.y) * f };
    apply();
  }

  function zoomBy(factor) {
    zoomAt(factor, els.host.clientWidth / 2, els.host.clientHeight / 2);
  }

  function setFollow(on) {
    follow = on;
    els.follow.setAttribute("aria-pressed", String(on));
  }

  function mount() {
    els.host = document.getElementById("flowchart");
    els.pct = document.getElementById("zoom-pct");
    els.follow = document.getElementById("follow");
    document.getElementById("zoom-in").addEventListener("click", () => zoomBy(1.2));
    document.getElementById("zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));
    document.getElementById("zoom-fit").addEventListener("click", () => fit());
    els.follow.addEventListener("click", () => setFollow(!follow));
    els.host.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = els.host.getBoundingClientRect();
      zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    els.host.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || !graph) return;
      els.host.setPointerCapture(ev.pointerId);
      els.host.classList.add("panning");
      cancelAnimationFrame(cameraAnim);
      const move = (e) => {
        view = { ...view, x: view.x + e.movementX, y: view.y + e.movementY };
        apply();
      };
      const up = () => {
        els.host.classList.remove("panning");
        els.host.removeEventListener("pointermove", move);
        els.host.removeEventListener("pointerup", up);
      };
      els.host.addEventListener("pointermove", move);
      els.host.addEventListener("pointerup", up);
    });
  }

  return { mount, render, update, flowState, fit, zoomBy, setFollow };
})();
