// 画面の見た目の状態（表や節の開閉・最後に選んだ Iteration）の置き場。データではないので store には入れない。
// Webview では vscode の getState / setState（ビューを閉じて開いても、VS Code を再起動しても残る）、開発用の dg serve では localStorage

/**
 * 推奨の項目の帯（components/setup-checklist.tsx の SetupBand）を出さないと決めたことを残す鍵。Webview の状態はワークスペース（リポジトリ）ごと
 * なので、このリポジトリでだけ出なくなる。store も読み、出さないと決めた間は推奨の項目を確かめない（store.tsx）。
 * チェックリストの「帯をまた出す」（BandRestore）が鍵ごと消して、帯を出す状態に戻す
 */
export const SETUP_BAND_DISMISSED_KEY = "setup.band.dismissed";

export interface UiState {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  /** 鍵ごと消す（使わなくなった鍵を残さないため） */
  remove(key: string): void;
}

/** acquireVsCodeApi() の getState / setState の部分。テストと dg serve では別の実装を渡す */
export interface StateBackend {
  getState(): unknown;
  setState(value: unknown): void;
}

export function createUiState(backend: StateBackend): UiState {
  const read = (): Record<string, unknown> => {
    const v = backend.getState();
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  };
  return {
    get<T>(key: string) {
      return read()[key] as T | undefined;
    },
    set(key, value) {
      backend.setState({ ...read(), [key]: value });
    },
    remove(key) {
      const state = read();
      if (!(key in state)) return;
      const { [key]: _removed, ...rest } = state;
      backend.setState(rest);
    },
  };
}

export function memoryBackend(initial: unknown = {}): StateBackend {
  let state = initial;
  return {
    getState: () => state,
    setState: (v) => {
      state = v;
    },
  };
}

/** dg serve 用。localStorage が使えない（プライベートウィンドウなど）ときはメモリだけ */
export function localStorageBackend(key = "deguboard.ui"): StateBackend {
  const memory = memoryBackend();
  return {
    getState() {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as unknown) : memory.getState();
      } catch {
        return memory.getState();
      }
    },
    setState(v) {
      memory.setState(v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // 保存できなくても画面は動く
      }
    },
  };
}
