// テスト用の CommandClient。コマンド名ごとの応答を持ち、呼ばれた記録を残す

import { planReadiness, progressOf } from "@deguboard/core";
import type { CommandClient, CommandResult, StatusView } from "@deguboard/core";
import type {
  EpicRow,
  Iteration,
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

export function mockClient(data = fixture()): MockClient {
  const calls: MockClient["calls"] = [];
  const handlers: MockClient["handlers"] = {
    "project.list": () => data.projects,
    "config.show": () => ({ default_project: "default" }),
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
    // core の ticket.update と同じく、属性を直して（null は外す）チケットの属性と本文を返す
    "ticket.update": (input) => {
      const {
        ticket: id,
        fields,
        ...patch
      } = input as { ticket: string; fields?: Record<string, unknown> } & Record<string, unknown>;
      const t = data.tickets.find((x) => x.id === id)! as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries({ ...patch, ...fields })) {
        if (key === "body") continue;
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
