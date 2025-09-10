#Installation:

```
chmod +x easy_install.sh
./easy_install.sh
``

If installation fails, try to create virtual python environment first:
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip


And then start once again.


Put this line in the secret_user_api_key.py to use AI functions:
```
user_api_key = "your_api_key_here"
```
This software uses openai gpt-4o model.

#Run:

```
chmod +x run_server.sh
./run_server.sh
``
