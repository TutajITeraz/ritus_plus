#!/usr/bin/env python3
"""
TITLE: ecatalogus_dicts.py
DESCRIPTION: Pulls the eCatalogus controlled vocabularies into a local cache,
  migrates the ritus content rows off the instance-local integer ids onto UUIDs,
  and carries new eCatalogus terms into ritus's own dictionaries.

  Five re-runnable subcommands. `pull` first, always; the rest in any order:

      pull    download the vocabularies from the canonical eCatalogus instance
      map     work out a uuid for every dictionary value ritus holds
      apply   write those uuids into the ritus database
      verify  re-check the result; exits non-zero if anything regressed
      sync    add new eCatalogus terms to ritus's own local dictionaries

  map/apply/verify/sync never touch the network. They read the cache `pull`
  wrote, so a run on the developer's machine and a run on production against
  the same cache produce the same result. That is the whole reason pull is
  separate from the rest.

WHY THIS EXISTS:
  UUIDs are the only identifier eCatalogus guarantees means the same thing on
  every instance. Two dictionaries, `rite-names` and `formulas`, also publish a
  plain numeric `id` straight from the canonical instance - every other
  dictionary publishes `uuid` only. Where content columns hold a ritus integer
  (`rite_id`, `formula_id`, a Usuarium id), `map`/`apply` resolve it to a uuid
  via the cache before it is ever sent, so nothing ritus-local is sent to
  eCatalogus and nothing cross-instance is trusted for identity.

  `id`, where it exists, is not automatically ritus's own numbering - see
  id_scheme_trustworthy() below and eCatalogus_REFERENCE.md §5. It agrees with
  ritus's numbering for `rite-names`. It does not for `formulas`, which is why
  `sync` writes to `rite_names.csv` but refuses to write to `formulas.csv`.

USAGE:
  python3 scripts/ecatalogus_dicts.py pull
  python3 scripts/ecatalogus_dicts.py map    --dry-run
  python3 scripts/ecatalogus_dicts.py map
  python3 scripts/ecatalogus_dicts.py apply  --dry-run
  python3 scripts/ecatalogus_dicts.py apply
  python3 scripts/ecatalogus_dicts.py verify
  python3 scripts/ecatalogus_dicts.py sync   --dry-run
  python3 scripts/ecatalogus_dicts.py sync

  Every subcommand takes --db, --cache and --mapping to override the defaults,
  and every subcommand is non-interactive and safe to run twice.

DEPENDENCIES:
  Python 3.8+ standard library only - no pip install on the production server.
"""

import argparse
import csv
import io
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

# --------------------------------------------------------------------------- #
# Paths and constants
# --------------------------------------------------------------------------- #

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(SERVER_DIR)

DEFAULT_SOURCE = "https://ecatalogus.ispan.pl"
DEFAULT_DB = os.path.join(SERVER_DIR, "instance", "projects.db")
# The full vocabularies live on the server side. They are 9 MB and only the
# migration reads them, so they are deliberately kept out of the web build.
DEFAULT_CACHE = os.path.join(SERVER_DIR, "data", "ecatalogus")
DEFAULT_MAPPING = os.path.join(SERVER_DIR, "data", "migration")

# ritus's own dictionaries sit in two different places depending on where this
# runs. In a checkout they are the client's source assets; on a deployed server
# there is no ritus-client at all - `package.sh` copies the built client into
# ritus-server/static, so the same files arrive under static/data. Both layouts
# are supported, and --local-dicts overrides the guess.
LOCAL_DICT_CANDIDATES = (
    os.path.join(REPO_ROOT, "ritus-client", "public", "data"),   # checkout
    os.path.join(SERVER_DIR, "static", "data"),                  # deployed server
)

# A file every layout has, used to recognise a real dictionary directory.
LOCAL_DICT_MARKER = "formulas.csv"


def find_local_dict_dir():
    for candidate in LOCAL_DICT_CANDIDATES:
        if os.path.isfile(os.path.join(candidate, LOCAL_DICT_MARKER)):
            return candidate
    return None


def find_index_out():
    """Where the browser lookups belong, for whichever layout this is.

    In a checkout they go to the client's source assets and reach production
    through `npm run build`. On a deployed server that directory does not exist;
    static/data is served directly, so writing there takes effect immediately
    with no rebuild.
    """
    local = find_local_dict_dir()
    if local:
        return os.path.join(local, "ecatalogus")
    return os.path.join(LOCAL_DICT_CANDIDATES[0], "ecatalogus")

PAGE_SIZE = 1000
HTTP_TIMEOUT = 180

UUID_LENGTH = 36


class Dictionary:
    """One controlled vocabulary, and how ritus refers to it.

    slug          the eCatalogus dictionary endpoint
    label         the Django model label, kept for cache sidecars
    remote_names  entry fields a ritus value may be matched against, in order
    ritus_columns the content columns that reference this vocabulary
    local_name    the column in ritus's own CSV holding the name, used only
                  for the human-readable label in map's mapping-*.tsv output
    """

    def __init__(self, slug, label, remote_names, ritus_columns, local_name=None):
        self.slug = slug
        self.label = label
        self.remote_names = remote_names
        self.ritus_columns = ritus_columns
        self.local_name = local_name

    @property
    def filename(self):
        return "%s.tsv" % self.slug


