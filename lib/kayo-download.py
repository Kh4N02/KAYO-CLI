#!/usr/bin/env python3
"""Kayo DASH downloader — curl_cffi CDN fetches (no User-Agent header; N_m3u8DL gets 401)."""

import argparse
import os
import re
import shutil
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.parse import unquote, urljoin, urlparse

from curl_cffi import requests

NS = {'d': 'urn:mpeg:dash:schema:mpd:2011', 'cenc': 'urn:mpeg:cenc:2013'}
NO_PROXY = {'http': None, 'https': None, 'all': None}
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
VERSION = '20250916'


class Log:
    _lock = threading.Lock()

    @classmethod
    def _emit(cls, level, msg):
        ts = datetime.now().strftime('%H:%M:%S.') + f'{datetime.now().microsecond // 1000:03d}'
        with cls._lock:
            print(f'{ts} {level} : {msg}', flush=True)

    @classmethod
    def info(cls, msg):
        cls._emit('INFO', msg)

    @classmethod
    def warn(cls, msg):
        cls._emit('WARN', msg)

def load_dotenv():
    path = os.path.join(ROOT, '.env')
    if not os.path.isfile(path):
        return
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value


def tool(name, env_key):
    override = os.environ.get(env_key, '').strip()
    if override:
        return override
    found = shutil.which(name)
    if found:
        return found
    raise SystemExit(f'{name} not found on PATH — set {env_key} in .env')


def cdn_get(url):
    resp = requests.get(url, impersonate='chrome120', timeout=120, proxies=NO_PROXY)
    if resp.status_code != 200:
        raise RuntimeError(f'HTTP {resp.status_code} for {url[:120]}')
    return resp.content


def load_mpd(manifest_arg, manifest_url=None):
    if os.path.isfile(manifest_arg):
        with open(manifest_arg, encoding='utf-8') as handle:
            return handle.read(), manifest_arg
    url = manifest_url or manifest_arg
    return cdn_get(url).decode('utf-8', 'replace'), url


def base_from_url(url):
    parsed = urlparse(url)
    path = parsed.path
    if path.endswith(('.mpd',)):
        path = path[:path.rfind('/') + 1]
    return f'{parsed.scheme}://{parsed.netloc}{path}'


def normalize_kid(value):
    return re.sub(r'[^0-9a-fA-F]', '', value or '').lower()


def parse_keys(key_args):
    keys = {}
    for item in key_args:
        if ':' not in item:
            continue
        kid, key = item.split(':', 1)
        keys[normalize_kid(kid)] = key.lower()
    return keys


def child_text(node, tag):
    for child in node:
        if child.tag.endswith(tag):
            return child
    return None


def rep_kid(rep):
    cp = None
    for node in rep.iter():
        if node.tag.endswith('ContentProtection') and node.get('value') == 'cenc':
            cp = node
            break
    if cp is None:
        return None
    kid = cp.get('{urn:mpeg:cenc:2013}default_KID') or cp.get('cenc:default_KID')
    return normalize_kid(kid)


def parse_reps(mpd_text):
    root = ET.fromstring(mpd_text)
    video = []
    audio = []
    for adap in root.findall('.//d:AdaptationSet', NS):
        mime = adap.get('mimeType', '')
        for rep in adap.findall('d:Representation', NS):
            template = child_text(rep, 'SegmentTemplate')
            if template is None:
                continue
            info = {
                'id': rep.get('id'),
                'bandwidth': int(rep.get('bandwidth', '0')),
                'codecs': rep.get('codecs', ''),
                'height': int(rep.get('height', '0') or 0),
                'width': int(rep.get('width', '0') or 0),
                'lang': adap.get('lang') or rep.get('lang') or '',
                'kid': rep_kid(rep),
                'template': template,
                'frame_rate': rep.get('frameRate', ''),
            }
            if mime.startswith('video/'):
                video.append(info)
            elif mime.startswith('audio/'):
                audio.append(info)
    return video, audio


