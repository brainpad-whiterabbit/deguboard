// 画面の状態。選んだ Project のチケット・Epic・Iteration・Workflow と同期の状態を CommandClient から読み、書き込みのあとに読み直す。
// 状態管理のライブラリは入れず、React の context だけで持つ

import type { CommandClient, CommandFailure, StatusView } from "@deguboard/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { failureOf } from "./client/http.js";
import type { EpicRow, Iteration, Project, Status, Ticket, WorkflowView } from "./types.js";

export interface Notice {
  kind: "error" | "info";
  text: string;
  detail?: string | undefined;
}

export type RunResult<O> =
  | { ok: true; data: O; warnings: string[] }
  | { ok: false; error: CommandFailure };

export interface Store {
  client: CommandClient;
  projects: Project[];
  project: Project | null;
  tickets: Ticket[];
  epics: EpicRow[];
  iterations: Iteration[];
  workflow: WorkflowView | null;
  status: StatusView | null;
  loading: boolean;
  notice: Notice | null;
  selectProject(id: string): void;
  /** すべて読み直す */
  reload(): Promise<void>;
  /** コマンドを実行し、成功したら読み直す。失敗は通知に出して ok: false で返す（画面側で戻す） */
  run<O = unknown>(name: string, input?: unknown): Promise<RunResult<O>>;
  notify(notice: Notice | null): void;
  /** Status の表示名（Workflow の labels） */
  labelOf(status: Status): string;
}

const StoreContext = createContext<Store | null>(null);

const STATUS_POLL_MS = 15_000;

export function StoreProvider({
  client,
  children,
}: {
  client: CommandClient;
  children: ReactNode;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [epics, setEpics] = useState<EpicRow[]>([]);
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowView | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const projectRef = useRef<string | null>(null);
  projectRef.current = projectId;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await client.status());
    } catch {
      // 同期の状態が取れなくても画面は動かす
    }
  }, [client]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [projectList, config] = await Promise.all([
        client.run<Project[]>("project.list"),
        client.run<{ default_project: string }>("config.show"),
      ]);
      setProjects(projectList.data);
      const current =
        projectList.data.find((p) => p.id === projectRef.current) ??
        projectList.data.find((p) => p.id === config.data.default_project) ??
        projectList.data[0] ??
        null;
      if (!current) {
        setProjectId(null);
        setTickets([]);
        setEpics([]);
        setIterations([]);
        setWorkflow(null);
        return;
      }
      setProjectId(current.id);
      const project = current.id;
      const [t, e, i, w] = await Promise.all([
        client.run<Ticket[]>("ticket.list", { project, include_abandoned: true }),
        client.run<EpicRow[]>("epic.list", { project }),
        client.run<Iteration[]>("iteration.list", { project }),
        client.run<WorkflowView>("workflow.show", { workflow: current.workflow }),
      ]);
      setTickets(t.data);
      setEpics(e.data);
      setIterations(i.data);
      setWorkflow(w.data);
      void refreshStatus();
    } catch (error) {
      const f = failureOf(error);
      setNotice({ kind: "error", text: f.message, detail: f.detail });
    } finally {
      setLoading(false);
    }
  }, [client, refreshStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const run = useCallback(
    async <O,>(name: string, input: unknown = {}): Promise<RunResult<O>> => {
      try {
        const result = await client.run<O>(name, input);
        if (result.warnings.length) setNotice({ kind: "info", text: result.warnings.join(" / ") });
        await reload();
        return { ok: true, data: result.data, warnings: result.warnings };
      } catch (error) {
        const f = failureOf(error);
        setNotice({ kind: "error", text: f.message, detail: f.detail });
        return { ok: false, error: f };
      }
    },
    [client, reload],
  );

  const selectProject = useCallback(
    (id: string) => {
      projectRef.current = id;
      setProjectId(id);
      void reload();
    },
    [reload],
  );

  const value = useMemo<Store>(
    () => ({
      client,
      projects,
      project: projects.find((p) => p.id === projectId) ?? null,
      tickets,
      epics,
      iterations,
      workflow,
      status,
      loading,
      notice,
      selectProject,
      reload,
      run,
      notify: setNotice,
      labelOf: (s) => workflow?.labels[s] ?? s,
    }),
    [
      client,
      projects,
      projectId,
      tickets,
      epics,
      iterations,
      workflow,
      status,
      loading,
      notice,
      selectProject,
      reload,
      run,
    ],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("StoreProvider の中で使う");
  return store;
}
