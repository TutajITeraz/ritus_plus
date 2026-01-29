import sys
import argparse
import os
import logging
import json
import re
import cv2
import torch
import webbrowser
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_jwt_extended import JWTManager, jwt_required, create_access_token, get_jwt_identity
from PIL import Image as PILImage
from PIL import ImageFile
from threading import Timer, Thread
from flask_caching import Cache
from config import SERVER_URL, ADMIN_USERNAME, ADMIN_PASSWORD, SECRET_KEY

# Importy lokalne
from models import db, User, Project, ProjectSharing, Image, Content, BatchProcessing
from batch_analysis import batch_process_project
from image_processing import split_line_boundary_by_color
from ai_tools import gpt_autofix
from secret_user_api_key import user_api_key
from cache_config import cache, init_cache

# --- KONFIGURACJA LOGOWANIA ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- PARSOWANIE ARGUMENTÓW ---
parser = argparse.ArgumentParser()
parser.add_argument('--no-kraken', action='store_true', help='Disable kraken OCR')
args, unknown = parser.parse_known_args()
NO_KRAKEN = args.no_kraken

if not NO_KRAKEN:
    from kraken import binarization, rpred, pageseg, blla
    from kraken.lib import vgsl
    from kraken.lib.models import load_any

def get_model_path(model_name):
    local_path = os.path.join("models", model_name)
    if os.path.exists(local_path): return local_path
    user_home = os.path.expanduser("~")
    app_support_path = os.path.join(user_home, "Library", "Application Support", "kraken", model_name)
    return app_support_path if os.path.exists(app_support_path) else None

# --- INICJALIZACJA FLASK ---
app = Flask(__name__, static_folder="static", static_url_path="/")
CORS(app, resources={
    r"/api/*": {
        "origins": "*",
        "allow_headers": ["Content-Type", "Authorization"],
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    }
})

# JWT Configuration
app.config["JWT_SECRET_KEY"] = SECRET_KEY
app.config["JWT_ACCESS_TOKEN_EXPIRE_MINUTES"] = 10080  # 7 days
jwt = JWTManager(app)

# Konfiguracja Gunicorn Logging
if __name__ != '__main__':
    gunicorn_logger = logging.getLogger('gunicorn.error')
    app.logger.handlers = gunicorn_logger.handlers
    app.logger.setLevel(gunicorn_logger.level)

# --- KONFIGURACJA BAZY I CACHE ---
# Dodajemy timeout=20 dla SQLite, aby uniknąć blokad
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///projects.db?timeout=20"
app.config["UPLOAD_FOLDER"] = "uploads"
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024 

db.init_app(app)
init_cache(app)

def init_database():
    """Initialize database tables and create admin user if needed."""
    with app.app_context():
        db.create_all()
        # Create admin user if not exists
        admin_user = User.query.filter_by(username=ADMIN_USERNAME).first()
        if not admin_user:
            admin_user = User(username=ADMIN_USERNAME, is_admin=True)
            admin_user.set_password(ADMIN_PASSWORD)
            db.session.add(admin_user)
            db.session.commit()
            logger.info("Admin user created")

# Initialize database for both direct run and Gunicorn
init_database()

ImageFile.LOAD_TRUNCATED_IMAGES = True
if not os.path.exists(app.config["UPLOAD_FOLDER"]):
    os.makedirs(app.config["UPLOAD_FOLDER"])

# --- OPTYMALIZACJA SQLITE (Tryb WAL) ---
def enable_wal(app):
    with app.app_context():
        with db.engine.connect() as connection:
            connection.exec_driver_sql("PRAGMA journal_mode=WAL")
            connection.exec_driver_sql("PRAGMA synchronous=NORMAL")

# --- MODELE KRAKEN (Globalne ładowanie) ---
selected_device = "cuda:0" if torch.cuda.is_available() else "cpu"
baseline_model = None
ocr_model = None
last_ocr_model_name = "Tridis_Medieval_EarlyModern.mlmodel"
MODEL_PATHS = {}

if not NO_KRAKEN:
    MODEL_PATHS = {
        "Tridis_Medieval_EarlyModern.mlmodel": get_model_path("Tridis_Medieval_EarlyModern.mlmodel"),
        "cremma-generic-1.0.1.mlmodel": get_model_path("cremma-generic-1.0.1.mlmodel"),
        "ManuMcFondue.mlmodel": get_model_path("ManuMcFondue.mlmodel"),
        "catmus-medieval.mlmodel": get_model_path("catmus-medieval.mlmodel"),
        "blla.mlmodel": get_model_path("blla.mlmodel"),
    }
    # Uwaga: Ładowanie ciężkich modeli lepiej robić wewnątrz pierwszej prośby 
    # lub użyć preload_app w Gunicorn, aby nie dublować RAM-u
    baseline_model_path = MODEL_PATHS.get("blla.mlmodel")
    if baseline_model_path:
        baseline_model = vgsl.TorchVGSLModel.load_model(baseline_model_path).to(device=selected_device)

### Color separation: #######################################################

################################### START OF SERVER:############################

