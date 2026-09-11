SERVER_URL = "https://ritus-indexer.ispan.pl" # Zmień na HTTPS
#SERVER_URL = "http://127.0.0.1:5000" # Zmień na HTTPS

# Admin credentials
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "de$tination1SUnknown"  # Change this in production!

# JWT Secret Key
SECRET_KEY = "lfh-45-fs-4sfs-43ts-43gs-jyt5-zrqw3-gsfs"  # Change this in production!

# Local Ollama model for AI Autofix (production: gemma4:26b)
OLLAMA_MODEL = "gemma4:e4b"

# Fraction of GPU memory kraken transcription is allowed to claim (0.0-1.0).
# Kept below 1.0 so Ollama (a separate process sharing the same GPU) always
# has headroom to load its model without a CUDA OOM.
KRAKEN_GPU_MEMORY_FRACTION = 0.6