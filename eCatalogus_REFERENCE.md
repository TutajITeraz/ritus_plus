# eCatalogus integration — reference

Every file, every endpoint, and — field by field — whether ritus keeps a **name**,
a **legacy id** or a **UUID**.

Companion to `eCatalogus_MIGRATION.md`, which explains how to run the migration.
This document is the "what is where" list.

---

## 1. The rule, in one line

> **Names travel. UUIDs identify. Legacy integers stay home.**

eCatalogus gives every dictionary row a UUID that means the same thing on every
instance. Two dictionaries — `rite-names` and `formulas` — also publish a plain
numeric `id`; every other dictionary publishes `uuid` only. So:

- a **name** is safe to send: the importer resolves it the same way everywhere;
- a **UUID** is safe to store and send: it means the same thing on every instance;
- a **legacy integer** is safe only inside ritus, as a join key to our own rows.
  It is never sent to eCatalogus. Whether it is safe to *read* from eCatalogus's
  `id` field depends on the dictionary — see §5, trap 3. It agrees with ritus's
  own numbering for `rite-names`; it does not for `formulas`.

---

## 2. What the ritus database keeps, per column

Content rows live in `content.data` — one JSON object per row, not real columns.
"Stored now" is what that JSON holds today.

### 2.1 Dictionary references

**Migrated — an opaque id, so it must become a UUID.** These three, and only
these three:

| ritus column | Stored now | Migration adds | Sent to eCatalogus as | eCatalogus field |
|---|---|---|---|---|
| `rite_id` | **legacy id** (int) | `rite_id_uuid` | **UUID** (from local cache) | `rubric_id` |
| `formula_id` | **legacy id** (int) | `formula_id_uuid` | **UUID** (from local cache) | `formula_id` |
| `text_standarization__usu_id` | **Usuarium id** (text) | `text_standarization__usu_id_uuid` | **UUID** (from local cache) | `text_standarization` |

**Kept as text — the value is already portable, so there is nothing to migrate.**
The importer resolves these itself, case-insensitively, the same way on every
instance:

| ritus column | Stored | Sent to eCatalogus as | eCatalogus field |
|---|---|---|---|
| `function_id` / `subfunction_id` | **name** | name, verbatim | same |
| `section_id` / `subsection_id` | **name** | name, verbatim | same |
| `liturgical_genre_id` | **name** | name, verbatim | same |
| `music_notation_id` | **name** | name, verbatim | same |
| `contributor_id` | **initials** | initials, verbatim | same |
| `layer`, `mass_hour`, `genre`, `season_month`, `week`, `day` | **short name** | short name, verbatim | same |

**The migration deliberately does not touch these.** It could add a `*_uuid` for
them, but that would turn ordinary data-entry noise into migration blockers: a
`function_id` column holding `"A"`, `"AA"`, `"A11A"` is a table that needs
correcting by the person who transcribed it, not something a script can decide.
Those values stay exactly as they are, and are caught in two places that name the
row: **Validate** in the table editor, and `dry_run` at upload.

`map` still counts them, as a heads-up rather than a blocker:

```
kept as text, not migrated - these need correcting in the table editor:
column                          distinct unrecognised examples
function_id                           11            8 'A', 'A11A', 'A1A', 'AA'
layer                                  2            1 'ZZZ'
```

`unresolved.tsv` therefore contains only genuine migration blockers — an opaque
id with no eCatalogus counterpart — which is what makes it worth sending to the
editors.

**Legacy integer columns are kept, not deleted.** They are the provenance of the
migration and the join key if it ever has to be re-run. They are simply never
read for anything API-facing.

**Where a `*_uuid` exists it wins.** The upload resolves in this order: `*_uuid`
on the row → a value that already is a UUID → a name sent verbatim → the local
cache. So after the migration, no lookup happens at all for migrated rows.

### 2.2 Dropped — nothing in the API can resolve them

| ritus column | Stored now | Why it cannot be sent |
|---|---|---|
| `quire_id` | legacy id (int) | Quires belong to one manuscript, not to a shared vocabulary. No `quires` dictionary exists, and none will. |
| `edition_index` | text | No read endpoint for `EditionContent`. |
| `edition_subindex` | text | Only meaningful beside `edition_index`. |

The dialog drops these with a visible notice rather than failing the upload.

### 2.3 Plain values — copied across, no lookup

