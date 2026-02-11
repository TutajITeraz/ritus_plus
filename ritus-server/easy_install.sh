#!/bin/bash

# Logfile
LOGFILE="install.log"
touch $LOGFILE

# Helper function to print and log messages
print_and_log() {
    echo -e "$1"
    echo -e "$1" >> $LOGFILE
}

# Function to run a command and log output
run_cmd() {
    print_and_log "Running: $1"
    eval "$1" >> $LOGFILE 2>&1
    if [[ $? -ne 0 ]]; then
        print_and_log "ERROR: Command '$1' failed. Check $LOGFILE for details."
        exit 1
    fi
}

print_and_log "Installation script started."

# Check for Python and ensurepip
print_and_log "Ensuring Python package manager is installed..."
run_cmd "python -m ensurepip --upgrade"

# 2. Install a Python 3.11 compatible NumPy version (1.26.4 is highly recommended)
print_and_log "Installing numpy..."
run_cmd "pip install numpy==1.26.4"

print_and_log "Installing sqllite..."
run_cmd "pip install flask_sqlalchemy"

print_and_log "Installing backports.tarfile==1.2"
run_cmd "pip install backports.tarfile==1.2"

# Install Kraken and its required dependencies
print_and_log "Installing Kraken version 5.2.7..."
run_cmd "pip install kraken==5.2.7 --no-deps"

# Install server libraries
print_and_log "Installing Flask..."
run_cmd "pip install flask"

print_and_log "Installing Flask CORS..."
run_cmd "pip install flask_cors"

print_and_log "Installing Flask migrate and sqlalchemy..."
run_cmd "pip install flask-migrate flask-sqlalchemy"

print_and_log "Installing Pillow..."
run_cmd "pip install pillow"

print_and_log "Installing rapidfuzz..."
run_cmd "pip install rapidfuzz"

print_and_log "Installing opencv-python..."
run_cmd "pip install opencv-python==4.11.0.86"

print_and_log "Installing matplotlib..."
run_cmd "pip install matplotlib"

print_and_log "Installing pandas..."
run_cmd "pip install pandas"

print_and_log "Installing Party (OCR alternative)..."
run_cmd "pip install git+https://github.com/mittagessen/party.git"

print_and_log "Installing openai and httpx..."
run_cmd "pip install openai==1.55.3 httpx==0.27.2 --force-reinstall --quiet"

print_and_log "Installing flask_caching..."
run_cmd "pip install flask_caching"

print_and_log "Installing flask_jwt..."
run_cmd ".venv/bin/pip install flask_jwt --quiet"

print_and_log "Installing flask_jwt_extended ..."
run_cmd ".venv/bin/pip install flask_jwt_extended --quiet"

# Check if user wants to install Torch for acceleration
read -p "Do you want to install PyTorch for GPU/CPU acceleration (this can take up to 10GB)? (y/n): " accel_choice

if [[ "$accel_choice" == "y" || "$accel_choice" == "Y" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
        # For macOS, checking for M1 chip and installing the proper PyTorch version
        print_and_log "Checking for M1/M2 chip compatibility..."
        if [[ $(sysctl -n machdep.cpu.brand_string) == *"Apple M1"* || $(sysctl -n machdep.cpu.brand_string) == *"Apple M2"* ]]; then
            print_and_log "Installing torch with MPS support (for Apple Silicon)..."
            run_cmd "pip install torch==2.0.1 torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu"
        else
            print_and_log "Installing CPU-only version of torch..."
            run_cmd "pip install torch"
        fi
    else
        # For Linux, prompt the user to install CUDA or ROCm if applicable
        read -p "Do you have CUDA or ROCm installed? (y/n): " gpu_choice
        if [[ "$gpu_choice" == "y" || "$gpu_choice" == "Y" ]]; then
            print_and_log "Installing torch with GPU support..."
            run_cmd "pip install torch"
        else
            print_and_log "Installing CPU-only version of torch..."
            run_cmd "pip install torch==2.0.1+cpu -f https://download.pytorch.org/whl/cpu.html"
        fi
    fi
else
    print_and_log "Skipping PyTorch installation."
fi

# Download and install models using Kraken
print_and_log "Fetching Kraken models..."

run_cmd "kraken list"
print_and_log "Downloading Tridis_Medieval_EarlyModern.mlmodel..."
run_cmd "kraken get 10.5281/zenodo.10788591"

print_and_log "Downloading cremma-generic-1.0.1.mlmodel..."
run_cmd "kraken get 10.5281/zenodo.7631619"

print_and_log "Downloading ManuMcFondue.mlmodel..."
run_cmd "kraken get 10.5281/zenodo.10886224"

print_and_log "Downloading catmus-medieval.mlmodel..."
run_cmd "kraken get 10.5281/zenodo.12743230"

print_and_log "Downloading McCATMuS_nfd_nofix_V1.mlmodel..."
run_cmd "kraken get 10.5281/zenodo.13788177"

print_and_log "Downloading LECTAUREP Contemporary French (lectaurep_base.mlmodel)..."
run_cmd "kraken get 10.5281/zenodo.6542744"

print_and_log "Downloading Lucien Peraire's handwriting (peraire2_ft_MMCFR.mlmodel)..."
run_cmd "kraken get 10.5281/zenodo.8193498"

print_and_log "Downloading German Handwriting (german_handwriting.mlmodel)..."
run_cmd "kraken get 10.5281/zenodo.7933463"

cp ~/.config/kraken/* ./models/

print_and_log "Downloading and installing Kraken model (blla.mlmodel)..."
mkdir -p models
curl -L -o models/blla.mlmodel https://github.com/mittagessen/kraken/raw/refs/heads/main/kraken/blla.mlmodel

print_and_log "Downloading Party models (this may take a while)..."
mkdir -p models/party
print_and_log "Downloading Party Multilingual (model.safetensors)..."
curl -L -o models/party/party_multilingual_v3.safetensors https://zenodo.org/records/15075344/files/model.safetensors?download=1

print_and_log "Downloading Party European Languages (party_european_langs.safetensors)..."
curl -L -o models/party/party_european_langs.safetensors https://zenodo.org/records/15764161/files/party_european_langs.safetensors?download=1

# Ask if the user wants to run the server now
read -p "Do you want to run the Kraken server now? (y/n): " server_choice

if [[ "$server_choice" == "y" || "$server_choice" == "Y" ]]; then
    print_and_log "Running the server..."
    print_and_log "To run the server later, use the following command:"
    print_and_log "    python krakenServer.py"
    
    python krakenServer.py
    print_and_log "Server is running in the background."
else
    print_and_log "To run the server later, use the following command:"
    print_and_log "    python krakenServer.py"
fi

print_and_log "Installation completed."
print_and_log "All output is logged in $LOGFILE."
