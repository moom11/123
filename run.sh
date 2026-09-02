#!/usr/bin/env bash
# تشغيل نظام الموارد البشرية محلياً
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "==> إنشاء بيئة بايثون افتراضية"
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

# تهيئة قاعدة البيانات (وبيانات تجريبية عند تمرير --demo)
if [ "$1" == "--demo" ]; then
  PYTHONPATH=backend .venv/bin/python -m app.seed --demo
  shift
else
  PYTHONPATH=backend .venv/bin/python -m app.seed
fi

HOST="${HR_HOST:-0.0.0.0}"
PORT="${HR_PORT:-8000}"
echo "==> النظام يعمل على http://localhost:${PORT}"
PYTHONPATH=backend .venv/bin/python -m uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"
