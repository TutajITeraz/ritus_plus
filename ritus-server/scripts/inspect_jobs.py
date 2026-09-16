#!/usr/bin/env python3
"""
TITLE: inspect_jobs.py
DESCRIPTION: Dump — and optionally unstick — the background download and
  transcription jobs recorded in the ritus database.

  Background jobs run as threads inside the server process. Their progress is
  written to two tables, `batch_transcribe_job` and `iiif_download_job`. When a
  process dies (deploy, `systemctl restart kraken_flask`, crash, OOM kill) the
  threads go with it, but those rows keep saying "running" or "pending". The
  server then shows a progress bar that can never move, and refuses to start
  the job again ("Transcription already running"). Restarting does not help,
  because nothing ever revisited the rows.

  This script talks to the SQLite file directly, so it works even when the
  server is wedged or stopped, and it needs no login.

USAGE (on the server, from the ritus-server directory):

    python3 scripts/inspect_jobs.py                 # show every job row
    python3 scripts/inspect_jobs.py --json          # same, machine readable
    python3 scripts/inspect_jobs.py --stuck         # only the stuck rows
    python3 scripts/inspect_jobs.py --reset         # clear stuck rows (asks first)
    python3 scripts/inspect_jobs.py --db /path/to/projects.db

  --reset is safe: it only rewrites the job's *status*. No transcription, no
  image and no downloaded page is touched, and each affected project can be
  resumed or restarted from the web interface afterwards.

  NOTE: from the server release that added startup reconciliation onwards,
  stuck rows are cleared automatically every time the server starts, so
  --reset is only needed to rescue an older deployment.
"""
import argparse
import datetime
import json
import os
import sqlite3
import sys

# Rows in these states claim a worker thread is on the job right now.
ACTIVE_TRANSCRIBE = ("running", "pending")
ACTIVE_DOWNLOAD = ("running", "pending", "waiting")

DEFAULT_DB = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "instance",
    "projects.db",
)


def connect(path):
    if not os.path.exists(path):
        sys.exit("Database not found: %s\nPass the right path with --db" % path)
    conn = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def read_jobs(conn):
    transcribe = [dict(r) for r in conn.execute(
        """
        SELECT j.*, p.name AS project_name
        FROM batch_transcribe_job j
        LEFT JOIN project p ON p.id = j.project_id
        ORDER BY j.project_id
        """
    )]
    download = [dict(r) for r in conn.execute(
        """
        SELECT j.*, p.name AS project_name, p.iiif_url
        FROM iiif_download_job j
        LEFT JOIN project p ON p.id = j.project_id
        ORDER BY j.project_id
        """
    )]
    return transcribe, download


def age(updated_at):
    """How long ago the row was last touched, as a human string."""
    if not updated_at:
        return "never"
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            then = datetime.datetime.strptime(str(updated_at), fmt)
            break
        except ValueError:
            continue
    else:
        return str(updated_at)
    delta = datetime.datetime.utcnow() - then
    minutes = int(delta.total_seconds() // 60)
    if minutes < 60:
        return "%dm ago" % minutes
    if minutes < 60 * 48:
        return "%dh ago" % (minutes // 60)
    return "%dd ago" % (minutes // (60 * 24))


def print_table(title, rows, active_states, current_key, total_key, stuck_only):
    shown = [r for r in rows if not stuck_only or r["status"] in active_states]
    print("\n%s (%d row%s%s)" % (
        title, len(shown), "" if len(shown) == 1 else "s",
        " shown of %d" % len(rows) if stuck_only and len(shown) != len(rows) else "",
    ))
    print("-" * 100)
    if not shown:
        print("  (none)")
        return
    print("  %-6s %-34s %-12s %-12s %-12s %s" % (
        "proj", "project", "status", "progress", "last update", "error"))
    for r in shown:
        flag = "  <-- STUCK" if r["status"] in active_states else ""
        name = (r["project_name"] or "?")[:32]
        progress = "%s/%s" % (r.get(current_key) or 0, r.get(total_key) or "?")
        err = (r.get("error_message") or "")[:30]
        print("  %-6s %-34s %-12s %-12s %-12s %s%s" % (
            r["project_id"], name, r["status"], progress,
            age(r.get("updated_at")), err, flag))


def reset_stuck(path, assume_yes):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    t_marks = ",".join("?" * len(ACTIVE_TRANSCRIBE))
    d_marks = ",".join("?" * len(ACTIVE_DOWNLOAD))
    n_t = conn.execute(
        "SELECT COUNT(*) FROM batch_transcribe_job WHERE status IN (%s)" % t_marks,
        ACTIVE_TRANSCRIBE,
    ).fetchone()[0]
    n_d = conn.execute(
        "SELECT COUNT(*) FROM iiif_download_job WHERE status IN (%s)" % d_marks,
        ACTIVE_DOWNLOAD,
    ).fetchone()[0]

    if not n_t and not n_d:
        print("\nNothing to reset - no job is in an active state.")
        return

    print("\nWill mark %d transcription job(s) and %d download job(s) as "
          "'interrupted'." % (n_t, n_d))
    print("Only the status column changes. Transcribed text and downloaded "
          "images are untouched.")
    if not assume_yes:
        if input("Proceed? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Aborted.")
            return

    # Stop the server first if it is running, otherwise a thread that is still
    # alive will write its own status back over this one.
    conn.execute(
        "UPDATE batch_transcribe_job SET status='interrupted', "
        "error_message='Reset by scripts/inspect_jobs.py - start the job again' "
        "WHERE status IN (%s)" % t_marks, ACTIVE_TRANSCRIBE)
    conn.execute(
        "UPDATE iiif_download_job SET status='interrupted', "
        "error_message='Reset by scripts/inspect_jobs.py - resume the download' "
        "WHERE status IN (%s)" % d_marks, ACTIVE_DOWNLOAD)
    conn.commit()
    conn.close()
    print("Done. Reload the projects page; each affected project now offers "
          "Resume / Retry.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB, help="path to projects.db (default: %(default)s)")
    ap.add_argument("--json", action="store_true", help="dump raw rows as JSON")
    ap.add_argument("--stuck", action="store_true", help="show only rows in an active state")
    ap.add_argument("--reset", action="store_true", help="mark active rows as interrupted")
    ap.add_argument("-y", "--yes", action="store_true", help="skip the --reset confirmation")
    args = ap.parse_args()

    conn = connect(args.db)
    transcribe, download = read_jobs(conn)
    conn.close()

    if args.json:
        print(json.dumps({
            "database": args.db,
            "generated_at": datetime.datetime.utcnow().isoformat(),
            "transcribe_jobs": transcribe,
            "download_jobs": download,
        }, indent=2, default=str))
    else:
        print("Database: %s" % args.db)
        print_table("Transcription jobs", transcribe, ACTIVE_TRANSCRIBE,
                    "current_image", "total_images", args.stuck)
        print_table("IIIF download jobs", download, ACTIVE_DOWNLOAD,
                    "current_page", "total_pages", args.stuck)
        stuck_t = [r for r in transcribe if r["status"] in ACTIVE_TRANSCRIBE]
        stuck_d = [r for r in download if r["status"] in ACTIVE_DOWNLOAD]
        if stuck_t or stuck_d:
            print("\n%d transcription and %d download row(s) claim to be active."
                  % (len(stuck_t), len(stuck_d)))
            print("If the server was restarted since 'last update', no thread is "
                  "behind them and they are blocking new jobs.")
            print("Clear them with: python3 scripts/inspect_jobs.py --reset")

    if args.reset:
        reset_stuck(args.db, args.yes)


if __name__ == "__main__":
    main()