| ritus column | Type | eCatalogus field |
|---|---|---|
| `sequence_in_ms` | integer | `sequence_in_ms` |
| `rite_sequence_in_the_MS` | integer | `rubric_sequence_in_the_MS` |
| `digital_page_number` | integer | `digital_page_number` |
| `where_in_ms_from` / `where_in_ms_to` | text | same |
| `formula_text_from_ms` | text | same |
| `rite_name_from_ms` | text | `rubric_name_from_ms` |
| `subrite_name_from_ms` | text | `subrubric_name_from_ms` |
| `original_or_added` | text | uppercased |
| `biblical_reference`, `reference_to_other_items`, `comments` | text | same |
| `similarity_by_user` | text | same |
| `proper_texts` | boolean | same |

Note the vocabulary difference: ritus says **rite**, eCatalogus says **rubric**.

### 2.4 Never sent

`id`, `manuscript_id`, `entry_date` are ritus-local. `formula_standardized`,
`rite_name_standarized` and `levenshtein` are derived from another column for
display. None is in the payload.

---

## 3. Files

### 3.1 Code

| File | What it is |
|---|---|
| `ritus-client/src/utils/ecatalogus.js` | API client, field map, name/UUID resolution |
| `ritus-client/src/components/ECatalogusUploadDialog.jsx` | The "Send to eCatalogus" dialog |
| `ritus-client/src/components/DataTable.jsx` | *(modified)* the toolbar button, after Validate |
| `ritus-client/src/pages/TableEditor.jsx` | *(modified)* passes `structureKey` through |
| `ritus-client/src/components/ECatalogusDictionaries.jsx` | Admin panel: refresh the vocabularies, see what changed |
| `ritus-server/scripts/ecatalogus_dicts.py` | `pull` / `map` / `apply` / `verify` / `sync` |
| `ritus-server/scripts/ecatalogus_migrate.sh` | Runs the migration steps in order, with dry runs |
| `ritus-server/krakenServer.py` | *(modified)* `GET`/`POST /api/admin/dictionaries[/refresh]` |
| `ritus-server/package.sh` | *(modified)* ships `scripts/` and `data/` in the zip |

### 3.2 Data

| Path | Contents | Size | In git? | Reaches production via |
|---|---|---|---|---|
| `ritus-server/data/ecatalogus/*.tsv` | Full vocabularies, keyed by `uuid`, with a `legacy_id` column. **No `id` column.** | 7.3 MB | yes | `package.sh` zip |
| `ritus-server/data/ecatalogus/*.meta.json` | Per-file sidecar: source, `fetched_at`, row count, CC-BY rights | small | yes | `package.sh` zip |
| `ritus-client/public/data/ecatalogus/index-*.json` | Compact browser lookups for `formulas`, `rite-names`, `text-standarization`. On a deployed server the same files live at `ritus-server/static/data/ecatalogus/` | 1.1 MB | **no** — `public/data` is gitignored | `npm run build` → `dist` → `package.sh`, or `pull` directly on the server |
| `ritus-server/data/migration/mapping-<column>.tsv` | `legacy_value → uuid`, with method and label, for audit | small | yes | not needed at runtime |
| `ritus-server/data/migration/unresolved.tsv` | Values with no eCatalogus counterpart — **send this to the editors** | small | yes | not needed at runtime |
| `ritus-server/data/migration/map.log.json`, `apply.log.json` | Counts, for the record that the migration was sound | small | yes | not needed at runtime |
| `ritus-server/instance/projects.db.bak-*` | Automatic backup taken by `--apply` | varies | no | — |

Only three of the fourteen vocabularies get a browser index, because only those
three are looked up at upload time. The other eleven are cached for the
migration's name-matching and are never sent to the browser.

### 3.3 ritus's own dictionaries (unchanged, still required)

Provided separately, per the README. The pull script reads them to attach ritus's
`legacy_id` to each cached entry.

`rite_names.csv`, `formulas.csv`, `functions.csv`, `sections.tsv`,
`liturgical_genres.tsv`, `layer.tsv`, `mass_hour.tsv`, `genre.tsv`,
`season_month.tsv`, `week.tsv`, `day.tsv`, `music_notation.tsv`.

They live in **two different places depending on the layout**, and the scripts
detect which by looking for `formulas.csv`:

| Layout | Dictionaries | Indexes written to |
|---|---|---|
| Checkout | `ritus-client/public/data/` | `ritus-client/public/data/ecatalogus/` |
| Deployed server | `ritus-server/static/data/` | `ritus-server/static/data/ecatalogus/` |

On a deployed server there is no `ritus-client` — `package.sh` copies the built
client into `ritus-server/static`, so the dictionaries arrive under `static/data`.
`--local-dicts <dir>` overrides the detection.

---

## 3.4 Keeping the dictionaries current

**Settings → eCatalogus Dictionaries** (admin only, on `/users`). One button:
*Refresh from eCatalogus*. It runs `pull` then `sync`, takes about 35 seconds,
and reports what changed.

| | |
|---|---|
| `pull` | Re-downloads all fourteen vocabularies into the cache and rewrites the browser indexes. **Full replace, never a merge** — `?since=` cannot report a term withdrawn upstream, so a merge would keep deleted entries forever. Nothing is written until every download has succeeded, so a failure leaves the previous cache intact. |
| `sync` | Appends terms eCatalogus has that ritus's own dictionaries lack, so they appear in the table editor's dropdowns and stop being flagged by Validate. Existing rows, their order and their ids never move. Idempotent. |

**All twelve local dictionary files are covered**, including `rite_names.csv`
and `formulas.csv` — the table editor keys both by the ritus integer, and
eCatalogus now publishes that same integer as `id` on both. `sync` writes it
straight from the API response; nothing is derived or guessed.

`formulas.csv` has one extra safeguard: `sync` first samples pre-existing
entries and checks that eCatalogus's `id` actually agrees with the number
already sitting in the local file. It does for `rite_names.csv`. It does
**not**, reliably, for `formulas.csv` — eCatalogus's `id` there is a plain,
unrelated autoincrement that only coincidentally matches ritus's own numbering
for the first few rows before diverging (confirmed live: 49 of 50 sampled
entries disagreed). When that check fails, `sync` adds nothing for that file
and says so, rather than writing rows under a number that resolves to the
wrong formula. Until eCatalogus's `formulas` endpoint publishes the actual
legacy number per row (today it's only obtainable one at a time, via
`?legacy_ids=`), `formulas.csv` stays manually maintained.

The panel is deliberately not wired to the upload dialog: an upload resolves
against whatever cache is on disk, so a refresh must never start underneath one.
Refreshes are serialised server-side — a second one gets `409` rather than
racing on the same files.

Command line equivalent, same effect:

```bash
python3 scripts/ecatalogus_dicts.py pull
python3 scripts/ecatalogus_dicts.py sync --dry-run   # what would be added
python3 scripts/ecatalogus_dicts.py sync
```

---

## 4. APIs used

All under `https://<instance>/api/v1/`. Reads are anonymous; only the import
needs credentials.

| Endpoint | Method | Auth | Used for |
|---|---|---|---|
| `/api/v1/` | GET | — | Instance name shown in the dialog |
| `/api/v1/whoami/` | GET | ✔ | Sign-in; distinguishes 401 from `can_import: false` |
| `/api/v1/manuscripts/?search=&limit=` | GET | — | The manuscript list, with `content_count` per row |
| `/api/v1/manuscripts/{uuid}/content/summary/` | GET | — | Re-check after upload |
| `/api/v1/manuscripts/{uuid}/content/bulk/` | POST | ✔ | `dry_run` first, then the real import |
| `/api/v1/dictionaries/{slug}/?limit=&offset=` | GET | — | `pull` only — never during an upload |

Query parameters we send: `search`, `limit`, `offset`. Unknown parameters are now
rejected with `400`.

**Deliberately not used:**

- **`id`** on dictionary entries — instance-local, and removed from the API.
- **`?legacy_ids=`** — see the warning in §5.
- Credentials on the manuscript list — the endpoint applies no visibility filter,
  so they would change nothing.
- `/api/etl/` — internal replication between instances, not for third parties.

### Instances

| Instance | `site_name` |
|---|---|
| `limbo.monumenta-poloniae-liturgica.ispan.pl` | MPL Limbo |
| `monumenta-poloniae-liturgica.ispan.pl` | Liturgica Poloniae |
| `ecatalogus.ispan.pl` | eCatalogus — **canonical master for all vocabularies** |
| `canon-missae.ispan.pl` | Canon Missae |
| `corpus-liturgicum.org` | Corpus Liturgicum |

