"""TrOCR line recognition, used as an alternative to kraken's own recognizers.

Kraken does two separate things for us: it finds the text lines on a page
(``blla`` baseline segmentation) and it reads them (``rpred`` + an
``.mlmodel`` recognizer).  Only the second half is replaced here.  A TrOCR
model is a plain HuggingFace ``VisionEncoderDecoderModel`` that takes one
*line image* and generates its text, so the pipeline stays:

    blla.segment -> (colour split) -> extract_polygons -> TrOCR generate

which means every feature built on top of the segmentation (red-text
splitting, multi-column reordering, edge filtering, autofix) keeps working
unchanged - the only thing that differs is which network turns a line
crop into characters.

``recognize`` deliberately returns a list of plain strings, because that is
what the call sites do with kraken's records anyway (``str(record)``), so a
TrOCR run is a drop-in replacement for ``rpred.rpred(...)``.
"""

import logging
import os
import shutil
import threading

logger = logging.getLogger(__name__)

# Client-facing model name -> HuggingFace repo id.  The names are what the
# React model dropdowns send in `modelName`, side by side with the kraken
# `*.mlmodel` names, so this dict is also the answer to "is this a TrOCR
# model?" everywhere in krakenServer.py.
TROCR_MODELS = {
    "TrOCR_Manicule_2026_Latin_Medieval": "LaMOP/TrOCR_Manicule_2026_Latin_Medieval",
}

# Weights land next to the kraken .mlmodel files instead of the user's global
# ~/.cache/huggingface, so a deployment keeps all its OCR models in one
# (gitignored) place and can be shipped/wiped as a unit. One checkpoint is
# ~1.2 GB, so set TROCR_CACHE_DIR to put them on a different disk, or to share
# one copy between checkouts. Deleting the directory costs only a re-download:
# the server starts and every kraken model works without it.
TROCR_CACHE_DIR = os.environ.get(
    "TROCR_CACHE_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "trocr"),
)

# The decoder is autoregressive, so a line costs one forward pass per token.
# Lines are therefore batched; 8 x 384x384 ViT inputs is small enough to stay
# well inside the per-page budget the MemoryGovernor hands out.
DEFAULT_BATCH_SIZE = int(os.environ.get("TROCR_BATCH_SIZE", 8))
# Medieval lines are long; 128 subword tokens is what the model card uses.
DEFAULT_MAX_NEW_TOKENS = int(os.environ.get("TROCR_MAX_NEW_TOKENS", 128))
# Greedy by default: beams multiply decoding time, and on these models they
# change very little. Set TROCR_NUM_BEAMS=4 to trade speed for accuracy.
DEFAULT_NUM_BEAMS = int(os.environ.get("TROCR_NUM_BEAMS", 1))

_loaded = {}  # repo id -> (processor, model, device)
_load_lock = threading.Lock()


def is_trocr_model(model_name):
    """True when `model_name` names a TrOCR model rather than a kraken one."""
    return model_name in TROCR_MODELS


def trocr_repo_id(model_name):
    """HuggingFace repo id for a client-facing TrOCR model name."""
    return TROCR_MODELS.get(model_name)


def trocr_available():
    """True when `transformers` is importable, i.e. TrOCR can actually run.

    The server must start (and keep serving kraken models) on an install that
    never got `transformers`, so this is a soft check rather than a hard
    import at module level.
    """
    try:
        import transformers  # noqa: F401
    except Exception as e:
        logger.info("TrOCR unavailable: %s", e)
        return False
    return True


# Files a checkpoint carries that are never read at inference time. They are
# only a few kilobytes, but leaving them out keeps the model directory to
# exactly what the server loads.
NON_RUNTIME_PATTERNS = ["*.md", ".gitattributes", "*.h5", "*.msgpack", "*.onnx", "*.onnx_data"]


def model_dir(repo_id):
    """Where this checkpoint's runtime files live, as a plain directory.

    Not a HuggingFace cache tree: `snapshot_download(local_dir=...)` writes the
    files themselves, so there are no blobs/, refs/, locks or symlinks to an
    indirection layer - just the handful of files `from_pretrained` reads. The
    directory is therefore self-contained: copy it to another machine, or
    delete it and lose nothing but a download.
    """
    return os.path.join(TROCR_CACHE_DIR, repo_id.replace("/", "--"))


def _ensure_downloaded(repo_id):
    """Return `model_dir(repo_id)`, downloading the checkpoint if it is absent."""
    target = model_dir(repo_id)
    if os.path.exists(os.path.join(target, "config.json")):
        return target

    from huggingface_hub import snapshot_download

    logger.info("Downloading TrOCR checkpoint %s into %s", repo_id, target)
    snapshot_download(repo_id, local_dir=target, ignore_patterns=NON_RUNTIME_PATTERNS)
    # snapshot_download leaves its own download bookkeeping behind; the
    # presence of config.json is what this module uses as the "already here"
    # marker, so the bookkeeping is dead weight.
    shutil.rmtree(os.path.join(target, ".cache"), ignore_errors=True)
    return target