# Fourteen vocabularies, covering all sixteen ritus content columns that
# reference one. `music-notation-names` is cached for completeness but is NOT how
# music_notation_id resolves - that field points at per-manuscript notation
# records, and the server resolves it from the notation NAME against the target
# manuscript. See ecatalogus.js.
DICTIONARIES = [
    Dictionary("rite-names", "indexerapp.RiteNames", ("name",),
               ("rite_id",), "text"),
    Dictionary("formulas", "indexerapp.Formulas", (),
               ("formula_id",), "text"),
    Dictionary("content-functions", "indexerapp.ContentFunctions", ("name",),
               ("function_id", "subfunction_id"), "name"),
    Dictionary("sections", "indexerapp.Sections", ("name",),
               ("section_id", "subsection_id"), "name"),
    Dictionary("liturgical-genres", "indexerapp.LiturgicalGenres", ("title",),
               ("liturgical_genre_id",), "name"),
    Dictionary("layers", "indexerapp.Layer", ("short_name", "name"),
               ("layer",), "name"),
    Dictionary("mass-hours", "indexerapp.MassHour", ("short_name", "name"),
               ("mass_hour",), "name"),
    Dictionary("genres", "indexerapp.Genre", ("short_name", "name"),
               ("genre",), "name"),
    Dictionary("seasons-and-months", "indexerapp.SeasonMonth", ("short_name", "name"),
               ("season_month",), "name"),
    Dictionary("weeks", "indexerapp.Week", ("short_name", "name"),
               ("week",), "name"),
    Dictionary("days", "indexerapp.Day", ("short_name", "name"),
               ("day",), "name"),
    Dictionary("text-standarization", "indexerapp.TextStandarization",
               ("usu_id", "standard_incipit"),
               ("text_standarization__usu_id",), None),
    Dictionary("music-notation-names", "indexerapp.MusicNotationNames", ("name",),
               ("music_notation_id",), "name"),
    Dictionary("contributors", "indexerapp.Contributors", ("initials",),
               ("contributor_id",), None),
]

BY_SLUG = {d.slug: d for d in DICTIONARIES}
BY_COLUMN = {column: d for d in DICTIONARIES for column in d.ritus_columns}

# Vocabularies the upload dialog has to look something up in at run time, because
# ritus holds a value the eCatalogus importer cannot resolve on its own:
#
#   formulas             Formulas declares no name lookup server-side, so a uuid
#                        is the only way to name a formula.
#   rite-names           ritus stores the legacy integer, not the rubric name.
#   text-standarization  ritus stores a Usuarium id; the server matches only on
#                        standard_incipit.
#
# Every other vocabulary is resolved by the server from the name ritus already
# holds, so the browser never needs it. A separate compact index keeps the
# dialog from having to parse the 8.5 MB formulas table.
RUNTIME_INDEX_SLUGS = ("formulas", "rite-names", "text-standarization")

# Columns eCatalogus cannot resolve from ritus data at all. Recorded so `verify`
# does not report them as gaps, and so the numbers in the log account for
# everything in the table.
UNMAPPABLE_COLUMNS = ("quire_id", "edition_index", "edition_subindex")

# Only these three columns are migrated, and the reason is the same one that
# decides how the upload sends them: an opaque identifier means nothing outside
# the database that issued it, so it has to become a uuid before it can travel.
#
#   rite_id                      a ritus integer
#   formula_id                   a ritus integer
#   text_standarization__usu_id  a Usuarium id
#
# Every other reference column holds a NAME - "Collecta", "S/C", "Square
# notation". Names are already portable: the importer resolves them itself, the
# same way on every instance, so there is nothing to migrate. They stay text.
#
# That is deliberate, not an omission. Migrating them would turn ordinary
# data-entry noise into migration blockers: a column full of values like "A",
# "AA", "A11A" is a table that needs correcting by the person who transcribed
# it, which is what Validate in the table editor is for. It is not something a
# migration script can decide, and burying it in unresolved.tsv would hide the
# formula ids that genuinely cannot be resolved.
MIGRATED_COLUMNS = ("rite_id", "formula_id", "text_standarization__usu_id")

# The rest: kept as text, validated in the table editor and again by dry_run.
TEXT_REFERENCE_COLUMNS = tuple(
    column for column in BY_COLUMN if column not in MIGRATED_COLUMNS
)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def normalize(value):
    """Match the server's own comparison: case-insensitive, whitespace-collapsed."""
    return " ".join(str(value or "").strip().lower().split())


def is_blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def looks_like_uuid(value):
    text = str(value).strip()
    if len(text) != UUID_LENGTH:
        return False
    try:
        uuid.UUID(text)
        return True
    except (ValueError, AttributeError):
        return False


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def log(message):
    sys.stdout.write(message + "\n")
    sys.stdout.flush()


def fail(message):
    sys.stderr.write("error: %s\n" % message)
    sys.exit(1)


def read_delimited(path):
    """Read a ritus CSV/TSV, autodetecting the delimiter from the header."""
    with open(path, encoding="utf-8-sig") as handle:
        text = handle.read()
    if not text.strip():
        return []
    header = text.split("\n", 1)[0]
    delimiter = "\t" if header.count("\t") > header.count(",") else ","
    return list(csv.DictReader(io.StringIO(text), delimiter=delimiter))


def write_tsv(path, fieldnames, rows):
    """Write atomically: a run interrupted here must not leave a half file."""
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=fieldnames, delimiter="\t",
            extrasaction="ignore", lineterminator="\n",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    os.replace(temporary, path)


def ensure_directory(path):
    if not os.path.isdir(path):
        os.makedirs(path)


# --------------------------------------------------------------------------- #
# The cache on disk
# --------------------------------------------------------------------------- #

