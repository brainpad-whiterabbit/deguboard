// やめた Project（カンバンの中の区切り。ADR-034）の残り。前の dg は projects/<slug>.yaml に Project ごとの既定の Workflow を、
// config.yaml の default_project に既定の Project を書いていた。projects/ は dg が同期か書き込みのときに消す（git/retire-projects.ts）。
// Workflow はカンバンに 1 つ（requirements.md 5.8）なので、Project が指していた Workflow はどこにも移さない

/** 前の dg が Project を置いていたディレクトリ（worktree からの相対パス） */
export const RETIRED_PROJECTS_DIR = "projects";
/** 前の dg が config.yaml に書いていた、既定の Project のキー */
export const RETIRED_DEFAULT_PROJECT_KEY = "default_project";

/**
 * チームの config.yaml が前に持っていたキー。読むときは値に出さず、config を書くたびにファイルから消す（Store.writeConfig）。
 * default_workflow はチケットごとに Workflow を選んでいたときの既定の名前
 */
export const RETIRED_CONFIG_KEYS = [RETIRED_DEFAULT_PROJECT_KEY, "default_workflow"] as const;

/** config.yaml の中身（raw）から、やめたキーを除く */
export function withoutRetiredConfigKeys(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([k]) => !(RETIRED_CONFIG_KEYS as readonly string[]).includes(k)),
  );
}
