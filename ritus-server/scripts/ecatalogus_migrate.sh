#!/usr/bin/env bash
#
# ecatalogus_migrate.sh - run the whole eCatalogus dictionary migration in order.
#
# The same command runs on a laptop, on staging and on the production server, and
# does the same thing each time. Nothing here prompts, so it is safe to call over
# SSH from a deploy script.
#
#   ./scripts/ecatalogus_migrate.sh              # check only: writes nothing to the database
#   ./scripts/ecatalogus_migrate.sh --apply      # the real run
#   ./scripts/ecatalogus_migrate.sh --apply --db instance/projects.db
#   ./scripts/ecatalogus_migrate.sh --skip-pull  # reuse the committed cache
#
# The check run is not a rehearsal you can skip: it prints the same numbers the
# real run will, so the production run is the second time you have seen them.
#
# --apply takes a timestamped copy of the database first. The migration only adds
# <column>_uuid keys and never removes anything, but a copy costs nothing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
CLI="$SCRIPT_DIR/ecatalogus_dicts.py"

PYTHON="${PYTHON:-python3}"
DB="$SERVER_DIR/instance/projects.db"
SOURCE="https://ecatalogus.ispan.pl"
APPLY=0
SKIP_PULL=0
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)     APPLY=1; shift ;;
    --skip-pull) SKIP_PULL=1; shift ;;
    --db)        DB="$2"; shift 2 ;;
    --source)    SOURCE="$2"; shift 2 ;;
    --cache|--mapping|--index-out|--local-dicts)
                 EXTRA+=("$1" "$2"); shift 2 ;;
    -h|--help)   sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$DB" ]; then
  echo "error: no ritus database at $DB" >&2
  exit 1
fi

run() {
  echo
  echo "=============================================================="
  echo "\$ $*"
  echo "=============================================================="
  "$@"
}

echo "ritus+ -> eCatalogus dictionary migration"
echo "  database : $DB"
echo "  source   : $SOURCE"
if [ "$APPLY" -eq 1 ]; then
  echo "  mode     : APPLY (the database will be written to)"
else
  echo "  mode     : check only (nothing will be written)"
fi

# 1. Pull the vocabularies. Pinning them here is what makes steps 2-4
#    reproducible: they read this snapshot and never the network, so a run today
#    and a run next week map identically even if the vocabulary has moved on.
if [ "$SKIP_PULL" -eq 0 ]; then
  run "$PYTHON" "$CLI" pull --source "$SOURCE" "${EXTRA[@]+"${EXTRA[@]}"}"
else
  echo
  echo "-- skipping pull, using the cache already on disk"
fi

# 2. Work out the mapping and show the numbers before committing to them.
run "$PYTHON" "$CLI" map --db "$DB" --dry-run "${EXTRA[@]+"${EXTRA[@]}"}"
run "$PYTHON" "$CLI" map --db "$DB" "${EXTRA[@]+"${EXTRA[@]}"}"

# 3. Report what would change in the database.
run "$PYTHON" "$CLI" apply --db "$DB" --dry-run "${EXTRA[@]+"${EXTRA[@]}"}"

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "=============================================================="
  echo "check complete - the database was not touched."
  echo "Review data/migration/unresolved.tsv, then re-run with --apply."
  echo "=============================================================="
  exit 0
fi

BACKUP="$DB.bak-$(date +%Y%m%d-%H%M%S)"
cp "$DB" "$BACKUP"
echo
echo "-- database copied to $BACKUP"

run "$PYTHON" "$CLI" apply --db "$DB" "${EXTRA[@]+"${EXTRA[@]}"}"
run "$PYTHON" "$CLI" verify --db "$DB" "${EXTRA[@]+"${EXTRA[@]}"}"

echo
echo "=============================================================="
echo "migration complete. Backup: $BACKUP"
echo "Send data/migration/unresolved.tsv to the eCatalogus editors if it"
echo "is not empty, and rebuild the client so the refreshed"
echo "public/data/ecatalogus/index-*.json ship with it."
echo "=============================================================="
