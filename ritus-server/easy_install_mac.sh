#!/bin/bash

# Logfile
LOGFILE="install.log"
touch $LOGFILE

# Helper function to print and log messages
print_and_log() {
    echo -e "$1"
    echo -e "$1" >> $LOGFILE
}

# Function to run a command and log output (short log)
run_cmd() {
    print_and_log "Running: $1"
    eval "$1" >> $LOGFILE 2>&1
    if [[ $? -ne 0 ]]; then
        print_and_log "ERROR: Command '$1' failed. Check $LOGFILE for details."
        tail -n 20 $LOGFILE
        exit 1
    fi
}

print_and_log "Installation script started."

print_and_log "Installing Homebrew and python@3.11..."
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install.sh)"

echo >> ~/.zprofile
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

print_and_log "Installing python@3.11..."
run_cmd "brew install python@3.11"

print_and_log "Installing system dependencies (libpng, zlib)..."
run_cmd "brew install libpng zlib"

print_and_log "Creating and activating virtual environment (.venv) with Python 3.11..."
run_cmd "/opt/homebrew/opt/python@3.11/bin/python3.11 -m venv .venv"
source .venv/bin/activate

print_and_log "Verifying Python version in virtual environment..."
run_cmd ".venv/bin/python3.11 --version"

print_and_log "Ensuring python3 package manager is installed..."
run_cmd ".venv/bin/python3.11 -m ensurepip --upgrade"

print_and_log "Updating pip to the latest version..."
run_cmd ".venv/bin/pip install --upgrade pip --quiet"

print_and_log "Clearing pip cache..."
run_cmd ".venv/bin/pip cache purge"

#print_and_log "Uninstalling any existing packages to avoid conflicts..."
#run_cmd ".venv/bin/pip uninstall -y flask flask-cors kraken lightning lightning-utilities matplotlib numpy opencv-python pillow python-bidi pytorch-lightning scikit-image scipy shapely torch torchmetrics torchvision torchaudio backports.tarfile httpx openai flask-caching flask-migrate flask-sqlalchemy rapidfuzz || true"

# Pin versions compatible with kraken
print_and_log "Installing numpy==1.23.0..."
run_cmd ".venv/bin/pip install numpy==1.23.0 --quiet"

print_and_log "Installing scikit-image==0.21.0..."
run_cmd ".venv/bin/pip install scikit-image==0.21.0 --quiet"

print_and_log "Installing scipy==1.10.1..."
run_cmd ".venv/bin/pip install scipy==1.10.1 --quiet"

print_and_log "Installing torchmetrics==1.4.3..."
run_cmd ".venv/bin/pip install torchmetrics==1.4.3 --quiet"

print_and_log "Installing lightning==2.2.5..."
run_cmd ".venv/bin/pip install lightning==2.2.5 --quiet"

print_and_log "Installing pytorch-lightning==2.4.0..."
run_cmd ".venv/bin/pip install pytorch-lightning==2.4.0 --quiet"

print_and_log "Installing lightning-utilities==0.11.7..."
run_cmd ".venv/bin/pip install lightning-utilities==0.11.7 --quiet"

print_and_log "Installing python-bidi==0.4.2..."
run_cmd ".venv/bin/pip install python-bidi==0.4.2 --quiet"

print_and_log "Installing shapely==1.8.5.post1..."
run_cmd ".venv/bin/pip install shapely==1.8.5.post1 --quiet"

# Install Kraken without dependencies to avoid pulling in incompatible versions
print_and_log "Installing kraken==5.2.7..."
run_cmd ".venv/bin/pip install kraken==5.2.7 --quiet"

# Install kraken dependencies explicitly
print_and_log "Installing kraken dependencies..."
run_cmd ".venv/bin/pip install coremltools~=6.0 importlib-resources>=1.3.0 jsonschema lxml protobuf>=3.0.0 pyarrow regex rich scikit-learn~=1.2.1 threadpoolctl~=3.4.0 --quiet"

print_and_log "Installing flask..."
run_cmd ".venv/bin/pip install flask --quiet"

print_and_log "Installing flask-cors==6.0.0..."
run_cmd ".venv/bin/pip install flask-cors==6.0.0 --quiet"

print_and_log "Installing flask-migrate and flask-sqlalchemy..."
run_cmd ".venv/bin/pip install flask-migrate flask-sqlalchemy --quiet"

