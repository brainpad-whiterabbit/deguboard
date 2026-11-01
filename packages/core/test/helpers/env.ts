// CLI をテストから in-process で動かすときの環境変数

/** 主体を決める環境変数。開発者のシェルが export していても、テストの結果を変えないように外す */
const ACTOR_VARS = ["DEGUBOARD_ACTOR", "DEGUBOARD_USER"];

/** process.env から主体を決める環境変数を除いた写し。CLI の run に env として渡す */
export function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ACTOR_VARS) delete env[name];
  return env;
}
