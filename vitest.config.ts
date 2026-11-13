import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { resolveMaxWorkers } from "./vitest.workers.js";

// 時差を UTC に固定する。web の日時は手元の時差で整形するので、期待値（例：2026-01-01T00:00Z を 2026-01-01）が
// UTC より西の時差（America/Los_Angeles など）で 1 日ずれて落ちる。ワーカーに引き継がれるよう、本体のプロセスで先に決めておく。
// 手元の時差で整形すること自体は timeline.test.ts が時差を変えて確かめる
process.env.TZ = "UTC";

// ホームディレクトリを空の一時ディレクトリにする。HOME を渡さないテスト（env が {} か、ctx.env を省いて process.env に落ちるもの）は
// os.homedir() で開発者の本物のホームを見る。dg hooks check・next・brief は ~/.claude/skills の古い Skill を警告に足すので（AG-2）、
// 前の dg で dg skill install --personal をした手元でだけ、警告を丸ごと比べるテストが落ちる。TZ と同じく本体のプロセスで先に決める。
// HOME を見るテストは自分で一時の HOME を渡す。
// git のグローバル設定は当てにしない：HOME が空なので ~/.gitconfig はなく、下で XDG_CONFIG_HOME も外すので
// $XDG_CONFIG_HOME/git/config も読まない（git-fixture.ts も GIT_CONFIG_GLOBAL=/dev/null にする）。git commit をするテストは
// user.name と user.email をリポジトリに自分で書く（createFixture は書く）。手元で通っても、グローバル設定のない端末で落ちないように
// 本物のホームは、それがコミットに入らないことを確かめるテスト（run.test.ts の MT-4）に inject("realHome") で渡す
const realHome = os.homedir();
const testHome = mkdtempSync(path.join(os.tmpdir(), "deguboard-test-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
delete process.env.XDG_CONFIG_HOME;

// エージェントと dg の環境変数を外し、エージェントの中で回しても人の端末で回しても同じものを見るようにする。
// Adapter は CLAUDECODE・AI_AGENT・CLAUDE_CODE_SESSION_ID・CODEX_THREAD_ID などでエージェントを判定し、CLAUDE_CONFIG_DIR・CODEX_HOME・
// COPILOT_HOME で会話記録の置き場所を本物の場所に戻す。セッションのフックは DEGUBOARD_ACTOR=agent・DEGUBOARD_SESSION・
// DEGUBOARD_TRANSCRIPT（本物のホームの下）を入れるので、残すと env を省いたテストの actor が変わり、開く Run が
// 「会話記録の置き場所（今は一時の HOME の下）の外」で拒まれる。名前を並べず接頭辞で外すのは、Adapter が見る変数を足したときに
// ここを直し忘れないため。テストの設定（DEGUBOARD_TEST_*）は残す。エージェントの環境を確かめるテストは env を自分で渡す
const agentEnv = /^(CLAUDE|CODEX_|COPILOT_|AI_AGENT$|DEGUBOARD_(?!TEST_))/;
for (const key of Object.keys(process.env)) {
  if (agentEnv.test(key)) delete process.env[key];
}

// ワーカー数の上限。全体のテストは check の flock で 1 本ずつになるが、test:related は lock の外で回るので、
// 全体のテストと重なる。vitest の既定（論理 CPU 数 - 1）のままだと 2 本で CPU 数のほぼ倍のワーカーが取り合い、
// 時間に頼るテストが落ちやすくなる。8 CPU で測ると、重ねたときは 4 と 7 で時間が変わらず（全体 193 秒と 195 秒）、
// 1 本だけのときは 4 が 2 割遅い（133 秒と 110 秒）だけだったので、既定を CPU 数の半分にして 2 本で CPU を埋める。
// 手元で 1 本だけ速く回したいときや、もっと絞りたいときは DEGUBOARD_TEST_MAX_WORKERS（数か "75%" のような割合）で変える。
// vitest 自身の VITEST_MAX_WORKERS を使わないのは、vitest がその値を parseInt で読むので "75%" が 75 本になり、
// 数でない値も黙って NaN になるから。この変数は vitest.workers.ts で読み、受けない値と 0 はエラーで止める
const maxWorkers = resolveMaxWorkers(process.env.DEGUBOARD_TEST_MAX_WORKERS);

export default defineConfig({
  // @deguboard/core を dist ではなく src で解決する（ビルドなしでテストする）
  resolve: { conditions: ["development"] },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    // Git を使うテストは bare リモートと clone を作るので余裕を持たせる
    testTimeout: 20_000,
    maxWorkers,
    provide: { realHome },
  },
});
