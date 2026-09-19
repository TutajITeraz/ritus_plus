#!/usr/bin/env python3
"""Convert an old HuggingFace-cache TrOCR directory into the flat layout.

trocr_recognizer used to hand `cache_dir=models/trocr` to `from_pretrained`,
which builds a full HF cache tree there: `models--<org>--<name>/snapshots/<sha>/`
full of symlinks into `blobs/`, plus `refs/`, `.locks/`, `.no_exist/` and a
`CACHEDIR.TAG`. It now keeps each checkpoint as a plain directory holding only
the files the server actually loads.

This script performs that migration without re-downloading: the files are
*moved* (same filesystem, so instantly and without needing room for a second
copy), then the cache scaffolding is deleted.

Be clear about what it saves: a checkpoint is ~1.2 GB of weights plus ~3.4 MB
of tokenizer, and all of that is needed at runtime. What goes away here is a
few kilobytes of bookkeeping and one confusing directory layout - not disk
space. If you want the space back, delete `models/trocr` entirely; the server
runs fine without it and re-downloads on the next TrOCR transcription.

Usage:
    python3 scripts/trim_trocr_cache.py [--dry-run]
"""

import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from trocr_recognizer import TROCR_CACHE_DIR, TROCR_MODELS, model_dir

# Never carried over: documentation and weights for frameworks we do not use.
SKIP_SUFFIXES = (".md", ".h5", ".msgpack", ".onnx", ".onnx_data")
SKIP_NAMES = (".gitattributes",)


def _cache_tree(repo_id):
    return os.path.join(TROCR_CACHE_DIR, "models--" + repo_id.replace("/", "--"))


def _snapshot_dir(tree):
    """The single snapshot directory inside an HF cache tree, if there is one."""
    snapshots = os.path.join(tree, "snapshots")
    if not os.path.isdir(snapshots):
        return None
    entries = [os.path.join(snapshots, e) for e in sorted(os.listdir(snapshots))]
    entries = [e for e in entries if os.path.isdir(e)]
    return entries[-1] if entries else None


def _dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            full = os.path.join(root, name)
            if not os.path.islink(full) and os.path.exists(full):
                total += os.path.getsize(full)
    return total


def migrate(repo_id, dry_run=False):
    tree = _cache_tree(repo_id)
    target = model_dir(repo_id)

    if os.path.exists(os.path.join(target, "config.json")):
        print(f"{repo_id}: already flat in {target}")
        if os.path.isdir(tree):
            print(f"  leftover cache tree {tree} ({_dir_size(tree) / 1e6:.1f} MB)")
            if not dry_run:
                shutil.rmtree(tree, ignore_errors=True)
                print("  removed")
        return

    snapshot = _snapshot_dir(tree)
    if snapshot is None:
        print(f"{repo_id}: nothing cached under {TROCR_CACHE_DIR}, nothing to do")
        return

    moves = []
    for name in sorted(os.listdir(snapshot)):
        if name in SKIP_NAMES or name.endswith(SKIP_SUFFIXES):
            continue
        # The snapshot entry is a symlink into blobs/; move what it points at,
        # which is the real file and costs nothing on the same filesystem.
        source = os.path.realpath(os.path.join(snapshot, name))
        if os.path.isfile(source):
            moves.append((name, source, os.path.getsize(source)))

    if not moves:
        print(f"{repo_id}: snapshot {snapshot} holds no files, leaving it alone")
        return

    print(f"{repo_id}: {len(moves)} runtime files -> {target}")
    for name, _source, size in moves:
        print(f"  {name:<28} {size / 1e6:>9.1f} MB")
    if dry_run:
        print("  (dry run, nothing moved)")
        return

    os.makedirs(target, exist_ok=True)
    for name, source, _size in moves:
        shutil.move(source, os.path.join(target, name))

    if not os.path.exists(os.path.join(target, "config.json")):
        # Bail out loudly rather than delete the cache we just half-emptied.
        raise SystemExit(f"config.json missing in {target} after the move - "
                         "the cache tree has been left in place, check it by hand")

    freed = _dir_size(tree)
    shutil.rmtree(tree, ignore_errors=True)
    print(f"  removed cache scaffolding ({freed / 1e6:.1f} MB of bookkeeping)")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="list what would move without touching anything")
    args = parser.parse_args()

    if not os.path.isdir(TROCR_CACHE_DIR):
        print(f"No TrOCR cache at {TROCR_CACHE_DIR}")
        return

    for repo_id in sorted(set(TROCR_MODELS.values())):
        migrate(repo_id, dry_run=args.dry_run)

    # Cache-wide leftovers that only exist because of the old layout.
    for name in (".locks", "CACHEDIR.TAG", ".DS_Store"):
        path = os.path.join(TROCR_CACHE_DIR, name)
        if os.path.exists(path):
            print(f"leftover {path}")
            if not args.dry_run:
                shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else os.remove(path)
                print("  removed")

    # The xet blob store is only used by the cache layout; once every
    # checkpoint is flat it holds nothing the server reads.
    blobs = os.path.join(TROCR_CACHE_DIR, "blobs")
    if os.path.isdir(blobs):
        size = _dir_size(blobs)
        print(f"leftover blob store {blobs} ({size / 1e6:.1f} MB)")
        if not args.dry_run:
            shutil.rmtree(blobs, ignore_errors=True)
            print("  removed")

    # Real files only - in the old layout the same weights file shows up three
    # times (snapshot symlink, cache blob symlink, xet blob) and listing all of
    # them suggests three copies on disk when there is one.
    print(f"\n{TROCR_CACHE_DIR} now holds:")
    total = 0
    for root, _dirs, files in os.walk(TROCR_CACHE_DIR):
        for name in sorted(files):
            full = os.path.join(root, name)
            if os.path.islink(full) or not os.path.exists(full):
                continue
            size = os.path.getsize(full)
            total += size
            print(f"  {os.path.relpath(full, TROCR_CACHE_DIR):<60} {size / 1e6:>9.1f} MB")
    print(f"  {'total':<60} {total / 1e6:>9.1f} MB")


if __name__ == "__main__":
    main()
