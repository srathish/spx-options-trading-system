#!/bin/bash
# GexClaw Setup Script
set -e

echo "Setting up GexClaw SPX Trading System..."

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Install with: brew install node"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Node.js v18+ required (found v$NODE_VERSION)"
  exit 1
fi

echo "Node.js $(node -v) OK"

# Install dependencies
echo "Installing dependencies..."
npm install

# Create data directory
mkdir -p data

# Make CLI executable
chmod +x claw

# Check for PM2
if command -v pm2 &> /dev/null; then
  echo "PM2 $(pm2 -v) OK"
else
  echo "PM2 not found. Installing globally..."
  npm install -g pm2
fi

# Check .env
if [ ! -f .env ]; then
  echo ""
  echo "WARNING: No .env file found!"
  echo "Copy .env.example to .env and fill in your credentials:"
  echo "  cp .env.example .env"
  exit 1
fi

echo ""
echo "Setup complete! Run './claw test-alert' to verify Discord webhook."
echo "Then run './claw start' to launch the bot."
