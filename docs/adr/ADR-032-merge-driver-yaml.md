# ADR-032 マージドライバを Plan・Iteration・Project の YAML にも当てる

- ステータス：承認
- 更新日：2026-11-09

## 背景

[ADR-002](ADR-002-storage-and-id.md) の「同期の競合」は、マージドライバを Markdown（チケットと Epic の frontmatter）にだけ当てると決めた。Plan・Iteration・Project の YAML は行単位のマージのままで、両側が同じ Plan の別のフィールド（`closed_at` と `updated_at` など）を変えると、`updated_at` の行がぶつかって rebase が止まる。実際に Plan の `closed_at` の競合で同期が 3 日止まった。

## 決定

ADR-002 の「同期の競合：frontmatter をフィールド単位でマージする」の「取り込みは rebase で行い、Markdown に git のマージドライバを当てる」の項のうち、「Markdown に git のマージドライバを当てる」の部分を置き換える。

- マージドライバは、チケット・墓標・Epic の Markdown に加えて、`plans/`・`iterations/`・`projects/` の YAML にも当てる
- 素の YAML は全体を frontmatter と同じに扱い、最上位のフィールドごとに 3-way で決める。両側が違う値に変えたフィールドだけを競合にする規則は ADR-002 のまま
- `config.yaml` と `workflows/` は当てず、行単位のマージのままにする
- 既にある `.gitattributes` には、`dg init` と `dg sync` が足りない行を足してコミットする

## 理由

- Plan・Iteration・Project も `dg` が書き込みのたびに `updated_at` を変えるので、行単位ではチケットと同じく同時の更新がほぼすべて競合になる
- frontmatter の YAML と同じ読み書き（コメントと書式を保つ Document）で扱えるので、規則を分けずに済む
- `config.yaml` と `workflows/` は人が手で書く設定で、入れ子の深い値を行単位で見て解く方が意図を壊しにくい

## 採らなかった案

- **すべての `*.yaml` に当てる**：人が手で書く設定までフィールド単位にすると、入れ子の深い値を 1 つの値として比べるので、別々の行の変更まで競合になる
