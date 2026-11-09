# OSS export tree (`tools/oss/export-oss.mjs`)

## What it does

Builds a publishable copy of the repository under a target directory:

1. Lists paths with `git ls-files` (only tracked files; no `.git`, `node_modules`, or untracked secrets).
2. **Skips** every path matched by the same rules as `tools/oss/check-sanitized.mjs` (`.claude/`, `deploy/`, `docs/claude/{production,growth,history}.md`, `informes/`, root `test*.js`, etc.).
3. **Strips** forbidden substrings (``, ``) from text files in the copy only.
4. Merges into `.gitignore`: `informes/`, `.env*`, `e2e/artifacts/`.
5. Adds `.dockerignore` when the tree did not already have one.
6. Runs `checkSanitized({ root: targetDir, hashesFile })` and exits non-zero on violations (path + reason only).

## Usage

```bash
node tools/oss/export-oss.mjs /path/to/oss-export [--hashes /path/to/hashes.txt]
```

- **Target directory** must not exist or must be empty; otherwise the script refuses to run.
- **Hashes file**: `--hashes`, or `OSS_FORBIDDEN_HASHES_FILE`, or an empty temporary file (hash scan disabled but the check still runs).

## Related

- Sanitize check only (no copy): `OSS_FORBIDDEN_HASHES_FILE=… node tools/oss/check-sanitized.mjs`
- CI/tests: `tools/oss/checkSanitized.test.js`
