// データのリモートをなしにする値。Stop のフックの速い経路（git/repo.ts）も読むので、zod を読む model/config.ts と分けて、何も import しない

/**
 * git.data_remote に書くと、データのリモートをなしにする値（dg init --no-data-remote が書く）。コードのリモートがあっても
 * データは手元だけに置き、リモートのないリポジトリと同じ経路（SY-6）で動く。この名前のリモートはデータのリモートにできない
 */
export const NO_DATA_REMOTE = "none";
