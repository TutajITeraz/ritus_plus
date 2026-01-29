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
    contents = db.relationship('Content', backref='project', cascade='all, delete-orphan')
    batch_processes = db.relationship('BatchProcessing', backref='project', cascade='all, delete-orphan')
    images = db.relationship('Image', backref='project', cascade='all, delete-orphan')

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
    transcribed_text = db.Column(db.Text)

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
    created_at = db.Column(db.DateTime, default=db.func.now())
    updated_at = db.Column(db.DateTime, default=db.func.now(), onupdate=db.func.now())