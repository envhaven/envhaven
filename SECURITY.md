# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in EnvHaven, please report it responsibly.

### How to Report

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email security concerns to: **security@envhaven.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Resolution Timeline**: Depends on severity, typically 30-90 days

### Scope

This policy applies to:
- The EnvHaven Docker image (`ghcr.io/envhaven/envhaven`)
- The Haven CLI
- The VS Code extension
- This repository's code

### Out of Scope

- Vulnerabilities in upstream dependencies (report to the respective projects)
- Self-hosted instances with custom modifications
- Social engineering attacks

## Security Model

EnvHaven treats the container as the sandbox. These are the boundaries it holds, and the ones it
deliberately does not.

**Agents run without permission prompts.** Claude Code, Codex, OpenCode and the other tools are
configured to act without asking, and VS Code's workspace trust is off. Anything that can steer an
agent (a prompt injection in a README, an issue or a dependency) can act as the workspace user
`abc`. Keep secrets you would not hand to that user out of the workspace.

**A mounted Docker socket is the host.** When you mount `/var/run/docker.sock`, `abc` joins the
socket's group and can start any container on that daemon, which is root on the machine that runs
it. The socket's own mode is left as the host set it, with one exception on managed workspaces:
images before 1.9.0 made it world-writable, and the first boot of a newer one puts it back to
660. Mount it only if you accept that.

**Root is separate from `abc`.** Root's environment never resolves a command through a directory
`abc` can write, boot steps that write into `/config` run as `abc`, and secrets that only root
services use (the tunnel token, the sudo password) are unreadable to `abc` and absent from every
process it runs. The web password hash is the exception: code-server runs as `abc` and needs it,
and the extension uses it to sign in to the console. Where the web and sudo passwords are the same
(managed workspaces set both from one password), code running as `abc` can try to crack that hash
offline and use the result with `sudo`, so a long password is what keeps root out of its reach.

**SSH takes keys only.** Password logins are disabled. Each workspace generates its own host keys
on first boot and keeps them in `/config/.config/envhaven/ssh`.

**No web password, no web access.** Without `PASSWORD` or `HASHED_PASSWORD`, code-server listens on
127.0.0.1 only and the browser terminal stays off. The browser terminal on port 7681 serves plain
HTTP; put TLS in front of it before exposing it.

**The editor sidebar trusts only its host.** The EnvHaven extension's webview shows a preview of
your own app, so the extension host treats each webview message as a request and checks it against
what it showed: known tools, listed skills, plain public keys, https links.

**Third-party code by design.** Skills installed from skills.sh are content from their authors,
loaded into every agent's configuration. API keys saved through the extension or the console live
in `~/.config/envhaven/environment` (mode 0600, plain text), as each tool's own configuration does.
The Haven CLI syncs files both ways, so a workspace can change any file in the folder you connect,
including build scripts.

**Supply chain.** Base images are pinned by digest; Docker, mise, rustup and Oh My Zsh are
pinned and checked against recorded hashes or commits; cloudflared comes from Cloudflare's signed
apt repository; npm and mise tools are pinned to exact versions. Vendor AI CLIs come from each
vendor's own installer, the same channel their built-in updaters use at runtime.

## Security Best Practices

When using EnvHaven:

1. **Set a strong web password** (`PASSWORD` or `HASHED_PASSWORD`) before exposing port 8443
2. **Add an SSH key** (`PUBLIC_KEY_URL`, `PUBLIC_KEY`, or the extension); SSH does not accept passwords
3. **Don't expose ports** 8443 and 7681 to the public internet without TLS and a password; SSH on 22 takes keys only
4. **Keep your image updated** to get security patches
5. **Review API keys** you add to the environment, and mount the Docker socket only when you mean to

## Acknowledgments

We appreciate security researchers who help keep EnvHaven safe. Contributors who report valid vulnerabilities will be acknowledged here (with permission).
