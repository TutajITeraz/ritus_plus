"""
TITLE: test_job_auto_resume.py
DESCRIPTION: Jobs killed by a server restart must come back on their own.

  A deploy or an OOM kill leaves `batch_transcribe_job` / `iiif_download_job`
  rows behind with no thread under them. The server marks those rows
  "interrupted" at startup and then starts them again itself, which is what
  these tests pin down - together with the brake that stops a job from
  restarting the server to death, and the arithmetic that keeps an "override"
  or "range" run from redoing the whole manuscript after every restart.

  Everything runs in a child process inside a temporary directory. Importing
  krakenServer has side effects by design: it opens instance/projects.db,
  reconciles it and starts worker threads. Doing that in the test process
  would point those side effects at the developer's own database.
"""
import json
import os
import subprocess
import sqlite3
import sys

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


OLD_SCHEMA = """
CREATE TABLE user (id INTEGER PRIMARY KEY, username VARCHAR(80) UNIQUE NOT NULL,
  password_hash VARCHAR(128) NOT NULL, is_admin BOOLEAN, created_at DATETIME);
CREATE TABLE project (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL,
  type VARCHAR(50), iiif_url VARCHAR(200), owner_id INTEGER NOT NULL);
CREATE TABLE project_sharing (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, shared_at DATETIME);
CREATE TABLE image (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
  name VARCHAR(100) NOT NULL, original VARCHAR(200) NOT NULL, transcribed_text TEXT);
CREATE TABLE content (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE batch_processing (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL, progress FLOAT, total_rows INTEGER, processed_rows INTEGER,
  similarity_threshold FLOAT, error_message TEXT, created_at DATETIME, updated_at DATETIME);
-- The job tables as they were before automatic resume: no options_json and no
-- auto_resume_* columns. The server has to add them to a database like this.
CREATE TABLE iiif_download_job (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL, current_page INTEGER, total_pages INTEGER,
  start_page INTEGER, error_message TEXT, created_at DATETIME, updated_at DATETIME);
CREATE TABLE batch_transcribe_job (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL, current_image INTEGER, total_images INTEGER,
  model_name VARCHAR(100), mode VARCHAR(20), error_message TEXT,
  created_at DATETIME, updated_at DATETIME);
"""


