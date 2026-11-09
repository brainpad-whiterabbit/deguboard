// deguboard worktree の中の配置（requirements.md 5.1）。すべて worktree からの相対パス

export const CONFIG_FILE = "config.yaml";
/** 個人の設定。deguboard-local/（Git 管理外）からの相対パス。上書きできる項目は model/config.ts の scope */
export const LOCAL_CONFIG_FILE = "config.yaml";
/** 個人の設定を指摘（Issue）で指すときの名前。worktree の外なので相対パスにはならない */
export const LOCAL_CONFIG_LABEL = "deguboard-local/config.yaml";
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
/** Run の完了時の集計 */
export const runPath = (id: string): string => `${DIRS.runs}/${id}.json`;
/** Run の会話記録のパス。deguboard-local/（Git 管理外）からの相対パス。Run を閉じた後も run refresh の期間は残す（run/record.ts） */
export const TRANSCRIPTS_DIR = "transcripts";
export const transcriptPath = (id: string): string => `${TRANSCRIPTS_DIR}/${id}.json`;
/** ストアの読みの結果のキャッシュ（ADR-033）。deguboard-local/（Git 管理外）からの相対パス。消してもよい */
export const STORE_CACHE_DIR = "store-cache";
