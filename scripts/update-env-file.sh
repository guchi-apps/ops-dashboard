#!/usr/bin/env bash
# Safely set KEY=VALUE in a dotenv file (values are double-quoted).
# Usage: bash scripts/update-env-file.sh <env-file> <key> <value>
set -euo pipefail

ENV_FILE="${1:?env file path required}"
KEY="${2:?key required}"
VALUE="${3-}"

python3 - "$ENV_FILE" "$KEY" "$VALUE" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]

escaped = (
    value.replace("\\", "\\\\")
    .replace('"', '\\"')
    .replace("\n", "\\n")
)
new_line = f'{key}="{escaped}"'

lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
pattern = re.compile(rf"^{re.escape(key)}=")
out: list[str] = []
found = False

for line in lines:
    if pattern.match(line):
        out.append(new_line)
        found = True
    else:
        out.append(line)

if not found:
    out.append(new_line)

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
