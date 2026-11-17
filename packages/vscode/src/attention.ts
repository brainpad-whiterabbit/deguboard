// タイトル行のボタンに点を付けて知らせる仕組み（UI-12）。VS Code の API に触れない部分で、extension.ts から呼ぶ。
// タイトル行のボタンは Webview の外にあり、アイコンもツールチップ（コマンドの title）も実行中に変えられない。そこで、点付きの SVG アイコンと
// 件数ごとの title を持つ差し替え用のコマンドを package.json に並べ、context key（件数。0 か未設定なら元のボタン）で menus の when を切り替える。
// 差し替え用のコマンドは元のコマンドと同じ処理を登録し、コマンドパレットには出さない（commandPalette の when を false）

/** 点を付けて知らせるタイトル行のボタン */
export interface AttentionButton {
  /** 元のコマンド（点のないアイコン） */
  command: string;
  /** 件数を入れる context key。0 か未設定の間は元のコマンドを出す */
  contextKey: string;
  /** 差し替え用のコマンドを用意する件数の上限。これより多い件数は上限のコマンド（の title）で出す */
  max: number;
}

/**
 * 左端のセットアップのアイコン。件数は導入のチェックリストの満たさない項目の数（setup.ts の missingSetupCount）。
 * 必須を満たさない間は後の項目を確かめないので 1 件、必須を満たした後は推奨の項目の数（Skill と hooks・dg コマンド・.gitignore の 3 つ）が最大。
 * 推奨の項目を足したら、上限と package.json のコマンドと文言も足す
 */
export const SETUP_ATTENTION: AttentionButton = {
  command: "deguboard.setup",
  contextKey: "deguboard.setupAttention",
  max: 3,
};

/** 件数 n（1 から max）のときに元のコマンドに差し替えるコマンド */
export function attentionCommandOf(button: AttentionButton, n: number): string {
  return `${button.command}.attention${n}`;
}

/** 差し替え用のコマンドをすべて、件数の順に返す */
export function attentionCommands(button: AttentionButton): string[] {
  return Array.from({ length: button.max }, (_, i) => attentionCommandOf(button, i + 1));
}

/** context key に入れる値。0 は点なし、多すぎる件数は上限にまとめる */
export function attentionValue(button: AttentionButton, count: number): number {
  return Math.max(0, Math.min(count, button.max));
}