def pick_reps(video, audio):
    hevc = [v for v in video if v['height'] <= 1080]
    if not hevc:
        hevc = video[:]
    hevc.sort(key=lambda v: (v['height'], v['bandwidth']), reverse=True)
    if not hevc:
        raise RuntimeError('No video representations in MPD')

    en = [a for a in audio if a['lang'].lower().startswith('en')] or audio
    en.sort(key=lambda a: a['bandwidth'])
    if not en:
        raise RuntimeError('No audio representations in MPD')
    return hevc[0], en[0]


def iter_segments(template):
    init = template.get('initialization')
    media = template.get('media')
    start_number = int(template.get('startNumber', '1'))
    timeline = child_text(template, 'SegmentTimeline')
    numbers = []
    if timeline is not None:
        cursor = start_number
        for s in timeline:
            if not s.tag.endswith('S'):
                continue
            repeat = int(s.get('r', '0'))
            count = repeat + 1
            numbers.extend(range(cursor, cursor + count))
            cursor += count
    else:
        numbers = [start_number]
    return init, media, numbers


def segment_duration(template):
    timescale = int(template.get('timescale', '1') or 1)
    timeline = child_text(template, 'SegmentTimeline')
    total = 0
    if timeline is not None:
        for s in timeline:
            if not s.tag.endswith('S'):
                continue
            d = int(s.get('d', '0'))
            r = int(s.get('r', '0'))
            total += d * (r + 1)
    if not total or not timescale:
        return None
    return total / timescale


def format_duration(seconds):
    if seconds is None:
        return '?'
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f'~{h:02d}h{m:02d}m{s:02d}s'
    return f'~{m:02d}m{s:02d}s'


def kbps(bandwidth):
    return max(1, int(round(bandwidth / 1000)))


def audio_channels(codecs):
    if 'ac-3' in codecs or 'ec-3' in codecs:
        return '6CH'
    return '2CH'


def frame_rate_label(frame_rate):
    if not frame_rate:
        return '?'
    if '/' in frame_rate:
        num, den = frame_rate.split('/', 1)
        try:
            val = float(num) / float(den)
            return str(int(round(val))) if val == int(val) else f'{val:.2f}'
        except (ValueError, ZeroDivisionError):
            pass
    return frame_rate


def stream_line(kind, rep, encrypted=True):
    template = rep['template']
    _, _, numbers = iter_segments(template)
    seg_count = len(numbers)
    dur = format_duration(segment_duration(template))
    cenc = '*CENC ' if encrypted else ''
    bw = kbps(rep['bandwidth'])

    if kind == 'Vid':
        res = f'{rep["width"]}x{rep["height"]}' if rep['width'] and rep['height'] else 'video'
        fps = frame_rate_label(rep.get('frame_rate'))
        return (
            f'Vid {cenc}{res} | {bw} Kbps | {rep["id"]} | {fps} | {rep["codecs"]} '
            f'| {seg_count} Segments | {dur}'
        )

    lang = rep['lang'] or '?'
    ch = audio_channels(rep['codecs'])
    return (
        f'Aud {cenc}{rep["id"]} | {bw} Kbps | {rep["codecs"]} | {lang} | {ch} '
        f'| {seg_count} Segments | {dur}'
    )


def start_line(kind, rep):
    bw = kbps(rep['bandwidth'])
    if kind == 'Vid':
        res = f'{rep["width"]}x{rep["height"]}' if rep['width'] and rep['height'] else 'video'
        fps = frame_rate_label(rep.get('frame_rate'))
        return f'Start downloading...Vid {res} | {bw} Kbps | {rep["id"]} | {fps} | {rep["codecs"]}'
    lang = rep['lang'] or '?'
    ch = audio_channels(rep['codecs'])
    return f'Start downloading...Aud {bw} Kbps | {rep["codecs"]} | {lang} | {ch}'


def progress_bar(ratio, width=24):
    ratio = max(0.0, min(1.0, ratio))
    filled = int(width * ratio)
    return f'[{"=" * filled}{" " * (width - filled)}] {ratio * 100:5.1f}%'