class Cache:
    """The pulled vocabularies, indexed for the two lookups map/verify need."""

    def __init__(self, directory):
        self.directory = directory
        self.by_slug = {}

    @classmethod
    def load(cls, directory, required_slugs=None):
        cache = cls(directory)
        if not os.path.isdir(directory):
            fail("no dictionary cache at %s - run `pull` first." % directory)

        for dictionary in DICTIONARIES:
            path = os.path.join(directory, dictionary.filename)
            if not os.path.isfile(path):
                if required_slugs and dictionary.slug in required_slugs:
                    fail("cache is missing %s - run `pull` first." % dictionary.filename)
                continue
            rows = read_delimited(path)
            index = {
                "rows": rows,
                "by_uuid": {},
                "by_name": {},
                "by_legacy": {},
            }
            for row in rows:
                row_uuid = (row.get("uuid") or "").strip()
                if not row_uuid:
                    continue
                index["by_uuid"][row_uuid] = row
                legacy = (row.get("legacy_id") or "").strip()
                if legacy:
                    index["by_legacy"].setdefault(legacy, row_uuid)
                for field in dictionary.remote_names:
                    key = normalize(row.get(field))
                    if key:
                        index["by_name"].setdefault(key, row_uuid)
            cache.by_slug[dictionary.slug] = index

        if not cache.by_slug:
            fail("dictionary cache at %s is empty - run `pull` first." % directory)
        return cache

    def entry(self, slug, row_uuid):
        return self.by_slug.get(slug, {}).get("by_uuid", {}).get(row_uuid)

    def name_of(self, slug, row_uuid):
        """The first populated name field of a cached entry, for confirmation."""
        row = self.entry(slug, row_uuid)
        if row is None:
            return None
        dictionary = BY_SLUG[slug]
        # Formulas declare no name lookup, so fall back to whichever descriptive
        # column exists - the mapping files are read by people, and a row of
        # bare uuids cannot be audited.
        candidates = list(dictionary.remote_names) or []
        candidates += [dictionary.local_name, "name", "title", "text", "standard_incipit"]
        for field in candidates:
            if field and not is_blank(row.get(field)):
                return str(row.get(field))[:120]
        return None


# --------------------------------------------------------------------------- #
# pull
# --------------------------------------------------------------------------- #

def http_get_json(url):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")[:400]
        raise RuntimeError("HTTP %s from %s\n%s" % (error.code, url, body))
    except urllib.error.URLError as error:
        raise RuntimeError("could not reach %s (%s)" % (url, error.reason))


def fetch_dictionary(base, slug):
    """Page through one vocabulary, following next_offset until it is null."""
    rows = []
    offset = 0
    rights = None
    while offset is not None:
        query = urllib.parse.urlencode({"limit": PAGE_SIZE, "offset": offset})
        page = http_get_json("%s/api/v1/dictionaries/%s/?%s" % (base, slug, query))
        rows.extend(page.get("results") or [])
        rights = page.get("rights") or rights
        offset = page.get("next_offset")
    return rows, rights


def attach_source_ids(remote_rows):
    """Take the integer id eCatalogus itself assigns, when it publishes one.

    Only `rite-names` and `formulas` currently carry one - every other
    dictionary publishes `uuid` only. Where it exists it is the canonical
    instance's own numbering, and that numbering is exactly what ritus's own
    `rite_names.csv` / `formulas.csv` have used since before eCatalogus
    existed. It is taken as-is: no derivation, no local cross-check. If
    eCatalogus ever adds `id` to another dictionary, it starts being trusted
    here automatically.
    """
    legacy_by_uuid = {}
    for row in remote_rows:
        row_uuid = row.get("uuid")
        row_id = row.get("id")
        if row_uuid and row_id is not None:
            legacy_by_uuid[row_uuid] = str(row_id)
    return legacy_by_uuid


