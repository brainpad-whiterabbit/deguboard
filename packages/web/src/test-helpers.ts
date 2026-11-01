// テスト用の CommandClient。コマンド名ごとの応答を持ち、呼ばれた記録を残す

import type { CommandClient, CommandResult, StatusView } from "@deguboard/core";
import type { EpicRow, Iteration, Project, Ticket, WorkflowView } from "./types.js";

export interface Fixture {
  projects: Project[];
  tickets: Ticket[];
  epics: EpicRow[];
  iterations: Iteration[];
  workflow: WorkflowView;
  status: StatusView;
}

export function ticket(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
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
    status: { ahead: 0, behind: 0, dirty: false, remote: "origin", issues: 0, data_dir: "/x" },
    ...partial,
  };
}

export interface MockClient extends CommandClient {
  calls: { name: string; input: unknown }[];
  /** コマンド名ごとの応答を差し替える */
  handlers: Record<string, (input: unknown) => unknown>;
  data: Fixture;
}

export function mockClient(data = fixture()): MockClient {
  const calls: MockClient["calls"] = [];
  const handlers: MockClient["handlers"] = {
    "project.list": () => data.projects,
    "config.show": () => ({ default_project: "default" }),
    "ticket.list": () => data.tickets,
    "epic.list": () => data.epics,
    "iteration.list": () => data.iterations,
    "workflow.show": () => data.workflow,
    history: () => ({ events: [], shallow: false, incomplete: [] }),
    "ticket.show": (input) => {
      const t = data.tickets.find((x) => x.id === (input as { ticket: string }).ticket)!;
      return {
        ...t,
        body: "## 概要\n\n本文\n\n## 受け入れ条件\n\n- [ ] a\n",
        dependents: [],
        deps_done: true,
      };
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
