# eCatalogus integration — reference

Every file, every endpoint, and — field by field — whether ritus keeps a **name**,
a **legacy id** or a **UUID**.

Companion to `eCatalogus_MIGRATION.md`, which explains how to run the migration.
This document is the "what is where" list.

---

## 1. The rule, in one line

> **Names travel. UUIDs identify. Legacy integers stay home.**

eCatalogus gives every dictionary row an autoincrement `id` that is **different on
every instance** — one rubric is id 1 on MPL Limbo, 4565 on Liturgica Poloniae,
9129 on Corpus Liturgicum, with the same UUID on all three. So:

- a **name** is safe to send: the importer resolves it the same way everywhere;
- a **UUID** is safe to store and send: it means the same thing on every instance;
- a **legacy integer** is safe only inside ritus, as a join key to our own rows.
  It is never sent, and never resolved against a remote `id` column. That column
  no longer exists in the API.

---

## 2. What the ritus database keeps, per column

Content rows live in `content.data` — one JSON object per row, not real columns.
"Stored now" is what that JSON holds today.

### 2.1 Dictionary references

| ritus column | Stored now | Migration adds | Sent to eCatalogus as | eCatalogus field |
|---|---|---|---|---|
| `rite_id` | **legacy id** (int) | `rite_id_uuid` | **UUID** (from local cache) | `rubric_id` |
| `formula_id` | **legacy id** (int) | `formula_id_uuid` | **UUID** (from local cache) | `formula_id` |
| `text_standarization__usu_id` | **Usuarium id** (text) | `text_standarization__usu_id_uuid` | **UUID** (from local cache) | `text_standarization` |
| `function_id` | **name** | `function_id_uuid` | **name**, verbatim | `function_id` |
| `subfunction_id` | **name** | `subfunction_id_uuid` | **name**, verbatim | `subfunction_id` |
| `section_id` | **name** | `section_id_uuid` | **name**, verbatim | `section_id` |
| `subsection_id` | **name** | `subsection_id_uuid` | **name**, verbatim | `subsection_id` |
| `liturgical_genre_id` | **name** | `liturgical_genre_id_uuid` | **name**, verbatim | `liturgical_genre_id` |
| `contributor_id` | **initials** | `contributor_id_uuid` | **initials**, verbatim | `contributor_id` |
| `music_notation_id` | **name** | `music_notation_id_uuid` | **name**, verbatim | `music_notation_id` |
| `layer` | **short name** | `layer_uuid` | **short name**, verbatim | `layer` |
| `mass_hour` | **short name** | `mass_hour_uuid` | **short name**, verbatim | `mass_hour` |
| `genre` | **short name** | `genre_uuid` | **short name**, verbatim | `genre` |
| `season_month` | **short name** | `season_month_uuid` | **short name**, verbatim | `season_month` |
| `week` | **short name** | `week_uuid` | **short name**, verbatim | `week` |
| `day` | **short name** | `day_uuid` | **short name**, verbatim | `day` |

**Legacy integer columns are kept, not deleted.** They are the provenance of the
migration and the join key if it ever has to be re-run. They are simply never
read for anything API-facing.

**Only three columns need a UUID at upload time** — `rite_id`, `formula_id` and
`text_standarization__usu_id` — because what ritus stores for them is not
something the importer can match on. Everything else in the table above travels
as the text ritus already holds.

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
| `ritus-server/scripts/ecatalogus_dicts.py` | `pull` / `map` / `apply` / `verify` |
| `ritus-server/scripts/ecatalogus_migrate.sh` | Runs all four in order, with dry runs |
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

## 5. Two traps, written down so nobody re-discovers them

**A derived UUID is not trustworthy on its own.** Legacy ids map to UUIDs by
`uuid5(NAMESPACE, "indexerapp.Model:id")`, and it holds for 4564/4564 rite names
and 13228/13228 formulas. But in `functions.csv`, id 81 ("Prefatio") derives to a
UUID that exists on the server and holds **"Super oblata"**. Two more collide the
same way. So a derived UUID is accepted only when the cached entry's name matches
the one ritus has; otherwise it falls through to name matching, then to
`unresolved.tsv`.

**`?legacy_ids=` is not universally safe.** Their `legacy_id` means *eCatalogus's*
pre-migration primary key; our `legacy_id` column means *ritus's* dictionary id.
For `formulas` and `rite-names` these coincide — 300/300 sampled agree with the
server. For **`content-functions` they do not**: ritus has Collecta=79, eCatalogus
has Collecta=1, so `?legacy_ids=79` returns a different function entirely (3 of
113 sampled resolved to the wrong entry, the other 110 came back unresolved). It
costs us nothing today, because `function_id` is stored and sent as a name — but
do not adopt `?legacy_ids=` as a general rule.

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
