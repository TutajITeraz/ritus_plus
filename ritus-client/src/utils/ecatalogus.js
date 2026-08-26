/*
TITLE: ecatalogus.js
DESCRIPTION: Client for the eCatalogus stable API v1 (/api/v1/) plus the mapping
  that turns ritus ContentStructure rows into the payload accepted by
  POST /api/v1/manuscripts/{uuid}/content/bulk/.
DEPENDENCIES:
  - /data/ecatalogus/index-*.json, written by
    ritus-server/scripts/ecatalogus_dicts.py pull
NOTES:
  - Reads are anonymous; writes carry an "Authorization: Basic" header built
    from credentials the user types in the upload dialog. Credentials are never
    persisted - they live in React state for the duration of the upload only.

  - HOW REFERENCES ARE RESOLVED, and why it is not the obvious way.

    eCatalogus gives every dictionary row an autoincrement `id` that differs per
    instance: RiteNames "apostoli plures" is id 1 on MPL Limbo, 4565 on
    Liturgica Poloniae, 9129 on Corpus Liturgicum - one uuid, five ids. Looking
    a ritus integer up in the target instance's `id` column therefore yields a
    valid uuid for the wrong entry, and the import succeeds with wrong data.
    That column is also being removed from the API. It is never read here.

    So, in order:
      1. `<column>_uuid` on the row, written by the migration script - used as is;
      2. a value that already is a uuid - used as is;
      3. a name or short name - sent verbatim, because the bulk importer resolves
         those itself, case-insensitively, against the same columns for every
         instance. Nothing is downloaded and nothing can be mis-matched;
      4. a legacy integer - resolved against the local cache in
         /data/ecatalogus/, which is pulled from the canonical eCatalogus
         instance. Only three vocabularies ever need this.

  - Uploads no longer download anything from the instance being uploaded to.
USAGE:
  import { ECATALOGUS_INSTANCES, whoami, listManuscripts } from "../utils/ecatalogus";
*/

export const ECATALOGUS_INSTANCES = [
  {
    value: "https://limbo.monumenta-poloniae-liturgica.ispan.pl",
    label: "MPL Limbo",
  },
  {
    value: "https://monumenta-poloniae-liturgica.ispan.pl",
    label: "Monumenta Poloniae Liturgica",
  },
  {
    value: "https://ecatalogus.ispan.pl",
    label: "eCatalogus",
  },
  {
    value: "https://canon-missae.ispan.pl",
    label: "Canon Missae",
  },
  {
    value: "https://corpus-liturgicum.org",
    label: "Corpus Liturgicum",
  },
];

export const buildAuthHeader = (username, password) => {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
};

class ECatalogusError extends Error {
  constructor(message, { status = null, cors = false, payload = null } = {}) {
    super(message);
    this.name = "ECatalogusError";
    this.status = status;
    this.cors = cors;
    this.payload = payload;
  }
}

/*
 * A cross-origin fetch the instance does not allow rejects with a bare
 * TypeError, before any status code exists. Translate that into something the
 * historian at the keyboard can forward to the eCatalogus administrator.
 */
const corsError = (base) =>
  new ECatalogusError(
    `${base} did not accept a request from this page. The eCatalogus ` +
      `administrator has to add this origin (${window.location.origin}) to ` +
      `API_INTEGRATION_ORIGINS on that instance.`,
    { cors: true }
  );

const request = async (base, path, { auth, method = "GET", body, signal } = {}) => {
  const headers = {};
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw corsError(base);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ECatalogusError(
      payload?.detail || `${method} ${path} failed with HTTP ${response.status}`,
      { status: response.status, payload }
    );
  }
  return payload;
};

export const fetchInstanceInfo = (base, signal) => request(base, "/", { signal });

/*
 * Anonymous whoami answers 200 with authenticated:false, so a 401 here really
 * does mean the credentials were rejected. The instances reply with
 * "WWW-Authenticate: xBasic" - the deliberately unknown scheme keeps the
 * browser's own password prompt from appearing on top of our form.
 */
