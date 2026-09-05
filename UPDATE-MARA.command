#!/bin/bash
cd "$(dirname "$0")" || exit 1
BRANCH=claude/mara-lounge-management-system-tlrc2b

echo
echo "  ============================================"
echo "     MARA Lounge - Getting the latest changes"
echo "  ============================================"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "  [X] Git is not installed.  ->  https://git-scm.com/downloads"
  echo
  read -r -p "  Press Enter to close. "; exit 1
fi

if [ ! -d .git ]; then
  echo "  [X] This folder is not connected to the repository."
  echo
  echo "      It looks like it came from a zip file. To get updates,"
  echo "      clone it instead - once - into a new folder:"
  echo
  echo "        git clone -b $BRANCH https://github.com/moom11/123.git mara"
  echo "        cd mara && npm install"
  echo
  read -r -p "  Press Enter to close. "; exit 1
fi

echo "  Fetching..."
if ! git pull --ff-only; then
  echo
  echo "  [X] Could not pull. If you have edited files here, your changes"
  echo "      conflict with the new ones. Copy your edits aside, then run:"
  echo "        git reset --hard origin/$BRANCH"
  echo
  read -r -p "  Press Enter to close. "; exit 1
fi

echo
echo "  Updating dependencies..."
if ! npm install; then
  echo
  echo "  [X] npm install failed. Check your internet connection."
  read -r -p "  Press Enter to close. "; exit 1
fi

echo
echo "  Up to date. Run START-MARA.command to start the system."
echo
read -r -p "  Press Enter to close. "
