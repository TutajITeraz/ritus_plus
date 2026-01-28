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
from models import User
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
        print(f"Database initialized with {total_users} user(s).")

        print("Database initialization complete!")

if __name__ == "__main__":
    init_database()