export const whoami = async (base, auth, signal) => {
  try {
    return await request(base, "/whoami/", { auth, signal });
  } catch (error) {
    if (error.status === 401) {
      throw new ECatalogusError("Wrong eCatalogus username or password.", {
        status: 401,
      });
    }
    throw error;
  }
};

/*
 * The manuscript list already carries content_count per row, so the dialog can
 * show "already holds N records" for every manuscript without a summary call
 * each. Deliberately anonymous: the endpoint applies no visibility filter, so
 * credentials would change nothing and would be sent where they are not needed.
 */
export const listManuscripts = async (base, { search = "", limit = 300, signal } = {}) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (search.trim()) params.set("search", search.trim());
  const payload = await request(base, `/manuscripts/?${params}`, { signal });
  return { count: payload?.count ?? 0, results: payload?.results ?? [] };
};

export const contentSummary = (base, uuid, signal) =>
  request(base, `/manuscripts/${uuid}/content/summary/`, { signal });

export const bulkImport = (base, uuid, body, auth, signal) =>
  request(base, `/manuscripts/${uuid}/content/bulk/`, {
    auth,
    method: "POST",
    body,
    signal,
  });

/* ------------------------------------------------------------------ *
 * The local dictionary cache
 * ------------------------------------------------------------------ */

const INDEX_PATH = "/data/ecatalogus";

const indexCache = new Map();

/*
 * Fetch one compact lookup written by `ecatalogus_dicts.py pull`. These are
 * static files on ritus's own origin - a few hundred KB each, browser-cached,
 * and only fetched when a column that needs one actually holds a value.
 */
export const loadRuntimeIndex = async (slug, signal) => {
  if (indexCache.has(slug)) return indexCache.get(slug);

  const response = await fetch(`${INDEX_PATH}/index-${slug}.json`, { signal });
  if (!response.ok) {
    throw new ECatalogusError(
      `The local ${slug} dictionary is missing. Run ` +
        `"python3 scripts/ecatalogus_dicts.py pull" in ritus-server to build it.`
    );
  }
  const payload = await response.json();
  indexCache.set(slug, payload);
  return payload;
};

/* ------------------------------------------------------------------ *
 * ritus ContentStructure -> eCatalogus content row
 * ------------------------------------------------------------------ */

/*
 * `from` is the ritus column, `to` the eCatalogus bulk-import field. Note the
 * rite_* -> rubric_* renames: the two systems use different words for the same
 * thing.
 *
 * `send: "name"` means the value ritus holds is already something the importer
 * matches on, so it goes across untouched. `send: "uuid"` means it is not, and
 * has to be resolved against the local cache first.
 *
 * Columns absent from this table (id, manuscript_id, entry_date, levenshtein,
 * formula_standardized, rite_name_standarized) are either ritus-local or
 * derived from another column and are not sent.
 */
