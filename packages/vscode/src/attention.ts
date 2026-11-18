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
   * どの件数も 0 から上限までで、すべて 0 なら点を出さない（すべて 0 の組のコマンドは用意しない）
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
 * 組み合わせの数だけコマンドが要るので、上限は小さくし、上限は「3+」と書く。
 * 未 push が 0 の組（0_1 など）は、自動の取り込みが止まっているときで、title に自動では取り込めないと書く
 */
export const SYNC_ATTENTION: AttentionButton = {
  command: "deguboard.sync",
  contextKey: "deguboard.syncAttention",
  max: [3, 3],
};

/** 件数の組のときに元のコマンドに差し替えるコマンド。件数は "_" でつなぐ（例 deguboard.sync.attention2_0） */
function attentionCommandOf(button: AttentionButton, counts: readonly number[]): string {
  return `${button.command}.attention${counts.join("_")}`;
}

/** 差し替え用のコマンドをすべて、1 つ目の件数から順に（2 つ目以降はその中で 0 から）返す。すべて 0 の組は除く */
export function attentionCommands(button: AttentionButton): string[] {
  let combos: number[][] = [[]];
  for (const max of button.max)
    combos = combos.flatMap((combo) => Array.from({ length: max + 1 }, (_, n) => [...combo, n]));
  return combos
    .filter((counts) => counts.some((n) => n > 0))
    .map((counts) => attentionCommandOf(button, counts));
}

/**
 * context key に入れる値。件数がすべて 0 なら 0（点なし）、ほかは件数の組を上限にまとめて "_" でつないだもの
 * （when の == は文字列で比べるので、package.json の when は "deguboard.syncAttention == 2_0" と書く）
 */
export function attentionValue(button: AttentionButton, counts: readonly number[]): string | 0 {
  const capped = button.max.map((max, i) => Math.max(0, Math.min(counts[i] ?? 0, max)));
  return capped.some((n) => n > 0) ? capped.join("_") : 0;
}

/**
 * 同期のボタンの件数（未 push・未取り込み）。人の同期が要る間だけ点を出す：未 push のコミットがある（未取り込みもあれば両方）か、
 * 未取り込みだけでも自動の取り込みが止まっている（まとめ待ちの変更・dg の外の変更など。core の fastForwardIfClean が blocked を返した）。
 * 未取り込みだけで止まっていなければ、次の fetch の後に fast-forward で自動で取り込めるので点を出さない
 */
export function syncAttentionCounts(status: {
  ahead: number;
  behind: number;
  auto_pull_blocked: boolean;
}): number[] {
  if (status.ahead > 0) return [status.ahead, status.behind];
  return status.auto_pull_blocked ? [0, status.behind] : [0, 0];
}
