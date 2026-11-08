// 画面がどこに載っているか（surface）と、画面の外への働きかけを 1 つの文脈で持つ（UI-12）。
// 載る場所は VS Code の左パネル（sidebar）とエディタのパネル（panel）だけ（ADR-023）。詳細へのリンクは拡張ホストに頼み（パネルは自分の中で遷移し、題が変わる）、
// パネルは詳細だけを出すので、パネルから一覧の画面へのリンクは拡張ホストに頼んでサイドバーに出す（show）。
// クリップボードへのコピーは拡張ホストに頼む（vscode.env.clipboard）。
// 開発用の dg serve（Webview の外）には拡張ホストがないので、リンクはハッシュ遷移、コピーは navigator.clipboard にする（createHost）。
// エージェントに頼む入力欄（UI-15）を開いているかと対象は、HostProvider の中の AskContext が見た目の状態として持つ。
// 拡張ホストからの通知（再読み込み・遷移・入力欄を開く）は HostBridge が store・ハッシュ・入力欄に結ぶ

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
import type { TerminalChoice, TerminalSendResult } from "@deguboard/core";
import { askKey, parseAskKey } from "./ask-key.js";
import type { WebviewClient } from "./client/webview.js";
import { hrefOf, navigate, toggleRoute, type Route } from "./router.js";
import { useStore } from "./store.js";
import type { AskAction } from "./types.js";
import { createUiState, localStorageBackend, type UiState } from "./ui-state.js";
import { tr } from "./l10n.js";

export type Surface = "sidebar" | "panel";

export interface Host {
  surface: Surface;
  /** 詳細（チケット・Iteration）を開く。拡張ホストに頼んでエディタ領域に開く（dg serve ではハッシュ遷移） */
  open(route: Route): void;
  /** 一覧の画面（カンバンなど）を出す。パネルでは拡張ホストに頼んでサイドバーに、サイドバー（と dg serve）ではハッシュ遷移 */
  show(route: Route): void;
  /** text をクリップボードに入れる。拡張ホストに頼む（dg serve では navigator.clipboard に書く）。書けなければ reject */
  copy(text: string): Promise<void>;
  /** 見た目の状態（開閉・最後に選んだもの）の置き場 */
  state: UiState;
  /** 開いているターミナルへ依頼文を送る口（UI-15）。Webview だけにあり、dg serve にはない（コピーだけになる） */
  terminals?: TerminalsHost | undefined;
}

export interface TerminalsHost {
  /** 今開いているターミナル */
  list(): Promise<TerminalChoice[]>;
  /** text を terminal の入力に入れる。Enter は押さない。ターミナルが閉じていたら reject */
  send(terminal: number, text: string): Promise<TerminalSendResult | null>;
  /** 開いた・閉じたで一覧が変わるたびに呼ぶ。戻り値で購読を外す */
  onChange(listener: (terminals: TerminalChoice[]) => void): () => void;
}

/** 拡張ホストのないとき（開発用の dg serve）の働きかけ。リンクはハッシュ遷移、コピーは navigator.clipboard */
const standalone: Omit<Host, "surface"> = {
  open: (route) => navigate(route),
  show: (route) => navigate(route),
  copy: (text) => writeClipboard(text),
  state: createUiState(localStorageBackend()),
};

const HostContext = createContext<Host>({ ...standalone, surface: "sidebar" });

/** <html data-surface> と拡張ホストとの接続から Host を作る。接続がなければ（dg serve）拡張ホストに頼まない */
export function createHost(surface: Surface, client: WebviewClient | null, state?: UiState): Host {
  if (client) {
    return {
      surface,
      open: (route) => void client.open(hrefOf(route)),
      show: (route) => (surface === "panel" ? void client.show(hrefOf(route)) : navigate(route)),
      // Webview の navigator.clipboard は VS Code の版や設定で使えないことがあるので、試さずに拡張ホストに頼む
      copy: (text) => client.copy(text),
      state: state ?? standalone.state,
      terminals: {
        list: () => client.terminals(),
        send: (terminal, text) => client.sendToTerminal(terminal, text),
        onChange: (listener) =>
          client.onEvent((event) => {
            if (event.name === "terminals") listener(event.terminals);
          }),
      },
    };
  }
  return { ...standalone, surface };
}

/** navigator.clipboard に書く。ない（安全でない文脈など）か拒まれたら reject */
async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error(tr("navigator.clipboard が使えない"));
  await navigator.clipboard.writeText(text);
}

/**
 * 載っている場所を読む。Webview では拡張ホストが付けた data 属性、開発用の dg serve では `?surface=sidebar`・`?surface=panel` を読み、
 * どちらもなければサイドバー（dg serve の画面を左パネルとパネルの配置で確かめるため。リンクはハッシュ遷移）
 */
export function readSurface(dataset: DOMStringMap, search = ""): Surface {
  const value = dataset.surface ?? new URLSearchParams(search).get("surface");
  return value === "panel" ? "panel" : "sidebar";
}

export function HostProvider({ host, children }: { host: Host; children: ReactNode }) {
  return (
    <HostContext.Provider value={host}>
      <AskProvider>{children}</AskProvider>
    </HostContext.Provider>
  );
}