print_and_log "Installing pillow==10.4.0..."
run_cmd ".venv/bin/pip install pillow==10.4.0 --quiet"

print_and_log "Installing rapidfuzz..."
run_cmd ".venv/bin/pip install rapidfuzz --quiet"

print_and_log "Installing opencv-python==4.12.0.88..."
run_cmd ".venv/bin/pip install opencv-python==4.12.0.88 --quiet"

print_and_log "Installing matplotlib==3.9.4..."
run_cmd ".venv/bin/pip install matplotlib==3.9.4 --quiet"

print_and_log "Installing flask-caching..."
run_cmd ".venv/bin/pip install flask-caching --quiet"

print_and_log "Installing pandas..."
run_cmd ".venv/bin/pip install pandas --quiet"

print_and_log "Installing optional dependencies (backports.tarfile, httpx, openai)..."
run_cmd ".venv/bin/pip install backports.tarfile httpx openai --force-reinstall --quiet"

print_and_log "Reinstalling numpy==1.23.0 to ensure compatibility..."
run_cmd ".venv/bin/pip install --force-reinstall numpy==1.23.0 --quiet"

# Check if user wants to install Torch for acceleration
read -p "Do you want to install PyTorch for GPU/CPU acceleration (this can take up to 10GB)? (y/n): " accel_choice

if [[ "$accel_choice" == "y" || "$accel_choice" == "Y" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
        print_and_log "Checking for M1/M2 chip compatibility..."
        if [[ $(sysctl -n machdep.cpu.brand_string) == *"Apple M1"* || $(sysctl -n machdep.cpu.brand_string) == *"Apple M2"* ]]; then
            print_and_log "Installing torch==2.1.2 with MPS support (for Apple Silicon)..."
            run_cmd ".venv/bin/pip install torch==2.1.2 torchvision==0.16.2 torchaudio==2.1.2 --quiet"
        else
            print_and_log "Installing CPU-only version of torch==2.1.2..."
            run_cmd ".venv/bin/pip install torch==2.1.2 torchvision==0.16.2 torchaudio==2.1.2 --quiet"
        fi
    else
        read -p "Do you have CUDA or ROCm installed? (y/n): " gpu_choice
        if [[ "$gpu_choice" == "y" || "$gpu_choice" == "Y" ]]; then
            print_and_log "Installing torch==2.1.2 with GPU support..."
            run_cmd ".venv/bin/pip install torch==2.1.2 torchvision==0.16.2 torchaudio==2.1.2 --quiet"
        else
            print_and_log "Installing CPU-only version of torch==2.1.2..."
            run_cmd ".venv/bin/pip install torch==2.1.2+cpu torchvision==0.16.2+cpu torchaudio==2.1.2+cpu -f https://download.pytorch.org/whl/cpu.html --quiet"
        fi
    fi
else
    print_and_log "Skipping PyTorch installation."
fi

print_and_log "Fetching Kraken models..."

run_cmd ".venv/bin/kraken list"
print_and_log "Downloading Tridis_Medieval_EarlyModern.mlmodel..."
run_cmd ".venv/bin/kraken get 10.5281/zenodo.10788591"

print_and_log "Downloading cremma-generic-1.0.1.mlmodel..."
run_cmd ".venv/bin/kraken get 10.5281/zenodo.7631619"

print_and_log "Downloading ManuMcFondue.mlmodel..."
run_cmd ".venv/bin/kraken get 10.5281/zenodo.10886224"

print_and_log "Downloading catmus-medieval.mlmodel..."
run_cmd ".venv/bin/kraken get 10.5281/zenodo.12743230"

print_and_log "Downloading and installing Kraken model (blla.mlmodel)..."
mkdir -p models
curl -L -o models/blla.mlmodel https://github.com/mittagessen/kraken/raw/refs/heads/main/kraken/blla.mlmodel

read -p "Do you want to run the Kraken server now? (y/n): " server_choice

if [[ "$server_choice" == "y" || "$server_choice" == "Y" ]]; then
    print_and_log "Running the server..."
    print_and_log "To run the server later, use the following command:"
    print_and_log "    ./run_server.sh"
    run_cmd "./run_server.sh"
    print_and_log "Server is running in the background."
else
    print_and_log "To run the server later, use the following command:"
    print_and_log "    ./run_server.sh"
fi

print_and_log "Installation completed."
print_and_log "All output is logged in $LOGFILE."