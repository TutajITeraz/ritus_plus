from flask_caching import Cache

# Cache instance to be initialized in krakenServer.py
cache = None

def init_cache(app):
    global cache
    if cache is None:
        cache = Cache(app, config={'CACHE_TYPE': 'SimpleCache'})
    return cache