export const FIELD_MAP = [
  { from: "sequence_in_ms", to: "sequence_in_ms", kind: "int" },
  { from: "rite_sequence_in_the_MS", to: "rubric_sequence_in_the_MS", kind: "int" },
  { from: "digital_page_number", to: "digital_page_number", kind: "int" },

  { from: "where_in_ms_from", to: "where_in_ms_from", kind: "text" },
  { from: "where_in_ms_to", to: "where_in_ms_to", kind: "text" },
  { from: "formula_text_from_ms", to: "formula_text_from_ms", kind: "text" },
  { from: "rite_name_from_ms", to: "rubric_name_from_ms", kind: "text" },
  { from: "subrite_name_from_ms", to: "subrubric_name_from_ms", kind: "text" },
  { from: "original_or_added", to: "original_or_added", kind: "upper" },
  { from: "biblical_reference", to: "biblical_reference", kind: "text" },
  { from: "reference_to_other_items", to: "reference_to_other_items", kind: "text" },
  { from: "comments", to: "comments", kind: "text" },
  { from: "similarity_by_user", to: "similarity_by_user", kind: "text" },
  { from: "proper_texts", to: "proper_texts", kind: "boolean" },

  // Resolved by the server from the name ritus already holds.
  { from: "function_id", to: "function_id", send: "name", slug: "content-functions" },
  { from: "subfunction_id", to: "subfunction_id", send: "name", slug: "content-functions" },
  { from: "section_id", to: "section_id", send: "name", slug: "sections" },
  { from: "subsection_id", to: "subsection_id", send: "name", slug: "sections" },
  { from: "liturgical_genre_id", to: "liturgical_genre_id", send: "name", slug: "liturgical-genres" },
  { from: "contributor_id", to: "contributor_id", send: "name", slug: "contributors" },
  { from: "layer", to: "layer", send: "name", slug: "layers" },
  { from: "mass_hour", to: "mass_hour", send: "name", slug: "mass-hours" },
  { from: "genre", to: "genre", send: "name", slug: "genres" },
  { from: "season_month", to: "season_month", send: "name", slug: "seasons-and-months" },
  { from: "week", to: "week", send: "name", slug: "weeks" },
  { from: "day", to: "day", send: "name", slug: "days" },

  // Sent by name, but resolved against the target manuscript's own notation
  // records rather than a vocabulary - a manuscript whose notation nobody has
  // described yet cannot take this field at all. See MUSIC_NOTATION_FIELD.
  { from: "music_notation_id", to: "music_notation_id", send: "name", slug: "music-notation-names" },

  // Resolved locally: ritus holds a legacy integer (or, for text
  // standarization, a Usuarium id) that the importer cannot match on.
  { from: "formula_id", to: "formula_id", send: "uuid", slug: "formulas" },
  { from: "rite_id", to: "rubric_id", send: "uuid", slug: "rite-names" },
  {
    from: "text_standarization__usu_id",
    to: "text_standarization",
    send: "uuid",
    slug: "text-standarization",
  },

  // Nothing in the API can resolve these from what ritus stores: quires and
  // editions belong to a manuscript rather than to a shared vocabulary, and
  // there is no read endpoint for EditionContent or Bibliography. Dropped with
  // a notice rather than failing hundreds of good rows.
  { from: "quire_id", kind: "drop", reason: "eCatalogus identifies quires by UUID, within one manuscript." },
  { from: "edition_index", kind: "drop", reason: "eCatalogus publishes no edition index to resolve against." },
  { from: "edition_subindex", kind: "drop", reason: "Sent only alongside edition_index, which cannot be resolved." },
];

export const MUSIC_NOTATION_FIELD = "music_notation_id";

const REFERENCE_FIELDS = FIELD_MAP.filter((field) => field.send);

const isEmpty = (value) =>
  value === null || value === undefined || value === "" ||
  (typeof value === "string" && value.trim() === "");

const normalize = (value) => String(value).trim().toLowerCase();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * Which local indexes this table needs. Only the three `send: "uuid"`
 * vocabularies have one, and only when a row holds a value that is not already
 * resolved.
 */
export const requiredIndexes = (rows) => {
  const needed = new Set();
  for (const field of REFERENCE_FIELDS) {
    if (field.send !== "uuid") continue;
    const wanted = rows.some((row) => {
      if (isEmpty(row[field.from])) return false;
      if (!isEmpty(row[`${field.from}_uuid`])) return false;
      return !UUID_RE.test(String(row[field.from]).trim());
    });
    if (wanted) needed.add(field.slug);
  }
  return [...needed];
};

const toInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};

const toBoolean = (value) => {
  if (typeof value === "boolean") return value;
  const key = normalize(value);
  if (["1", "true", "yes", "tak"].includes(key)) return true;
  if (["0", "false", "no", "nie"].includes(key)) return false;
  return null;
};

/*
 * Build the bulk payload. Returns the items alongside two lists: `errors` are
 * values that must be fixed before anything can be sent, `warnings` describe
 * fields dropped from otherwise valid rows - so the dialog can say what will
 * not make it across rather than dropping it silently.
 */
