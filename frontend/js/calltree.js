const CallTree = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const NODE_H = 48;
  const GAP_X = 14;
  const GAP_Y = 46;
  const CHAR = 7.2;

  function s(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    if (parent) parent.appendChild(node);
    return node;
  }

  // fib(5) com um argumento simples; bubbleSort(arr, n = 5) quando há vários ou ponteiros.
  function label(func, args) {
    const entries = Object.entries(args || {});
    const simple = (v) => typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && !/^0x/.test(v));
    if (entries.length === 1 && simple(entries[0][1])) return `${func}(${entries[0][1]})`;
    return `${func}(${entries.map(([k, v]) => (simple(v) ? `${k} = ${v}` : k)).join(", ")})`;
  }

  // Chamadas até o cursor, derivadas dos eventos call/return do trace (sem fonte nova).
  function build(steps, cursor) {
    const calls = new Map();
    const order = [];
    for (let i = 0; i <= cursor; i += 1) {
      const st = steps[i];
      if (!calls.has(st.frame_id) && st.func !== "main") {
        const stack = st.call_stack || [];
        const parent = stack.length > 1 ? stack[stack.length - 2] : null;
        const args = (stack.length ? stack[stack.length - 1].args : st.args) || {};
        const call = { id: st.frame_id, func: st.func, args, label: label(st.func, args), kids: [], value: undefined };
        call.parent = parent && calls.has(parent.frame_id) ? parent.frame_id : null;
        if (call.parent !== null) calls.get(call.parent).kids.push(call);
        calls.set(st.frame_id, call);
        order.push(call);
      }
      // O valor de retorno chega no passo do chamador; quem retornou é o quadro do passo anterior.
      if (st.event === "return" && i > 0 && st.return_value !== undefined && st.return_value !== null) {
        const done = calls.get(steps[i - 1].frame_id);
        if (done) done.value = st.return_value;
      }
    }
    const now = steps[cursor];
    const active = new Set((now.call_stack || []).map((f) => f.frame_id));
    const seen = new Map();
    order.forEach((c) => {
      c.status = c.id === now.frame_id ? "current" : active.has(c.id) ? "waiting" : "returned";
      const n = (seen.get(c.label) || 0) + 1;
      seen.set(c.label, n);
      c.nth = n;
    });
    order.forEach((c) => {
      c.repeated = seen.get(c.label) > 1;
    });
    return order;
  }

  // Folhas em sequência, pai centrado sobre os filhos.
  function layout(order, width) {
    let slot = 0;
    let depthMax = 0;
    const place = (c, depth) => {
      depthMax = Math.max(depthMax, depth);
      c.kids.forEach((k) => place(k, depth + 1));
      c.y = depth * (NODE_H + GAP_Y);
      c.x = c.kids.length ? (c.kids[0].x + c.kids[c.kids.length - 1].x) / 2 : slot++ * (width + GAP_X);
    };
    order.filter((c) => c.parent === null).forEach((root) => place(root, 0));
    return depthMax + 1;
  }

  function render(host, steps, cursor) {
    host.innerHTML = "";
    const order = build(steps, cursor);
    const wrap = document.createElement("div");
    wrap.className = "calltree";
    if (!order.length) {
      wrap.textContent = "Nenhuma chamada ainda: a árvore cresce conforme as funções são chamadas.";
      host.appendChild(wrap);
      return;
    }
    const width = Math.max(96, ...order.map((c) => c.label.length * CHAR + 20));
    const levels = layout(order, width);
    const maxX = Math.max(...order.map((c) => c.x)) + width;
    // Encolhe para caber no painel, mas não abaixo de 70%: daí em diante o painel rola.
    const w = maxX + 16;
    const hgt = levels * (NODE_H + GAP_Y) - GAP_Y + 30;
    const fit = Math.min((host.clientWidth - 330) / w, (host.clientHeight - 8) / hgt);
    const k = Math.max(0.7, Math.min(1, fit || 1));
    const svg = s("svg", { class: "ct-canvas", viewBox: `0 0 ${w} ${hgt}`, width: w * k, height: hgt * k });
    const g = s("g", { transform: "translate(8,14)" }, svg);
    order.forEach((c) => {
      if (c.parent === null) return;
      const p = order.find((o) => o.id === c.parent);
      const x1 = p.x + width / 2;
      const y1 = p.y + NODE_H;
      const x2 = c.x + width / 2;
      s("path", { d: `M ${x1} ${y1} C ${x1} ${y1 + 24}, ${x2} ${c.y - 24}, ${x2} ${c.y}`, class: `ct-edge ${c.status}` }, g);
    });
    order.forEach((c) => {
      const node = s("g", { class: `ct-node ${c.status}${c.repeated ? " repeated" : ""}`, transform: `translate(${c.x},${c.y})` }, g);
      s("rect", { width, height: NODE_H, rx: 6 }, node);
      s("text", { x: width / 2, y: 18, class: "ct-label" }, node).textContent = c.label;
      const sub = c.status === "current" ? "executando" : c.status === "waiting" ? "aguardando" : c.value !== undefined ? `= ${c.value}` : "retornou";
      s("text", { x: width / 2, y: 35, class: `ct-sub${c.value !== undefined && c.status === "returned" ? " value" : ""}` }, node).textContent = sub;
      if (c.nth > 1) {
        const tag = `${c.nth}ª vez`;
        const badge = s("g", { class: "ct-badge", transform: `translate(${width - 10},-8)` }, node);
        s("rect", { x: -tag.length * 3.3 - 6, y: -8, width: tag.length * 6.6 + 12, height: 16, rx: 8 }, badge);
        s("text", { x: 0, y: 0 }, badge).textContent = tag;
      }
      s("title", {}, node).textContent = `${c.label}${c.value !== undefined ? ` = ${c.value}` : ""}`;
    });
    wrap.appendChild(svg);
    wrap.appendChild(summary(order, levels));
    host.appendChild(wrap);
  }

  function summary(order, levels) {
    const rep = order.filter((c) => c.nth > 1).length;
    const box = document.createElement("aside");
    box.className = "ct-summary";
    box.innerHTML = `
      <div class="ct-stats">
        <div><strong>${order.length}</strong><span>chamadas</span></div>
        <div><strong>${levels}</strong><span>níveis</span></div>
        <div><strong class="rep">${rep}</strong><span>repetidas</span></div>
      </div>
      <p>${rep ? `${rep} das ${order.length} chamadas repetem argumentos de uma chamada anterior: recalculam um valor que já foi resolvido.` : "Nenhuma chamada repetiu argumentos até aqui."}</p>
      <ul class="ct-legend">
        <li><i class="current"></i>executando agora</li>
        <li><i class="waiting"></i>na pilha, aguardando retorno</li>
        <li><i class="returned"></i>retornou (= valor)</li>
        <li><i class="repeated"></i>argumento repetido</li>
      </ul>`;
    return box;
  }

  return { render, label };
})();
