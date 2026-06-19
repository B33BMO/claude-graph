import type { Graph, GraphNode } from "./types.js";

function fmtDate(ts: unknown): string {
  if (typeof ts !== "string") return "?";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "?" : d.toISOString().slice(0, 10);
}

function degree(graph: Graph): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of graph.edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + e.weight);
    deg.set(e.target, (deg.get(e.target) ?? 0) + e.weight);
  }
  return deg;
}

export function buildReport(graph: Graph): string {
  const deg = degree(graph);
  const nodes = graph.nodes;
  const files = nodes.filter((n) => n.type === "file");
  const sessions = nodes.filter((n) => n.type === "session");
  const projects = nodes.filter((n) => n.type === "project");

  const topBy = (list: GraphNode[], n: number) =>
    [...list].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, n);

  const lines: string[] = [];
  lines.push(`# Claude Graph Report`);
  lines.push("");
  lines.push(`_Generated ${graph.generatedAt} · scope: ${graph.scope}_`);
  lines.push("");
  lines.push(
    `**${graph.stats.sessions}** sessions · **${graph.stats.files}** files · ` +
      `**${graph.stats.projects}** projects · **${graph.stats.tasks}** tasks · ` +
      `**${graph.stats.edges}** connections`,
  );
  lines.push("");

  // God nodes: the files that show up across the most work.
  lines.push(`## 🌟 Most-worked files`);
  lines.push("");
  lines.push(`The files that recur across the most sessions and edits — your hubs.`);
  lines.push("");
  lines.push(`| File | Sessions | Edits | Writes | Reads |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: |`);
  for (const f of [...files]
    .sort(
      (a, b) =>
        (Number(b.meta.sessions) || 0) - (Number(a.meta.sessions) || 0) ||
        b.weight - a.weight,
    )
    .slice(0, 15)) {
    lines.push(
      `| \`${f.label}\` | ${f.meta.sessions ?? 0} | ${f.meta.edits ?? 0} | ${
        f.meta.writes ?? 0
      } | ${f.meta.reads ?? 0} |`,
    );
  }
  lines.push("");

  // Busiest sessions.
  lines.push(`## 🔥 Busiest sessions`);
  lines.push("");
  lines.push(`| Session | Project | When | Files | Tasks |`);
  lines.push(`| --- | --- | --- | ---: | ---: |`);
  for (const s of topBy(sessions, 15)) {
    lines.push(
      `| ${s.label} | ${s.meta.project ?? "?"} | ${fmtDate(s.meta.lastTs)} | ${
        s.meta.fileCount ?? 0
      } | ${s.meta.taskCount ?? 0} |`,
    );
  }
  lines.push("");

  // Per-project breakdown.
  lines.push(`## 📂 Projects`);
  lines.push("");
  lines.push(`| Project | Sessions |`);
  lines.push(`| --- | ---: |`);
  const sessionsPerProject = new Map<string, number>();
  for (const s of sessions) {
    const p = String(s.meta.project ?? "(unknown)");
    sessionsPerProject.set(p, (sessionsPerProject.get(p) ?? 0) + 1);
  }
  for (const p of [...projects].sort(
    (a, b) => (sessionsPerProject.get(b.label) ?? 0) - (sessionsPerProject.get(a.label) ?? 0),
  )) {
    lines.push(`| ${p.label} | ${sessionsPerProject.get(p.label) ?? 0} |`);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(`Open \`graph.html\` for the interactive view.`);
  lines.push("");
  return lines.join("\n");
}
