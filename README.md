# ritus+
Interface for transcription and analysis of medieval manuscripts using kraken and LLM

## Installation

### To use already compiled server:

On Linux:
```
cd ritus-server/
./easy_install.sh

source .venv/bin/activate
python init_db.py
```

On Mac:
```
cd ritus-server/
./easy_install_mac.sh

source .venv/bin/activate
python init_db.py
```

There is no Windows version, because Kraken if not available for Windows. Sorry.

### Files that has to be provided separately:

ritus-client/public/data/formulas.csv in format (id, corpus orationem no, formula text): 
```
"id","co_no","text"
```

ritus-client/public/data/functions.csv in format:
```
id,name,parent_function
1,Collecta,-
2,Secreta,-
3,Prefatio,-
(...)
```

ritus-client/public/data/rite_names.csv in format:
```
"id","text","english_translation","votive","section_id"
1,"apostoli plures",,1,1
(...)
7,"abbas",,NULL,1
(...)
```


ritus-server/secret_user_api_key.py (key for OpenAI) in format:
```
user_api_key = "?????????"
```


ritus-server/models/blla.mlmodel 
(please get if from kraken repository)


### Following commands must be executed in the project directory to compile it from the scratch!

```
## Client
cd ritus-client
npm install

### To build all in one server:
npm run build 
cp -r dist ../ritus-server/static
```

### Following commands must be executed in the project directory to compile it from the scratch

## Server
```
cd ritus-server
./easy_install_mac.sh 
```

### To run the server later, use the following command:
./run_server.sh

### To install required libraries:

### Check pip version:
    pip --version
### If pip is not installed, install it:
#### Manjaro linux command:
    pacman -Syu python-pip
#### Ubuntu linux command:
    sudo apt install Python3-pip

#### Install pkg-config (Ubuntu):
    sudo apt install pkg-config
#### Install pkg-config (Manjaro):
    sudo pamac install pkg-config


## For the table only (no transcription ) version run:
npm run build:tableonly
npm run preview:tableonly

### And visit:
http://localhost:4173/index-tableonly.html

### Fast server run, without OCR:
python krakenServer.py --no-kraken



### When you update this software on a server, remember: ###
set proper config.js
set config.py
systemctl restart kraken_flask
## To check LOGS from gunicorn:
journalctl -u kraken_flask -f

### The server must run as a SINGLE worker process

Downloads and transcriptions run as threads inside the server process, and the
registries that track them (which project is downloading, which stop-event
cancels which job) live in that process's memory. With more than one Gunicorn
worker, a Cancel request can land on a worker that knows nothing about the job,
and each worker's startup reconciliation would wipe the others' live jobs. Run
`gunicorn` with `-w 1` (threads, not workers, are what give concurrency here).

Two workers also double the memory bill - each process loads its own copy of
the kraken models and runs its own transcription pool - which is how eight
configured workers became sixteen concurrent pages and an OOM kill.

`--timeout` matters for the same reason. Background download and transcription
threads live *inside* the gunicorn worker, so if a slow request trips the
timeout and the worker is killed, every batch job running in that process dies
with it. Keep it well above how long one page can take (see
`ritus-server/deploy/kraken_flask.service`).



## Background jobs: downloads and transcriptions

"Download All" and "Transcribe All" hand work to background threads and record
progress in two tables, `iiif_download_job` and `batch_transcribe_job`. One
project transcribes at a time; the rest queue as "pending". Pages within a
project run in parallel - `transcription_workers` (domain_config.json) at
most, fewer when there is not enough free RAM for that many (see below).

### How many pages run at once

Segmenting one page peaks at about **1.5 GB of RAM** - blla upsamples a
per-class heatmap back to full page resolution, and that tensor, the page
tensor and the polygonisation are all alive at the same moment (measured on a
3280x4702 page: +1525 MB over a 528 MB baseline). Memory between pages is flat,
so there is nothing leaking; the only thing that can kill the server is how
many of those peaks overlap.

`transcription_workers` is therefore a **ceiling, not a promise**. At the start
of each job the server reads how much memory is actually free and lowers the
pool to what fits:

    workers = min(transcription_workers, (available_MB - headroom) / page_MB)

