Set tier to heavy for any ticket that changes the data sync and write path (packages/core/src/git/sync.ts and git/write.ts, and the commands that call them).
If a change is likely to exceed 500 lines, split the change to the path itself and the change to its callers into separate tickets, and link them with after. (When splitting, suggest to the human that they re-file the tickets with dg guide import.)
Include in the acceptance criteria the case where work stops while re-integrating the remote changes after a rejected push.
Basis: all 7 heavy findings of s33 clustered on this path: t904 (1258 lines, retries 8, heavy 4), t906 (2132 lines, retries 6, heavy 2), t909 (retries 2, heavy 1).
