// ビルド済みの VSIX を VS Code に入れる。mise run install の最後に pnpm run vsix:install から呼ぶ。
// code CLI がない環境（VS Code の外のシェルなど）では失敗させず、飛ばした旨を出す。
// リモート開発では PATH の code はリモート側の CLI なので、拡張はリモート側に入る。
// 同じ版番号でも差し替わるように --force を付ける。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vsix = path.join(root, "packages", "vscode", "deguboard-vscode.vsix");

if (!existsSync(vsix)) {
  console.error(`install-vsix: ${path.relative(root, vsix)} がない。先に mise run vsix を実行する`);
  process.exit(1);
}

if (!hasCode()) {
  console.log(
    "install-vsix: code CLI が見つからないので VS Code への導入は飛ばした。VS Code の統合ターミナルで `mise run install` し直すか、`code --install-extension packages/vscode/deguboard-vscode.vsix --force` を実行する",
  );
  process.exit(0);
}

const result = spawnSync("code", ["--install-extension", vsix, "--force"], { stdio: "inherit" });
if (result.status !== 0) {
  console.error("install-vsix: VS Code への導入に失敗した");
  process.exit(result.status ?? 1);
}
console.log(
  "install-vsix: 入れた拡張を使うには VS Code のウィンドウを再読み込みする（Developer: Reload Window）",
);

function hasCode() {
  try {
    execFileSync("code", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
