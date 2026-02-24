#!/bin/bash
# Install OpenClaw as a macOS LaunchAgent — auto-starts on boot.
# Run once: ./scripts/install-mac-mini.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_NAME="com.openclaw.trading"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$SCRIPT_DIR/logs"
NODE_PATH="$(which node)"
PM2_PATH="$(which pm2)"

echo "=== OpenClaw Mac Mini Installer ==="
echo ""
echo "Project:  $SCRIPT_DIR"
echo "Node:     $NODE_PATH"
echo "PM2:      $PM2_PATH"
echo ""

# Verify prerequisites
if [ ! -f "$NODE_PATH" ]; then
  echo "ERROR: Node.js not found. Install with: brew install node"
  exit 1
fi

if [ ! -f "$PM2_PATH" ]; then
  echo "ERROR: PM2 not found. Install with: npm install -g pm2"
  exit 1
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Build dashboard for production
echo "Building dashboard..."
cd "$SCRIPT_DIR/dashboard" && npm run build > /dev/null 2>&1
echo "Dashboard built."

# Set up PM2 startup (tells PM2 to resurrect on reboot)
echo "Configuring PM2 startup..."
pm2 start "$SCRIPT_DIR/ecosystem.config.cjs" --silent
pm2 save --silent
echo "PM2 processes saved."

# Generate PM2 startup command (launchd on macOS)
echo ""
echo "Run the following command to enable PM2 auto-start on boot:"
echo ""
pm2 startup launchd 2>&1 | grep "sudo" || echo "  pm2 startup launchd"
echo ""

# Create a wrapper script for ngrok (PM2 doesn't handle it well)
NGROK_LAUNCHER="$SCRIPT_DIR/scripts/start-ngrok.sh"
cat > "$NGROK_LAUNCHER" << 'NGROK_EOF'
#!/bin/bash
# Start ngrok tunnel for TV webhooks
ngrok http 3001 --log=stdout --log-level=warn > /tmp/openclaw-ngrok.log 2>&1
NGROK_EOF
chmod +x "$NGROK_LAUNCHER"

# Create launchd plist for ngrok (separate from PM2)
cat > "$PLIST_PATH" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${SCRIPT_DIR}/scripts/start-ngrok.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/ngrok-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/ngrok-stderr.log</string>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
</dict>
</plist>
PLIST_EOF

# Load the plist
launchctl load "$PLIST_PATH" 2>/dev/null || true

echo ""
echo "=== Installation Complete ==="
echo ""
echo "What happens on boot:"
echo "  1. PM2 auto-starts backend + dashboard (via pm2 startup)"
echo "  2. launchd starts ngrok tunnel (via $PLIST_NAME)"
echo ""
echo "To uninstall:"
echo "  launchctl unload $PLIST_PATH"
echo "  rm $PLIST_PATH"
echo "  pm2 unstartup launchd"
echo ""
echo "To verify: reboot and check ./claw status"