# Only define kraken-dependent functions if not NO_KRAKEN
if not NO_KRAKEN:
    def serialize_segmentation(segmentation):
        serialized_lines = []
        for line in segmentation:
            serialized_lines.append({
                "id": line.id,
                "baseline": line.baseline,
                "boundary": line.boundary,
                "text": line.text,
                "base_dir": line.base_dir,
                "type": line.type,
                "imagename": line.imagename,
                "tags": line.tags,
                "split": line.split,
                "regions": line.regions,
            })
        return serialized_lines

    def transcribe_image(image_file, model_name):
        global baseline_model, last_ocr_model_name, ocr_model, selected_device
        import time
        start_time = time.time()
        model_path = MODEL_PATHS.get(model_name)
        if not model_path:
            logger.error(f"Model not found: {model_name}")
            return "Model not found", 400

        if model_name != last_ocr_model_name:
            logger.info(f"Loading model: {model_name}")
            ocr_model = load_any(model_path, device=selected_device)
            last_ocr_model_name = model_name

        logger.info("Image processing...")
        image = PILImage.open(image_file)
        if image.mode != "L":
            image = image.convert("L")

        logger.info("Baseline segmentation...")
        seg = blla.segment(image, model=baseline_model, device=selected_device)
        lines = serialize_segmentation(seg.lines)

        # black_seg, red_seg = split_seg(seg, image) # Only if split_seg is defined

        logger.info("LINES:")
        logger.info(lines)

        logger.info("Recognition...")
        predictions = rpred.rpred(ocr_model, image, seg)
        transcribed_text = ""
        for record in predictions:
            if len(str(record)) > 2:
                transcribed_text += str(record) + "\n"

        elapsed = time.time() - start_time
        logger.info(f"Transcription operation took {elapsed:.2f} seconds on device: {selected_device}")

        return {"text": transcribed_text, "lines": lines}



################################################################################################
################################################################################################
"""
hue selectivity is too narrow.

I can provide a hsv values for sample red and not red. So maybe some kind of distance calculation?

how_red = how_close_to_red_color - how_close_to_bg_color -how_close_to_black.


red color samples:
H: 17/365 
S: 73
V: 73

H: 20/365
S: 35
V: 91

H: 11/365
S: 77
V: 54

H: 11/365
S: 66
V: 73
"""




def rgb_to_hsl(rgb):
    """
    Convert an RGB image (NumPy array) to HSL.
    
    Args:
        rgb: NumPy array of shape (height, width, 3) with values in [0, 255].
    
    Returns:
        hsl: NumPy array of shape (height, width, 3) with H, S, L in [0, 1].
    """
    rgb = rgb.astype(float) / 255.0
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    
    cmax = np.max(rgb, axis=2)
    cmin = np.min(rgb, axis=2)
    delta = cmax - cmin
    
    l = (cmax + cmin) / 2.0
    
    s = np.zeros_like(l)
    mask = cmax != cmin
    s[mask] = delta[mask] / (1.0 - np.abs(2.0 * l[mask] - 1.0))
    s[~mask] = 0
    
    h = np.zeros_like(l)
    h[delta == 0] = 0  # Set hue to 0 where delta is 0 to avoid division by zero
    mask_r = (cmax == r) & (delta > 0)
    mask_g = (cmax == g) & (delta > 0)
    mask_b = (cmax == b) & (delta > 0)
    
    h[mask_r] = (60 * ((g - b) / delta))[mask_r] % 360
    h[mask_g] = (60 * ((b - r) / delta + 2))[mask_g]
    h[mask_b] = (60 * ((r - g) / delta + 4))[mask_b]
    
    h = h / 360.0
    return np.stack([h, s, l], axis=2)

def hsl_to_rgb(hsl):
    """
    Convert an HSL image (NumPy array) to RGB.
    
    Args:
        hsl: NumPy array of shape (height, width, 3) with H, S, L in [0, 1].
    
    Returns:
        rgb: NumPy array of shape (height, width, 3) with values in [0, 255].
    """
    h, s, l = hsl[:, :, 0], hsl[:, :, 1], hsl[:, :, 2]
    h = h * 360
    
    c = (1 - np.abs(2 * l - 1)) * s
    x = c * (1 - np.abs((h / 60) % 2 - 1))
    m = l - c / 2
    
    rgb = np.zeros_like(hsl)
    
    for i in range(h.shape[0]):
        for j in range(h.shape[1]):
            h_ij = h[i, j]
            c_ij = c[i, j]
            x_ij = x[i, j]
            m_ij = m[i, j]
            
            if 0 <= h_ij < 60:
                r, g, b = c_ij, x_ij, 0
            elif 60 <= h_ij < 120:
                r, g, b = x_ij, c_ij, 0
            elif 120 <= h_ij < 180:
                r, g, b = 0, c_ij, x_ij
            elif 180 <= h_ij < 240:
                r, g, b = 0, x_ij, c_ij
            elif 240 <= h_ij < 300:
                r, g, b = x_ij, 0, c_ij
            else:
                r, g, b = c_ij, 0, x_ij
                
            rgb[i, j] = np.array([r, g, b]) + m_ij
    
    return (rgb * 255).astype(np.uint8)