class StreamProgress:
    def __init__(self, label, total):
        self.label = label
        self.total = total
        self.done = 0
        self.bytes = 0
        self.lock = threading.Lock()
        self.start = time.monotonic()
        self.last_pct = -1

    def tick(self, nbytes=0):
        with self.lock:
            self.done += 1
            self.bytes += nbytes
            elapsed = max(0.001, time.monotonic() - self.start)
            speed = self.bytes / elapsed
            speed_s = f'{speed / 1024 / 1024:.2f} MB/s' if speed > 512 * 1024 else f'{speed / 1024:.1f} KB/s'
            ratio = self.done / self.total if self.total else 1.0
            pct = int(ratio * 100)
            bar = progress_bar(ratio)
            # Log every segment on small jobs; every ~5% on large ones.
            step = 1 if self.total <= 40 else max(1, self.total // 20)
            if self.done == self.total or self.done == 1 or pct >= self.last_pct + 5 or self.done % step == 0:
                self.last_pct = pct
                Log.info(f'{self.label} | {bar} | {self.done}/{self.total} | {speed_s}')


def extract_dazn_token(url):
    match = re.search(r'[?&]dazn-token=([^&]+)', url or '')
    return unquote(match.group(1)) if match else None


def append_dazn_token(url, token_value):
    if not token_value or 'dazn-token=' in url:
        return url
    sep = '&' if '?' in url else '?'
    return f'{url}{sep}dazn-token={token_value}'


def build_url(base, template, number, token_value=None):
    rel = template.replace('$Number$', str(number)).replace('&amp;', '&')
    if rel.startswith('http://') or rel.startswith('https://'):
        out = rel
    else:
        root = base if base.endswith('/') else f'{base}/'
        out = urljoin(root, rel)
    return append_dazn_token(out, token_value)


def download_rep(base, rep, tmp_dir, label, token_value, stream_label, max_segments=0):
    template = rep['template']
    init_tpl, media_tpl, numbers = iter_segments(template)
    if max_segments > 0:
        numbers = numbers[:max_segments]

    progress = StreamProgress(stream_label, len(numbers) + 1)
    paths = []
    init_path = os.path.join(tmp_dir, f'{label}_init.mp4')
    init_data = cdn_get(build_url(base, init_tpl, numbers[0] if numbers else 1, token_value))
    with open(init_path, 'wb') as handle:
        handle.write(init_data)
    paths.append(init_path)
    progress.tick(len(init_data))

    def fetch(num):
        out = os.path.join(tmp_dir, f'{label}_{num:06d}.m4s')
        data = cdn_get(build_url(base, media_tpl, num, token_value))
        with open(out, 'wb') as handle:
            handle.write(data)
        progress.tick(len(data))
        return out

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch, num): num for num in numbers}
        for fut in as_completed(futures):
            paths.append(fut.result())

    Log.info(f'{stream_label} | merge {len(numbers) + 1} parts...')

    merged = os.path.join(tmp_dir, f'{label}_merged.mp4')
    with open(merged, 'wb') as out:
        for part in paths:
            with open(part, 'rb') as handle:
                shutil.copyfileobj(handle, out)
    Log.info(f'{stream_label} | download complete')
    return merged, rep.get('kid')


def decrypt_file(src, dst, kid, keys, label):
    key = keys.get(normalize_kid(kid))
    if not key:
        raise RuntimeError(f'No key for KID {kid}')
    Log.info(f'Decrypting {label}...')
    mp4decrypt = tool('mp4decrypt', 'KAYO_MP4DECRYPT')
    subprocess.run(
        [mp4decrypt, '--key', f'{normalize_kid(kid)}:{key}', src, dst],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    Log.info(f'Decrypt {label} OK')


def mux(video, audio, out_path, fmt):
    Log.info(f'Muxing to {fmt.upper()}...')
    mkvmerge = tool('mkvmerge', 'KAYO_MMKVMERGE')
    result = subprocess.run([mkvmerge, '-o', out_path, video, audio], capture_output=True, text=True)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr or result.stdout or 'mkvmerge failed')
    for line in (result.stdout or '').splitlines():
        line = line.strip()
        if line:
            Log.info(line)


