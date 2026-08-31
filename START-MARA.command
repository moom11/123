#!/bin/bash
# macOS: double-click this file. You may need to allow it once under
# System Settings -> Privacy & Security.
cd "$(dirname "$0")" || exit 1

echo
echo "  ============================================"
echo "     MARA Lounge - Starting"
echo "  ============================================"
echo

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "  [X] Node.js is not installed, or npm is missing from it."
  echo
  echo "      Install it from https://nodejs.org (choose LTS),"
  echo "      then run this file again."
  echo
  read -r -p "  Press Enter to close. "
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "  [X] PostgreSQL was not found."
  echo
  echo "      brew install postgresql@16"
  echo "      brew services start postgresql@16"
  echo
  read -r -p "  Press Enter to close. "
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  Installing dependencies. This happens once and takes a few minutes."
  echo
  if ! npm install; then
    echo
    echo "  [X] npm install failed. Check your internet connection."
    read -r -p "  Press Enter to close. "
    exit 1
  fi
fi

echo
echo "  Starting. The browser opens by itself in a moment."
echo "  Leave this window open. Close it, or press Ctrl-C, to stop."
echo

( sleep 12; open http://localhost:4173 2>/dev/null ) &
npm start

echo
echo "  MARA has stopped."
read -r -p "  Press Enter to close. "
