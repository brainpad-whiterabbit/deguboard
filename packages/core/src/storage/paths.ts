// deguboard worktree の中の配置（requirements.md 5.1）。すべて worktree からの相対パス

export const CONFIG_FILE = "config.yaml";
export const DIRS = {
  projects: "projects",
  tickets: "tickets",
  deletedTickets: "tickets/deleted",
  epics: "epics",
  iterations: "iterations",
  plans: "plans",
  workflows: "workflows",
  runs: "runs",
} as const;

export const projectPath = (slug: string): string => `${DIRS.projects}/${slug}.yaml`;
export const ticketPath = (id: string): string => `${DIRS.tickets}/${id}.md`;
export const deletedTicketPath = (id: string): string => `${DIRS.deletedTickets}/${id}.md`;
export const epicPath = (id: string): string => `${DIRS.epics}/${id}.md`;
export const iterationPath = (id: string): string => `${DIRS.iterations}/${id}.yaml`;
export const planPath = (id: string): string => `${DIRS.plans}/${id}.yaml`;
export const workflowPath = (id: string): string => `${DIRS.workflows}/${id}.yaml`;
/** 完了時の集計。実行中の記録も deguboard-local/ の下の同じ相対パスに置く */
export const runPath = (id: string): string => `${DIRS.runs}/${id}.json`;
