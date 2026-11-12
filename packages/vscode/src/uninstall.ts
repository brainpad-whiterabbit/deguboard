// 拡張を消したときに VS Code が走らせる（package.json の vscode:uninstall）。VS Code の API には触れず、node だけで動く。
// 拡張のフォルダの cli/dg.mjs（この拡張が同梱した dg）を current が指すときだけ、起動ファイル・current・リンクを片付ける（launcher.ts）。
// ほかの版やほかのエディタの拡張が使っているものは残す

import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeLauncherOf } from "./launcher.js";

// dist/uninstall.mjs の隣の cli/dg.mjs。extension.ts が書く current の dg と同じ絶対パスになる
const dgFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli", "dg.mjs");

try {
  await removeLauncherOf(dgFile);
} catch (error) {
  console.warn("deguboard: could not remove the dg launcher", error);
}