def load_model(model_name, device="cpu"):
    """Load (and cache) the processor + model for `model_name`.

    The first call downloads ~1.2 GB into `models/trocr`; later calls, from
    any thread, get the cached pair back. Loading is serialised by
    `_load_lock` for the same reason kraken's recognizer loading is:
    inference is read-only and safe to share, loading is not.
    """
    repo_id = TROCR_MODELS.get(model_name)
    if repo_id is None:
        raise ValueError(f"Unknown TrOCR model: {model_name}")

    key = (repo_id, device)
    cached = _loaded.get(key)
    if cached is not None:
        return cached

    with _load_lock:
        # Another thread may have loaded it while we waited for the lock.
        cached = _loaded.get(key)
        if cached is not None:
            return cached

        from transformers import TrOCRProcessor, VisionEncoderDecoderModel

        logger.info("Loading TrOCR model %s on %s (cache: %s)", repo_id, device, TROCR_CACHE_DIR)
        os.makedirs(TROCR_CACHE_DIR, exist_ok=True)
        local_dir = _ensure_downloaded(repo_id)
        processor = TrOCRProcessor.from_pretrained(local_dir)
        model = VisionEncoderDecoderModel.from_pretrained(local_dir)
        model.to(device)
        model.eval()
        # The published generation_config ships `use_cache: false`, which makes
        # every generated token re-run the whole decoder. Measured on four
        # lines of tests/test_red2.jpg: 5.3 s without the cache, 2.9 s with it,
        # identical text either way. Turn it back on.
        model.generation_config.use_cache = True
        model.config.decoder.use_cache = True
        # The checkpoint contradicts itself: config.json says the decoder was
        # trained to start from <s> (0) while generation_config.json says </s>
        # (2), and generate() believes the generation config. This is the usual
        # TrOCR finetuning mismatch - the common recipe sets
        # decoder_start_token_id = tokenizer.cls_token_id (0) while TrOCR's
        # inherited default is 2, and an exported generation_config keeps the
        # default. Starting from the wrong token makes the decoder emit <pad>
        # forever on any line it is not certain about: it produced empty text
        # for 9 of 20 lines of tests/test_red2.jpg and for 52 of 83 lines of
        # tests/test_img2.png, and for two of five line images taken straight
        # from the model's own training set (magistermilitum/Tridis), which is
        # what proves the config rather than the crops is at fault. The
        # architecture config is the one that matches training, so prefer it.
        trained_start = model.config.decoder_start_token_id
        if trained_start is not None and trained_start != model.generation_config.decoder_start_token_id:
            logger.info(
                "TrOCR %s: decoder_start_token_id %s (generation_config) -> %s (config.json, "
                "matches how the decoder was trained)",
                repo_id, model.generation_config.decoder_start_token_id, trained_start,
            )
            model.generation_config.decoder_start_token_id = trained_start

        _loaded[key] = (processor, model, device)
        logger.info("TrOCR model %s loaded", repo_id)
        return _loaded[key]


def unload_models():
    """Drop cached TrOCR weights (used when switching back to kraken-only work)."""
    with _load_lock:
        _loaded.clear()


def _line_crops(image, seg):
    """Dewarped line images for `seg.lines`, in order, `None` where unusable.

    `extract_polygons` is exactly what kraken's own `rpred` uses, so a TrOCR
    run sees the same pixels a kraken recognizer would have seen.
    """
    # Imported lazily so this module stays importable when the server runs
    # with --no-kraken (no segmentation, hence no recognition either).
    from kraken.lib.exceptions import KrakenInputException
    from kraken.lib.segmentation import extract_polygons

    crops = []
    try:
        extractor = extract_polygons(image, seg)
        for crop, _line in extractor:
            if crop is None or 0 in crop.size:
                crops.append(None)
            else:
                crops.append(crop.convert("RGB"))
    except KrakenInputException as e:
        logger.warning("TrOCR line extraction failed: %s", e)
    except Exception:
        logger.exception("TrOCR line extraction raised")

    # A failed extraction mid-way must not silently shift the text of every
    # following line onto the wrong baseline, so pad back to line count.
    while len(crops) < len(seg.lines):
        crops.append(None)
    return crops


def recognize(image, seg, model_name, device="cpu",
              batch_size=DEFAULT_BATCH_SIZE,
              max_new_tokens=DEFAULT_MAX_NEW_TOKENS,
              num_beams=DEFAULT_NUM_BEAMS):
    """Transcribe every line of `seg` with a TrOCR model.

    Args:
        image: the page as a PIL image (colour is preferred - TrOCR was
            trained on RGB line crops).
        seg: a kraken `Segmentation` whose `lines` are to be read.
        model_name: a key of `TROCR_MODELS`.

    Returns:
        A list of strings, one per line in `seg.lines` and in the same order
        (empty string where a line could not be read), mirroring what
        `str(record)` yields for kraken's `rpred` records.
    """
    import torch

    processor, model, _ = load_model(model_name, device=device)

    if image.mode != "RGB":
        image = image.convert("RGB")

    crops = _line_crops(image, seg)
    texts = [""] * len(crops)

    # Only the usable crops go through the network; their positions are kept
    # so the results can be written back to the right lines.
    usable = [(i, crop) for i, crop in enumerate(crops) if crop is not None]
    for start in range(0, len(usable), batch_size):
        chunk = usable[start:start + batch_size]
        images = [crop for _i, crop in chunk]
        try:
            pixel_values = processor(images=images, return_tensors="pt").pixel_values.to(device)
            with torch.inference_mode():
                generated = model.generate(
                    pixel_values,
                    max_new_tokens=max_new_tokens,
                    num_beams=num_beams,
                )
            decoded = processor.batch_decode(
                generated,
                skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            )
        except Exception:
            logger.exception("TrOCR recognition failed for lines %d-%d",
                             chunk[0][0] + 1, chunk[-1][0] + 1)
            continue
        for (i, _crop), text in zip(chunk, decoded):
            texts[i] = text.strip()

    return texts
