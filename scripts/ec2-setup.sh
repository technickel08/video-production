#!/usr/bin/env bash
# Set up Video Autopilot on a fresh Ubuntu EC2 instance (24.04 or newer), behind HTTPS.
#
#   Run from the project folder, as the normal login user (ubuntu), not root:
#     DOMAIN=videos.example.com ADMIN_PASSWORD='a-long-password' bash scripts/ec2-setup.sh
#
#   DOMAIN          the name that points at this instance (an A record to its public IP). Required.
#   ADMIN_PASSWORD  the dashboard's admin password, at least 10 characters. Required on first run.
#   S3_BUCKET       optional: bucket for files and backups (the instance's IAM role must allow it).
#   AWS_REGION      optional: the bucket's region (default us-east-1).
#
# Safe to run again: it updates packages, rebuilds and restarts.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN to the address that points at this server, e.g. DOMAIN=videos.example.com}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="$(id -un)"
ENV_FILE=/etc/video-autopilot.env
[ "$APP_USER" != root ] || { echo "Run this as your normal user (for example ubuntu), not root." >&2; exit 1; }

echo "==> System packages"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates gnupg ffmpeg python3 python3-venv python3-pip build-essential \
  debian-keyring debian-archive-keyring apt-transport-https fonts-noto fonts-noto-cjk fonts-noto-color-emoji

echo "==> Node.js 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "==> uv (Python tools for the video skill)"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh

echo "==> Claude Code"
command -v claude >/dev/null || sudo npm install -g @anthropic-ai/claude-code

echo "==> App: install and build"
cd "$APP_DIR"
npm install
npm run build

echo "==> Settings file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  : "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD (at least 10 characters) on the first run}"
  sudo install -m 600 -o "$APP_USER" /dev/null "$ENV_FILE"
  {
    echo "HOST=127.0.0.1"                      # only Caddy talks to the app
    echo "PORT=4317"
    echo "PUBLIC_URL=https://$DOMAIN"
    echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
    [ -z "${S3_BUCKET:-}" ] || echo "S3_BUCKET=$S3_BUCKET"
    echo "AWS_REGION=${AWS_REGION:-us-east-1}"
  } > "$ENV_FILE"
else
  echo "    keeping the existing file (edit it with: sudo nano $ENV_FILE)"
fi

echo "==> Service"
sudo tee /etc/systemd/system/video-autopilot.service >/dev/null <<UNIT
[Unit]
Description=Video Autopilot
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=PATH=/home/$APP_USER/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/npm run start -w server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:4317 {
		flush_interval -1
	}
}
CADDY

sudo systemctl daemon-reload
sudo systemctl enable --now video-autopilot
sudo systemctl restart video-autopilot
sudo systemctl reload caddy || sudo systemctl restart caddy

cat <<DONE

Done. Next steps:
  1. Sign Claude Code in to your plan (once):      claude          then type /login and follow the link
  2. Open https://$DOMAIN and sign in with the admin password.
  3. Settings → Setup checks: press "Install video tools", then fix anything still red.
  4. Settings → Cloud storage: enter the bucket, Test connection, then "Restore missing files" if you are moving from another machine.
  5. In Google Cloud and Meta, add the new redirect addresses shown on the Settings page (they now start with https://$DOMAIN).

Logs:     journalctl -u video-autopilot -f
Restart:  sudo systemctl restart video-autopilot
DONE
