#!/bin/bash
# void — 로컬 서버 + Chrome. file:// 로는 카메라 권한이 안 나온다.
cd "$(dirname "$0")"
PORT=8745
lsof -ti :$PORT >/dev/null 2>&1 || { python3 -m http.server $PORT --directory "$(pwd)" >/dev/null 2>&1 & sleep 1; }
echo "→ http://localhost:$PORT"
open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT"
