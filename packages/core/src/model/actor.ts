// 主体の ID（requirements.md TK-7、AG-1、ADR-004）。
// ユーザ名と種別を 1 文字列で表す：`eiki`（人）、`eiki/agent`（eiki の AI）。ホスト名は含めない

export type ActorKind = "human" | "agent";

const AGENT_SUFFIX = "/agent";

/** ユーザ名と種別から ID を作る */
export function actorIdOf(user: string, kind: ActorKind): string {
  return kind === "agent" ? `${user}${AGENT_SUFFIX}` : user;
}

/** ID からユーザ名を取り出す（`eiki/agent` → `eiki`） */
function userOf(id: string): string {
  return id.endsWith(AGENT_SUFFIX) ? id.slice(0, -AGENT_SUFFIX.length) : id;
}

/** 同じユーザか（人とその AI は同じユーザ） */
export function sameUser(a: string, b: string): boolean {
  return userOf(a) === userOf(b);
}

/**
 * そのユーザ本人とみなす主体の ID（人とその AI）。画面が「自分か自分の agent」を判定するのに使う（whoami の own_ids）
 */
export function ownActorIds(user: string): string[] {
  return [actorIdOf(user, "human"), actorIdOf(user, "agent")];
}

/**
 * 入力に書かれた主体の参照を ID に直す。
 * `human` は自分のユーザ本人、`agent` は自分のユーザの AI。それ以外はそのまま（別のユーザの ID を書ける）
 */
export function resolveActorRef(self: { user: string }, ref: string): string {
  if (ref === "human") return self.user;
  if (ref === "agent") return actorIdOf(self.user, "agent");
  return ref;
}