and before admitting each page it re-checks, so a job started while the box was
idle backs off when something else (Ollama) grows. One page always runs, so a
busy machine transcribes slowly instead of not at all. Both figures are
tunable in `domain_config.json`:

    "transcription_page_memory_mb": 2000,      // budgeted peak per page
    "transcription_memory_headroom_mb": 2048   // RAM left for everything else

The decisions are logged - look for `Capping transcription workers 8 -> 3`,
`Memory at start of transcription ...`, and a per-page `rss=... MB, ... MB free`
line - and `GET /api/jobs/diagnostics` reports the live limit, how many pages
are in flight, and current RSS.

### When the server is OOM-killed

Symptom in `journalctl -u kraken_flask`: a run of `Baseline segmentation...`
lines, then

    A process of this unit has been killed by the OOM killer.
    Worker (pid:...) was sent SIGKILL! Perhaps out of memory?
    kraken_flask.service: Failed with result 'oom-kill'.

That is the machine running out of RAM, not a bug in a manuscript. Two things
matter. The first is **not over-committing**, which the worker cap above now
handles. The second is that systemd's default `OOMPolicy=stop` takes the
*whole unit* down when one of its processes is killed, and without `Restart=`
it stays down - which is why one manuscript could end a whole overnight run.

`ritus-server/deploy/kraken_flask.service` is a reference unit with the right
settings. To add them to an existing unit without replacing it, use a drop-in
(`systemctl edit kraken_flask`):

    [Service]
    OOMPolicy=continue
    Restart=always
    RestartSec=10
    MemoryHigh=7G
    MemoryMax=8G

`MemoryMax` also makes the worker cap exact: the server reads the cgroup limit
and sizes itself against that rather than against the whole box, so an
over-commit can no longer reach Ollama or the rest of the system.

### Sharing the box with Ollama

Ollama is usually the largest process on the server (~20 GB of 31 GB while a
model is resident), which leaves roughly 8 GB for transcription - three
concurrent pages, not eight. If swap is also full there is no cushion left at
all and an over-commit is an immediate kill, so the server logs a warning when
it sees that. `OLLAMA_KEEP_ALIVE` (how long a model stays resident) and
`OLLAMA_MAX_LOADED_MODELS=1` are the levers that give the transcription pool
more room.

### Stopping everything

The projects page shows a red **Stop All (n)** button whenever any job is
running or queued. It cancels every download and every transcription the user
can see. A page already being processed finishes first; everything transcribed
so far is kept, and each project offers Resume / Retry afterwards.

### Re-transcribing manuscripts that are already done

In the Transcribe All dialog:

- **Skip** / **Continue** leave finished manuscripts alone, because there is
  nothing left for them to do. Tick **Include projects that are already fully
  transcribed** to send them through anyway.
- **Override** re-transcribes every page of every project and *replaces*
  existing text. It always includes finished manuscripts.

The dialog states up front how many projects it will actually start, so
"nothing happened" is visible before you press the button rather than after.

### When a job looks stuck

A job whose thread died with the server process (deploy, restart, crash, OOM
kill) used to leave its row reading "running" forever: the progress bar never
moved and every new start was refused with "Transcription already running".
Restarting did not help, because nothing revisited those rows.

Now the server reconciles them at startup - every row still claiming to be
active is marked `interrupted`, keeping its progress counters - and then
**starts them again by itself**, exactly as if you had pressed Resume on each
project. A deploy in the middle of the night no longer leaves every manuscript
waiting until somebody notices in the morning. Starting a job also ignores a
row that no live thread backs, so a stale row can never block a restart again.

What "resume" means per mode:

- **Skip** / **Continue** recompute their work list from the pages that have no
  text yet, so they carry on naturally.
- **Override** / **Range** always process the same list, so the server records
  how far the interrupted run got and starts from there, rewinding by the
  number of pages that were in flight when the process died. A couple of pages
  transcribed twice is the price of never leaving a hole in a manuscript.
- The model, the page range and every checkbox from the Transcribe dialog are
  stored with the job, so a resumed run uses the settings you chose, not the
  defaults. Jobs started before this release only carry a model and a mode; a
  "range" job among them resumes in skip mode, because its range is not
  recorded anywhere.

