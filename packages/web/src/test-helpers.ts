// テスト用の CommandClient。コマンド名ごとの応答を持ち、呼ばれた記録を残す

import {
  askCandidates,
  askMenuKey,
  buildAsk,
  parseAskMenuKey,
  planReadiness,
  progressOf,
  type AskMenu,
  type AskSubject,
} from "@deguboard/core";
import type { CommandClient, CommandResult, StatusView } from "@deguboard/core";
import type {
  EpicRow,
  Iteration,
  IterationDetail,
  PlanRow,
  Project,
  Ticket,
  TicketRow,
  WorkflowView,
} from "./types.js";

export interface Fixture {
  projects: Project[];
  tickets: TicketRow[];
  epics: EpicRow[];
  iterations: Iteration[];
  plans: PlanRow[];
  workflow: WorkflowView;
  status: StatusView;
}

/**
 * ticket.list の 1 行。deps_done を省けば、依存先がないときだけ真にする。依存先を持つ行で依存先が終わった場合を試すときは deps_done を明示する。
 * run_agent を省けば Run のないチケット（null）
 */
export function ticket(partial: Partial<TicketRow> & { id: string }): TicketRow {
  return {
    deps_done: (partial.depends_on ?? []).length === 0,
    run_agent: null,
    project: "default",
    title: `題 ${partial.id}`,
    status: "todo",
    priority: "medium",
    labels: [],
    depends_on: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

export function iteration(partial: Partial<Iteration> & { id: string; name: string }): Iteration {
  return { project: "default", goal: "", status: "planned", ...partial };
}

/** iteration.show の応答。進捗は core と同じく中のチケットから求める */
export function iterationDetail(it: Iteration, items: Ticket[] = []): IterationDetail {
  return { ...it, progress: progressOf(items), items, next: null };
}

/** boardFixture が置く active の Iteration */
const BOARD_ITERATION = iteration({ id: "s0", name: "既定", status: "active" });

/** plan.list の 1 行。progress・waiting・ready・next は空のまま（fixture の plan.list は withPlanFacts でチケットから求めて載せる） */
export function plan(partial: Partial<PlanRow> & { id: string; tickets: string[] }): PlanRow {
  return {
    project: "default",
    after: {},
    pending_approval: false,
    details: {},
    status: partial.pending_approval ? "pending" : "approved",
    progress: {
      total: 0,
      done: 0,
      by_status: { todo: 0, in_progress: 0, review: 0, done: 0, abandoned: 0 },
    },
    waiting: {},
    ready: [],
    next: null,
    ...partial,
  };
}

/** fixture の plan.list だけが使う。core の plan.list と同じく、進捗と着手できるか（PL-6）をチケットから求めて Plan の行に載せる */
function withPlanFacts(row: PlanRow, tickets: readonly Ticket[]): PlanRow {
  const byId = new Map<string, Ticket>(tickets.map((t) => [t.id, t]));
  const found = row.tickets.flatMap((id) => byId.get(id) ?? []);
  return { ...row, progress: progressOf(found), ...planReadiness(row, (id) => byId.get(id)) };
}

/**
 * カンバンのテスト用の fixture。カンバンは開いた Iteration のチケットだけを出すので、active の Iteration（BOARD_ITERATION）を置き、
 * Iteration を持たないチケット（既定の t1〜t3 を含む）をそこに入れる。後から足すチケットは iteration を明示する
 */
export function boardFixture(partial: Partial<Fixture> = {}): Fixture {
  const result = fixture({ iterations: [BOARD_ITERATION], ...partial });
  return {
    ...result,
    tickets: result.tickets.map((t) => (t.iteration ? t : { ...t, iteration: BOARD_ITERATION.id })),
  };
}

export function fixture(partial: Partial<Fixture> = {}): Fixture {
  return {
    projects: [
      {
        id: "default",
        name: "Default",
        description: "",
        workflow: "software-development",
        status: "active",
      },
    ],
    tickets: [
      ticket({ id: "t1", title: "ログイン", status: "done" }),
      ticket({ id: "t2", title: "API", status: "in_progress", priority: "high", epic: "e1" }),
      ticket({ id: "t3", title: "画面", labels: ["web"], created_by: "eiki/agent" }),
    ],
    epics: [
      {
        id: "e1",
        project: "default",
        title: "最初の版",
        status: "open",
        labels: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        progress: {
          total: 1,
          done: 0,
          by_status: { todo: 0, in_progress: 1, review: 0, done: 0, abandoned: 0 },
        },
      },
    ],
    iterations: [],
    plans: [],
    workflow: {
      definition: {
        id: "software-development",
        name: "SD",
        transitions: [],
        reconcile: [],
        fields: [],
      },
      labels: {
        todo: "Todo",
        in_progress: "In Progress",
        review: "Code Review",
        done: "Done",
        abandoned: "Abandoned",
      },
      transitions: [],
    },
    status: {
      ahead: 0,
      behind: 0,
      dirty: false,
      remote: "origin",
      issues: 0,
      data_dir: "/x",
      web_url: null,
    },
    ...partial,
  };
}

export interface MockClient extends CommandClient {
  calls: { name: string; input: unknown }[];
  /** コマンド名ごとの応答を差し替える */
  handlers: Record<string, (input: unknown) => unknown>;
  data: Fixture;
}

/** mockClient の ticket.show・ticket.update が返す本文 */
const TICKET_BODY = "## 概要\n\n本文\n\n## 受け入れ条件\n\n- [ ] a\n";

function askSubjectOf(data: Fixture, id: string): AskSubject {
  const it = data.iterations.find((i) => i.id === id);
  if (it) return { kind: "iteration", id, title: it.name, status: it.status, complete: false };
  const ep = data.epics.find((e) => e.id === id);
  if (ep) return { kind: "epic", id, title: ep.title, status: ep.status };
  const p = data.plans.find((x) => x.id === id);
  if (p)
    return {
      kind: "plan",
      id,
      status: p.closed_at ? "closed" : p.pending_approval ? "pending_approval" : "approved",
      tickets: p.tickets,
      complete: false,
    };
  const t = data.tickets.find((x) => x.id === id);
  if (!t) throw new Error(`テストの fixture にない対象: ${id}`);
  return {
    kind: "ticket",
    id,
    title: t.title,
    status: t.status,
    iteration: t.iteration ?? null,
    iteration_status: data.iterations.find((i) => i.id === t.iteration)?.status ?? null,
    epic: t.epic ?? null,
    deps_done: t.deps_done,
    running: false,
  };
}

export function mockClient(data = fixture()): MockClient {
  const calls: MockClient["calls"] = [];
  const handlers: MockClient["handlers"] = {
    "project.list": () => data.projects,
    "config.show": () => ({
      default_project: "default",
      priority: {
        high: "利用者に見える不具合・ほかのチケットを止めている",
        medium: "機能の追加と改善・テストの抜け",
        low: "使われていないコードと依存・急がない調査",
      },
    }),
    whoami: () => ({
      id: "eiki",
      user: "eiki",
      user_source: "user.name",
      kind: "human",
      own_ids: ["eiki", "eiki/agent"],
    }),
    "ticket.list": () => data.tickets,
    // core の epic.list と同じく、進みは Epic のチケットから求める（fixture の progress は使わない）
    "epic.list": () =>
      data.epics.map((e) => ({
        ...e,
        progress: progressOf(data.tickets.filter((t) => t.epic === e.id)),
      })),
    "iteration.list": () => data.iterations,
    "plan.list": () => data.plans.map((p) => withPlanFacts(p, data.tickets)),
    "workflow.show": () => data.workflow,
    history: () => ({ events: [], shallow: false, incomplete: [] }),
    "run.list": () => [],
    // core の ask と同じく、対象を fixture から引いて buildAsk で依頼文を作る（チケットと Iteration だけ。実行中の Run はない）
    ask: (input) => {
      const { targets = [], ...rest } = input as { targets?: string[] } & Record<string, unknown>;
      return buildAsk({ subjects: targets.map((id) => askSubjectOf(data, id)), ...rest });
    },
    // core の ask-menu と同じく、組（core の askMenuKey の形にそろえた鍵）ごとに候補を返す。fixture にない対象は error。
    // 返す key は core と同じくそろえた形なので、画面が別の形の鍵で引くと候補が見つからない
    "ask-menu": (input) =>
      ((input as { sets?: string[] }).sets ?? []).map((set): AskMenu => {
        const { refs, within } = parseAskMenuKey(set);
        const key = askMenuKey(refs, within);
        try {
          const candidates = askCandidates(
            refs.map((id) => askSubjectOf(data, id)),
            within,
          );
          return { key, candidates, error: null };
        } catch (e) {
          return { key, candidates: [], error: e instanceof Error ? e.message : String(e) };
        }
      }),
    "ticket.show": (input) => {
      const t = data.tickets.find((x) => x.id === (input as { ticket: string }).ticket)!;
      return {
        ...t,
        body: TICKET_BODY,
        dependents: [],
        deps_done: true,
        pending_deps: [],
      };
    },
    // core の ticket.update と同じく、属性を直して（null は外す）チケットの属性と本文を返す。
    // 本物と違い data.tickets の中のオブジェクトをその場で書き換え、ticket.list は同じ配列を返すので、
    // 保存の後に読み直しても store.tickets は変わらず、一覧の読み直しによる ticket.show も走らない。
    // それを確かめるテストでは ticket.list を毎回別の配列で返すよう差し替える
    "ticket.update": (input) => {
      const {
        ticket: id,
        fields,
        ...patch
      } = input as { ticket: string; fields?: Record<string, unknown> } & Record<string, unknown>;
      const t = data.tickets.find((x) => x.id === id)! as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries({ ...patch, ...fields })) {
        // body と acceptance は本文（の節）を置き換える入力で、属性ではない
        if (key === "body" || key === "acceptance") continue;
        if (value === null) delete t[key];
        else t[key] = value;
      }
      return { ...t, body: (patch["body"] as string | undefined) ?? TICKET_BODY };
    },
    "ticket.move": (input) => {
      const { ticket: id, status } = input as { ticket: string; status: Ticket["status"] };
      const t = data.tickets.find((x) => x.id === id)!;
      t.status = status;
      return t;
    },
  };
  return {
    calls,
    handlers,
    data,
    async run<O>(name: string, input: unknown = {}): Promise<CommandResult<O>> {
      calls.push({ name, input });
      const h = handlers[name];
      if (!h) throw new Error(`テストの応答がない: ${name}`);
      return { data: (await h(input)) as O, warnings: [] };
    },
    async status() {
      return data.status;
    },
  };
}