def run_download(args):
    Log.info(f'Kayo Download (curl_cffi) {VERSION}')
    Log.info(f'Loading URL: {args.manifest}')

    mpd_text, source = load_mpd(args.manifest, args.manifest_url)
    Log.info('Content Matched: Dynamic Adaptive Streaming over HTTP')
    Log.info('Parsing streams...')

    token_source = args.manifest_url or (source if str(source).startswith('http') else args.manifest)
    base = args.base_url or base_from_url(source)
    token_value = extract_dazn_token(token_source)
    if not token_value:
        match = re.search(r'dazn-token=([^&"\']+)', mpd_text)
        if match:
            token_value = match.group(1)

    keys = parse_keys(args.key)
    video_reps, audio_reps = parse_reps(mpd_text)
    video_rep, audio_rep = pick_reps(video_reps, audio_reps)

    for rep in sorted(video_reps, key=lambda r: r['bandwidth'], reverse=True):
        Log.info(stream_line('Vid', rep))
    for rep in sorted(audio_reps, key=lambda r: r['bandwidth'], reverse=True):
        Log.info(stream_line('Aud', rep))

    Log.info('Parsing streams...')
    Log.info('Selected streams:')
    Log.info(stream_line('Vid', video_rep))
    Log.info(stream_line('Aud', audio_rep))
    Log.warn('Writing meta json')
    Log.info(f'Save Name: {args.save_name}')

    os.makedirs(args.save_dir, exist_ok=True)
    tmp_dir = os.path.join(args.save_dir, f'.tmp_{args.save_name}')
    os.makedirs(tmp_dir, exist_ok=True)

    max_segments = int(args.max_segments or 0)
    vid_label = f'Vid {video_rep["width"]}x{video_rep["height"]}'
    aud_label = f'Aud {kbps(audio_rep["bandwidth"])} Kbps'

    Log.info(start_line('Aud', audio_rep))
    Log.info(start_line('Vid', video_rep))

    results = {}

    def run_audio():
        enc, kid = download_rep(
            base, audio_rep, tmp_dir, 'audio', token_value, aud_label, max_segments,
        )
        results['audio'] = (enc, kid)

    def run_video():
        enc, kid = download_rep(
            base, video_rep, tmp_dir, 'video', token_value, vid_label, max_segments,
        )
        results['video'] = (enc, kid)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = [pool.submit(run_audio), pool.submit(run_video)]
        for fut in futs:
            fut.result()

    video_enc, video_kid = results['video']
    audio_enc, audio_kid = results['audio']

    video_dec = os.path.join(tmp_dir, 'video_dec.mp4')
    audio_dec = os.path.join(tmp_dir, 'audio_dec.mp4')
    decrypt_file(video_enc, video_dec, video_kid, keys, 'video')
    decrypt_file(audio_enc, audio_dec, audio_kid, keys, 'audio')

    ext = '.mkv' if args.format == 'mkv' else '.mp4'
    out_path = os.path.join(args.save_dir, f'{args.save_name}{ext}')
    mux(video_dec, audio_dec, out_path, args.format)

    if not args.keep_tmp:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    Log.info(f'Done - saved to {out_path}')


def main():
    load_dotenv()
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)

    dl = sub.add_parser('download')
    dl.add_argument('manifest', help='Local manifest path or remote MPD URL')
    dl.add_argument('--manifest-url', help='Remote URL when manifest is a local file')
    dl.add_argument('--base-url', help='CDN base URL for segment templates')
    dl.add_argument('--key', action='append', default=[], help='kid:key (repeatable)')
    dl.add_argument('--save-dir', required=True)
    dl.add_argument('--save-name', required=True)
    dl.add_argument('--format', choices=['mkv', 'mp4'], default='mkv')
    dl.add_argument('--keep-tmp', action='store_true')
    dl.add_argument('--max-segments', type=int, default=0, help='Limit media segments (0 = all)')

    args = parser.parse_args()
    if args.cmd == 'download':
        run_download(args)


if __name__ == '__main__':
    main()