def command_pull(args):
    base = args.source.rstrip("/")
    log("pull  source=%s  out=%s" % (base, args.cache))
    if args.dry_run:
        log("      --dry-run: nothing will be written")

    try:
        index = http_get_json("%s/api/v1/" % base)
    except RuntimeError as error:
        fail(str(error))
    site_name = index.get("site_name", "?")
    log("      instance: %s (API %s)" % (site_name, index.get("api_version")))

    wanted = DICTIONARIES
    if args.only:
        requested = [slug.strip() for slug in args.only.split(",") if slug.strip()]
        unknown = [slug for slug in requested if slug not in BY_SLUG]
        if unknown:
            fail("unknown dictionary slug(s): %s" % ", ".join(unknown))
        wanted = [BY_SLUG[slug] for slug in requested]

    if not args.dry_run:
        ensure_directory(args.cache)

    # Download everything before writing anything: a refresh must never apply
    # partially, or a later upload resolves against a half-updated cache.
    staged = []
    totals = {"rows": 0, "with_id": 0}
    started = time.time()

    log("")
    log("      %-22s %7s %9s" % ("dictionary", "rows", "with id"))
    log("      " + "-" * 40)

    for dictionary in wanted:
        try:
            rows, rights = fetch_dictionary(base, dictionary.slug)
        except RuntimeError as error:
            fail("%s: %s\n       nothing was written; the previous cache is intact."
                 % (dictionary.slug, error))

        legacy_by_uuid = attach_source_ids(rows)

        # `id` (when present) is kept, but under the `legacy_id` column, never
        # under `id` - that name is reserved for ritus's own local file, so the
        # two are never confused with each other.
        field_order = ["uuid", "legacy_id"]
        for row in rows:
            for key in row:
                if key not in field_order and key != "id":
                    field_order.append(key)

        out_rows = []
        for row in rows:
            row_uuid = row.get("uuid")
            if not row_uuid:
                continue
            record = {key: value for key, value in row.items() if key != "id"}
            record["uuid"] = row_uuid
            record["legacy_id"] = legacy_by_uuid.get(row_uuid, "")
            for key, value in list(record.items()):
                if isinstance(value, (list, dict)):
                    record[key] = json.dumps(value, ensure_ascii=False)
                elif value is None:
                    record[key] = ""
            out_rows.append(record)

        staged.append((dictionary, field_order, out_rows, rights, len(legacy_by_uuid)))
        totals["rows"] += len(out_rows)
        totals["with_id"] += len(legacy_by_uuid)

        log("      %-22s %7d %9d" % (dictionary.slug, len(out_rows), len(legacy_by_uuid)))

    log("      " + "-" * 40)
    log("      %-22s %7d %9d" % ("total", totals["rows"], totals["with_id"]))
    log("      %.1fs" % (time.time() - started))

    if args.dry_run:
        log("\n      --dry-run: %d dictionaries fetched, nothing written." % len(staged))
        return 0

    # Swap everything in at once, now that every download has succeeded.
    for dictionary, field_order, out_rows, rights, with_id in staged:
        write_tsv(os.path.join(args.cache, dictionary.filename), field_order, out_rows)
        sidecar = {
            "slug": dictionary.slug,
            "model": dictionary.label,
            "source": "%s/api/v1/dictionaries/%s/" % (base, dictionary.slug),
            "site_name": site_name,
            "fetched_at": now_iso(),
            "row_count": len(out_rows),
            "rows_with_id": with_id,
        }
        if rights:
            # A TSV on disk has no HTTP headers left to carry the licence.
            sidecar["rights"] = {
                "license": rights.get("license"),
                "license_url": rights.get("license_url"),
                "attribution": rights.get("attribution"),
                "required_statement": rights.get("required_statement"),
            }
        path = os.path.join(args.cache, "%s.meta.json" % dictionary.slug)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(sidecar, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

        if dictionary.slug in RUNTIME_INDEX_SLUGS:
            ensure_directory(args.index_out)
            write_runtime_index(args.index_out, dictionary, out_rows, base)

    log("\n      wrote %d dictionaries to %s" % (len(staged), args.cache))
    indexed = [d for d, _, _, _, _ in staged if d.slug in RUNTIME_INDEX_SLUGS]
    if indexed:
        log("      wrote %d browser index(es) to %s" % (len(indexed), args.index_out))
    return 0


def write_runtime_index(directory, dictionary, rows, base):
    """Emit the small lookup the browser fetches, instead of the full table."""
    by_legacy = {}
    by_name = {}
    for row in rows:
        row_uuid = row["uuid"]
        legacy = (row.get("legacy_id") or "").strip()
        if legacy:
            by_legacy.setdefault(legacy, row_uuid)
        for field in dictionary.remote_names:
            key = normalize(row.get(field))
            if key:
                by_name.setdefault(key, row_uuid)

    payload = {
        "slug": dictionary.slug,
        "source": "%s/api/v1/dictionaries/%s/" % (base, dictionary.slug),
        "fetched_at": now_iso(),
        "row_count": len(rows),
        "byLegacyId": by_legacy,
        "byName": by_name,
    }
    path = os.path.join(directory, "index-%s.json" % dictionary.slug)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, path)


# --------------------------------------------------------------------------- #
# Reading the ritus database
# --------------------------------------------------------------------------- #

def open_database(path):
    if not os.path.isfile(path):
        fail("no ritus database at %s" % path)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def iter_content(connection):
    """Yield (id, parsed dict) for every content row that holds valid JSON."""
    for row in connection.execute("SELECT id, data FROM content ORDER BY id"):
        try:
            parsed = json.loads(row["data"])
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            yield row["id"], parsed


def collect_values(connection, columns=None):
    """Every distinct non-empty value per dictionary column, with its frequency."""
    columns = tuple(columns) if columns is not None else tuple(BY_COLUMN)
    found = {column: {} for column in columns}
    total_rows = 0
    for _, data in iter_content(connection):
        total_rows += 1
        for column in columns:
            value = data.get(column)
            if is_blank(value):
                continue
            key = str(value).strip()
            found[column][key] = found[column].get(key, 0) + 1
    return found, total_rows


# --------------------------------------------------------------------------- #
# map
# --------------------------------------------------------------------------- #

def resolve_value(dictionary, value, cache):
    """Resolve one ritus value to a uuid. Returns (uuid, method, note).

    Order matters and mirrors the server's own precedence:
      1. already a uuid   - nothing to do
      2. an integer       - looked up against the cache's own legacy_id
                             column, which for rite-names and formulas is the
                             id eCatalogus itself returned - the source of
                             truth, not a guess
      3. matched by name  - the same columns the server matches on
      otherwise unresolved.
    """
    text = str(value).strip()
    index = cache.by_slug.get(dictionary.slug)
    if index is None:
        return None, "no-cache", "%s is not in the cache" % dictionary.slug

    if looks_like_uuid(text):
        if text in index["by_uuid"]:
            return text, "already-uuid", ""
        return None, "unknown-uuid", "uuid is not in the cache"

    if text.isdigit():
        cached = index["by_legacy"].get(text)
        if cached:
            return cached, "by-id", ""
        return None, "unresolved", "no entry with id %s" % text

    matched = index["by_name"].get(normalize(text))
    if matched:
        return matched, "by-name", ""
    return None, "unresolved", "no entry named %r" % text