A job the user **cancelled** is never resumed - that was a decision, not an
accident.

#### When resuming would be a crash loop

If the server is dying *because* of one job - an OOM kill on a huge page is the
usual cause - resuming it forever would take the server down repeatedly and
starve every other project. So a job that comes back three times without
finishing a single page is left `interrupted`, with a message saying so, and
waits for a human. Any real progress resets that count.

To turn automatic resume off entirely (useful while rescuing a server that is
stuck in a restart loop), add to `ritus-server/domain_config.json`:

    { "auto_resume_interrupted_jobs": false }

`GET /api/jobs/diagnostics` reports `auto_resume_enabled`, `max_auto_resumes`
and each job's `auto_resume_count`.

To inspect (or rescue) a server without logging in - it reads the SQLite file
directly, so it works even when the server is stopped or wedged:

    cd ritus-server
    python3 scripts/inspect_jobs.py            # every job row, stuck ones flagged
    python3 scripts/inspect_jobs.py --stuck    # only the rows claiming to be active
    python3 scripts/inspect_jobs.py --json     # machine-readable dump to attach to a bug report
    python3 scripts/inspect_jobs.py --reset    # clear stuck rows (stop the server first)

`--reset` only rewrites the status column; no transcription and no downloaded
image is touched.

Admins can get the same picture from a running server, which additionally knows
which jobs have a live thread behind them:

    GET /api/jobs/diagnostics

A row with `"status": "running"` and `"live": false` is a tombstone from a dead
process. `server_started_at` and the row's `updated_at` show which side of the
last restart the job is on.



## Matching methods: n-gram matcher vs legacy algorithm

**Full Automatic Lookup and Split** and **Automatic Fill** both match manuscript
text against the reference corpus (`formulas.csv`, ~13k entries). Each has a
**Matching method** dropdown offering:

- **n-gram matcher** (default)
- **legacy algorithm** — the original implementation, kept for comparison

Both are two-stage: a cheap prefilter narrows the corpus, then edit distance
decides. They differ in the prefilter. The legacy algorithm compares the query
against entries by shared 3-character chunks (Automatic Fill) or sweeps every
text fragment against all 13,228 formulas repeatedly (Split). The n-gram matcher
indexes the corpus **once** by word n-grams, so instead of asking "which of
13,228 formulas does this look like?" it asks "which formulas share any wording
with this text?" and gets candidates straight from the index. Text is normalized
for medieval Latin first (accents stripped, j->i, v->u, w->uu, ae/oe->e), so
scribal spelling variants stop counting as textual differences.

Measured on `ritus-server/tests/Wr_Univ_I_F_366_*.csv`, against an exhaustive
Levenshtein scan of the whole corpus as ground truth:

| Automatic Fill (1532 rows) | legacy algorithm | n-gram matcher |
|---|---|---|
| wall time | 55.6s | **14.1s** (3.9x faster) |
| rows filled (60% threshold) | 601 | **622** |
| of those, the corpus-best match | 98.67% | **99.04%** |
| found the corpus-best where one exists | 94.58% | **95.80%** |

The two agree on 98.67% of the rows both fill. Of the 22 rows only the n-gram
matcher fills, all 22 are the exhaustive scan's best match — they are cases like
`contitebor tibi domine` or `oremus flectua genuam` that the legacy algorithm
scored just under the cutoff because of spelling alone. Where the two disagree on
a row both fill, the n-gram matcher's pick is textually closer 6 times and the
legacy algorithm's 0 times.

Wall times vary with machine load (the ratio has measured between 3.5x and 4x);
the accuracy figures are deterministic. Note that Automatic Fill also sleeps 10ms
per row to keep the progress bar responsive, so the wall clock a user sees
includes ~15s on top of both methods.

For **Full Automatic Lookup and Split**, the same manuscript is supplied as one
225,645-character stream with every boundary removed (`Wr_Univ_I_F_366_merged.csv`)
and the splitter has to find where each of the 1532 prayers starts and ends.
Ground truth is exact — that stream is the individual texts concatenated in row
order, so every true boundary is recoverable without any algorithm. A predicted
segment counts as correct when it overlaps a true one by at least 50% IoU:

