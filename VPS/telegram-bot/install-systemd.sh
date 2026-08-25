#!/usr/bin/env bash
# Run on the server as root:
#   sudo bash install-systemd.sh
set -euo pipefail

APP_DIR=/opt/vps-bot
UNIT=/etc/systemd/system/vps-bot.service
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

id vpsbot >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin vpsbot

mkdir -p "$APP_DIR" "$APP_DIR/data" "$APP_DIR/catalog"
cp -a "$SRC_DIR/bot.py" "$SRC_DIR/extract_catalog.py" "$SRC_DIR/vps-bot.service" "$APP_DIR/"
cp -a "$SRC_DIR/catalog/plans.json" "$APP_DIR/catalog/"

if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -f "$SRC_DIR/.env" ]]; then
    cp "$SRC_DIR/.env" "$APP_DIR/.env"
  else
    cp "$SRC_DIR/.env.example" "$APP_DIR/.env"
    echo "Edit $APP_DIR/.env and put TELEGRAM_BOT_TOKEN + TELEGRAM_CHANNEL_ID" >&2
  fi
fi
chmod 600 "$APP_DIR/.env"
chown -R vpsbot:vpsbot "$APP_DIR"

install -m 644 "$APP_DIR/vps-bot.service" "$UNIT"
systemctl daemon-reload
systemctl enable --now vps-bot.service
systemctl status --no-pager vps-bot.service
echo "logs: journalctl -u vps-bot -f"
