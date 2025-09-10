# ritus+
Interface for transcription and analysis of medieval manuscripts using kraken and chatGPT


## Installation

### To use already compiled server:

On Linux:
```
cd ritus-server/
./easy_install.sh
```

On Mac:
```
cd ritus-server/
./easy_install_mac.sh
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


### Following commands must be executed in the project directory to compile it from the scratch!

```
### Check pip version:
    pip --version
# If pip is not installed, install it:
# Manjaro linux command:
    pacman -Syu python-pip
# Ubuntu linux command:
    sudo apt install Python3-pip

# Install pkg-config (Ubuntu):
    sudo apt install pkg-config
# Install pkg-config (Manjaro):
    sudo pamac install pkg-config


python3 -m venv .venv
source .venv/bin/activate

## Server
cd ritus-server
pip install -r requirements.txt
pip install flask flask-migrate flask-sqlalchemy

flask --app server.py db init
flask --app server.py db migrate -m "Initial"
flask --app server.py db upgrade

python server.py

## Client
npm install vite

# To build all in one server:
npm run build ; cp dist/* ../ritus-server/static/ -r

# To use 
```