def build_sandbox(root):
    """A directory that looks enough like ritus-server to import it into.

    The modules are symlinked, so the code under test is the real code, but
    instance/, uploads/ and logs/ land here instead of in the checkout.
    """
    for name in os.listdir(SERVER_DIR):
        if name.endswith(".py"):
            os.symlink(os.path.join(SERVER_DIR, name), os.path.join(root, name))
    os.mkdir(os.path.join(root, "instance"))
    os.mkdir(os.path.join(root, "uploads"))
    with open(os.path.join(root, "domain_config.json"), "w") as f:
        # Resume is switched off for the import itself: each test drives
        # auto_resume_interrupted_jobs() by hand so it can watch what it does.
        json.dump({"transcription_workers": 1,
                   "auto_resume_interrupted_jobs": False}, f)

    db_path = os.path.join(root, "instance", "projects.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(OLD_SCHEMA)
    conn.execute("INSERT INTO user (id, username, password_hash, is_admin) VALUES (1,'admin','x',1)")
    for pid in (1, 2, 3):
        conn.execute("INSERT INTO project (id, name, iiif_url, owner_id) VALUES (?,?,?,1)",
                     (pid, "Codex %d" % pid, "https://example.org/iiif/%d/manifest" % pid))
        for i in range(1, 11):
            # Project 1 got four pages done before the server died.
            text = "already transcribed" if (pid == 1 and i <= 4) else None
            conn.execute(
                "INSERT INTO image (project_id, name, original, transcribed_text) VALUES (?,?,?,?)",
                (pid, "p%02d" % i, "p%02d.jpg" % i, text))
    conn.execute("""INSERT INTO batch_transcribe_job
        (project_id, status, current_image, total_images, model_name, mode)
        VALUES (1,'running',4,10,'catmus-medieval.mlmodel','skip')""")
    conn.execute("""INSERT INTO iiif_download_job
        (project_id, status, current_page, total_pages, start_page)
        VALUES (2,'running',6,40,1)""")
    # Cancelled on purpose by a user - must survive every restart untouched.
    conn.execute("""INSERT INTO batch_transcribe_job
        (project_id, status, current_image, total_images, model_name, mode)
        VALUES (3,'cancelled',2,10,'catmus-medieval.mlmodel','skip')""")
    conn.commit()
    conn.close()
    return db_path


def run_in_sandbox(root, body):
    """Run *body* in a child process that has imported the server."""
    script = os.path.join(root, "_case.py")
    with open(script, "w") as f:
        f.write(
            "import os, sys, threading\n"
            "sys.argv = ['krakenServer.py', '--no-kraken']\n"
            "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n"
            "import krakenServer as K\n"
            "from models import db, BatchTranscribeJob, IiifDownloadJob, Image\n"
            # Pretend Kraken is present; no page is ever really transcribed,
            # transcribe_image_by_id is replaced below where it matters.
            "K.NO_KRAKEN = False\n"
            "K._load_domain_config = lambda: {'transcription_workers': 1}\n"
            + body
        )
    result = subprocess.run([sys.executable, script], cwd=root,
                            capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, (
        "sandbox case failed\n--- stdout ---\n%s\n--- stderr ---\n%s"
        % (result.stdout, result.stderr))
    return result.stdout


def test_startup_adds_missing_columns_and_resumes_interrupted_jobs(tmp_path):
    root = str(tmp_path / "server")
    os.mkdir(root)
    db_path = build_sandbox(root)

    out = run_in_sandbox(root, '''
launched_t, launched_d = [], []
def fake_launch_t(project_id, opts, resume_offset=0, auto_resumed=False):
    launched_t.append((project_id, opts["mode"], opts["model_name"], resume_offset, auto_resumed))
    job = BatchTranscribeJob.query.filter_by(project_id=project_id).first()
    job.status = "pending"
    db.session.commit()
    return job.id
K._launch_transcribe_job = fake_launch_t
K._launch_iiif_thread = lambda pid, jid, url, folder, start: launched_d.append((pid, start))

with K.app.app_context():
    # The import already reconciled: no thread means no job.
    assert BatchTranscribeJob.query.filter_by(project_id=1).first().status == "interrupted"
    assert IiifDownloadJob.query.filter_by(project_id=2).first().status == "interrupted"
    assert BatchTranscribeJob.query.filter_by(project_id=1).first().current_image == 4
    # A job the user cancelled is not something a restart should undo.
    assert BatchTranscribeJob.query.filter_by(project_id=3).first().status == "cancelled"

K.auto_resume_interrupted_jobs()

assert launched_t == [(1, "skip", "catmus-medieval.mlmodel", 4, True)], launched_t
assert launched_d == [(2, 7)], launched_d          # page 7, not page 1
with K.app.app_context():
    assert BatchTranscribeJob.query.filter_by(project_id=3).first().status == "cancelled"
    dl = IiifDownloadJob.query.filter_by(project_id=2).first()
    assert dl.start_page == 7 and dl.auto_resume_count == 1
print("OK")
''')
    assert "OK" in out

    columns = {}
    conn = sqlite3.connect(db_path)
    for table in ("batch_transcribe_job", "iiif_download_job"):
        columns[table] = {r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)}
    conn.close()
    assert {"options_json", "auto_resume_count", "auto_resume_mark"} <= columns["batch_transcribe_job"]
    assert {"auto_resume_count", "auto_resume_mark"} <= columns["iiif_download_job"]


def test_a_job_that_never_progresses_is_eventually_left_alone(tmp_path):
    """The brake: a job that keeps taking the server down stops being resumed."""
    root = str(tmp_path / "server")
    os.mkdir(root)
    build_sandbox(root)

    run_in_sandbox(root, '''
launched = []
K._launch_iiif_thread = lambda pid, jid, url, folder, start: launched.append((pid, start))

def crash_again(page, mark):
    """Put the download back exactly where the last attempt started."""
    with K.app.app_context():
        job = IiifDownloadJob.query.filter_by(project_id=2).first()
        job.status = "interrupted"
        job.current_page = page
        job.auto_resume_mark = mark
        db.session.commit()

attempts = []
for _ in range(K.MAX_AUTO_RESUMES + 2):
    crash_again(6, 6)
    launched.clear()
    K.auto_resume_interrupted_jobs()
    attempts.append(list(launched))

assert attempts[:K.MAX_AUTO_RESUMES - 1] == [[(2, 7)]] * (K.MAX_AUTO_RESUMES - 1), attempts
assert attempts[-1] == [], attempts
with K.app.app_context():
    job = IiifDownloadJob.query.filter_by(project_id=2).first()
    assert job.status == "interrupted"
    assert "gave up" in (job.error_message or ""), job.error_message

# ...but a run that actually got somewhere earns a fresh set of attempts.
crash_again(30, 6)
launched.clear()
K.auto_resume_interrupted_jobs()
assert launched == [(2, 31)], launched
with K.app.app_context():
    assert IiifDownloadJob.query.filter_by(project_id=2).first().auto_resume_count == 1
print("OK")
''')


def test_override_and_range_resume_where_they_stopped(tmp_path):
    """Without an offset these modes would redo page 1 after every restart."""
    root = str(tmp_path / "server")
    os.mkdir(root)
    build_sandbox(root)

    run_in_sandbox(root, '''
transcribed = []
K.transcribe_image_by_id = lambda image_id, model, **kw: transcribed.append(image_id) or "text"
# The memory governor caps workers by free RAM; pin it so the rewind below is
# measured against the number this test actually asked for.
K._page_admission.cap_workers = lambda n: n

def run(project_id, mode, resume_offset, workers, **extra):
    transcribed.clear()
    K._load_domain_config = lambda: {"transcription_workers": workers}
    with K.app.app_context():
        job = BatchTranscribeJob.query.filter_by(project_id=project_id).first()
        if job is None:
            job = BatchTranscribeJob(project_id=project_id)
            db.session.add(job)
        job.status, job.mode, job.current_image = "pending", mode, 0
        db.session.commit()
        job_id = job.id
        ids = [i.id for i in Image.query.filter_by(project_id=project_id).order_by(Image.id.asc())]
    stop = threading.Event()
    K._transcribe_stop_events[project_id] = stop
    K.run_batch_transcribe(project_id, job_id, "m.mlmodel", mode, K.app, stop,
                           resume_offset=resume_offset, **extra)
    K._transcribe_stop_events.pop(project_id, None)
    with K.app.app_context():
        job = BatchTranscribeJob.query.filter_by(project_id=project_id).first()
        return ids, sorted(transcribed), job

# Project 2: ten untouched pages, override interrupted after six.
ids, done, job = run(2, "override", resume_offset=6, workers=1)
assert done == ids[6:], done
assert (job.current_image, job.total_images) == (10, 10)   # progress bar still reads 10/10
assert job.status == "completed"
assert job.auto_resume_mark == 6

# Three pages were in flight when the server died, so rewind by two: better a
# couple of pages transcribed twice than a hole in the middle of a manuscript.
ids, done, job = run(2, "override", resume_offset=6, workers=3)
assert done == ids[4:], done

# A start nobody interrupted still does the whole thing.
ids, done, job = run(2, "override", resume_offset=0, workers=1)
assert done == ids, done

# Range keeps its bounds and resumes inside them.
ids, done, job = run(2, "range", resume_offset=2, workers=1, range_from=3, range_to=8)
assert done == ids[4:8], done
assert (job.current_image, job.total_images) == (6, 6)

# Skip recomputes the work list from what has no text, so the offset is noise.
# Project 1 has pages 1-4 transcribed already.
ids, done, job = run(1, "skip", resume_offset=99, workers=1)
assert done == ids[4:], done
assert (job.current_image, job.total_images) == (6, 6)
print("OK")
''')
