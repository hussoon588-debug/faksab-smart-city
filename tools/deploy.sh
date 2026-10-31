#!/usr/bin/env bash
# نشر فكسب سمارت سيتي على GitHub Pages. يتطلب GH_TOKEN في البيئة.
set -euo pipefail
OWNER=${OWNER:-hussoon588-debug}
REPO=${REPO:-faksab-smart-city}
cd "$(dirname "$0")/.."

: "${GH_TOKEN:?GH_TOKEN missing}"
export GH_TOKEN

# 1) إنشاء المستودع إن لم يكن موجوداً
if ! gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  gh repo create "$OWNER/$REPO" --public --description "FAKSAB SMART CITY — Arabic city-building game" --source=. --remote=origin --push
fi

# 2) الدفع
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$OWNER/$REPO.git"
git branch -M main
git push -u origin main --force

# 3) تشغيل Pages من الفرع main
curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/pages" \
  -d '{"source":{"branch":"main","path":"/"}}' || true

# 4) بناء أول مرة إن لم تكن الصفحة مفعلة (404 ثم إنشاء)
curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/pages/builds" >/dev/null || true

sleep 5
curl -sS -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/pages" | head -c 600
