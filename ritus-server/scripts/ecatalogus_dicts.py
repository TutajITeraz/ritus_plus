#!/usr/bin/env python3
"""
TITLE: ecatalogus_dicts.py
DESCRIPTION: Pulls the eCatalogus controlled vocabularies into a local cache and
  migrates the ritus content rows off the instance-local integer ids onto UUIDs.

  Four re-runnable subcommands, meant to be run in this order:

      pull    download the vocabularies from the canonical eCatalogus instance
      map     work out a uuid for every dictionary value ritus holds
      apply   write those uuids into the ritus database
      verify  re-check the result; exits non-zero if anything regressed

  Steps 2-4 never touch the network. They read the cache written by step 1, so a
  run on the developer's machine and a run on production against the same cache
  produce the same mapping. That is the whole reason the steps are separate.

WHY THIS EXISTS:
  eCatalogus assigns each dictionary row an autoincrement `id` that differs per
  instance - RiteNames "apostoli plures" is id 1 on MPL Limbo, 4565 on Liturgica
  Poloniae and 9129 on Corpus Liturgicum, while its uuid is the same everywhere.
  ritus stored those integers. Resolving them against whichever instance is being
  uploaded to therefore yields a valid uuid for the wrong entry: the import
  succeeds and the data is wrong. The uuid is the only cross-instance identifier.

HOW A LEGACY ID BECOMES A UUID:
  When the legacy database was migrated into eCatalogus every row was given a
  uuid derived from its old primary key, and ritus's ids are that same old
  numbering:

      uuid5(NAMESPACE, "indexerapp.RiteNames:1") -> 0d6b1e87-...-a14d78895b30

  Derivation alone is not enough. In functions.csv, id 81 ("Prefatio") derives to
  a uuid that exists on the server and holds "Super oblata" - a silent
  mis-mapping. So a derived uuid is accepted only when the cached entry it points
  at carries the same name ritus has. Anything else falls through to matching by
  name, and then to the unresolved report.

USAGE:
  python3 scripts/ecatalogus_dicts.py pull
  python3 scripts/ecatalogus_dicts.py map    --dry-run
  python3 scripts/ecatalogus_dicts.py map
  python3 scripts/ecatalogus_dicts.py apply  --dry-run
  python3 scripts/ecatalogus_dicts.py apply
  python3 scripts/ecatalogus_dicts.py verify

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
# The browser gets only the compact indexes, which are served as static files.
DEFAULT_INDEX_OUT = os.path.join(REPO_ROOT, "ritus-client", "public", "data", "ecatalogus")
DEFAULT_MAPPING = os.path.join(SERVER_DIR, "data", "migration")
LOCAL_DICT_DIR = os.path.join(REPO_ROOT, "ritus-client", "public", "data")

# The namespace eCatalogus used when it derived uuids from the legacy primary
# keys. Verified against live data: 4564/4564 rite names and 13228/13228 formulas
# in ritus's own CSVs reproduce exactly.
LEGACY_NAMESPACE = uuid.UUID("8e7f6f8a-cc0f-4e6f-a7af-c7a7e9d1f4e3")

PAGE_SIZE = 1000
HTTP_TIMEOUT = 180

UUID_LENGTH = 36


class Dictionary:
    """One controlled vocabulary, and how ritus refers to it.

    slug          the eCatalogus dictionary endpoint
    label         the Django model label, used for the uuid derivation
    remote_names  entry fields a ritus value may be matched against, in order
    ritus_columns the content columns that reference this vocabulary
    local_csv     ritus's own copy, used to attach legacy ids to the cache
    local_id      the id column in that file (None when it has none)
    local_name    the column in that file holding the name
    """

    def __init__(self, slug, label, remote_names, ritus_columns,
                 local_csv=None, local_id=None, local_name=None):
        self.slug = slug
        self.label = label
        self.remote_names = remote_names
        self.ritus_columns = ritus_columns
        self.local_csv = local_csv
        self.local_id = local_id
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
               ("rite_id",), "rite_names.csv", "id", "text"),
    Dictionary("formulas", "indexerapp.Formulas", (),
               ("formula_id",), "formulas.csv", "id", "text"),
    Dictionary("content-functions", "indexerapp.ContentFunctions", ("name",),
               ("function_id", "subfunction_id"), "functions.csv", "id", "name"),
    Dictionary("sections", "indexerapp.Sections", ("name",),
               ("section_id", "subsection_id"), "sections.tsv", "id", "name"),
    Dictionary("liturgical-genres", "indexerapp.LiturgicalGenres", ("title",),
               ("liturgical_genre_id",), "liturgical_genres.tsv", "id", "name"),
    Dictionary("layers", "indexerapp.Layer", ("short_name", "name"),
               ("layer",), "layer.tsv", "id", "name"),
    Dictionary("mass-hours", "indexerapp.MassHour", ("short_name", "name"),
               ("mass_hour",), "mass_hour.tsv", "id", "name"),
    Dictionary("genres", "indexerapp.Genre", ("short_name", "name"),
               ("genre",), "genre.tsv", None, "name"),
    Dictionary("seasons-and-months", "indexerapp.SeasonMonth", ("short_name", "name"),
               ("season_month",), "season_month.tsv", "id", "name"),
    Dictionary("weeks", "indexerapp.Week", ("short_name", "name"),
               ("week",), "week.tsv", "id", "name"),
    Dictionary("days", "indexerapp.Day", ("short_name", "name"),
               ("day",), "day.tsv", "id", "name"),
    Dictionary("text-standarization", "indexerapp.TextStandarization",
               ("usu_id", "standard_incipit"),
               ("text_standarization__usu_id",), None, None, None),
    Dictionary("music-notation-names", "indexerapp.MusicNotationNames", ("name",),
               ("music_notation_id",), "music_notation.tsv", "id", "name"),
    Dictionary("contributors", "indexerapp.Contributors", ("initials",),
               ("contributor_id",), None, None, None),
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


def derive_uuid(label, legacy_id):
    return str(uuid.uuid5(LEGACY_NAMESPACE, "%s:%d" % (label, int(legacy_id))))


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


def attach_legacy_ids(dictionary, remote_rows):
    """Give each cached entry the integer id ritus has always used for it.

    The id is taken from ritus's own copy of the vocabulary, not from the
    server: the server's `id` is instance-local and is on its way out of the
    API. A local id is accepted for an entry when the uuid derived from it
    points at that entry AND the names agree; otherwise the entry is matched by
    name. Anything left over has no legacy id, which is correct - it is an entry
    ritus has never seen.
    """
    stats = {"derived": 0, "by_name": 0, "no_legacy_id": 0, "rejected": 0}
    if not dictionary.local_csv or not dictionary.local_id:
        stats["no_legacy_id"] = len(remote_rows)
        return {}, stats

    path = os.path.join(LOCAL_DICT_DIR, dictionary.local_csv)
    if not os.path.isfile(path):
        log("    ! ritus dictionary %s not found; cache will carry no legacy ids"
            % dictionary.local_csv)
        stats["no_legacy_id"] = len(remote_rows)
        return {}, stats

    by_uuid = {row["uuid"]: row for row in remote_rows if row.get("uuid")}
    by_name = {}
    for row in remote_rows:
        for field in dictionary.remote_names or ():
            key = normalize(row.get(field))
            if key:
                by_name.setdefault(key, row["uuid"])
    # Formulas declare no name lookup on the server, but the local text is still
    # the only way to confirm a derived uuid points at the right row.
    confirm_fields = dictionary.remote_names or ("text",)

    legacy_by_uuid = {}
    for local_row in read_delimited(path):
        raw_id = (local_row.get(dictionary.local_id) or "").strip()
        if not raw_id.isdigit():
            continue
        local_name = normalize(local_row.get(dictionary.local_name))

        candidate = derive_uuid(dictionary.label, raw_id)
        remote_row = by_uuid.get(candidate)
        if remote_row is not None:
            names = [normalize(remote_row.get(f)) for f in confirm_fields]
            if local_name and local_name in names:
                legacy_by_uuid.setdefault(candidate, raw_id)
                stats["derived"] += 1
                continue
            # The derived uuid exists but describes something else. This is the
            # silent mis-mapping the whole exercise is about - never take it.
            stats["rejected"] += 1

        matched = by_name.get(local_name) if local_name else None
        if matched:
            legacy_by_uuid.setdefault(matched, raw_id)
            stats["by_name"] += 1

    stats["no_legacy_id"] = len(remote_rows) - len(legacy_by_uuid)
    return legacy_by_uuid, stats


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
    totals = {"rows": 0, "derived": 0, "by_name": 0, "rejected": 0}
    started = time.time()

    log("")
    log("      %-22s %7s %8s %8s %9s" % ("dictionary", "rows", "derived", "by name", "no id"))
    log("      " + "-" * 58)

    for dictionary in wanted:
        try:
            rows, rights = fetch_dictionary(base, dictionary.slug)
        except RuntimeError as error:
            fail("%s: %s\n       nothing was written; the previous cache is intact."
                 % (dictionary.slug, error))

        legacy_by_uuid, stats = attach_legacy_ids(dictionary, rows)

        # `id` is the server's own autoincrement. It is instance-local, it is
        # being removed from the API, and caching it is what made the whole
        # mis-mapping look reasonable. It is dropped here deliberately.
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

        staged.append((dictionary, field_order, out_rows, rights, stats))
        totals["rows"] += len(out_rows)
        totals["derived"] += stats["derived"]
        totals["by_name"] += stats["by_name"]
        totals["rejected"] += stats["rejected"]

        log("      %-22s %7d %8d %8d %9d"
            % (dictionary.slug, len(out_rows), stats["derived"],
               stats["by_name"], stats["no_legacy_id"]))
        if stats["rejected"]:
            log("        ^ %d local id(s) rejected: the derived uuid exists but "
                "names a different entry" % stats["rejected"])

    log("      " + "-" * 58)
    log("      %-22s %7d %8d %8d" % ("total", totals["rows"], totals["derived"], totals["by_name"]))
    log("      %.1fs" % (time.time() - started))

    if args.dry_run:
        log("\n      --dry-run: %d dictionaries fetched, nothing written." % len(staged))
        return 0

    # Swap everything in at once, now that every download has succeeded.
    for dictionary, field_order, out_rows, rights, stats in staged:
        write_tsv(os.path.join(args.cache, dictionary.filename), field_order, out_rows)
        sidecar = {
            "slug": dictionary.slug,
            "model": dictionary.label,
            "source": "%s/api/v1/dictionaries/%s/" % (base, dictionary.slug),
            "site_name": site_name,
            "fetched_at": now_iso(),
            "row_count": len(out_rows),
            "legacy_ids_derived": stats["derived"],
            "legacy_ids_by_name": stats["by_name"],
            "legacy_ids_rejected": stats["rejected"],
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


def collect_values(connection):
    """Every distinct non-empty value per dictionary column, with its frequency."""
    found = {column: {} for column in BY_COLUMN}
    total_rows = 0
    for _, data in iter_content(connection):
        total_rows += 1
        for column in BY_COLUMN:
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
      1. already a uuid            - nothing to do
      2. an integer, derived       - only when the cached entry's name agrees
      3. matched by name           - the same columns the server matches on
      4. an integer, cached        - the cache's own legacy_id column
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
        candidate = derive_uuid(dictionary.label, text)
        entry = index["by_uuid"].get(candidate)
        if entry is not None:
            legacy = (entry.get("legacy_id") or "").strip()
            if legacy == text:
                return candidate, "derived", ""
            # Derivable but the cache attributes that id to a different entry.
            return None, "derivation-rejected", (
                "derived uuid holds %r, whose legacy id is %s"
                % (cache.name_of(dictionary.slug, candidate), legacy or "unset"))
        cached = index["by_legacy"].get(text)
        if cached:
            return cached, "cached-legacy-id", ""
        return None, "unresolved", "no entry with legacy id %s" % text

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
        values, total_rows = collect_values(connection)
    finally:
        connection.close()

    log("      %d content rows\n" % total_rows)
    log("      %-30s %8s %9s %8s %8s %11s"
        % ("column", "distinct", "derived", "by name", "uuid", "UNRESOLVED"))
    log("      " + "-" * 80)

    mappings = {}
    unresolved_rows = []
    grand = {"derived": 0, "by-name": 0, "already-uuid": 0, "unresolved": 0}

    for column, dictionary in sorted(BY_COLUMN.items()):
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
            if method in ("unresolved", "unknown-uuid", "derivation-rejected", "no-cache")
        )
        for key in ("derived", "by-name", "already-uuid"):
            grand[key] += counts.get(key, 0)
        grand["unresolved"] += unresolved_here

        log("      %-30s %8d %9d %8d %8d %11d"
            % (column, len(distinct), counts.get("derived", 0) + counts.get("cached-legacy-id", 0),
               counts.get("by-name", 0), counts.get("already-uuid", 0), unresolved_here))

    log("      " + "-" * 80)
    log("      %-30s %8s %9d %8d %8d %11d"
        % ("total", "", grand["derived"], grand["by-name"],
           grand["already-uuid"], grand["unresolved"]))

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

def load_mappings(directory):
    if not os.path.isdir(directory):
        fail("no mapping directory at %s - run `map` first." % directory)
    mappings = {}
    for column in BY_COLUMN:
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
            for column, dictionary in BY_COLUMN.items():
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
# Entry point
# --------------------------------------------------------------------------- #

def build_parser():
    parser = argparse.ArgumentParser(
        prog="ecatalogus_dicts.py",
        description="Pull the eCatalogus vocabularies and migrate ritus onto UUIDs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run in order: pull, map --dry-run, map, apply --dry-run, apply, verify.",
    )
    subparsers = parser.add_subparsers(dest="command")

    def add_common(sub, network=False):
        if network:
            sub.add_argument("--source", default=DEFAULT_SOURCE,
                             help="canonical eCatalogus instance (default: %(default)s)")
        sub.add_argument("--db", default=DEFAULT_DB, help="ritus SQLite database")
        sub.add_argument("--cache", default=DEFAULT_CACHE, help="dictionary cache directory")
        sub.add_argument("--index-out", default=DEFAULT_INDEX_OUT,
                         help="where the compact browser indexes are written")
        sub.add_argument("--mapping", default=DEFAULT_MAPPING, help="mapping output directory")
        sub.add_argument("--dry-run", action="store_true", help="report, write nothing")

    pull = subparsers.add_parser("pull", help="download the vocabularies into the cache")
    add_common(pull, network=True)
    pull.add_argument("--only", help="comma-separated slugs, for a partial refresh")

    add_common(subparsers.add_parser("map", help="resolve every ritus value to a uuid"))
    add_common(subparsers.add_parser("apply", help="write the uuids into the database"))
    add_common(subparsers.add_parser("verify", help="re-check; non-zero exit if incomplete"))

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    handler = {
        "pull": command_pull,
        "map": command_map,
        "apply": command_apply,
        "verify": command_verify,
    }[args.command]
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
