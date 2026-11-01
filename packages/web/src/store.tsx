// 画面の状態。選んだ Project のチケット・Epic・Iteration・Plan・Workflow と同期の状態を CommandClient から読み、書き込みのあとに読み直す。
// 状態管理のライブラリは入れず、React の context だけで持つ。
// cache を渡すと（VS Code の Webview）、読み終えた一覧を残しておき、次に開いたときはそれをすぐ描いてから読み直して差し替える。
// 最初の読み込みは core の中で 1 本ずつ処理されるコマンドが 8 本並び、サイドバーとパネルが同じ列を使うので、その間を空の画面にしない。
// 実行中の Run（run.list の running だけ。このマシンの deguboard-local/runs/ を読むだけで、終わった Run の集計は読まない）は
// チケットの ID の集まりだけを持ち、cache には残さない（前回の「実行中」を次に開いたときに出さない）

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
import type {
  EpicRow,
  Iteration,
  PlanRow,
  Project,
  RunView,
  Status,
  Ticket,
  WorkflowView,
} from "./types.js";
import type { UiState } from "./ui-state.js";

/** cache に残す一覧。読み直しが終わるたびに書き換える */
interface Snapshot {
  projectId: string | null;
  projects: Project[];
  tickets: Ticket[];
  epics: EpicRow[];
  iterations: Iteration[];
  plans: PlanRow[];
  workflow: WorkflowView | null;
}

/** cache の置き場の鍵。形が変わったら番号を上げて古いものを読まない */
export const SNAPSHOT_KEY = "store.snapshot.v1";

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
  plans: PlanRow[];
  workflow: WorkflowView | null;
  /** 実行中（running）の Run があるチケットの ID。読めなければ空 */
  runningTickets: ReadonlySet<string>;
  status: StatusView | null;
  loading: boolean;
  /** 最初の読み込みが終わったか。終わるまで画面は空状態の文言を出さない */
  loaded: boolean;
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

const NO_RUNNING: ReadonlySet<string> = new Set();

export function StoreProvider({
  client,
  cache,
  children,
}: {
  client: CommandClient;
  /** 前回の一覧の置き場。渡さなければ（ブラウザ）残さない */
  cache?: UiState | undefined;
  children: ReactNode;
}) {
  const [cached] = useState(() => cache?.get<Snapshot>(SNAPSHOT_KEY));
  const [projects, setProjects] = useState<Project[]>(cached?.projects ?? []);
  const [projectId, setProjectId] = useState<string | null>(cached?.projectId ?? null);
  const [tickets, setTickets] = useState<Ticket[]>(cached?.tickets ?? []);
  const [epics, setEpics] = useState<EpicRow[]>(cached?.epics ?? []);
  const [iterations, setIterations] = useState<Iteration[]>(cached?.iterations ?? []);
  const [plans, setPlans] = useState<PlanRow[]>(cached?.plans ?? []);
  const [workflow, setWorkflow] = useState<WorkflowView | null>(cached?.workflow ?? null);
  const [runningTickets, setRunningTickets] = useState<ReadonlySet<string>>(NO_RUNNING);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [loading, setLoading] = useState(true);
  // 前回の一覧があれば、それを読み終えたものとして先に描く
  const [loaded, setLoaded] = useState(!!cached);
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
        setPlans([]);
        setWorkflow(null);
        setRunningTickets(NO_RUNNING);
        return;
      }
      setProjectId(current.id);
      const project = current.id;
      const [t, e, i, p, w, r] = await Promise.all([
        client.run<Ticket[]>("ticket.list", { project, include_abandoned: true }),
        client.run<EpicRow[]>("epic.list", { project }),
        client.run<Iteration[]>("iteration.list", { project }),
        client.run<PlanRow[]>("plan.list", { project }),
        client.run<WorkflowView>("workflow.show", { workflow: current.workflow }),
        // 行の印（UI-2）のためだけに読むので、読めなくても他の一覧は出す
        client
          .run<RunView[]>("run.list", { project, running: true })
          .then((res) => res.data)
          .catch(() => [] as RunView[]),
      ]);
      setTickets(t.data);
      setEpics(e.data);
      setIterations(i.data);
      setPlans(p.data);
      setWorkflow(w.data);
      setRunningTickets(new Set(r.map((run) => run.ticket)));
      cache?.set(SNAPSHOT_KEY, {
        projectId: project,
        projects: projectList.data,
        tickets: t.data,
        epics: e.data,
        iterations: i.data,
        plans: p.data,
        workflow: w.data,
      } satisfies Snapshot);
      void refreshStatus();
    } catch (error) {
      const f = failureOf(error);
      setNotice({ kind: "error", text: f.message, detail: f.detail });
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [client, cache, refreshStatus]);

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
      plans,
      workflow,
      runningTickets,
      status,
      loading,
      loaded,
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
      plans,
      workflow,
      runningTickets,
      status,
      loading,
      loaded,
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
