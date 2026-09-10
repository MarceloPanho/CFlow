const Flowchart = (() => {
  const host = () => document.getElementById("flowchart");
  const visits = new Map();
  let lastToken = null;
  let positions = new Map();

  function resetVisits() {
    visits.clear();
  }

  function nodeForLine(cfg, line) {
    if (!cfg) return null;
    const hits = cfg.nodes.filter((n) => n.lines && n.lines.includes(line));
    if (!hits.length) {
      return cfg.nodes.find((n) => n.lines && n.lines.length && n.lines[0] <= line && n.lines[n.lines.length - 1] >= line) || null;
    }
    hits.sort((a, b) => a.lines.length - b.lines.length);
    return hits[0];
  }

  function layout(cfg) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 48, edgesep: 16, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));
    cfg.nodes.forEach((n) => {
      const w = n.kind === "decision" ? 170 : 190;
      const h = n.kind === "decision" ? 70 : 46;
      g.setNode(n.id, { width: w, height: h, ...n });
    });
    cfg.edges.forEach((e, i) => {
      g.setEdge(e.from, e.to, { label: e.label || "", width: 40, height: 14 }, `e${i}`);
    });
    dagre.layout(g);
    return g;
  }

  function diamond(x, y, w, h) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    return `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
  }

  function edgePath(g, e) {
    const pts = e.points || [];
    if (pts.length < 2) return "";
    const d = [`M ${pts[0].x} ${pts[0].y}`];
    for (let i = 1; i < pts.length; i += 1) d.push(`L ${pts[i].x} ${pts[i].y}`);
    return d.join(" ");
  }

  function render(cfg) {
    const el = host();
    el.innerHTML = "";
    if (!cfg || !cfg.nodes || !cfg.nodes.length) {
      el.textContent = "Nenhum fluxograma para esta função.";
      return;
    }
    const g = layout(cfg);
    const graph = g.graph();
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", Math.max(graph.width + 40, el.clientWidth || 400));
    svg.setAttribute("height", graph.height + 40);
    svg.innerHTML = `
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#6e97ab"></path>
        </marker>
      </defs>
    `;
    const root = document.createElementNS(svgNS, "g");
    root.setAttribute("transform", "translate(8,8)");
    svg.appendChild(root);

    g.edges().forEach((ek) => {
      const e = g.edge(ek);
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", edgePath(g, e));
      path.setAttribute("class", "edge-path");
      path.dataset.from = ek.v;
      path.dataset.to = ek.w;
      path.dataset.label = e.label || "";
      root.appendChild(path);
      if (e.label) {
        const mid = e.points[Math.floor(e.points.length / 2)];
        const t = document.createElementNS(svgNS, "text");
        t.setAttribute("class", "edge-label");
        t.setAttribute("x", mid.x + 6);
        t.setAttribute("y", mid.y - 4);
        t.textContent = e.label;
        root.appendChild(t);
      }
    });

    g.nodes().forEach((id) => {
      const n = g.node(id);
      const group = document.createElementNS(svgNS, "g");
      group.setAttribute("class", "cfg-node");
      group.dataset.id = id;
      group.dataset.kind = n.kind;
      const cls = n.kind === "decision" ? "node-decision" : n.kind === "call" ? "node-call" : n.kind === "return" ? "node-return" : "node-box";
      if (n.kind === "decision") {
        const poly = document.createElementNS(svgNS, "polygon");
        poly.setAttribute("points", diamond(n.x - n.width / 2, n.y - n.height / 2, n.width, n.height));
        poly.setAttribute("class", cls);
        group.appendChild(poly);
      } else {
        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", n.x - n.width / 2);
        rect.setAttribute("y", n.y - n.height / 2);
        rect.setAttribute("width", n.width);
        rect.setAttribute("height", n.height);
        rect.setAttribute("rx", n.kind === "return" ? 16 : 3);
        rect.setAttribute("class", cls);
        group.appendChild(rect);
      }
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("class", "node-label");
      text.setAttribute("x", n.x);
      text.setAttribute("y", n.y);
      text.textContent = n.label;
      group.appendChild(text);
      root.appendChild(group);
      positions.set(id, { x: n.x, y: n.y });
    });

    const token = document.createElementNS(svgNS, "circle");
    token.setAttribute("r", 6);
    token.setAttribute("class", "token");
    token.setAttribute("visibility", "hidden");
    root.appendChild(token);
    lastToken = token;
    el.appendChild(svg);
  }

  function highlight(nodeId, prevId) {
    host().querySelectorAll(".cfg-node").forEach((g) => {
      g.classList.toggle("node-current", g.dataset.id === nodeId);
      if (g.dataset.id === nodeId) {
        const c = (visits.get(nodeId) || 0) + 1;
        visits.set(nodeId, c);
        g.classList.add("node-visited");
      }
    });
    if (prevId && nodeId && prevId !== nodeId) {
      host().querySelectorAll(".edge-path").forEach((p) => {
        if (p.dataset.from === prevId && p.dataset.to === nodeId) {
          p.classList.add("taken");
          animateToken(p);
        }
      });
    }
  }

  function animateToken(path) {
    if (!lastToken || !path.getTotalLength) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const len = path.getTotalLength();
    lastToken.setAttribute("visibility", "visible");
    const start = performance.now();
    const dur = 280;
    path.classList.add("pulse");
    function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      const pt = path.getPointAtLength(t * len);
      lastToken.setAttribute("cx", pt.x);
      lastToken.setAttribute("cy", pt.y);
      if (t < 1) requestAnimationFrame(tick);
      else {
        lastToken.setAttribute("visibility", "hidden");
        path.classList.remove("pulse");
      }
    }
    requestAnimationFrame(tick);
  }

  return { render, highlight, nodeForLine, resetVisits };
})();
