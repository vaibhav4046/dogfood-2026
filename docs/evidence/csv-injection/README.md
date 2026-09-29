# CSV formula regression

`node --test tests/unit/csv-injection.test.js` exercises seven hostile project
titles against the same `buildCsv` function used by `/api/export.csv`.

`red.txt` records the test after the formula-prefix expression was replaced
with `const s = raw;` (exit 1). `green.txt` records the restored code (exit 0).
The mutation was made and restored in one command. The full suite after the
fix passed 107 of 107 tests.
