import type { Graph } from "./types.js";

// Self-contained interactive graph: a single .html with the data inlined and a
// dependency-free canvas force simulation. No CDN, no server — just open it.

const TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__TITLE__</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden;
    font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0e1116; color: #e6edf3; }
  #app { position: fixed; inset: 0; }
  canvas { display: block; cursor: grab; }
  canvas.dragging { cursor: grabbing; }
  .panel { position: fixed; background: rgba(22,27,34,.92); border: 1px solid #30363d;
    border-radius: 10px; padding: 12px 14px; backdrop-filter: blur(6px); }
  #controls { top: 12px; left: 12px; width: 250px; }
  #controls h1 { margin: 0 0 2px; font-size: 15px; }
  #controls .sub { color: #8b949e; font-size: 11px; margin-bottom: 10px; }
  #search { width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid #30363d;
    background: #0d1117; color: #e6edf3; margin-bottom: 10px; }
  .legend label { display: flex; align-items: center; gap: 7px; padding: 2px 0; cursor: pointer; }
  .dot { width: 11px; height: 11px; border-radius: 50%; flex: none; }
  .count { color: #8b949e; margin-left: auto; font-variant-numeric: tabular-nums; }
  #details { top: 12px; right: 12px; width: 290px; max-height: 70vh; overflow: auto;
    display: none; }
  #details h2 { font-size: 13px; margin: 0 0 6px; word-break: break-word; }
  #details .kind { display: inline-block; font-size: 10px; text-transform: uppercase;
    letter-spacing: .04em; padding: 1px 6px; border-radius: 999px; margin-bottom: 8px; }
  #details dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
  #details dt { color: #8b949e; } #details dd { margin: 0; word-break: break-word; }
  #hint { position: fixed; bottom: 10px; left: 12px; color: #6e7681; font-size: 11px; }
  #tip { position: fixed; pointer-events: none; background: #161b22; border: 1px solid #30363d;
    border-radius: 6px; padding: 4px 8px; font-size: 12px; display: none; max-width: 320px;
    z-index: 5; }
</style>
</head>
<body>
<div id="app"><canvas id="c"></canvas></div>
<div id="controls" class="panel">
  <h1>Claude Graph</h1>
  <div class="sub" id="meta"></div>
  <input id="search" placeholder="Search nodes…" autocomplete="off" />
  <div class="legend" id="legend"></div>
