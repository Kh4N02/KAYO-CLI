#!/usr/bin/env python3
"""Local HTTP bridge: N_m3u8DL -> curl_cffi (no User-Agent header on Kayo CDN)."""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from curl_cffi import requests

NO_PROXY = {'http': None, 'https': None, 'all': None}


class BridgeHandler(BaseHTTPRequestHandler):
    cdn_origin = ''

    def log_message(self, _fmt, *_args):
        return

    def _fetch(self, path):
        url = self.cdn_origin.rstrip('/') + path
        return requests.get(url, impersonate='chrome120', timeout=120, proxies=NO_PROXY)

    def do_GET(self):
        try:
            resp = self._fetch(self.path)
            body = resp.content
            self.send_response(resp.status_code)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)
        except Exception as exc:
            msg = str(exc).encode('utf-8', 'replace')
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', required=True, help='CDN origin, e.g. https://dck1-fs-live.dtcdn.dazn.com')
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()

    parsed = urlparse(args.origin)
    if not parsed.scheme or not parsed.netloc:
        print(json.dumps({'error': f'invalid origin: {args.origin}'}))
        sys.exit(2)

    BridgeHandler.cdn_origin = f'{parsed.scheme}://{parsed.netloc}'
    server = ThreadingHTTPServer(('127.0.0.1', args.port), BridgeHandler)
    print(json.dumps({'ok': True, 'port': args.port, 'origin': BridgeHandler.cdn_origin}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
