#!/bin/bash
# macOS: 이 파일을 더블클릭하면 실행됩니다(처음 한 번은 우클릭 → 열기).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."; exit 1
fi
[ -d node_modules ] || npm install --omit=dev
OPEN_BROWSER=1 node server.js
