#!/bin/bash
#
# Haven CLI - Remote Install Script
# Downloads prebuilt binaries from GitHub releases.
# Served via: curl -fsSL https://envhaven.com/install.sh | bash
#
# For local development, use: ./install-local.sh
#
set -e

REPO="envhaven/envhaven"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

detect_platform() {
  local os arch
  
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      echo "Error: Unsupported operating system. Haven CLI supports macOS and Linux only."
      echo "For Windows, use WSL: https://docs.microsoft.com/en-us/windows/wsl/"
      exit 1
      ;;
  esac
  
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "Error: Unsupported architecture: $(uname -m)"
      exit 1
      ;;
  esac
  
  echo "${os}-${arch}"
}

get_latest_version() {
  curl -sL "https://api.github.com/repos/${REPO}/releases/latest" | \
    grep '"tag_name":' | \
    sed -E 's/.*"([^"]+)".*/\1/'
}

main() {
  echo "Installing Haven CLI..."
  echo
  
  local platform
  platform=$(detect_platform)
  echo "Detected platform: ${platform}"
  
  local version
  version=$(get_latest_version)
  
  if [ -z "$version" ]; then
    echo "Warning: Could not detect latest version, using 'latest'"
    version="latest"
  else
    echo "Latest version: ${version}"
  fi
  
  local url="https://github.com/${REPO}/releases/download/${version}/haven-${platform}"
  
  echo "Downloading from: ${url}"
  
  mkdir -p "$INSTALL_DIR"
  
  if command -v curl &> /dev/null; then
    curl -fsSL "$url" -o "${INSTALL_DIR}/haven"
  elif command -v wget &> /dev/null; then
    wget -q "$url" -O "${INSTALL_DIR}/haven"
  else
    echo "Error: curl or wget is required"
    exit 1
  fi
  
  chmod +x "${INSTALL_DIR}/haven"
  
  echo
  echo "✓ Haven CLI installed to ${INSTALL_DIR}/haven"
  echo
  
  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo
    echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
    echo
  fi
  
  echo "Get started:"
  echo "  haven connect ."
  echo
}

main "$@"
