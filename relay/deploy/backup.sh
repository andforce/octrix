#!/usr/bin/env bash
set -euo pipefail

backup_dir="${OCTRIX_BACKUP_DIR:-/opt/octrix/deploy/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

install -d -m 0700 "$backup_dir"
docker exec octrix-cloud node -e '
  const Database = require("better-sqlite3");
  const database = new Database("/data/octrix.sqlite3", { readonly: true });
  database.backup(`/backups/octrix-${process.argv[1]}.sqlite3`)
    .then(() => database.close())
    .catch(error => { console.error(error.message); process.exit(1); });
' "$timestamp"
find "$backup_dir" -type f -name 'octrix-*.sqlite3' -mtime +14 -delete
