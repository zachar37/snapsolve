#!/bin/bash

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       SnapSolve — First Run Setup    ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Paste your UploadThing token below."
echo "(Get it at: https://uploadthing.com/dashboard → API Keys)"
echo ""
read -rp "Token: " RAW_TOKEN

if [ -z "$RAW_TOKEN" ]; then
  echo "No token entered. Run ./setup.sh again when you have it."
  exit 1
fi

CLEAN_TOKEN=$(echo "$RAW_TOKEN" | sed 's/^UPLOADTHING_TOKEN=//i' | tr -d "'\"")

printf "UPLOADTHING_TOKEN=%s\n" "$CLEAN_TOKEN" > "$(dirname "$0")/.env.local"

echo ""
echo "Token saved to .env.local"
echo ""
echo "Starting dev server..."
echo ""
npm --prefix "$(dirname "$0")" run dev
