# ritus+
Interface for transcription and analysis of medieval manuscripts using kraken and chatGPT


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

- `eCatalogus_REFERENCE.md` — every file, every endpoint, and what each column
  stores (name, id or UUID).
- `eCatalogus_MIGRATION.md` — how to run the migration, and what is still blocked.


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
