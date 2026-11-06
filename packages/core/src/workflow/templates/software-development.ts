import type { WorkflowDefinitionInput } from "../../model/workflow.js";

/** ソフトウェア開発。PR の事実は gh があるときだけ使われ、なくても branch_merged で done になる */
export const softwareDevelopment: WorkflowDefinitionInput = {
  id: "software-development",
  name: "Software Development",
  labels: { review: "Code Review" },
  // review → done に requires を足さない。requires は AND なので branch_merged を書くと
  // squash マージ（pr_merged だけが真）で done に進めなくなる
  transitions: [],
  reconcile: [
    // squash マージは祖先判定で取れないので PR のマージを先に見る
    { when: ["pr_merged"], status: "done" },
    { when: ["branch_merged"], status: "done" },
    { when: ["pr_open", "!pr_draft"], status: "review" },
    { when: ["branch_exists"], status: "in_progress" },
  ],
  fields: [{ id: "estimate", type: "number", label: "Estimate" }],
  // Run の step の語彙。順や分岐は書かない（手順は dg guide が持つ。WF-5）
  steps: [
    { id: "investigate", label: "Investigate" },
    {
      id: "implement",
      label: "Implement",
      actions: ["create_worktree", "create_branch", "run_tests", "create_pr"],
      // agent の ticket claim がこの step の Run を開く（RN-5）
      opens_on: "claim",
    },
    // 見直し役の見直しと、指摘を受けた手直しは実装と分けて数える（ADR-005）
    { id: "review", label: "Review", actions: ["run_tests"] },
    // 人のレビューの後の手直しは、自分の PR のあるチケットのもう一度の claim がこの step の Run を開く（RN-5）
    { id: "fix", label: "Fix", actions: ["run_tests"], opens_on: "reclaim" },
    // PR のマージは base を変えるので、Action の確認の要否によらず人の承認を取る
    { id: "merge", label: "Merge", actions: ["merge_pr"], approval: true },
  ],
};
