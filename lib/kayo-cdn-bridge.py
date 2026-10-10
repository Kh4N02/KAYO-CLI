#!/usr/bin/env python3
"""Local HTTP bridge: N_m3u8DL -> curl_cffi (no User-Agent header on Kayo CDN)."""

import argparse
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlencode, urlsplit, urlparse, urlunsplit

from curl_cffi import requests

NO_PROXY = {'http': None, 'https': None, 'all': None}
# Audio/subtitle init files 404 while video init is already up. N_m3u8DL then
# drops that track and only video is downloaded. Keep this short — a long hold
# makes N_m3u8DL abort with "Download speed too slow".
INIT_404_RETRIES = 4
INIT_404_DELAY = 0.12
# Live record: N_m3u8DL refreshes the MPD every ~14s while -mt hammers segments — transient curl errors happen.
UPSTREAM_RETRIES = 4
UPSTREAM_RETRY_DELAY = 0.35
_TZ_SPACE = re.compile(r' (\d{2}:\d{2})$')


class _Body:
    def __init__(self, status_code, content):
        self.status_code = status_code
        self.content = content


def _normalize_path(path):
    """Re-encode start/end so a '+' timezone offset is not sent as a space."""
    parts = urlsplit(path)
    pairs = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key in ('start', 'end'):
            value = _TZ_SPACE.sub(r'+\1', value)
        pairs.append((key, value))
    query = urlencode(pairs)
    return urlunsplit(('', '', parts.path, query, ''))


def _without_window(path):
    """Init files 404 when start/end is attached; token + m= is enough."""
    parts = urlsplit(path)
    pairs = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if key not in ('start', 'end')
    ]
    return urlunsplit(('', '', parts.path, urlencode(pairs), ''))


class BridgeHandler(BaseHTTPRequestHandler):
    cdn_origin = ''

    def log_message(self, _fmt, *_args):
        return

    def _get(self, path):
        url = self.cdn_origin.rstrip('/') + path
        last_exc = None
        for attempt in range(UPSTREAM_RETRIES):
            # One curl handle per request. The shared session breaks parallel -mt
            # downloads and returns 404 for audio/subtitle init while video succeeds.
            session = requests.Session()
            try:
                resp = session.get(url, impersonate='chrome120', timeout=120, proxies=NO_PROXY)
                return _Body(resp.status_code, resp.content)
            except Exception as exc:
                last_exc = exc
                if attempt + 1 < UPSTREAM_RETRIES:
                    time.sleep(UPSTREAM_RETRY_DELAY * (attempt + 1))
            finally:
                session.close()
        raise last_exc

    def _fetch(self, path):
        path = _normalize_path(path)
        resp = self._get(path)
        file_part = path.split('?', 1)[0]
        if resp.status_code != 404 or '_init.' not in file_part:
            return resp
        alt = _without_window(path)
        if alt != path:
            alt_resp = self._get(alt)
            if alt_resp.status_code != 404:
                return alt_resp
        for _ in range(INIT_404_RETRIES):
            time.sleep(INIT_404_DELAY)
            resp = self._get(path)
            if resp.status_code != 404:
                return resp
            if alt != path:
                alt_resp = self._get(alt)
                if alt_resp.status_code != 404:
                    return alt_resp
        return resp

    def do_GET(self):
        try:
            resp = self._fetch(self.path)
            body = resp.content
            self.send_response(resp.status_code)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # N_m3u8DL cancelled or moved on — not an upstream failure.
            return
        except Exception as exc:
            msg = f'bridge upstream error: {exc}'.encode('utf-8', 'replace')
            try:
                self.send_response(502)
                self.send_header('Content-Type', 'text/plain')
                self.send_header('Content-Length', str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                return


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
