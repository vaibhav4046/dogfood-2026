# Database-path normalization regression

The rubric columns in SQLite are `min_score` and `max_score`. `normalize()`
expects `min` and `max`. Before the SQL aliases were added, the unit tests
using hand-built criteria passed while the fixture database produced 30 zero
normalized scores among 41 projects.

Reproduce the test with `node --test tests/unit/results-live.test.js`.
`red.txt` is the output after replacing `min_score AS min, max_score AS max`
with the original unaliased columns. It exits 1 and fails four of five tests.
`green.txt` is the output after restoring the aliases. It exits 0 and passes
five of five tests. The source file was restored after the mutation.

The current fixture proof is `normalization-proof.md` at the repository root.
Generate it with `node scripts/normalization-proof.js`. It was generated twice
after this fix with byte-identical SHA-256
`1E0E22AEB961071DB99589E1B99DE8C7DB1C6FD2B9EE5C17CDCB92C6BC5F2E47`.