def transcribe_image_by_id(image_id, model_name):
    global baseline_model, last_ocr_model_name, ocr_model, selected_device
    model_path = MODEL_PATHS.get(model_name)
    if not model_path:
        logger.error(f"Model not found: {model_name}")
        return "Model not found", 400

    image_record = Image.query.get_or_404(image_id)
    image_path = image_record.original
    if not os.path.exists(image_path):
        logger.error(f"Image file not found at {image_path}")
        return f"Image file not found at {image_path}", 404

    if model_name != last_ocr_model_name:
        logger.info(f"Loading model: {model_name}")
        ocr_model = load_any(model_path, device=selected_device)
        last_ocr_model_name = model_name

    logger.info("Image processing...")
    # Load color image for cropping and analysis
    color_image = PILImage.open(image_path)
    # Load grayscale image for OCR
    ocr_image = PILImage.open(image_path)
    if ocr_image.mode != "L":
        ocr_image = ocr_image.convert("L")

    logger.info("Baseline segmentation...")
    seg = blla.segment(ocr_image, model=baseline_model, device=selected_device, text_direction='horizontal-tb')

    # Log segmentation attributes for debugging
    logger.info(f"Segmentation attributes: {seg.__dict__}")

    # Ensure debug directory exists
    debug_dir = "dbg_imgs"
    os.makedirs(debug_dir, exist_ok=True)

    transcribed_text = ""
    new_lines = []
    original_lines = seg.lines
    if not original_lines:
        logger.info("No lines detected in image")
        return "", 200

    previous_color = None  # Track color of previous non-whitespace record
    buffered_text = []     # Buffer for accumulating text of the same color

    for i, line in enumerate(original_lines):
        logger.info(f"Processing line {i + 1}")
        logger.info(f"Baseline: {line.baseline}")
        logger.info(f"Boundary: {line.boundary}")

        # Split line by color and get new line segments
        split_lines = split_line_boundary_by_color(color_image, line, i, debug_dir, window_size=80, red_threshold=10)

        # Process each split line for OCR
        for split_line in split_lines:
            seg.lines = [split_line]
            logger.info(f"Recognition for line {i + 1}, color {split_line.color}...")
            try:
                predictions = rpred.rpred(ocr_model, ocr_image, seg)
                for record in predictions:
                    record_text = str(record).strip()
                    # Skip if record is empty or contains only non-letter characters
                    if not record_text or not re.search(r'[a-zA-Z]', record_text):
                        logger.debug(f"Skipping record for line {i + 1}, color {split_line.color}: '{record_text}' (empty or non-letter)")
                        continue
                    
                    current_color = split_line.color.upper()
                    if current_color == "RED":
                        if previous_color == "RED":
                            # Append to buffered text without closing/opening tags
                            buffered_text.append(record_text)
                        else:
                            # Close previous red text if open, start new red text
                            if buffered_text and previous_color == "RED":
                                transcribed_text += " ".join(buffered_text) + "</red> "
                                buffered_text = []
                            elif buffered_text:
                                transcribed_text += " ".join(buffered_text) + " "
                                buffered_text = []
                            buffered_text.append(record_text)
                            if not transcribed_text.endswith("<red> "):
                                transcribed_text += "<red> "
                    else:  # BLACK (default)
                        if buffered_text and previous_color == "RED":
                            # Close red text and append buffered text
                            transcribed_text += " ".join(buffered_text) + "</red> "
                            buffered_text = []
                        elif buffered_text:
                            # Append buffered black text
                            transcribed_text += " ".join(buffered_text) + " "
                            buffered_text = []
                        buffered_text.append(record_text)
                    
                    previous_color = current_color
                    logger.info(f"Prediction {current_color}: {record_text}")
            except Exception as e:
                logger.error(f"OCR failed for line {i + 1}, color {split_line.color}: {str(e)}")

        new_lines.extend(split_lines)

    # Append any remaining buffered text
    if buffered_text:
        if previous_color == "RED":
            transcribed_text += " ".join(buffered_text) + "</red>"
        else:
            transcribed_text += " ".join(buffered_text)

    image_record.transcribed_text = transcribed_text.strip()
    db.session.commit()

    return {"text": transcribed_text, "lines": new_lines}


# Authentication middleware
def get_current_user():
    current_user_id = get_jwt_identity()
    # Handle admin user (not in database)
    if current_user_id == "admin":
        return type('AdminUser', (), {
            'id': 'admin',
            'username': 'admin',
            'is_admin': True
        })()
    # Handle regular users
    current_user = User.query.get(int(current_user_id))
    return current_user

def check_project_access(project_id, user=None):
    """Check if user has access to the project (owner or shared)"""
    if user is None:
        user = get_current_user()
        if not user:
            return False
    project = Project.query.get_or_404(project_id)
    if project.owner_id == user.id:
        return True
    sharing = ProjectSharing.query.filter_by(project_id=project_id, user_id=user.id).first()
    return sharing is not None

# Authentication routes
@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()
    username = data.get("username")
    password = data.get("password")

    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400

    # Check admin credentials and get admin user from database
    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
        admin_user = User.query.filter_by(username=ADMIN_USERNAME).first()
        if admin_user:
            access_token = create_access_token(identity=str(admin_user.id))
            return jsonify({"access_token": access_token, "user": {"id": admin_user.id, "username": admin_user.username, "is_admin": admin_user.is_admin}})

    # Check regular user
    user = User.query.filter_by(username=username).first()
    if user and user.check_password(password):
        access_token = create_access_token(identity=str(user.id))
        return jsonify({"access_token": access_token, "user": {"id": user.id, "username": user.username, "is_admin": user.is_admin}})

    return jsonify({"error": "Invalid credentials"}), 401

@app.route("/api/users", methods=["GET"])
@jwt_required()
def get_users():
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    users = User.query.all()
    result = [{"id": u.id, "username": u.username} for u in users if u.id != current_user.id]
    return jsonify(result)

@app.route("/api/users", methods=["POST"])
@jwt_required()
def create_user():
    current_user = get_current_user()
    if not current_user or not current_user.is_admin:
        return jsonify({"error": "Admin access required"}), 403

    data = request.get_json()
    username = data.get("username")
    password = data.get("password")
    is_admin = data.get("is_admin", False)

    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400

    if User.query.filter_by(username=username).first():
        return jsonify({"error": "Username already exists"}), 400

    user = User(username=username, is_admin=is_admin)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    return jsonify({"id": user.id, "username": user.username, "is_admin": user.is_admin}), 201

