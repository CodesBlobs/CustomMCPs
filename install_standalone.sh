#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Define color codes for pretty output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 1. Check Prerequisites
log_info "Checking prerequisites..."
if ! command -v npm &> /dev/null; then
    log_error "npm is not installed. Please install Node.js and npm first."
    exit 1
fi

if ! command -v curl &> /dev/null; then
    log_error "curl is not installed. Please install curl."
    exit 1
fi

if ! command -v unzip &> /dev/null; then
    log_error "unzip is not installed. Please install unzip."
    exit 1
fi

# 2. Install @agentic-browser-mcp/standalone globally
log_info "Installing @agentic-browser-mcp/standalone globally..."
log_info "Running: npm install -g @agentic-browser-mcp/standalone --registry https://bnpm.byted.org"

# Try installing without sudo first. If it fails with permission error, suggest running with sudo.
if ! npm install -g @agentic-browser-mcp/standalone --registry https://bnpm.byted.org; then
    log_warn "Global installation failed. Trying with sudo..."
    if ! sudo npm install -g @agentic-browser-mcp/standalone --registry https://bnpm.byted.org; then
        log_error "Failed to install @agentic-browser-mcp/standalone globally."
        exit 1
    fi
fi
log_success "@agentic-browser-mcp/standalone installed successfully!"

# 3. Download and Install Skills
SKILL_URLS=(
    "https://tosv-sg.tiktok-row.org/obj/stats-data-sg/usttp-biz-config-deploy.zip"
    "https://tosv-sg.tiktok-row.org/obj/stats-data-sg/euttp-biz-config-deploy.zip"
    "https://tosv-sg.tiktok-row.org/obj/stats-data-sg/row-biz-config-deploy.zip"
    "https://tosv-sg.tiktok-row.org/obj/stats-data-sg/ote-biz-config-deploy.zip"
)

TARGET_DIRS=(
    "$HOME/.trae/skills"
    "$HOME/.agents/skills"
)

# Create a temporary directory for downloads
TEMP_DIR=$(mktemp -d)
log_info "Created temporary directory for downloads: $TEMP_DIR"

# Cleanup on exit
cleanup() {
    rm -rf "$TEMP_DIR"
    log_info "Cleaned up temporary directory."
}
trap cleanup EXIT

# Download all skills first
log_info "Downloading skills..."
DOWNLOADED_ZIPS=()
for URL in "${SKILL_URLS[@]}"; do
    FILE_NAME=$(basename "$URL")
    ZIP_PATH="$TEMP_DIR/$FILE_NAME"
    log_info "Downloading $URL..."
    if curl -L -f -o "$ZIP_PATH" "$URL"; then
        DOWNLOADED_ZIPS+=("$ZIP_PATH")
    else
        log_error "Failed to download $URL"
        exit 1
    fi
done

# Extract to each target directory
for TARGET_DIR in "${TARGET_DIRS[@]}"; do
    log_info "Installing skills to $TARGET_DIR..."
    mkdir -p "$TARGET_DIR"
    
    for ZIP_PATH in "${DOWNLOADED_ZIPS[@]}"; do
        log_info "Extracting $(basename "$ZIP_PATH") to $TARGET_DIR..."
        # -o: overwrite files without prompting
        # -q: quiet mode
        # -x: exclude files/directories (excluding macOS metadata folder __MACOSX)
        unzip -o -q "$ZIP_PATH" -x "__MACOSX/*" -d "$TARGET_DIR"
    done
done

log_success "Skills installed successfully in:"
for TARGET_DIR in "${TARGET_DIRS[@]}"; do
    echo "  - $TARGET_DIR"
done

log_success "Installation complete!"
