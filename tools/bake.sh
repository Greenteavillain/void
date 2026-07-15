#!/bin/bash
# art/thread-field.svg → art/points.bin 다시 굽기.
# 그림(SVG)을 바꿨을 때만 돌리면 된다. 평소엔 필요 없음.
#
# 브라우저에서 굽는 이유: 원본 코드가 쓰던 것과 같은 브라우저의 getPointAtLength 구현으로
# 좌표를 뽑아야 그림이 안 바뀐다. JS path 라이브러리로 다시 계산하면 미세하게 달라진다.
cd "$(dirname "$0")/.."
python3 tools/bake_server.py &
SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
sleep 1.5
echo "브라우저에서 http://localhost:8744/tools/bake.html 을 열면 굽고 저장합니다."
open -a "Google Chrome" "http://localhost:8744/tools/bake.html" 2>/dev/null || open "http://localhost:8744/tools/bake.html"
echo "저장되면 Ctrl+C 로 종료하세요. (art/points.bin 갱신 확인)"
wait $SRV
