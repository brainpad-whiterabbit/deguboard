// ビルド済みの VSIX を VS Code に入れる。mise run install の最後に pnpm run vsix:install から呼ぶ。
// 引数で VSIX の位置を変えられる（テスト用。既定は packages/vscode/deguboard-vscode.vsix）。
// code CLI がない環境（VS Code の外のシェルなど）や、code が時間の上限までに答えないときは、失敗させず手で入れるコマンドを出す。
// リモート開発では PATH の code はリモート側の CLI なので、拡張はリモート側に入る。リモートの CLI は --version にはすぐ答えるが、
// --install-extension は VS Code の窓口のソケットを上限なく待つことがあるので、上限を付ける（t230）。
// code は sh が node を子として起こすので、上限を超えたらプロセスグループごと止める（sh だけ止めると node が残る）。
// 上限は DEGUBOARD_VSIX_INSTALL_TIMEOUT_MS（ミリ秒、既定 60 秒）で変えられる。--version の上限はその値と 10 秒の短い方。
// 同じ版番号でも差し替わるように --force を付ける。
// Windows は想定しない（プロセスグループで止められないので、子だけを止める。code.cmd は shell なしでは起こせない）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vsix = path.resolve(
  process.argv[2] ?? path.join(root, "packages", "vscode", "deguboard-vscode.vsix"),
);
const givenTimeoutMs = Number(process.env.DEGUBOARD_VSIX_INSTALL_TIMEOUT_MS);
const installTimeoutMs = givenTimeoutMs > 0 ? givenTimeoutMs : 60_000;
const versionTimeoutMs = Math.min(installTimeoutMs, 10_000);
// 案内はリポジトリの根からの位置で出す（mise のタスクは根で動く）。根の外なら絶対パスのまま
const shown = path.relative(root, vsix).startsWith("..") ? vsix : path.relative(root, vsix);
const manual = `code --install-extension ${shown} --force`;

if (!existsSync(vsix)) {
  console.error(`install-vsix: ${shown} がない。先に mise run vsix を実行する`);
  process.exit(1);
}

const version = await runCode(["--version"], versionTimeoutMs, "ignore");
if (version.timedOut || version.status !== 0) {
  const why = version.timedOut
    ? `code CLI が ${versionTimeoutMs / 1000} 秒で答えなかった`
    : version.status === null
      ? "code CLI が見つからない"
      : `code --version が終了コード ${version.status} で終わった`;
  console.log(
    `install-vsix: ${why}ので VS Code への導入は飛ばした。VS Code の統合ターミナルで \`mise run vsix:install\` し直すか、\`${manual}\` を実行する`,
  );
  process.exit(0);
}

const result = await runCode(["--install-extension", vsix, "--force"], installTimeoutMs, "inherit");
if (result.timedOut) {
  console.log(
    `install-vsix: code CLI が ${installTimeoutMs / 1000} 秒で終わらなかったので止め、VS Code への導入は飛ばした（VS Code の窓口が答えていない）。VS Code の統合ターミナルで \`${manual}\` を実行する`,
  );
  process.exit(0);
}
if (result.status !== 0) {
  console.error("install-vsix: VS Code への導入に失敗した");
  process.exit(result.status ?? 1);
}
console.log(
  "install-vsix: 入れた拡張を使うには VS Code のウィンドウを再読み込みする（Developer: Reload Window）",
);

/**
 * code を引数配列で起こし、終わるか上限を超えるまで待つ。上限を超えたらプロセスグループごと SIGKILL で止める。
 * 見つからないときは status を null で返し、シグナルで終わったときは 1 で返す
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {"ignore" | "inherit"} stdio
 * @returns {Promise<{ status: number | null; timedOut: boolean }>}
 */
function runCode(args, timeoutMs, stdio) {
  return new Promise((resolve) => {
    // detached で子を新しいプロセスグループの頭にし、孫（sh が起こす node）もまとめて止められるようにする
    const windows = process.platform === "win32";
    const child = spawn("code", args, { stdio, detached: !windows });
    let timedOut = false;
    let settled = false;
    const killGroup = () => {
      try {
        if (windows) child.kill();
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // 既に終わっているか、起こせなかった
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    // 途中で止められたら（Ctrl-C・kill・端末を閉じる）、別のグループにいる code も止めてから終える
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const onSignal = () => {
      killGroup();
      process.exit(130);
    };
    for (const signal of signals) process.once(signal, onSignal);
    const done = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) process.off(signal, onSignal);
      resolve({ status, timedOut });
    };
    child.once("error", () => done(null));
    child.once("exit", (code) => done(code ?? 1));
  });
}