export const mapRowsForUpload = (rows, indexes = {}) => {
  const errors = [];
  const warnings = new Map();

  const warn = (field, value, detail) => {
    const key = `${field} ${value} ${detail}`;
    const existing = warnings.get(key);
    if (existing) existing.count += 1;
    else warnings.set(key, { field, value, detail, count: 1 });
  };

  const items = rows.map((row, index) => {
    const item = {};

    for (const field of FIELD_MAP) {
      if (field.kind === "drop") {
        if (!isEmpty(row[field.from])) {
          warn(field.from, String(row[field.from]).trim(), field.reason);
        }
        continue;
      }

      const raw = row[field.from];
      if (isEmpty(raw)) continue;
      const value = String(raw).trim();

      if (field.send) {
        // The migration script writes <column>_uuid beside the legacy value.
        // When it is there it is authoritative and nothing else is consulted.
        const migrated = row[`${field.from}_uuid`];
        if (!isEmpty(migrated)) {
          item[field.to] = String(migrated).trim();
          continue;
        }
        if (UUID_RE.test(value)) {
          item[field.to] = value;
          continue;
        }
        if (field.send === "name") {
          // The importer matches these itself, the same way on every instance.
          item[field.to] = value;
          continue;
        }

        const index_ = indexes[field.slug];
        if (!index_) {
          errors.push({
            row: index,
            field: field.from,
            value,
            detail: `The local ${field.slug} dictionary was not loaded.`,
          });
          continue;
        }
        const resolved =
          index_.byLegacyId?.[value] ?? index_.byName?.[normalize(value)];
        if (resolved) {
          item[field.to] = resolved;
        } else {
          errors.push({
            row: index,
            field: field.from,
            value,
            detail:
              `No ${field.slug} entry for "${value}" in the local dictionary. ` +
              "It may be a term eCatalogus does not have yet, or the cache may " +
              "need refreshing.",
          });
        }
        continue;
      }

      switch (field.kind) {
        case "int": {
          const number = toInteger(value);
          if (number === null) {
            errors.push({
              row: index,
              field: field.from,
              value,
              detail: `Expected a whole number, got "${value}".`,
            });
          } else {
            item[field.to] = number;
          }
          break;
        }
        case "boolean": {
          const flag = toBoolean(value);
          if (flag === null) warn(field.from, value, "Not a yes/no value.");
          else item[field.to] = flag;
          break;
        }
        case "upper":
          item[field.to] = value.toUpperCase();
          break;
        default:
          item[field.to] = value;
      }
    }

    return item;
  });

  return { items, errors, warnings: [...warnings.values()] };
};

/*
 * Remove one field from every item. Used for the music_notation_id retry: the
 * importer rejects a notation the target manuscript has no described block for,
 * and that is not something the uploader can correct - it means nobody has
 * described that manuscript's notation in eCatalogus yet. Better to import the
 * rows without the field than to fail all of them.
 */
export const stripField = (items, field) => {
  let removed = 0;
  const stripped = items.map((item) => {
    if (!(field in item)) return item;
    removed += 1;
    const { [field]: _dropped, ...rest } = item;
    return rest;
  });
  return { items: stripped, removed };
};

/*
 * Turn the errors[] array the bulk endpoint returns on 400 into the same shape
 * mapRowsForUpload produces, so the dialog renders one list either way.
 */
export const normalizeServerErrors = (payload) =>
  (payload?.errors || []).map((error) => ({
    row: error.row,
    field: error.field,
    value: error.value,
    code: error.error,
    detail: error.detail || error.error || "Rejected by eCatalogus.",
  }));

/*
 * dry_run abandons validation after 200 problems and appends a final
 * too_many_errors entry, so a systematically mis-mapped column reports 200 and
 * hides the rest. The dialog says so, rather than letting someone fix 200 rows
 * and believe they are finished.
 */
export const isErrorListTruncated = (serverErrors) =>
  serverErrors.some((error) => error.code === "too_many_errors") ||
  serverErrors.length >= 200;

export { ECatalogusError };
