# server.py
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
import os
from PIL import Image as PILImage
from PIL import ImageFile

# Allow truncated images
ImageFile.LOAD_TRUNCATED_IMAGES = True

app = Flask(__name__, static_folder="../ritus-client/dist", static_url_path="/")
CORS(app)

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///projects.db'
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max upload size
SERVER_URL = 'http://127.0.0.1:5000'  # Adjust as needed
db = SQLAlchemy(app)

if not os.path.exists(app.config['UPLOAD_FOLDER']):
    os.makedirs(app.config['UPLOAD_FOLDER'])

# Models
class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    type = db.Column(db.String(50))
    iiif_url = db.Column(db.String(200))

class Image(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)  # Original name without extension
    original = db.Column(db.String(200), nullable=False)  # Path with project folder and ID suffix
    transcribed_text = db.Column(db.Text)

@app.route("/api/projects", methods=['GET'])
def get_projects():
    projects = Project.query.all()
    result = []
    for p in projects:
        # Get the first image for this project, ordered by ID (earliest uploaded)
        first_image = Image.query.filter_by(project_id=p.id).order_by(Image.id.asc()).first()
        thumbnail_url = (
            f"{SERVER_URL}/{app.config['UPLOAD_FOLDER']}/project_{p.id}/{first_image.name}_{first_image.id}_thumbnail.jpg"
            if first_image
            else None
        )
        result.append({
            "id": p.id,
            "name": p.name,
            "type": p.type,
            "iiif_url": p.iiif_url,
            "first_thumbnail": thumbnail_url  # New field
        })
    return jsonify(result)

@app.route("/api/projects", methods=['POST'])
def create_project():
    data = request.json
    project = Project(**data)
    db.session.add(project)
    db.session.commit()
    return jsonify({'message': 'Project created', 'id': project.id})

@app.route("/api/projects/<int:id>", methods=['GET'])
def get_project(id):
    project = Project.query.get_or_404(id)
    return jsonify({
        "id": project.id,
        "name": project.name,
        "type": project.type,
        "iiif_url": project.iiif_url
    })

@app.route("/api/projects/<int:id>", methods=['DELETE'])
def delete_project(id):
    project = Project.query.get_or_404(id)
    project_folder = os.path.join(app.config['UPLOAD_FOLDER'], f"project_{id}")
    if os.path.exists(project_folder):
        import shutil
        shutil.rmtree(project_folder)
    db.session.delete(project)
    db.session.commit()
    return jsonify({'message': 'Project deleted'})

@app.route("/api/projects/<int:id>", methods=['PUT'])
def update_project(id):
    project = Project.query.get_or_404(id)
    data = request.json
    for key, value in data.items():
        setattr(project, key, value)
    db.session.commit()
    return jsonify({'message': 'Project updated'})

@app.route("/api/projects/<int:project_id>/images", methods=['GET'])
def get_project_images(project_id):
    images = Image.query.filter_by(project_id=project_id).all()
    return jsonify([{
        "id": img.id,
        "name": img.name,
        "original": f"{SERVER_URL}/{img.original}",
        "thumbnail": f"{SERVER_URL}/{app.config['UPLOAD_FOLDER']}/project_{project_id}/{img.name}_{img.id}_thumbnail.jpg",
        "transcribed_text": img.transcribed_text
    } for img in images])

@app.route("/api/projects/<int:project_id>/upload", methods=['POST'])
def upload_images(project_id):
    if 'images' not in request.files:
        return jsonify({'message': 'No files uploaded'}), 400
    
    files = request.files.getlist('images')
    project = Project.query.get_or_404(project_id)
    uploaded_files = []
    allowed_extensions = {'.jpg', '.jpeg', '.png', '.tiff', '.bmp', '.JPG', '.PNG'}
    
    project_folder = os.path.join(app.config['UPLOAD_FOLDER'], f"project_{project_id}")
    if not os.path.exists(project_folder):
        os.makedirs(project_folder)

    for file in files:
        if not file or file.filename == '':
            continue
            
        if not any(file.filename.lower().endswith(ext) for ext in allowed_extensions):
            return jsonify({'message': f'Invalid file type for {file.filename}. Allowed: .jpg, .jpeg, .png, .tiff, .bmp'}), 400
            
        name_without_ext, ext = file.filename.rsplit('.', 1) if '.' in file.filename else (file.filename, '')
        ext = ext.lower()

        temp_filename = f"temp_{project_id}_{file.filename}"
        temp_file_path = os.path.join(project_folder, temp_filename)
        file.save(temp_file_path)

        try:
            if not os.path.exists(temp_file_path) or os.path.getsize(temp_file_path) == 0:
                return jsonify({'message': f'File {temp_filename} was not properly saved'}), 500
                
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
                    if img.mode not in ('RGB', 'L'):
                        img = img.convert('RGB')
                    img.thumbnail((360, 240))
                    img.save(thumbnail_path, 'JPEG', quality=85)
            except Exception as e:
                os.remove(final_file_path)
                db.session.delete(image)
                return jsonify({'message': f'Error processing image {final_filename}: {str(e)}'}), 500
                
            uploaded_files.append({
                "id": image.id,
                "name": name_without_ext,
                "original": f"{SERVER_URL}/{image.original}",
                "thumbnail": f"{SERVER_URL}/{app.config['UPLOAD_FOLDER']}/project_{project_id}/{thumbnail_filename}"
            })
            
        except Exception as e:
            if os.path.exists(temp_file_path):
                os.remove(temp_file_path)
            return jsonify({'message': f'Error uploading file {file.filename}: {str(e)}'}), 500

    db.session.commit()
    return jsonify({'message': 'Files uploaded', 'files': uploaded_files})

@app.route("/api/images/<int:image_id>", methods=['DELETE'])
def delete_image(image_id):
    image = Image.query.get_or_404(image_id)
    project_id = image.project_id
    name_without_ext = image.name
    
    original_path = image.original
    thumbnail_path = os.path.join(app.config['UPLOAD_FOLDER'], f"project_{project_id}", f"{name_without_ext}_{image_id}_thumbnail.jpg")
    
    if os.path.exists(original_path):
        os.remove(original_path)
    if os.path.exists(thumbnail_path):
        os.remove(thumbnail_path)
        
    db.session.delete(image)
    db.session.commit()
    return jsonify({'message': 'Image deleted'})

@app.route("/")
@app.route("/new-project")
@app.route("/project/<path:path>")
def serve_react_app(path=""):
    return send_from_directory("../ritus-client/dist", "index.html")

@app.route('/<path:path>')
def serve_react(path):
    return send_from_directory(app.static_folder, path)

@app.route('/uploads/<path:filename>')
def serve_uploads(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True)