/**
 * エージェントに頼む入力欄を開く頼み。targets は対象の ID（空なら対象なし）、action は選んで開く頼むこと（省けばおすすめ）、
 * within は対象のチケットが入っている Iteration・Epic（詳細の中の行から開いたとき。外すの候補が出る）。見た目の状態の ask.open に残す
 */
export interface AskRequest {
  targets: string[];
  action?: AskAction | undefined;
  within?: string | undefined;
}

/** 見た目の状態の鍵。拡張ホストが HTML の data-ask で渡した対象は、main.tsx が描く前にここへ書く */
export const ASK_OPEN_KEY = "ask.open";

export interface Ask {
  /** 開いている入力欄の対象。閉じていれば null */
  request: AskRequest | null;
  /** 入力欄を開く。開いていれば対象を入れ替える（頼むことは action か、なければおすすめ。指示の下書きは残す） */
  open(targets: readonly string[], action?: AskAction, within?: string): void;
  close(): void;
  /** 開いた回数。開き直したら入力欄の中の状態（外した対象・選んだ頼むこと）を捨てるための key に使う。0 なら見た目の状態からの復元で、頼むことを選んで開いたときのコピーはしない（判別にも使う） */
  serial: number;
  /** 画面の今の対象（カンバンで選んでいる Iteration、履歴で開いている行）。なければ空。タイトル行の吹き出しが使う */
  current(): string[];
  /** 画面が今の対象を知らせる（useAskCurrent が使う）。戻り値で取り下げる（その画面が出していた値のときだけ空にする） */
  setCurrent(targets: readonly string[]): () => void;
}

const AskContext = createContext<Ask>({
  request: null,
  open() {},
  close() {},
  serial: 0,
  current: () => [],
  setCurrent: () => () => {},
});

function AskProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useUiState<AskRequest | null>(ASK_OPEN_KEY, null);
  const [serial, setSerial] = useState(0);
  const open = useCallback(
    (targets: readonly string[], action?: AskAction, within?: string) => {
      setRequest({
        targets: [...targets],
        ...(action ? { action } : {}),
        ...(within ? { within } : {}),
      });
      setSerial((n) => n + 1);
    },
    [setRequest],
  );
  const close = useCallback(() => setRequest(null), [setRequest]);
  // 今の対象は描画に使わないので state にしない（変わるたびに描き直さない）
  const currentRef = useRef<readonly string[]>([]);
  const current = useCallback(() => [...currentRef.current], []);
  const setCurrent = useCallback((targets: readonly string[]) => {
    const mine = [...targets];
    currentRef.current = mine;
    return () => {
      if (currentRef.current === mine) currentRef.current = [];
    };
  }, []);
  // 形の違うもの（前の版や壊れた値）は閉じたものとみなす
  const valid =
    request && Array.isArray(request.targets) && request.targets.every((t) => typeof t === "string")
      ? request
      : null;
  const value = useMemo(
    () => ({ request: valid, open, close, serial, current, setCurrent }),
    [valid, open, close, serial, current, setCurrent],
  );
  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}

/** エージェントに頼む入力欄の開閉（UI-15） */
export function useAsk(): Ask {
  return useContext(AskContext);
}

/**
 * 画面の今の対象を知らせる（UI-15）。タイトル行の吹き出しは、これを対象にして入力欄を開く。
 * 画面を離れる（外す）と取り下げ、対象なしに戻る
 */
export function useAskCurrent(targets: readonly string[]): void {
  const { setCurrent } = useAsk();
  const key = askKey(targets);
  useEffect(() => setCurrent(parseAskKey(key).targets), [key, setCurrent]);
}

export function useHost(): Host {
  return useContext(HostContext);
}

/** 見た目の状態を 1 つ持つ。useState と同じ形で、書くたびに host.state に残す */
export function useUiState<T>(key: string, initial: T): [T, (value: T) => void] {
  const host = useHost();
  const [value, setValue] = useState<T>(() => host.state.get<T>(key) ?? initial);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      host.state.set(key, next);
    },
    [host, key],
  );
  return [value, set];
}

/**
 * 拡張ホストからの通知を受ける。navigate はハッシュを書き換え、toggle はその画面と来る前の画面を切り替え（歯車の設定画面）、
 * reload は store を読み直す（同期は拡張ホストが済ませてから送ってくる）、ask はエージェントに頼む入力欄を開く
 * （current つきはタイトル行の吹き出しで、画面の今の対象を対象にする）。
 * StoreProvider と HostProvider の中に置く
 */
export function HostBridge({ client }: { client: WebviewClient }) {
  const store = useStore();
  const { open: openAsk, current } = useAsk();
  const reloadRef = useRef(store.reload);
  // 最新の reload を通知の受け手から呼ぶ。描画中に ref を書かない（react/refs）ので、描いた後に写す
  useEffect(() => {
    reloadRef.current = store.reload;
  });
  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.name === "navigate") window.location.hash = event.hash;
        else if (event.name === "toggle") toggleRoute(event.hash);
        else if (event.name === "reload") void reloadRef.current();
        else if (event.name === "ask") openAsk(event.current ? current() : event.targets);
      }),
    [client, openAsk, current],
  );
  return null;
}
