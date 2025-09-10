from flask_sqlalchemy import SQLAlchemy

# Initialize SQLAlchemy (will be bound to app in krakenServer.py)
db = SQLAlchemy()

class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    type = db.Column(db.String(50))
    iiif_url = db.Column(db.String(200))
    contents = db.relationship('Content', backref='project', cascade='all, delete-orphan')
    batch_processes = db.relationship('BatchProcessing', backref='project', cascade='all, delete-orphan')

class Image(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    original = db.Column(db.String(200), nullable=False)
    transcribed_text = db.Column(db.Text)

class Content(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id'), nullable=False)
    data = db.Column(db.Text, nullable=False)  # JSON string for dynamic columns

class BatchProcessing(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id'), nullable=False)
    status = db.Column(db.String(20), nullable=False, default='pending')  # pending, running, completed, canceled, failed
    progress = db.Column(db.Float, default=0.0)
    total_rows = db.Column(db.Integer, default=0)
    processed_rows = db.Column(db.Integer, default=0)
    similarity_threshold = db.Column(db.Float, default=0.0)
    error_message = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=db.func.now())
    updated_at = db.Column(db.DateTime, default=db.func.now(), onupdate=db.func.now())