Uploads can go to any of them. The cache is always pulled from
`ecatalogus.ispan.pl`, because UUIDs are identical everywhere, so one cache
serves every target.

---

## 5. Three traps, written down so nobody re-discovers them

**A derived UUID is not trustworthy on its own.** The scripts no longer derive
one (see §3.4), but the fact remains true of the technique itself, for anyone
tempted to reach for it again: legacy ids map to UUIDs by
`uuid5(NAMESPACE, "indexerapp.Model:id")`, and it held for 4564/4564 rite names
and 13228/13228 formulas at the time this was checked. But in `functions.csv`,
id 81 ("Prefatio") derives to a UUID that exists on the server and holds
**"Super oblata"**. Two more collide the same way. A derived UUID is only ever
safe to accept when the cached entry's name also matches the one ritus has —
never on its own.

**`?legacy_ids=` is not universally safe.** Their `legacy_id` means *eCatalogus's*
pre-migration primary key; our `legacy_id` column means *ritus's* dictionary id.
For `formulas` and `rite-names` these coincide — 300/300 sampled agree with the
server. For **`content-functions` they do not**: ritus has Collecta=79, eCatalogus
has Collecta=1, so `?legacy_ids=79` returns a different function entirely (3 of
113 sampled resolved to the wrong entry, the other 110 came back unresolved). It
costs us nothing today, because `function_id` is stored and sent as a name — but
do not adopt `?legacy_ids=` as a general rule.

**eCatalogus's plain `id` and its `?legacy_ids=`-derived `legacy_id` are not the
same number, even for the same dictionary.** `rite-names` and `formulas` both
publish a plain `id` on a general listing (§1). For `rite-names` that `id`
happens to *be* the pre-migration primary key — same number either way. For
`formulas` it is not: it is a separate, unrelated Django autoincrement that
only coincidentally agrees with the real legacy number for the first handful of
rows (`id: 1` ↔ legacy `1`, `id: 2` ↔ legacy `3`, `id: 3` ↔ legacy `5` …) before
silently diverging. Live sample: 50 pre-existing `formulas.csv` entries checked
against the plain `id` field, 49 disagreed. `sync` (§3.4) checks for exactly
this before trusting `id` on any file, which is why `formulas.csv` stays
manually maintained and `rite_names.csv` does not — not a hardcoded distinction,
a measured one. Never assume a present, plausible-looking `id` field is the
number you already hold; check a sample first.

---

## 6. Current status

Checked 2026-08-26, from a browser running on the real production origin.

**All five instances are live and reachable.** Code deploy and CORS both
confirmed on every one, across all six endpoints the dialog uses — `/`,
`/whoami/`, `/manuscripts/`, `/content/summary/`, `/dictionaries/{slug}/`, and
the `POST` preflight for `/content/bulk/` carrying `Authorization`.

Driven through the real dialog against MPL Limbo, from
`https://ritus-indexer.ispan.pl`, with browser CORS enforcement on:

- 161 manuscripts listed, with their record counts (939, 288, 11, 7 …);
- bad credentials produce *"Wrong eCatalogus username or password."* — a real
  `401` round trip, not a blocked request;
- `POST .../content/bulk/` with `dry_run` answers `401` on all five rather than
  failing preflight;
- zero network failures, zero exceptions.

| Instance | Code | CORS | Browser |
|---|---|---|---|
| `limbo.monumenta-poloniae-liturgica.ispan.pl` | ✅ | ✅ | ✅ 161 manuscripts |
| `monumenta-poloniae-liturgica.ispan.pl` | ✅ | ✅ | ✅ |
| `ecatalogus.ispan.pl` | ✅ | ✅ | ✅ |
| `canon-missae.ispan.pl` | ✅ | ✅ | ✅ |
| `corpus-liturgicum.org` | ✅ | ✅ | ✅ |

Check any instance with:

```bash
curl -s -D - -o /dev/null -H "Origin: https://ritus-indexer.ispan.pl" \
     https://<instance>/api/v1/ | grep -i access-control-allow-origin
```

**Two things remain.**

`http://localhost:5173` is not allow-listed on any instance, so the dev server
cannot reach the API — testing has to go through the production origin. It was in
the administrator's original list, so it looks like an oversight rather than a
decision.

An `api_importers` account is still needed before a real import can be run. That
is now the only thing standing between here and a working upload.
