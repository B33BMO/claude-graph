// Shapes we care about from Claude Code transcripts (~/.claude/projects/<enc>/*.jsonl).
// Transcripts contain many record types; we only model what's useful for the graph.

export interface RawRecord {
  type?: string; // user | assistant | system | attachment | ...
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  agentId?: string;
  message?: RawMessage;
}

export interface RawMessage {
  role?: string;
  content?: string | ContentBlock[];
}

export interface ContentBlock {
  type?: string; // text | thinking | tool_use | tool_result | image
  text?: string;
  thinking?: string; // reasoning text (thinking block)
  name?: string; // tool name (tool_use)
  input?: Record<string, unknown>; // tool input (tool_use)
}

// ---- Graph model ----

export type NodeType = "project" | "session" | "file" | "task";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  weight: number; // drives size in the viz
  meta: Record<string, unknown>;
}

export type EdgeType =
  | "contains" // project -> session
  | "touched" // session -> file
  | "co-edited" // file <-> file (same session)
  | "worked-on" // session -> task
  | "imports"; // file -> file (code structure, from overlay)

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  weight: number;
}

export interface Graph {
  generatedAt: string;
  scope: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
}

// Intermediate, per-transcript summary produced by the parser.
export interface SessionSummary {
  sessionId: string;
  filePath: string; // transcript path on disk
  isSidechain: boolean;
  cwd?: string;
  project?: string; // human label for cwd
  gitBranch?: string;
  version?: string;
  title: string; // first human prompt, truncated
  firstTs?: string;
  lastTs?: string;
  userTurns: number;
  assistantTurns: number;
  toolCounts: Record<string, number>;
  // file_path -> { reads, writes, edits }
  files: Map<string, FileOps>;
  tasks: string[]; // TaskCreate subjects
  prompts: string[]; // all human prompts (topics discussed), cleaned & capped
  decisions: string[]; // heuristic decision/rationale lines from text & thinking
}

export interface FileOps {
  reads: number;
  writes: number;
  edits: number;
}
