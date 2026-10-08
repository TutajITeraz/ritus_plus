from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime

# Initialize SQLAlchemy (will be bound to app in krakenServer.py)
db = SQLAlchemy()

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    # Relationships
    owned_projects = db.relationship('Project', backref='owner', cascade='all, delete-orphan', lazy=True)
    shared_projects = db.relationship('Project', secondary='project_sharing', backref='shared_users', lazy=True, cascade='all, delete')

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    type = db.Column(db.String(50))
    iiif_url = db.Column(db.String(200))
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    # Red-ink detection sensitivity (UI percent, 0-100) for this manuscript,
    # because ink colour differs between manuscripts. NULL = not determined
    # yet. red_sensitivity_source says who set it: 'auto' (calibrated from
    # sample pages) or 'manual' (the user's override, never recalibrated).
    red_sensitivity = db.Column(db.Float)
    red_sensitivity_source = db.Column(db.String(10))
    contents = db.relationship('Content', backref='project', cascade='all, delete-orphan')
    batch_processes = db.relationship('BatchProcessing', backref='project', cascade='all, delete-orphan')
    images = db.relationship('Image', backref='project', cascade='all, delete-orphan')
    iiif_download_job = db.relationship('IiifDownloadJob', backref='project', cascade='all, delete-orphan', uselist=False)
    batch_transcribe_job = db.relationship('BatchTranscribeJob', backref='project', cascade='all, delete-orphan', uselist=False)

class ProjectSharing(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id', ondelete='CASCADE'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False)
    shared_at = db.Column(db.DateTime, default=datetime.utcnow)

class Image(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id', ondelete='CASCADE'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    original = db.Column(db.String(200), nullable=False)
    # The working copy: what a human reads/edits, and what exports use. An
    # automatic transcription fills this in too, but only while a human has
    # never touched it (see human_edited) - once someone edits a page here,
    # re-running OCR on it must not silently clobber their work.
    transcribed_text = db.Column(db.Text)
    # True once a human has explicitly saved transcribed_text (the editor's
    # Save button, or accepting an AI Auto Fix result). From then on, ordinary
    # automatic transcription (single page, batch, override, ...) leaves
    # transcribed_text alone; only the explicit "overwrite with automatic
    # transcription" action may replace it.
    human_edited = db.Column(db.Boolean, nullable=False, default=False)
    # The model's own, unedited output - always overwritten by the next
    # automatic transcription run, and never touched by a human edit. This is
    # what "overwrite with automatic transcription" copies into
    # transcribed_text, and what the transcription/human diff compares against.
    auto_transcribed_text = db.Column(db.Text)
    # Which model produced auto_transcribed_text, and when.
    model_name = db.Column(db.String(100))
    auto_transcribed_at = db.Column(db.DateTime)

class Content(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id', ondelete='CASCADE'), nullable=False)
    data = db.Column(db.Text, nullable=False)  # JSON string for dynamic columns

class BatchProcessing(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id', ondelete='CASCADE'), nullable=False)
    status = db.Column(db.String(20), nullable=False, default='pending')  # pending, running, completed, canceled, failed
    progress = db.Column(db.Float, default=0.0)
    total_rows = db.Column(db.Integer, default=0)
    processed_rows = db.Column(db.Integer, default=0)
    similarity_threshold = db.Column(db.Float, default=0.0)
    error_message = db.Column(db.Text)
    # Needed to restart the run after a server restart, with the same settings.
    method = db.Column(db.String(10))
    auto_resume_count = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=db.func.now())
    updated_at = db.Column(db.DateTime, default=db.func.now(), onupdate=db.func.now())

class BulkAiJob(db.Model):
    """Bulk AI autofix over the transcribed text of several projects. The page
    list is rebuilt from project_ids_json (in that order), and `done` pages are
    skipped, so a restarted server continues where the last one stopped."""
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, nullable=False)
    project_ids_json = db.Column(db.Text, nullable=False)
    status = db.Column(db.String(20), nullable=False, default='pending')  # pending, running, completed, failed, cancelled, interrupted
    done = db.Column(db.Integer, default=0)
    total = db.Column(db.Integer, default=0)
    changed = db.Column(db.Integer, default=0)
    projects = db.Column(db.Integer, default=0)
    skipped = db.Column(db.Integer, default=0)
    error_message = db.Column(db.Text)
    auto_resume_count = db.Column(db.Integer, default=0)
    auto_resume_mark = db.Column(db.Integer, default=0)

class IiifDownloadJob(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id', ondelete='CASCADE'), nullable=False, unique=True)
    status = db.Column(db.String(20), nullable=False, default='pending')  # pending, running, waiting, completed, failed, cancelled, interrupted
    current_page = db.Column(db.Integer, default=0)
    total_pages = db.Column(db.Integer, default=0)
    start_page = db.Column(db.Integer, default=1)  # 1-based; for resuming
    error_message = db.Column(db.Text)
    # Automatic resume after a server restart. auto_resume_count counts
    # consecutive restarts that resumed this job, auto_resume_mark is the
    # progress value the current run started from; together they tell a job
    # that is making progress from one that keeps killing the server.
    auto_resume_count = db.Column(db.Integer, default=0)
    auto_resume_mark = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=db.func.now())
    updated_at = db.Column(db.DateTime, default=db.func.now(), onupdate=db.func.now())


class BatchTranscribeJob(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id', ondelete='CASCADE'), nullable=False, unique=True)
    status = db.Column(db.String(20), nullable=False, default='pending')  # pending/running/completed/failed/cancelled/interrupted
    current_image = db.Column(db.Integer, default=0)
    total_images = db.Column(db.Integer, default=0)
    model_name = db.Column(db.String(100))
    mode = db.Column(db.String(20), default='skip')  # skip/continue/override/range
    # Full option set the job was started with (JSON), so a job interrupted by
    # a restart can be resumed with the same settings and not with defaults.
    options_json = db.Column(db.Text)
    # See IiifDownloadJob for what these two mean.
    auto_resume_count = db.Column(db.Integer, default=0)
    auto_resume_mark = db.Column(db.Integer, default=0)
    error_message = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=db.func.now())
    updated_at = db.Column(db.DateTime, default=db.func.now(), onupdate=db.func.now())