def command_map(args):
    log("map   db=%s" % args.db)
    log("      cache=%s" % args.cache)
    log("      out=%s" % args.mapping)
    if args.dry_run:
        log("      --dry-run: nothing will be written")

    cache = Cache.load(args.cache)
    connection = open_database(args.db)
    try:
        values, total_rows = collect_values(connection, MIGRATED_COLUMNS)
        text_values, _ = collect_values(connection, TEXT_REFERENCE_COLUMNS)
    finally:
        connection.close()

    log("      %d content rows\n" % total_rows)
    log("      %-30s %8s %9s %8s %8s %11s"
        % ("column", "distinct", "by id", "by name", "uuid", "UNRESOLVED"))
    log("      " + "-" * 80)

    mappings = {}
    unresolved_rows = []
    grand = {"by-id": 0, "by-name": 0, "already-uuid": 0, "unresolved": 0}

    for column in sorted(MIGRATED_COLUMNS):
        dictionary = BY_COLUMN[column]
        distinct = values.get(column) or {}
        if not distinct:
            continue
        counts = {}
        rows = []
        for raw, occurrences in sorted(distinct.items()):
            resolved, method, note = resolve_value(dictionary, raw, cache)
            counts[method] = counts.get(method, 0) + 1
            if resolved:
                rows.append({
                    "legacy_value": raw,
                    "uuid": resolved,
                    "method": method,
                    "label": cache.name_of(dictionary.slug, resolved) or "",
                    "occurrences": occurrences,
                })
            else:
                unresolved_rows.append({
                    "column": column,
                    "slug": dictionary.slug,
                    "legacy_value": raw,
                    "occurrences": occurrences,
                    "reason": method,
                    "detail": note,
                })
        mappings[column] = rows

        unresolved_here = sum(
            count for method, count in counts.items()
            if method in ("unresolved", "unknown-uuid", "no-cache")
        )
        for key in ("by-id", "by-name", "already-uuid"):
            grand[key] += counts.get(key, 0)
        grand["unresolved"] += unresolved_here

        log("      %-30s %8d %9d %8d %8d %11d"
            % (column, len(distinct), counts.get("by-id", 0),
               counts.get("by-name", 0), counts.get("already-uuid", 0), unresolved_here))

    log("      " + "-" * 80)
    log("      %-30s %8s %9d %8d %8d %11d"
        % ("total", "", grand["by-id"], grand["by-name"],
           grand["already-uuid"], grand["unresolved"]))

    # The text columns are not migrated, but it is worth saying how much of the
    # table an editor still has to correct - a count here, the row-by-row detail
    # from Validate in the table editor.
    report_text_columns(cache, text_values)

    if args.dry_run:
        log("\n      --dry-run: nothing written.")
        if unresolved_rows:
            log("      %d value(s) would be reported unresolved." % len(unresolved_rows))
        return 0

    ensure_directory(args.mapping)
    for column, rows in mappings.items():
        write_tsv(
            os.path.join(args.mapping, "mapping-%s.tsv" % column),
            ["legacy_value", "uuid", "method", "label", "occurrences"],
            rows,
        )
    write_tsv(
        os.path.join(args.mapping, "unresolved.tsv"),
        ["column", "slug", "legacy_value", "occurrences", "reason", "detail"],
        unresolved_rows,
    )
    with open(os.path.join(args.mapping, "map.log.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "mapped_at": now_iso(),
            "database": os.path.abspath(args.db),
            "cache": os.path.abspath(args.cache),
            "content_rows": total_rows,
            "totals": grand,
            "columns": {column: len(rows) for column, rows in mappings.items()},
        }, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    log("\n      wrote %d mapping file(s) to %s" % (len(mappings), args.mapping))
    if unresolved_rows:
        log("      unresolved.tsv: %d value(s) - send this file to the eCatalogus editors."
            % len(unresolved_rows))
    else:
        log("      unresolved.tsv: empty - everything resolved.")
    return 0


# --------------------------------------------------------------------------- #
# apply
# --------------------------------------------------------------------------- #

def report_text_columns(cache, text_values):
    """Count values in the kept-as-text columns that no vocabulary recognises.

    These are not migration problems and never reach unresolved.tsv. They are
    transcription noise - "A", "AA", "A11A" - that the person who entered them
    fixes with Validate in the table editor, which names the row and column.
    """
    rows = []
    for column in sorted(TEXT_REFERENCE_COLUMNS):
        distinct = text_values.get(column) or {}
        if not distinct:
            continue
        dictionary = BY_COLUMN[column]
        index = cache.by_slug.get(dictionary.slug)
        if index is None:
            continue
        unknown = {
            value: count for value, count in distinct.items()
            if normalize(value) not in index["by_name"]
            and not looks_like_uuid(value)
        }
        rows.append((column, len(distinct), unknown))

    if not rows or not any(unknown for _, _, unknown in rows):
        return

    log("")
    log("      kept as text, not migrated - these need correcting in the table editor:")
    log("      %-30s %9s %11s %s" % ("column", "distinct", "unrecognised", "examples"))
    log("      " + "-" * 80)
    for column, distinct_count, unknown in rows:
        if not unknown:
            continue
        examples = ", ".join(
            repr(value) for value, _ in
            sorted(unknown.items(), key=lambda kv: -kv[1])[:4]
        )
        log("      %-30s %9d %11d %s"
            % (column, distinct_count, len(unknown), examples[:44]))
    log("")
    log("      Open the table in the editor and press Validate - it names the row")
    log("      and column for each one. They are also caught by dry_run at upload.")


def load_mappings(directory):
    if not os.path.isdir(directory):
        fail("no mapping directory at %s - run `map` first." % directory)
    mappings = {}
    for column in MIGRATED_COLUMNS:
        path = os.path.join(directory, "mapping-%s.tsv" % column)
        if not os.path.isfile(path):
            continue
        mappings[column] = {
            row["legacy_value"]: row["uuid"]
            for row in read_delimited(path)
            if row.get("legacy_value") and row.get("uuid")
        }
    if not mappings:
        fail("no mapping-*.tsv files in %s - run `map` first." % directory)
    return mappings


def command_apply(args):
    log("apply db=%s" % args.db)
    log("      mapping=%s" % args.mapping)
    if args.dry_run:
        log("      --dry-run: the database will not be written to")

    mappings = load_mappings(args.mapping)
    connection = open_database(args.db)

    changed_rows = 0
    already = 0
    per_column = {}
    updates = []

    try:
        for content_id, data in iter_content(connection):
            row_changed = False
            for column, table in mappings.items():
                value = data.get(column)
                if is_blank(value):
                    continue
                resolved = table.get(str(value).strip())
                if not resolved:
                    continue
                target = "%s_uuid" % column
                if data.get(target) == resolved:
                    already += 1
                    continue
                data[target] = resolved
                per_column[column] = per_column.get(column, 0) + 1
                row_changed = True
            if row_changed:
                changed_rows += 1
                updates.append((json.dumps(data, ensure_ascii=False), content_id))

        log("")
        for column in sorted(per_column):
            log("      %-30s %6d row(s) gain %s_uuid" % (column, per_column[column], column))
        if not per_column:
            log("      nothing to change - every mapped value already carries its uuid.")
        log("      %d row(s) to update, %d value(s) already correct" % (changed_rows, already))

        if args.dry_run:
            log("\n      --dry-run: database untouched.")
            return 0

        # One transaction for the whole table: a partial backfill would be
        # worse than none, because verify could not tell it from a complete one.
        with connection:
            connection.executemany("UPDATE content SET data = ? WHERE id = ?", updates)
    finally:
        connection.close()

    ensure_directory(args.mapping)
    with open(os.path.join(args.mapping, "apply.log.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "applied_at": now_iso(),
            "database": os.path.abspath(args.db),
            "rows_updated": changed_rows,
            "values_already_correct": already,
            "per_column": per_column,
        }, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    log("\n      committed. %d row(s) updated." % changed_rows)
    return 0


# --------------------------------------------------------------------------- #
# verify
# --------------------------------------------------------------------------- #

def command_verify(args):
    log("verify db=%s" % args.db)
    log("       cache=%s" % args.cache)

    cache = Cache.load(args.cache)
    connection = open_database(args.db)

    missing = {}
    unknown = {}
    checked = 0
    total_rows = 0
    try:
        for _, data in iter_content(connection):
            total_rows += 1
            for column in MIGRATED_COLUMNS:
                dictionary = BY_COLUMN[column]
                value = data.get(column)
                if is_blank(value):
                    continue
                checked += 1
                resolved = data.get("%s_uuid" % column)
                if is_blank(resolved):
                    missing[column] = missing.get(column, 0) + 1
                    continue
                if not cache.entry(dictionary.slug, str(resolved).strip()):
                    unknown[column] = unknown.get(column, 0) + 1
    finally:
        connection.close()

    log("       %d content rows, %d dictionary value(s) checked\n" % (total_rows, checked))

    problems = 0
    if missing:
        log("       values with no uuid:")
        for column in sorted(missing):
            log("         %-30s %6d" % (column, missing[column]))
            problems += missing[column]
    if unknown:
        log("       uuids absent from the cache:")
        for column in sorted(unknown):
            log("         %-30s %6d" % (column, unknown[column]))
            problems += unknown[column]

    if problems == 0:
        log("       OK - every dictionary value carries a uuid present in the cache.")
        return 0

    log("\n       %d problem(s). Re-run `map` then `apply`; anything still listed in"
        % problems)
    log("       unresolved.tsv needs the term adding in eCatalogus first.")
    return 1


# --------------------------------------------------------------------------- #
# sync - carry new eCatalogus terms into ritus's own dictionaries
# --------------------------------------------------------------------------- #

# Every local dictionary the table editor draws its dropdowns from, and how
# `sync` recognises a row it already has.
#
# Ten are keyed by NAME or SHORT NAME - a new row is just a new option, and
# duplicates are avoided by normalized-name comparison.
#
# `rite_names.csv` and `formulas.csv` are keyed by `id` instead, because that
# is how the table editor has always referenced them (`rite_id`, `formula_id`
# are plain integer columns). eCatalogus publishes `id` for exactly these two
# dictionaries, straight from the canonical instance, and for `rite_names.csv`
# it is trustworthy as-is: it agrees with ritus's own numbering, no guessing.
#
# `formulas.csv` is listed here too, but `sync_one` will refuse to write to it:
# eCatalogus's `id` for formulas is a plain, unrelated autoincrement that only
# coincidentally matches ritus's numbering for the first few rows (see
# id_scheme_trustworthy below). It stays effectively manual until eCatalogus
# publishes the real legacy number per row, not just per queried candidate.
SYNCABLE = {
    "functions.csv": ("content-functions", "name", ("id", "name", "parent_function")),
    "sections.tsv": ("sections", "name", ("id", "name")),
    "liturgical_genres.tsv": ("liturgical-genres", "title", ("id", "name")),
    "music_notation.tsv": ("music-notation-names", "name", ("id", "name")),
    "layer.tsv": ("layers", "short_name", ("short_name", "name", "id")),
    "mass_hour.tsv": ("mass-hours", "short_name", ("short_name", "name", "id", "type")),
    "genre.tsv": ("genres", "short_name", ("name", "short_name")),
    "season_month.tsv": ("seasons-and-months", "short_name", ("kind", "short_name", "name", "id", "types")),
    "week.tsv": ("weeks", "short_name", ("short_name", "name", "id", "types")),
    "day.tsv": ("days", "short_name", ("part", "short_name", "name", "id", "types")),
    "rite_names.csv": ("rite-names", "id", ("id", "text", "english_translation", "votive", "section_id")),
    "formulas.csv": ("formulas", "id", ("id", "co_no", "text")),
}


def build_id_keyed_row(filename, remote_row, legacy_id, local_dir):
    """Build a new row for the two dictionaries the editor keys by `id`.

    Both files carry fields with no equivalent column on the other, so this is
    written per file rather than as one generic mapping.
    """
    if filename == "formulas.csv":
        return {
            "id": legacy_id,
            "co_no": remote_row.get("co_no") or "",
            "text": remote_row.get("text") or "",
        }

    # rite_names.csv: `section_id` is a foreign key into ritus's own
    # sections.tsv, by ritus's local numeric id - not something eCatalogus
    # knows. It is resolved here by name against sections.tsv directly
    # (section_label, which every rite-names row carries), the same way every
    # other text reference column in this file is matched. No derivation.
    sections_by_name = {
        normalize(row.get("name")): (row.get("id") or "").strip()
        for row in read_delimited(os.path.join(local_dir, "sections.tsv"))
        if row.get("name")
    }
    section_id = sections_by_name.get(normalize(remote_row.get("section_label")), "") or "NULL"
    votive = "1" if normalize(remote_row.get("votive")) == "true" else "NULL"
    return {
        "id": legacy_id,
        "text": remote_row.get("name") or "",
        "english_translation": remote_row.get("english_translation") or "",
        "votive": votive,
        "section_id": section_id,
    }


# For the two `id`-keyed files: which local column and which remote field to
# compare, to check the id scheme actually agrees before trusting it.
ID_KEYED_CONFIRM_FIELD = {
    "rite_names.csv": ("text", "name"),
    "formulas.csv": ("text", "text"),
}


def id_scheme_trustworthy(local_rows, local_col, remote_field, remote_rows, sample_size=50):
    """Sanity-check eCatalogus's `id` against ritus's own numbering before
    keying new rows on it.

    eCatalogus publishes `id` for exactly two dictionaries. For one of them
    it is genuinely the same numbering ritus has always used. For the other,
    live testing found it is not: `id` is a fresh, unrelated autoincrement
    that only coincidentally agrees for the first few rows before silently
    diverging - trusting it would interleave thousands of rows under the
    wrong local id. So: before adding anything, sample local rows whose `id`
    also appears as a cached `legacy_id`, and check the descriptive text
    agrees. Anything less than a clean match means the id scheme cannot be
    trusted for this file, and nothing is added.
    """
    by_legacy = {}
    for row in remote_rows:
        legacy = (row.get("legacy_id") or "").strip()
        if legacy:
            by_legacy.setdefault(legacy, row)

    candidates = [row for row in local_rows if (row.get("id") or "").strip() in by_legacy]
    if not candidates:
        return True, 0, 0  # nothing to check against yet; do not block on it

    sample = candidates[:sample_size]
    agree = sum(
        1 for local_row in sample
        if normalize(local_row.get(local_col))
        == normalize(by_legacy[(local_row.get("id") or "").strip()].get(remote_field))
    )
    return agree == len(sample), agree, len(sample)


def sync_one(local_dir, filename, cache, dry_run):
    """Append eCatalogus entries the local dictionary does not have yet."""
    slug, key_source, columns = SYNCABLE[filename]
    index = cache.by_slug.get(slug)
    path = os.path.join(local_dir, filename)
    if index is None or not os.path.isfile(path):
        return None

    local_rows = read_delimited(path)
    additions = []

    if key_source == "id":
        local_col, remote_field = ID_KEYED_CONFIRM_FIELD[filename]
        trustworthy, agree, sampled = id_scheme_trustworthy(
            local_rows, local_col, remote_field, index["rows"])
        if not trustworthy:
            return {
                "file": filename, "slug": slug, "local": len(local_rows),
                "added": 0, "examples": [],
                "warning": (
                    "id scheme does not match ritus's numbering here (%d/%d "
                    "sampled entries disagree) - nothing added, to avoid "
                    "duplicating rows under the wrong id" % (sampled - agree, sampled)
                ),
            }
        existing = {(row.get("id") or "").strip() for row in local_rows}
        for row in index["rows"]:
            legacy_id = (row.get("legacy_id") or "").strip()
            if not legacy_id or legacy_id in existing:
                continue
            additions.append(build_id_keyed_row(filename, row, legacy_id, local_dir))
            existing.add(legacy_id)
    else:
        # The editor's key column in the local file has the same meaning as
        # key_source in the cache, whatever it is called locally.
        local_key_col = "short_name" if key_source == "short_name" else "name"
        existing = {normalize(row.get(local_key_col)) for row in local_rows}
        for row in index["rows"]:
            value = row.get(key_source)
            if is_blank(value) or normalize(value) in existing:
                continue
            new_row = {column: "" for column in columns}
            if "name" in new_row:
                new_row["name"] = row.get("name") or row.get("title") or value
            if "short_name" in new_row:
                new_row["short_name"] = row.get("short_name") or value
            additions.append(new_row)
            existing.add(normalize(value))

    if additions and not dry_run:
        # Append rather than rewrite: existing rows, their order and their ids
        # are what the stored data refers to, and must not move.
        delimiter = "\t" if filename.endswith(".tsv") else ","
        # Several of these files have no trailing newline. Appending blindly
        # would splice the first new row onto the last existing one, corrupting
        # both - and the corrupted key then reads as "still missing" on the next
        # run, so it would keep appending forever.
        needs_newline = False
        if os.path.getsize(path):
            with open(path, "rb") as probe:
                probe.seek(-1, os.SEEK_END)
                needs_newline = probe.read(1) not in (b"\n", b"\r")
        with open(path, "a", encoding="utf-8", newline="") as handle:
            if needs_newline:
                handle.write("\n")
            writer = csv.DictWriter(handle, fieldnames=columns, delimiter=delimiter,
                                    extrasaction="ignore", lineterminator="\n")
            for row in additions:
                writer.writerow(row)

    return {"file": filename, "slug": slug, "local": len(local_rows),
            "added": len(additions),
            "examples": [r.get("name") or r.get("short_name") or r.get("text")
                         for r in additions[:4]]}


def command_sync(args):
    """Bring new eCatalogus terms into ritus's own dictionaries. No network."""
    log("sync  local=%s" % args.local_dicts)
    log("      cache=%s" % args.cache)
    if args.dry_run:
        log("      --dry-run: nothing will be written")
    if not args.local_dicts:
        fail("cannot find ritus's own dictionaries - pass --local-dicts.")

    cache = Cache.load(args.cache)

    log("")
    log("      %-24s %8s %7s  %s" % ("dictionary", "local", "new", "examples"))
    log("      " + "-" * 74)
    total_added = 0
    results = []
    for filename in sorted(SYNCABLE):
        outcome = sync_one(args.local_dicts, filename, cache, args.dry_run)
        if outcome is None:
            continue
        results.append(outcome)
        total_added += outcome["added"]
        examples = ", ".join(str(e) for e in outcome["examples"] if e)
        log("      %-24s %8d %7d  %s"
            % (filename, outcome["local"], outcome["added"], examples[:34]))
        if outcome.get("warning"):
            log("        ! %s" % outcome["warning"])
    log("      " + "-" * 74)
    log("      %-24s %8s %7d" % ("total", "", total_added))

    if args.dry_run:
        log("\n      --dry-run: nothing written.")
    elif total_added:
        log("\n      %d new option(s) added. Rebuild the client (or reload, on a"
            " deployed\n      server) for them to appear in the dropdowns." % total_added)
    else:
        log("\n      ritus dictionaries already have every eCatalogus term.")

    if getattr(args, "json_out", None):
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump({"synced_at": now_iso(), "total_added": total_added,
                       "dictionaries": results}, handle, ensure_ascii=False, indent=2)
    return 0


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def build_parser():
    parser = argparse.ArgumentParser(
        prog="ecatalogus_dicts.py",
        description="Pull the eCatalogus vocabularies and migrate ritus onto UUIDs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Migration: pull, map --dry-run, map, apply --dry-run, apply, verify. "
               "Ongoing upkeep: pull, sync.",
    )
    subparsers = parser.add_subparsers(dest="command")

    def add_common(sub, network=False):
        if network:
            sub.add_argument("--source", default=DEFAULT_SOURCE,
                             help="canonical eCatalogus instance (default: %(default)s)")
        sub.add_argument("--db", default=DEFAULT_DB, help="ritus SQLite database")
        sub.add_argument("--cache", default=DEFAULT_CACHE, help="dictionary cache directory")
        sub.add_argument("--index-out", default=None,
                         help="where the compact browser indexes are written "
                              "(default: autodetected from the layout)")
        sub.add_argument("--local-dicts", default=None,
                         help="ritus's own dictionaries: ritus-client/public/data in a "
                              "checkout, ritus-server/static/data on a deployed server "
                              "(default: autodetected)")
        sub.add_argument("--mapping", default=DEFAULT_MAPPING, help="mapping output directory")
        sub.add_argument("--dry-run", action="store_true", help="report, write nothing")

    pull = subparsers.add_parser("pull", help="download the vocabularies into the cache")
    add_common(pull, network=True)
    pull.add_argument("--only", help="comma-separated slugs, for a partial refresh")

    add_common(subparsers.add_parser("map", help="resolve every ritus value to a uuid"))
    add_common(subparsers.add_parser("apply", help="write the uuids into the database"))
    add_common(subparsers.add_parser("verify", help="re-check; non-zero exit if incomplete"))

    sync = subparsers.add_parser(
        "sync", help="add new eCatalogus terms to ritus's own dictionaries")
    add_common(sync)
    sync.add_argument("--json-out", help="also write the diff as JSON")

    return parser


def resolve_layout(args):
    """Fill in the paths that depend on where this is running, and say so.

    Printing them is the point: the checkout and the deployed server put ritus's
    dictionaries in different places, and a silent wrong guess produces a cache
    with no legacy ids, which only surfaces later as an unresolvable `map`.
    """
    if not getattr(args, "local_dicts", None):
        args.local_dicts = find_local_dict_dir()
    if not getattr(args, "index_out", None):
        args.index_out = (
            os.path.join(args.local_dicts, "ecatalogus")
            if args.local_dicts else find_index_out()
        )

    if args.command in ("pull", "sync"):
        if not args.local_dicts:
            fail(
                "cannot find ritus's own dictionaries (looked for %s in:\n  %s\n"
                "Pass --local-dicts with the directory holding formulas.csv and "
                "rite_names.csv." % (
                    LOCAL_DICT_MARKER, "\n  ".join(LOCAL_DICT_CANDIDATES))
            )
        log("      dictionaries: %s" % args.local_dicts)
        log("      indexes     : %s" % args.index_out)


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    resolve_layout(args)
    handler = {
        "pull": command_pull,
        "map": command_map,
        "apply": command_apply,
        "verify": command_verify,
        "sync": command_sync,
    }[args.command]
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
