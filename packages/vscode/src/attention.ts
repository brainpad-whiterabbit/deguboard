// タイトル行のボタンに点を付けて知らせる仕組み（UI-6・UI-12）。VS Code の API に触れない部分で、extension.ts から呼ぶ。
// タイトル行のボタンは Webview の外にあり、アイコンもツールチップ（コマンドの title）も実行中に変えられない。そこで、点付きの SVG アイコンと
// 件数ごとの title を持つ差し替え用のコマンドを package.json に並べ、context key（件数。0 か未設定なら元のボタン）で menus の when を切り替える。
// 差し替え用のコマンドは元のコマンドと同じ処理を登録し、コマンドパレットには出さない（commandPalette の when を false）

/** 点を付けて知らせるタイトル行のボタン */
export interface AttentionButton {
  /** 元のコマンド（点のないアイコン） */
  command: string;
  /** 件数を入れる context key。0 か未設定の間は元のコマンドを出す */
  contextKey: string;
  /**
   * ツールチップに出す件数ごとの、差し替え用のコマンドを用意する上限。これより多い件数は上限のコマンド（の title）で出す。
   * 1 つ目の件数が 0 なら点を出さない（1 から上限まで）。2 つ目からの件数は 0 から上限まで
   */
  max: readonly number[];
}

/**
 * 左端のセットアップのアイコン。件数は導入のチェックリストの満たさない項目の数（setup.ts の missingSetupCount）。
 * 必須を満たさない間は後の項目を確かめないので 1 件、必須を満たした後は推奨の項目の数（Skill と hooks・dg コマンド・.gitignore の 3 つ）が最大。
 * 推奨の項目を足したら、上限と package.json のコマンドと文言も足す
 */
export const SETUP_ATTENTION: AttentionButton = {
  command: "deguboard.setup",
  contextKey: "deguboard.setupAttention",
  max: [3],
};

/**
 * 同期のボタン（UI-6）。件数は未 push と未取り込みのコミットの数（syncAttentionCounts）。
 * 組み合わせの数だけコマンドが要るので、上限は小さくし、上限は「3+」と書く
 */
export const SYNC_ATTENTION: AttentionButton = {
  command: "deguboard.sync",
  contextKey: "deguboard.syncAttention",
  max: [3, 3],
};

/** 件数の組（1 つ目は 1 から max）のときに元のコマンドに差し替えるコマンド。件数は "_" でつなぐ（例 deguboard.sync.attention2_0） */
export function attentionCommandOf(button: AttentionButton, counts: readonly number[]): string {
  return `${button.command}.attention${counts.join("_")}`;
}

/** 差し替え用のコマンドをすべて、1 つ目の件数から順に（2 つ目以降はその中で 0 から）返す */
export function attentionCommands(button: AttentionButton): string[] {
  const [first = 0, ...rest] = button.max;
  let combos: number[][] = Array.from({ length: first }, (_, i) => [i + 1]);
  for (const max of rest)
    combos = combos.flatMap((combo) => Array.from({ length: max + 1 }, (_, n) => [...combo, n]));
  return combos.map((counts) => attentionCommandOf(button, counts));
}

/**
 * context key に入れる値。1 つ目の件数が 0 なら 0（点なし）、ほかは件数の組を上限にまとめて "_" でつないだもの
 * （when の == は文字列で比べるので、package.json の when は "deguboard.syncAttention == 2_0" と書く）
 */
export function attentionValue(button: AttentionButton, counts: readonly number[]): string | 0 {
  if (!(counts[0]! > 0)) return 0;
  return button.max.map((max, i) => Math.max(0, Math.min(counts[i] ?? 0, max))).join("_");
}

/**
 * 同期のボタンの件数。人の同期が要る間（未 push のコミットがある。未取り込みもあれば両方）だけ点を出す。
 * 未取り込みだけなら fast-forward で自動で取り込める（core の fastForwardIfClean）ので点を出さない。
 * 未コミットの変更などで自動の取り込みが止まっていても、未 push がなければ出さない（Activity Bar のバッジが件数を出す）
 */
export function syncAttentionCounts(status: { ahead: number; behind: number }): number[] {
  return status.ahead > 0 ? [status.ahead, status.behind] : [0];
}
