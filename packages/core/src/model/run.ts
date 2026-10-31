// Run（runs/、Phase 3）。Phase 1 では型だけ置く（requirements.md 5.9、ADR-005）

export type RunResult = "success" | "failure" | "interrupted";

export interface RunUsage {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  estimated?: boolean;
}

export interface Run {
  id: string;
  ticket: string;
  step: string;
  agent: string;
  model: string | null;
  started_at: string;
  finished_at: string | null;
  result: RunResult | null;
  error: string | null;
  retries: number;
  usage: RunUsage;
}
