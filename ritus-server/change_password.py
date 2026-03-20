from krakenServer import app
from models import db, User
import sys

def change_password(username, new_password):
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if not user:
            print(f"Error: User '{username}' not found.")
            return
        
        user.set_password(new_password)
        db.session.commit()
        print(f"Password for user '{username}' has been updated successfully.")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python change_password.py <username> <new_password>")
        print("Example: python change_password.py admin MyNewPassword123")
    else:
        change_password(sys.argv[1], sys.argv[2])
