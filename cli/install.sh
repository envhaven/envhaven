#!/bin/sh
#
# Haven CLI - Remote Install Script
# Downloads a prebuilt binary from GitHub releases and verifies it against the release's
# SHA256SUMS before installing.
# Usage: curl -fsSL https://raw.githubusercontent.com/envhaven/envhaven/master/cli/install.sh | sh
#
# For local development, use: ./install-local.sh
#
set -eu

REPO="envhaven/envhaven"
RELEASES="https://github.com/${REPO}/releases"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "Error: $*" >&2
  exit 1
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      echo "Error: Unsupported operating system. Haven CLI supports macOS and Linux only." >&2
      echo "For Windows, use WSL: https://docs.microsoft.com/en-us/windows/wsl/" >&2
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac

  echo "${os}-${arch}"
}

# The tag of the latest release, read from where github.com/<repo>/releases/latest redirects
# (.../releases/tag/<tag>). The GitHub API allows 60 unauthenticated requests an hour per address,
# shared by everyone behind one NAT; when that ran out, this used to fall back to a URL that 404s.
latest_version() {
  url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASES}/latest") ||
    fail "could not reach ${RELEASES}/latest"
  version="${url##*/}"
  case "$version" in
    v[0-9]*) ;;
    *) fail "could not determine the latest release from ${url}" ;;
  esac
  case "$version" in
    *[!A-Za-z0-9._-]*) fail "unexpected release tag: ${version}" ;;
  esac
  echo "$version"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "sha256sum or shasum is required to verify the download"
  fi
}

main() {
  command -v curl >/dev/null 2>&1 || fail "curl is required"

  echo "Installing Haven CLI..."
  echo

  platform=$(detect_platform)
  echo "Detected platform: ${platform}"

  version=$(latest_version)
  echo "Latest version: ${version}"

  binary="haven-${platform}"
  base="${RELEASES}/download/${version}"

  mkdir -p "$INSTALL_DIR"
  if [ -d "${INSTALL_DIR}/haven" ]; then
    fail "${INSTALL_DIR}/haven is a directory"
  fi

  # Downloaded beside the destination and renamed over it at the end: the rename replaces
  # whatever is at the destination, a symlink included, instead of writing through it.
  tmpdir=$(mktemp -d "${INSTALL_DIR}/.haven-install.XXXXXX")
  trap 'rm -rf "$tmpdir"' EXIT
  # dash (sh on Debian and Ubuntu) skips the EXIT trap when a signal ends it; an exit runs it.
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  echo "Downloading ${base}/${binary}"
  curl -fsSL -o "${tmpdir}/haven" "${base}/${binary}" || fail "could not download ${binary} (${version})"
  curl -fsSL -o "${tmpdir}/SHA256SUMS" "${base}/SHA256SUMS" ||
    fail "could not download SHA256SUMS for ${version}; refusing to install an unverified binary"

  expected=$(awk -v name="$binary" '$2 == name || $2 == "*" name { print $1; exit }' "${tmpdir}/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS for ${version} has no entry for ${binary}; refusing to install"
  actual=$(sha256_of "${tmpdir}/haven")
  [ "$actual" = "$expected" ] ||
    fail "checksum mismatch for ${binary} (${version}): expected ${expected}, got ${actual}. Nothing was installed."
  echo "Verified SHA-256: ${actual}"

  chmod 755 "${tmpdir}/haven"
  mv -f "${tmpdir}/haven" "${INSTALL_DIR}/haven"

  echo
  echo "✓ Haven CLI ${version} installed to ${INSTALL_DIR}/haven"
  echo

  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
      echo
      echo "  export PATH=\"\$PATH:${INSTALL_DIR}\""
      echo
      ;;
  esac

  echo "Get started:"
  echo "  haven connect ."
  echo
}

main "$@"
