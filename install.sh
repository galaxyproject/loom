#!/usr/bin/env bash
#
# Loom Installer
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/galaxyproject/pi-galaxy-analyst/main/install.sh | bash
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Loom Installer                        ║${NC}"
echo -e "${GREEN}║     Galaxy Co-Scientist for Bioinformatics ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    error "Node.js is required but not installed. Please install Node.js 18+ from https://nodejs.org/"
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    error "Node.js 18+ is required. You have $(node -v). Please upgrade."
fi
success "Node.js $(node -v) found"

# Check for uv or python3 (galaxy-mcp needs it)
if command -v uvx &> /dev/null; then
    success "uvx found (for galaxy-mcp)"
elif command -v uv &> /dev/null; then
    success "uv found (for galaxy-mcp)"
elif command -v python3 &> /dev/null; then
    warn "uv not found — galaxy-mcp will use python3 directly"
    warn "For best results, install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
else
    warn "Neither uv nor python3 found. galaxy-mcp may need manual setup."
fi

# Install loom
info "Installing loom..."
npm install -g @galaxyproject/loom
success "loom installed"

echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Run 'loom' to start. Use /connect to set your Galaxy credentials."
echo ""