@app.route("/api/users/<int:user_id>", methods=["PUT"])
@jwt_required()
def update_user(user_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    if not current_user.is_admin and current_user.id != user_id:
        return jsonify({"error": "Access denied"}), 403

    user = User.query.get_or_404(user_id)
    data = request.get_json()

    if "password" in data:
        user.set_password(data["password"])

    if current_user.is_admin and "is_admin" in data:
        user.is_admin = data["is_admin"]

    db.session.commit()
    return jsonify({"id": user.id, "username": user.username, "is_admin": user.is_admin})

@app.route("/api/users/<int:user_id>", methods=["DELETE"])
@jwt_required()
def delete_user(user_id):
    current_user = get_current_user()
    if not current_user or not current_user.is_admin:
        return jsonify({"error": "Admin access required"}), 403

    user = User.query.get_or_404(user_id)
    
    # Manually delete all projects owned by this user first
    # This ensures cascade deletion of images and other related data
    owned_projects = Project.query.filter_by(owner_id=user_id).all()
    for project in owned_projects:
        # Delete project folder and all files
        project_folder = os.path.join(app.config["UPLOAD_FOLDER"], f"project_{project.id}")
        if os.path.exists(project_folder):
            import shutil
            shutil.rmtree(project_folder)
        db.session.delete(project)
    
    # Delete the user (this will also delete any remaining relationships via cascade)
    db.session.delete(user)
    db.session.commit()
    logger.info(f"Deleted user {user.username} and all their projects by admin {current_user.username}")
    return jsonify({"message": "User deleted"})

@app.route("/api/users/<int:user_id>/projects/<int:project_id>/share", methods=["POST"])
@jwt_required()
def share_project(user_id, project_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    project = Project.query.get_or_404(project_id)
    if project.owner_id != current_user.id:
        return jsonify({"error": "Only project owner can share"}), 403

    user = User.query.get_or_404(user_id)

    # Check if already shared
    existing = ProjectSharing.query.filter_by(project_id=project_id, user_id=user_id).first()
    if existing:
        return jsonify({"error": "Project already shared with this user"}), 400

    sharing = ProjectSharing(project_id=project_id, user_id=user_id)
    db.session.add(sharing)
    db.session.commit()

    return jsonify({"message": "Project shared successfully"})

@app.route("/api/projects/<int:project_id>/shared_users", methods=["GET"])
@jwt_required()
def get_shared_users(project_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    project = Project.query.get_or_404(project_id)
    if project.owner_id != current_user.id:
        return jsonify({"error": "Only project owner can view shares"}), 403

    try:
        shared_users = User.query.join(ProjectSharing).filter(ProjectSharing.project_id == project_id).all()
        result = [{"id": u.id, "username": u.username} for u in shared_users]
        return jsonify(result)
    except Exception as e:
        logger.error(f"Error in get_shared_users for project ID {project_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects/<int:project_id>/shares", methods=["POST"])
@jwt_required()
def update_project_shares(project_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    project = Project.query.get_or_404(project_id)
    if project.owner_id != current_user.id:
        return jsonify({"error": "Only project owner can update shares"}), 403

    data = request.get_json()
    new_user_ids = set(data.get("user_ids", []))

    try:
        # Get current shared user IDs
        current_sharings = ProjectSharing.query.filter_by(project_id=project_id).all()
        current_user_ids = set(s.user_id for s in current_sharings)

        # Users to add
        to_add = new_user_ids - current_user_ids
        # Users to remove
        to_remove = current_user_ids - new_user_ids

        # Remove old shares
        for user_id in to_remove:
            sharing = ProjectSharing.query.filter_by(project_id=project_id, user_id=user_id).first()
            if sharing:
                db.session.delete(sharing)

        # Add new shares
        for user_id in to_add:
            user = User.query.get(user_id)
            if user and user.id != current_user.id:  # Don't share with self
                sharing = ProjectSharing(project_id=project_id, user_id=user_id)
                db.session.add(sharing)

        db.session.commit()
        return jsonify({"message": "Project shares updated"})
    except Exception as e:
        db.session.rollback()
        logger.error(f"Error in update_project_shares for project ID {project_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


# Debug route
@app.route("/api/debug/batch-processing")
def debug_batch_processing():
    try:
        count = BatchProcessing.query.count()
        return jsonify({"status": "success", "batch_processing_count": count})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# Batch Processing Routes
@app.route("/api/projects/<int:project_id>/batch-process", methods=["POST"])
def start_batch_process(project_id):
    logger.info(f"POST /api/projects/{project_id}/batch-process registered")
    try:
        project = Project.query.get_or_404(project_id)
        data = request.json
        similarity_threshold = data.get("similarity_threshold", 75.0)
        if not isinstance(similarity_threshold, (int, float)) or similarity_threshold < 1 or similarity_threshold > 100:
            logger.error(f"Invalid similarity threshold: {similarity_threshold}")
            return jsonify({"error": "Invalid similarity threshold (must be between 1 and 100)"}), 400

        # Delete any existing batch process for this project
        BatchProcessing.query.filter_by(project_id=project_id).delete()
        db.session.commit()

        # Create new batch process
        batch_process = BatchProcessing(
            project_id=project_id,
            status="running",
            similarity_threshold=similarity_threshold
        )
        db.session.add(batch_process)
        db.session.commit()

        # Start processing in a background thread
        def run_batch_process(batch_process_id):
            with app.app_context():
                logger.info("Inside app context, checking BatchProcessing")
                try:
                    batch_process_project(project_id, similarity_threshold)
                    batch_process = db.session.get(BatchProcessing, batch_process_id)
                    if batch_process:
                        batch_process.status = "completed"
                        db.session.commit()
                        logger.info(f"Batch process completed for project ID {project_id}")
                except Exception as e:
                    logger.error(f"Batch process failed for project {project_id}: {str(e)}")
                    batch_process = db.session.get(BatchProcessing, batch_process_id)
                    if batch_process:
                        batch_process.status = "failed"
                        batch_process.error_message = str(e)
                        db.session.commit()

        logger.info(f"Starting batch process for project ID {project_id}")
        Thread(target=run_batch_process, args=(batch_process.id,), daemon=True).start()
        return jsonify({
            "message": "Batch process started",
            "process_id": batch_process.id,
            "status": batch_process.status,
            "progress": batch_process.progress
        })
    except Exception as e:
        logger.error(f"Error in start_batch_process for project ID {project_id}: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/projects/<int:project_id>/batch-process", methods=["GET"])
def get_batch_process_status(project_id):
    try:
        batch_process = BatchProcessing.query.filter_by(project_id=project_id).first()
        if not batch_process:
            return jsonify({"status": "none", "progress": 0})
        result = {
            "process_id": batch_process.id,
            "status": batch_process.status,
            "progress": batch_process.progress,
            "total_rows": batch_process.total_rows,
            "processed_rows": batch_process.processed_rows,
            "similarity_threshold": batch_process.similarity_threshold,
            "error_message": batch_process.error_message
        }
        logger.info(f"Retrieved batch process status for project ID {project_id}")
        return jsonify(result)
    except Exception as e:
        logger.error(f"Error in get_batch_process_status for project ID {project_id}: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/projects/<int:project_id>/batch-process", methods=["DELETE"])
def cancel_batch_process(project_id):
    try:
        batch_process = BatchProcessing.query.filter_by(project_id=project_id).first()
        if not batch_process:
            return jsonify({"message": "No active batch process"}), 404
        batch_process.status = "canceled"
        db.session.commit()
        logger.info(f"Canceled batch process for project ID {project_id}")
        return jsonify({"message": "Batch process canceled"})
    except Exception as e:
        logger.error(f"Error in cancel_batch_process for project ID {project_id}: {str(e)}")
        return jsonify({"error": str(e)}), 500

# Project Routes
@app.route("/api/projects", methods=["GET"])
@jwt_required()
def get_projects():
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({"error": "Authentication required"}), 401

        # Get owned projects
        owned_projects = Project.query.filter_by(owner_id=current_user.id).all()

        # Get shared projects
        shared_project_ids = [ps.project_id for ps in ProjectSharing.query.filter_by(user_id=current_user.id).all()]
        shared_projects = Project.query.filter(Project.id.in_(shared_project_ids)).all() if shared_project_ids else []

        def format_project(p):
            first_image = Image.query.filter_by(project_id=p.id).order_by(Image.id.asc()).first()
            thumbnail_url = (
                f"{SERVER_URL}/{app.config['UPLOAD_FOLDER']}/project_{p.id}/{first_image.name}_{first_image.id}_thumbnail.jpg"
                if first_image
                else None
            )
            result = {
                "id": p.id,
                "name": p.name,
                "type": p.type,
                "iiif_url": p.iiif_url,
                "first_thumbnail": thumbnail_url,
                "owner_id": p.owner_id,
                "is_owner": p.owner_id == current_user.id
            }
            if p.owner_id == current_user.id:
                shared_user_ids = [s.user_id for s in ProjectSharing.query.filter_by(project_id=p.id).all()]
                result["shared_users"] = shared_user_ids
            return result

        owned_result = [format_project(p) for p in owned_projects]
        shared_result = [format_project(p) for p in shared_projects]

        logger.info(f"Retrieved {len(owned_projects)} owned and {len(shared_projects)} shared projects for user {current_user.username}")
        return jsonify({"owned": owned_result, "shared": shared_result})
    except Exception as e:
        logger.error(f"Error in get_projects: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects", methods=["POST"])
@jwt_required()
def create_project():
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({"error": "Authentication required"}), 401

        data = request.json
        project = Project(
            name=data["name"],
            type=data.get("type"),
            iiif_url=data.get("iiif_url"),
            owner_id=current_user.id
        )
        db.session.add(project)
        db.session.commit()
        logger.info(f"Created project with ID {project.id} for user {current_user.username}")
        return jsonify({"message": "Project created", "id": project.id})
    except Exception as e:
        logger.error(f"Error in create_project: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects/<int:id>", methods=["GET"])
def get_project(id):
    try:
        project = Project.query.get_or_404(id)
        result = {
            "id": project.id,
            "name": project.name,
            "type": project.type,
            "iiif_url": project.iiif_url
        }
        logger.info(f"Retrieved project with ID {id}")
        return jsonify(result)
    except Exception as e:
        logger.error(f"Error in get_project for ID {id}: {str(e)}")
        return jsonify({"error": f"Failed to retrieve project: {str(e)}"}), 500

@app.route("/api/projects/<int:id>", methods=["DELETE"])
@jwt_required()
def delete_project(id):
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({"error": "Authentication required"}), 401

        project = Project.query.get_or_404(id)
        if project.owner_id != current_user.id:
            return jsonify({"error": "Only project owner can delete"}), 403

        project_folder = os.path.join(app.config["UPLOAD_FOLDER"], f"project_{id}")
        if os.path.exists(project_folder):
            import shutil
            shutil.rmtree(project_folder)
        db.session.delete(project)
        db.session.commit()
        logger.info(f"Deleted project with ID {id} by user {current_user.username}")
        return jsonify({"message": "Project deleted"})
    except Exception as e:
        logger.error(f"Error in delete_project for ID {id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects/<int:id>", methods=["PUT"])
@jwt_required()
def update_project(id):
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({"error": "Authentication required"}), 401

        project = Project.query.get_or_404(id)
        if project.owner_id != current_user.id:
            return jsonify({"error": "Only project owner can update"}), 403

        data = request.json
        for key, value in data.items():
            if key != 'owner_id':  # Prevent changing ownership
                setattr(project, key, value)
        db.session.commit()
        logger.info(f"Updated project with ID {id} by user {current_user.username}")
        return jsonify({"message": "Project updated"})
    except Exception as e:
        logger.error(f"Error in update_project for ID {id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

# Image Routes
@app.route("/api/projects/<int:project_id>/images", methods=["GET"])
@jwt_required()
def get_project_images(project_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    if not check_project_access(project_id, current_user):
        return jsonify({"error": "Access denied"}), 403

    try:
        images = Image.query.filter_by(project_id=project_id).all()
        result = [{
            "id": img.id,
            "name": img.name,
            "original": f"{SERVER_URL}/{img.original}",
            "thumbnail": f"{SERVER_URL}/{app.config['UPLOAD_FOLDER']}/project_{project_id}/{img.name}_{img.id}_thumbnail.jpg",
            "transcribed_text": img.transcribed_text,
            "line_count": len(img.transcribed_text.split("\n")) if img.transcribed_text else 0
        } for img in images]
        logger.info(f"Retrieved {len(images)} images for project ID {project_id} by user {current_user.username}")
        return jsonify(result)
    except Exception as e:
        logger.error(f"Error in get_project_images for project ID {project_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects/<int:project_id>/upload", methods=["POST"])
@jwt_required()
def upload_images(project_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    if not check_project_access(project_id, current_user):
        return jsonify({"error": "Access denied"}), 403
    if "images" not in request.files:
        logger.error("No files uploaded in upload_images")
        return jsonify({"message": "No files uploaded"}), 400
    
    files = request.files.getlist("images")
    try:
        project = Project.query.get_or_404(project_id)
        uploaded_files = []
        allowed_extensions = {".jpg", ".jpeg", ".png", ".tiff", ".bmp", ".JPG", ".PNG"}
        
        project_folder = os.path.join(app.config["UPLOAD_FOLDER"], f"project_{project_id}")
        if not os.path.exists(project_folder):
            os.makedirs(project_folder)

        for file in files:
            if not file or file.filename == "":
                continue
                
            if not any(file.filename.lower().endswith(ext) for ext in allowed_extensions):
                logger.error(f"Invalid file type for {file.filename}")
                return jsonify({"message": f"Invalid file type for {file.filename}. Allowed: .jpg, .jpeg, .png, .tiff, .bmp"}), 400
                
            name_without_ext, ext = file.filename.rsplit(".", 1) if "." in file.filename else (file.filename, "")
            ext = ext.lower()

            temp_filename = f"temp_{project_id}_{file.filename}"
            temp_file_path = os.path.join(project_folder, temp_filename)
            file.save(temp_file_path)

            try:
                if not os.path.exists(temp_file_path) or os.path.getsize(temp_file_path) == 0:
                    logger.error(f"File {temp_filename} was not properly saved")
                    return jsonify({"message": f"File {temp_filename} was not properly saved"}), 500
                    
                image = Image(project_id=project_id, name=name_without_ext, original=temp_file_path)
                db.session.add(image)
                db.session.flush()
                
                final_filename = f"{name_without_ext}_{image.id}.{ext}"
                final_file_path = os.path.join(project_folder, final_filename)
                os.rename(temp_file_path, final_file_path)
                
                image.original = f"{app.config['UPLOAD_FOLDER']}/project_{project_id}/{final_filename}"

                thumbnail_filename = f"{name_without_ext}_{image.id}_thumbnail.jpg"
                thumbnail_path = os.path.join(project_folder, thumbnail_filename)
                try:
                    with PILImage.open(final_file_path) as img:
                        if img.mode not in ("RGB", "L"):
                            img = img.convert("RGB")
                        img.thumbnail((360, 240))
                        img.save(thumbnail_path, "JPEG", quality=85)
                except Exception as e:
                    os.remove(final_file_path)
                    db.session.delete(image)
                    logger.error(f"Error processing image {final_filename}: {str(e)}")
                    return jsonify({"message": f"Error processing image {final_filename}: {str(e)}"}), 500
                    
                uploaded_files.append({
                    "id": image.id,
                    "name": name_without_ext,
                    "original": f"{SERVER_URL}/{image.original}",
                    "thumbnail": f"{SERVER_URL}/{app.config['UPLOAD_FOLDER']}/project_{project_id}/{thumbnail_filename}"
                })
                
            except Exception as e:
                if os.path.exists(temp_file_path):
                    os.remove(temp_file_path)
                logger.error(f"Error uploading file {file.filename}: {str(e)}")
                return jsonify({"message": f"Error uploading file {file.filename}: {str(e)}"}), 500

        db.session.commit()
        logger.info(f"Uploaded {len(uploaded_files)} images for project ID {project_id}")
        return jsonify({"message": "Files uploaded", "files": uploaded_files})
    except Exception as e:
        logger.error(f"Error in upload_images for project ID {project_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/images/<int:image_id>", methods=["DELETE"])
@jwt_required()
def delete_image(image_id):
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({"error": "Authentication required"}), 401

        image = Image.query.get_or_404(image_id)
        if not check_project_access(image.project_id, current_user):
            return jsonify({"error": "Access denied"}), 403

        project_id = image.project_id
        name_without_ext = image.name

        original_path = image.original
        thumbnail_path = os.path.join(app.config["UPLOAD_FOLDER"], f"project_{project_id}", f"{name_without_ext}_{image_id}_thumbnail.jpg")

        if os.path.exists(original_path):
            os.remove(original_path)
        if os.path.exists(thumbnail_path):
            os.remove(thumbnail_path)

        db.session.delete(image)
        db.session.commit()
        logger.info(f"Deleted image with ID {image_id} by user {current_user.username}")
        return jsonify({"message": "Image deleted"})
    except Exception as e:
        logger.error(f"Error in delete_image for ID {image_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/images/<int:image_id>", methods=["PUT"])
@jwt_required()
def update_image(image_id):
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({"error": "Authentication required"}), 401

        image = Image.query.get_or_404(image_id)
        if not check_project_access(image.project_id, current_user):
            return jsonify({"error": "Access denied"}), 403

        data = request.json
        transcribed_text = data.get("transcribed_text", image.transcribed_text)
        image.transcribed_text = transcribed_text
        db.session.commit()
        logger.info(f"Updated image with ID {image_id} by user {current_user.username}")
        return jsonify({
            "message": "Image updated",
            "image": {
                "id": image.id,
                "project_id": image.project_id,
                "name": image.name,
                "original": f"{SERVER_URL}/{image.original}",
                "transcribed_text": image.transcribed_text,
                "line_count": len(image.transcribed_text.split("\n")) if image.transcribed_text else 0
            }
        })
    except Exception as e:
        logger.error(f"Error in update_image for ID {image_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

# Content Routes

@app.route("/api/projects/<int:project_id>/content", methods=["GET"])
@jwt_required()
def get_project_content(project_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    if not check_project_access(project_id, current_user):
        return jsonify({"error": "Access denied"}), 403

    try:
        contents = Content.query.filter_by(project_id=project_id).all()
        result = [{
            "id": content.id,
            "project_id": content.project_id,
            "data": json.loads(content.data)
        } for content in contents]
        logger.info(f"Retrieved {len(contents)} content rows for project ID {project_id} by user {current_user.username}")
        return jsonify(result)
    except Exception as e:
        logger.error(f"Error in get_project_content for project ID {project_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects/<int:project_id>/content/bulk", methods=["GET","POST"])
@jwt_required()
def bulk_project_content(project_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    if not check_project_access(project_id, current_user):
        return jsonify({"error": "Access denied"}), 403
    try:
        data = request.json
        created_ids = []
        updated_ids = []
        deleted_ids = []

        # Handle create operations
        for row in data.get("create", []):
            content = Content(project_id=project_id, data=json.dumps(row))
            db.session.add(content)
            db.session.flush()  # Get the ID without committing
            created_ids.append(content.id)

        # Handle update operations
        for row in data.get("update", []):
            content = Content.query.get_or_404(row["id"])
            if content.project_id != project_id:
                return jsonify({"error": "Content does not belong to project"}), 400
            content.data = json.dumps(row)
            updated_ids.append(content.id)

        # Handle delete operations
        for content_id in data.get("delete", []):
            content = Content.query.get_or_404(content_id)
            if content.project_id != project_id:
                return jsonify({"error": "Content does not belong to project"}), 400
            db.session.delete(content)
            deleted_ids.append(content_id)

        db.session.commit()
        logger.info(f"Bulk operation for project ID {project_id}: "
                   f"Created {len(created_ids)}, Updated {len(updated_ids)}, "
                   f"Deleted {len(deleted_ids)}")

        return jsonify({
            "message": "Bulk operation completed",
            "created": created_ids,
            "updated": updated_ids,
            "deleted": deleted_ids
        })
    except Exception as e:
        db.session.rollback()
        logger.error(f"Error in bulk_project_content for project ID {project_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects/<int:project_id>/content", methods=["POST"])
@jwt_required()
def create_project_content(project_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    if not check_project_access(project_id, current_user):
        return jsonify({"error": "Access denied"}), 403

    try:
        data = request.json
        content_data = data.get("data", {})
        content = Content(project_id=project_id, data=json.dumps(content_data))
        db.session.add(content)
        db.session.commit()
        logger.info(f"Created content row for project ID {project_id}")
        return jsonify({
            "message": "Content created",
            "id": content.id,
            "data": content_data
        })
    except Exception as e:
        logger.error(f"Error in create_project_content for project ID {project_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects/<int:project_id>/content/<int:content_id>", methods=["PUT"])
@jwt_required()
def update_project_content(project_id, content_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    if not check_project_access(project_id, current_user):
        return jsonify({"error": "Access denied"}), 403

    try:
        content = Content.query.get_or_404(content_id)
        if content.project_id != project_id:
            return jsonify({"error": "Content does not belong to project"}), 400
        data = request.json
        content_data = data.get("data", {})
        content.data = json.dumps(content_data)
        db.session.commit()
        logger.info(f"Updated content ID {content_id} for project ID {project_id} by user {current_user.username}")
        return jsonify({
            "message": "Content updated",
            "id": content.id,
            "data": content_data
        })
    except Exception as e:
        logger.error(f"Error in update_project_content for ID {content_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/projects/<int:project_id>/content/<int:content_id>", methods=["DELETE"])
@jwt_required()
def delete_project_content(project_id, content_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    if not check_project_access(project_id, current_user):
        return jsonify({"error": "Access denied"}), 403

    try:
        content = Content.query.get_or_404(content_id)
        if content.project_id != project_id:
            return jsonify({"error": "Content does not belong to project"}), 400
        db.session.delete(content)
        db.session.commit()
        logger.info(f"Deleted content ID {content_id} for project ID {project_id} by user {current_user.username}")
        return jsonify({"message": "Content deleted"})
    except Exception as e:
        logger.error(f"Error in delete_project_content for ID {content_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


# Transcription Routes
if not NO_KRAKEN:
    @app.route("/api/transcribe/", methods=["POST"])
    @jwt_required()
    def transcribe():
        current_user = get_current_user()
        if not current_user:
            return jsonify({"error": "Authentication required"}), 401

        if "croppedImage" not in request.files:
            logger.error("No image uploaded in transcribe")
            return jsonify({"status": "error", "text": "No image uploaded"}), 400

        image_file = request.files["croppedImage"]
        temp_path = os.path.join(app.config["UPLOAD_FOLDER"], "uploaded.png")
        image_file.save(temp_path)

        model_name = request.form.get("modelName", "Tridis_Medieval_EarlyModern.mlmodel")

        try:
            transcribed_results = transcribe_image(temp_path, model_name)
            if isinstance(transcribed_results, tuple):
                logger.error(f"Error in transcribe: {transcribed_results[0]}")
                return jsonify({"status": "error", "text": transcribed_results[0]}), transcribed_results[1]
            logger.info("Transcription successful")
            return jsonify({"status": "success", "text": transcribed_results["text"], "lines": transcribed_results["lines"]})
        except Exception as e:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            logger.error(f"Error in transcribe: {str(e)}")
            return jsonify({"status": "error", "text": str(e)}), 500

# Transcribe by image ID route (always available, even without kraken)
@app.route("/api/transcribe/<int:image_id>", methods=["POST"])
@jwt_required()
def transcribe_by_id(image_id):
    current_user = get_current_user()
    if not current_user:
        return jsonify({"error": "Authentication required"}), 401

    image = Image.query.get_or_404(image_id)
    if not check_project_access(image.project_id, current_user):
        return jsonify({"error": "Access denied"}), 403

    if NO_KRAKEN:
        return jsonify({"status": "error", "message": "Transcription service is not available (Kraken OCR is disabled)"}), 503

    model_name = request.form.get("modelName", "Tridis_Medieval_EarlyModern.mlmodel")
    try:
        result = transcribe_image_by_id(image_id, model_name)
        if isinstance(result, tuple):
            logger.error(f"Error in transcribe_by_id for ID {image_id}: {result[0]}")
            return jsonify({"status": "error", "message": result[0], "line_count": 0}), result[1]
        logger.info(f"Transcribed image with ID {image_id} by user {current_user.username}")
        return jsonify({
            "status": "success",
            "message": "Image transcribed and text saved",
            "line_count": len(result["lines"])
        })
    except Exception as e:
        logger.error(f"Error in transcribe_by_id for ID {image_id}: {str(e)}")
        return jsonify({"status": "error", "message": str(e), "line_count": 0}), 500

# Static File Serving
@app.route("/project/<path:path>")
@app.route("/new-project")
@app.route("/")
def serve_react_app(path=""):
    try:
        return send_from_directory(app.static_folder, "index.html")
    except Exception as e:
        logger.error(f"Error in serve_react_app: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/<path:path>")
def serve_react(path):
    try:
        if os.path.exists(os.path.join(app.static_folder, path)):
            return send_from_directory(app.static_folder, path)
        return send_from_directory(app.static_folder, "index.html")
    except Exception as e:
        logger.error(f"Error in serving path {path}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/uploads/<path:filename>")
def serve_files(filename):
    try:
        return send_from_directory(app.config["UPLOAD_FOLDER"], filename)
    except Exception as e:
        logger.error(f"Error serving file {filename}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/api/ai-autofix", methods=["POST"])
def autofix():
    logger.info(f"POST /api/ai-autofix registered")
    try:
        data = request.get_json()
        if not data or 'question' not in data:
            return jsonify({"error": "Missing question in request"}), 400
        
        question = data['question']
        response = gpt_autofix(question, user_api_key, cache)
        
        if response['error']:
            return jsonify({"error": response['error']}), 500
        
        return jsonify({"text": response['text']}), 200

        #faster frontend debugging:
        #return jsonify({"text": "In libris Corberensig Momis Scicemoniamma sanctae <red>Memoriae</red> quibeatum gentianum martyrem tuum, nobis a tua bonitate concessum, benigne adiuva. Ut sicut hodierna die te auctore venerabile eius meritus sumus suscipere corpus, ita ad tuae misericordiae impetrandam interventionem ipsum mereamur habere. Per eumdem Dominum nostrum Iesum Christum Filium tuum, qui tecum vivit et regnat.\n\n<func>Oratio</func> In laude diei, in qua beati Gentiani martyris tui, cuius venerabilem corpori suscipimus oblationem hostiarum; oblationes offerrimus, precantes ut eius fiant oratione acceptae, per quem dilectionis ardore martyrio flagravit. Per Dominum.\n\n<func>Prefatio</func> Patris omnipotentis, te laudare, benedicere et glorificare, maxime in beati Gentiani martyris tui triumpho. Qui est palma martyrii glorificamus maiestatem."}),200
    
    except Exception as e:
        logger.error(f"Error in autofix: {str(e)}")
        return jsonify({"error": f"Server error: {str(e)}"}), 500


def open_browser():
    if not os.environ.get("WERKZEUG_RUN_MAIN"):
        webbrowser.open_new("http://127.0.0.1:5000")

if __name__ == "__main__":
    open_browser()
    app.run(host="127.0.0.1", port=5000, debug=True)