</div>
<div id="details" class="panel"></div>
<div id="tip"></div>
<div id="hint">drag to pan · scroll to zoom · drag a node to pin · click for details</div>
<script id="data" type="application/json">__GRAPH_DATA__</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var COLORS = { project: "#f0883e", session: "#58a6ff", file: "#3fb950", task: "#bc8cff" };

  document.getElementById("meta").textContent =
    DATA.stats.sessions + " sessions · " + DATA.stats.files + " files · " +
    DATA.stats.projects + " projects · " + DATA.stats.tasks + " tasks";

  // ---- Build node/edge runtime objects ----
  var nodeById = {};
  var nodes = DATA.nodes.map(function (n, i) {
    var angle = i * 2.399963; // golden-angle seed scatter (deterministic)
    var r = 30 + Math.sqrt(i) * 22;
    var o = {
      id: n.id, type: n.type, label: n.label, meta: n.meta,
      r: 4 + Math.sqrt(n.weight || 1) * 1.7,
      x: Math.cos(angle) * r, y: Math.sin(angle) * r,
      vx: 0, vy: 0, pinned: false, visible: true
    };
    nodeById[n.id] = o;
    return o;
  });
  var links = DATA.edges
    .map(function (e) {
      return { s: nodeById[e.source], t: nodeById[e.target], type: e.type, w: e.weight };
    })
    .filter(function (l) { return l.s && l.t; });

  // adjacency for highlight-on-hover
  var adj = {};
  nodes.forEach(function (n) { adj[n.id] = {}; });
  links.forEach(function (l) { adj[l.s.id][l.t.id] = 1; adj[l.t.id][l.s.id] = 1; });

  // ---- Legend / type filters ----
  var typeOn = { project: true, session: true, file: true, task: true };
  var counts = { project: 0, session: 0, file: 0, task: 0 };
  nodes.forEach(function (n) { counts[n.type] = (counts[n.type] || 0) + 1; });
  var legend = document.getElementById("legend");
  Object.keys(COLORS).forEach(function (t) {
    var lbl = document.createElement("label");
    var cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = true;
    cb.onchange = function () { typeOn[t] = cb.checked; applyFilter(); };
    var dot = document.createElement("span");
    dot.className = "dot"; dot.style.background = COLORS[t];
    var name = document.createElement("span"); name.textContent = t;
    var cnt = document.createElement("span"); cnt.className = "count"; cnt.textContent = counts[t];
    lbl.appendChild(cb); lbl.appendChild(dot); lbl.appendChild(name); lbl.appendChild(cnt);
    legend.appendChild(lbl);
  });

  var query = "";
  document.getElementById("search").addEventListener("input", function (e) {
    query = e.target.value.toLowerCase().trim(); applyFilter();
  });
  function matches(n) { return query && n.label.toLowerCase().indexOf(query) !== -1; }
  function applyFilter() {
    nodes.forEach(function (n) { n.visible = typeOn[n.type]; });
    alpha = Math.max(alpha, 0.3);
  }

  // ---- Canvas + camera ----
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var W = 0, H = 0;
  var cam = { x: 0, y: 0, k: 1 };
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
  }
  window.addEventListener("resize", resize); resize();
  cam.x = W / 2; cam.y = H / 2;

  // ---- Force simulation (Barnes-Hut-free, fine for a few thousand nodes) ----
  var alpha = 1;
  function tick() {
    var vis = nodes.filter(function (n) { return n.visible; });
    // repulsion (O(n^2) but capped by alpha decay; fine for typical graphs)
    for (var i = 0; i < vis.length; i++) {
      var a = vis[i];
      for (var j = i + 1; j < vis.length; j++) {
        var b = vis[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 90000) continue; // ignore far pairs
        var f = 900 / d2;
        var d = Math.sqrt(d2);
        var fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    // spring links
    for (var k = 0; k < links.length; k++) {
      var l = links[k];
      if (!l.s.visible || !l.t.visible) continue;
      var dx2 = l.t.x - l.s.x, dy2 = l.t.y - l.s.y;
      var dist = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 0.01;
      var target = l.type === "co-edited" ? 70 : 110;
      var f2 = (dist - target) * 0.02;
      var ux = (dx2 / dist) * f2, uy = (dy2 / dist) * f2;
      l.s.vx += ux; l.s.vy += uy; l.t.vx -= ux; l.t.vy -= uy;
    }
    // gravity to center + integrate
    for (var m = 0; m < vis.length; m++) {
      var n = vis[m];
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.vx -= n.x * 0.002; n.vy -= n.y * 0.002;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx * alpha; n.y += n.vy * alpha;
    }
    alpha += (0 - alpha) * 0.01; // slow cool
    if (alpha < 0.02) alpha = 0.02;
  }

  // ---- Render ----
  var hover = null, selected = null;
  function toScreen(n) { return { x: n.x * cam.k + cam.x, y: n.y * cam.k + cam.y }; }
  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var focus = hover || selected;
    // edges
    ctx.lineWidth = 1;
    for (var k = 0; k < links.length; k++) {
      var l = links[k];
      if (!l.s.visible || !l.t.visible) continue;
      var s = toScreen(l.s), t = toScreen(l.t);
      var lit = focus && (l.s.id === focus.id || l.t.id === focus.id);
      ctx.strokeStyle = lit ? "rgba(88,166,255,.55)" : "rgba(139,148,158,.12)";
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
    }
    // nodes
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.visible) continue;
      var p = toScreen(n);
      var rad = Math.max(2, n.r * cam.k);
      var dim = focus && focus.id !== n.id && !adj[focus.id][n.id];
      var hit = matches(n);
      ctx.globalAlpha = dim ? 0.18 : 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.2832);
      ctx.fillStyle = COLORS[n.type] || "#999"; ctx.fill();
      if (hit) { ctx.lineWidth = 2; ctx.strokeStyle = "#ffd33d"; ctx.stroke(); }
      else if (n === focus) { ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(); }
      // labels for big or focused nodes
      if (!dim && (rad > 7 || n === focus || hit)) {
        ctx.globalAlpha = dim ? 0.2 : 0.9;
        ctx.fillStyle = "#c9d1d9"; ctx.font = "11px system-ui";
        var lab = n.label.length > 38 ? n.label.slice(0, 37) + "…" : n.label;
        ctx.fillText(lab, p.x + rad + 3, p.y + 3);
      }
    }
    ctx.globalAlpha = 1;
  }
  function frame() { tick(); draw(); requestAnimationFrame(frame); }
  frame();

  // ---- Picking ----
  function pick(mx, my) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.visible) continue;
      var p = toScreen(n);
      var rad = Math.max(3, n.r * cam.k) + 4;
      var dx = mx - p.x, dy = my - p.y, d = dx * dx + dy * dy;
      if (d < rad * rad && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  // ---- Interaction ----
  var tip = document.getElementById("tip");
  var details = document.getElementById("details");
  var dragNode = null, panning = false, last = null, moved = false;

  canvas.addEventListener("mousemove", function (e) {
    var mx = e.clientX, my = e.clientY;
    if (dragNode) {
      moved = true;
      dragNode.x = (mx - cam.x) / cam.k; dragNode.y = (my - cam.y) / cam.k;
      dragNode.pinned = true; alpha = Math.max(alpha, 0.4); return;
    }
    if (panning) {
      moved = true; cam.x += mx - last.x; cam.y += my - last.y; last = { x: mx, y: my }; return;
    }
    hover = pick(mx, my);
    if (hover) {
      canvas.style.cursor = "pointer";
      tip.style.display = "block";
      tip.style.left = (mx + 12) + "px"; tip.style.top = (my + 12) + "px";
      tip.textContent = hover.type + " · " + hover.label;
    } else { canvas.style.cursor = ""; tip.style.display = "none"; }
  });
  canvas.addEventListener("mousedown", function (e) {
    moved = false; last = { x: e.clientX, y: e.clientY };
    var hit = pick(e.clientX, e.clientY);
    if (hit) { dragNode = hit; canvas.classList.add("dragging"); }
    else { panning = true; canvas.classList.add("dragging"); }
  });
  window.addEventListener("mouseup", function () {
    if (dragNode && !moved) showDetails(dragNode);
    else if (panning && !moved) hideDetails();
    dragNode = null; panning = false; canvas.classList.remove("dragging");
  });
  canvas.addEventListener("dblclick", function (e) {
    var hit = pick(e.clientX, e.clientY);
    if (hit) { hit.pinned = false; alpha = Math.max(alpha, 0.4); }
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var mx = e.clientX, my = e.clientY;
    var factor = Math.pow(1.0015, -e.deltaY);
    var nk = Math.max(0.15, Math.min(5, cam.k * factor));
    // zoom around cursor
    cam.x = mx - (mx - cam.x) * (nk / cam.k);
    cam.y = my - (my - cam.y) * (nk / cam.k);
    cam.k = nk;
  }, { passive: false });

  function row(dt, dd) { return "<dt>" + dt + "</dt><dd>" + esc(dd) + "</dd>"; }
  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }
  function showDetails(n) {
    selected = n;
    var m = n.meta || {};
    var html = '<span class="kind" style="background:' + (COLORS[n.type] || "#444") +
      '33;color:' + (COLORS[n.type] || "#aaa") + '">' + n.type + "</span>";
    html += "<h2>" + esc(n.label) + "</h2><dl>";
    if (n.type === "session") {
      html += row("project", m.project);
      if (m.gitBranch) html += row("branch", m.gitBranch);
      html += row("when", (m.firstTs || "?").slice(0, 16).replace("T", " "));
      html += row("turns", (m.userTurns || 0) + " you / " + (m.assistantTurns || 0) + " claude");
      html += row("files", m.fileCount || 0);
      html += row("tasks", m.taskCount || 0);
    } else if (n.type === "file") {
      html += row("reads", m.reads || 0);
      html += row("writes", m.writes || 0);
      html += row("edits", m.edits || 0);
      html += row("sessions", m.sessions || 0);
    } else if (n.type === "project") {
      html += row("path", m.cwd || n.label);
    }
    html += "</dl>";
    details.innerHTML = html; details.style.display = "block";
  }
  function hideDetails() { selected = null; details.style.display = "none"; }
})();
</script>
</body>
</html>`;

export function buildHtml(graph: Graph, title: string): string {
  const json = JSON.stringify(graph).replace(/<\/script/gi, "<\\/script");
  return TEMPLATE.replace("__GRAPH_DATA__", json).replace(/__TITLE__/g, title);
}
