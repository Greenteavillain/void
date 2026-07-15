#!/usr/bin/env python3
"""굽기 전용 임시 서버 — 정적 서빙 + POST /bake 로 받은 바이너리를 파일로 저장.

브라우저에서만 getPointAtLength(원본과 비트 단위로 같은 결과)를 얻을 수 있는데
그 결과를 디스크로 빼낼 방법이 필요해서 만든 것. 굽고 나면 안 쓴다.
"""
import http.server, socketserver, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8744

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_POST(self):
        if not self.path.startswith('/bake'):
            self.send_error(404); return
        name = self.headers.get('X-Filename', 'points.bin')
        name = os.path.basename(name)                       # 경로 탈출 방지
        n = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(n)
        out_dir = os.path.join(ROOT, 'art')
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, name)
        with open(path, 'wb') as f:
            f.write(data)
        print(f'  saved {path}  ({len(data):,} bytes)', file=sys.stderr)
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(f'{len(data)}'.encode())

    def log_message(self, *a): pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), H) as httpd:
    print(f'bake server on http://localhost:{PORT}', file=sys.stderr)
    httpd.serve_forever()
