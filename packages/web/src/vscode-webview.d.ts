// VS Code の Webview が用意するグローバル。拡張ホストと話す postMessage を得る（ブラウザにはない）
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(value: unknown): void;
};