| Full Automatic Lookup and Split | legacy algorithm | n-gram matcher |
|---|---|---|
| wall time | 2403s (40 min) | **5.5s** (~440x faster) |
| boundary precision | 41.11% | **50.14%** |
| boundary recall | 67.62% | **68.60%** |
| boundary F1 | 51.14 | **57.94** |
| formula_id agreement | 85.92% | **93.12%** |

The n-gram matcher is ahead on every axis. The `formula_id` figure comes from a
final re-rank step: the interval-scheduling DP is good at deciding *where* a
segment is but poor at deciding *which* formula it is, because `partial_ratio`
gives a short sub-formula a perfect score inside a longer prayer. Once the
boundaries are fixed, each span's candidates are re-scored by symmetric full-text
similarity, which lifts agreement from 81% to 93% and leaves boundaries untouched.

Both benchmarks end in a regression gate and exit non-zero if the n-gram matcher
falls behind the legacy algorithm on any accuracy axis or on speed.

Implementation:

- `ritus-client/src/utils/ngramLookup.jsx` — Automatic Fill (browser)
- `ritus-server/ngram_matcher.py` — Full Automatic Lookup and Split (server)
- `ritus-client/src/utils/lookup.jsx`, `ritus-server/batch_analysis.py` — legacy

Tests and benchmarks:

```
# unit tests (fast, no extra dependencies)
cd ritus-client && node tests/ngramLookup.test.mjs
cd ritus-server && python tests/test_ngram_matcher.py

# Automatic Fill benchmark: build the ground-truth oracle once (~25s), then compare
cd ritus-server && python tests/build_fill_oracle.py
cd ritus-client && node tests/benchmark_fill_methods.mjs      # ~70s, asserts no regression

# Full Automatic Lookup and Split benchmark
cd ritus-server && python tests/benchmark_split_methods.py            # n-gram only, ~1s
cd ritus-server && python tests/benchmark_split_methods.py --legacy   # both; legacy takes hours
```

`build_fill_oracle.py` writes `oracle_raw.json` / `oracle_norm.json` into
`ritus-server/tests/` — the exhaustive best match for every manuscript row over
the whole corpus. `benchmark_fill_methods.mjs` scores both methods against it and
fails if the n-gram matcher regresses on precision, coverage or speed.


## eCatalogus integration

The table editor (`/table/`) has a **Send to eCatalogus** button next to Validate.
It picks one of the five eCatalogus instances, signs the user in with their own
eCatalogus account (held in the page only, never stored), lists the manuscripts
with the number of records each already holds, validates the table with a
`dry_run` and then imports it in bulk.

The rule the integration is built on: **names travel, UUIDs identify, legacy
integers stay home.** eCatalogus numbers its dictionary rows differently on every
instance, so ritus never resolves against a remote `id`. Thirteen reference
fields are sent as the name ritus already holds and resolved server-side; only
`rite_id`, `formula_id` and `text_standarization__usu_id` need a UUID, taken from
a local cache pulled from `ecatalogus.ispan.pl`.

Refresh that cache and migrate the database with the committed scripts — the same
commands on a laptop, staging and production:

```
cd ritus-server
./scripts/ecatalogus_migrate.sh              # check run, writes nothing
./scripts/ecatalogus_migrate.sh --apply      # backs up the DB, applies, verifies
```

The browser lookups live in `ritus-client/public/data/ecatalogus/index-*.json`.
That directory is gitignored, so they reach production through `npm run build`
and `package.sh` — re-run the pull before building.

Terms added in eCatalogus do **not** appear automatically. An admin refreshes
them under **Settings → eCatalogus Dictionaries**, which re-pulls the
vocabularies and adds any new options to the table editor's dropdowns.
`formulas.csv` is the one exception: the editor keys it by the ritus number,
and eCatalogus's own numbering for formulas does not agree with ours (see
`eCatalogus_REFERENCE.md` §5) — new formulas still need adding by hand.

- `eCatalogus_REFERENCE.md` — every file, every endpoint, and what each column
  stores (name, id or UUID).
- `eCatalogus_MIGRATION.md` — how to run the migration, and what is still blocked.

