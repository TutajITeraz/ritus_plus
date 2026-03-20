#!/usr/bin/env python3
"""
Database initialization script for Ritus Plus server.
Creates default admin user and any other initial data.
"""

import sys
import os

# Add the parent directory to the path so we can import the app
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from krakenServer import app, db
from models import User, Project, Image, BatchTranscribeJob, IiifDownloadJob
from config import ADMIN_USERNAME, ADMIN_PASSWORD

def init_database():
    """Initialize the database with default data."""
    with app.app_context():
        # Create all tables
        print("Creating database tables...")
        db.create_all()

        # Check if admin user already exists
        admin_user = User.query.filter_by(username=ADMIN_USERNAME).first()
        if admin_user:
            print(f"Admin user '{ADMIN_USERNAME}' already exists.")
        else:
            # Create admin user
            print(f"Creating admin user '{ADMIN_USERNAME}'...")
            admin_user = User(username=ADMIN_USERNAME, is_admin=True)
            admin_user.set_password(ADMIN_PASSWORD)
            db.session.add(admin_user)
            db.session.commit()
            print(f"Admin user '{ADMIN_USERNAME}' created successfully.")

        # Print database statistics
        total_users = User.query.count()
        total_projects = Project.query.count()
        total_images = Image.query.count()
        total_iiif_jobs = IiifDownloadJob.query.count()
        total_transcribe_jobs = BatchTranscribeJob.query.count()
        print(f"  users:               {total_users}")
        print(f"  projects:            {total_projects}")
        print(f"  images:              {total_images}")
        print(f"  iiif_download_jobs:  {total_iiif_jobs}")
        print(f"  batch_transcribe_jobs: {total_transcribe_jobs}")

        # Ensure domain_config.json exists with sensible defaults
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "domain_config.json")
        if not os.path.exists(config_path):
            import json
            default_config = {
                "gallica.bnf.fr": {"sleep_seconds": 1, "timeout": 60},
                "digi.vatlib.it": {"sleep_seconds": 2, "timeout": 120}
            }
            with open(config_path, "w") as f:
                json.dump(default_config, f, indent=2)
            print("Created default domain_config.json")
        else:
            print(f"domain_config.json already exists at {config_path}")

        print("Database initialization complete!")

if __name__ == "__main__":
    init_database()