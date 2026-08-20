#!/usr/bin/env python3
"""Test MPD URL manipulation for hidden 2160p renditions."""

import json
import re
import uuid
import time
import base64
from urllib.parse import urlencode, urlparse, parse_qs, urlunparse

from curl_cffi import requests

NO_PROXY = {'http': None, 'https': None, 'all': None}
APP = '0.134.1-hotfix.f7e0d40f1'
HEIGHT_RE = re.compile(r'height="(\d+)"')


def token_payload(token):
    part = token.split('.')[1]
    part += '=' * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part).decode())


with open('kayo-token.json', encoding='utf-8') as f:
    sess = json.load(f)
TOKEN = sess['token']
PL = token_payload(TOKEN)
DEVICE = PL.get('deviceId', '')


def headers():
    return {
        'Accept': '*/*',
        'Authorization': f'Bearer {TOKEN}',
        'X-BRAND': 'KAYO',
        'Origin': 'https://kayosports.com.au',
        'Referer': 'https://kayosports.com.au/',
        'x-dazn-device': DEVICE,
        'x-daznid': PL.get('user', ''),
        'x-correlation-id': str(uuid.uuid4()),
    }


def get_widevine_mpd(aid):
    sid = f'{int(time.time() * 1000)}-{PL.get("viewerId", "")}-{aid}-67BC9B'
    params = {
        'AppVersion': APP,
        'DrmType': 'WIDEVINE',
        'Format': 'MPEG-DASH',
        'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
        'Platform': 'webos',
        'Model': '43UR8050PSB',
        'Secure': 'true',
        'Manufacturer': 'lg',
        'PlayReadyInitiator': 'false',
        'Capabilities': '4k,dd,ddp,hdr,hevc,mta',
        'AssetId': aid,
        'MtaLanguageCode': '',
        'LanguageCode': 'en',
        'SessionId': sid,
    }
    url = f'https://api.playback.indazn.com/v5/Playback?{urlencode(params)}'
    r = requests.get(url, headers=headers(), impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    if r.status_code != 200:
        return None
    pb = r.json()
    for name in ('dck1-ac-vod', 'dck1-fs-vod'):
        entry = next((d for d in pb.get('PlaybackDetails', []) if d.get('CdnName') == name), None)
        if entry:
            mpd = entry['ManifestUrl']
            if entry.get('CdnToken'):
                tok = entry['CdnToken']
                sep = '&' if '?' in mpd else '?'
                mpd += f'{sep}{tok["Name"]}={tok["Value"]}'
            return mpd
    return None


def mpd_max(url, extra_params=None):
    u = urlparse(url)
    q = parse_qs(u.query)
    if extra_params:
        for k, v in extra_params.items():
            q[k] = [v]
    new_q = '&'.join(f'{k}={v[0]}' for k, v in q.items())
    test_url = urlunparse((u.scheme, u.netloc, u.path, u.params, new_q, u.fragment))
    h = headers()
    r = requests.get(test_url, headers=h, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    if r.status_code != 200:
        return r.status_code, 0
    heights = [int(x) for x in HEIGHT_RE.findall(r.text)]
    return 200, max(heights) if heights else 0


def main():
    aid = 'emfu5j39wp8385wo18re4vq81'
    base = get_widevine_mpd(aid)
    if not base:
        print('Could not get base MPD URL')
        return
    print(f'Base MPD: {base[:100]}...')
    tricks = [
        ('baseline', {}),
        ('quality=4k', {'quality': '4k'}),
        ('quality=uhd', {'quality': 'uhd'}),
        ('maxHeight=2160', {'maxHeight': '2160'}),
        ('resolution=2160', {'resolution': '2160'}),
        ('format=hevc', {'format': 'hevc'}),
        ('drm=playready', {'drm': 'playready'}),
        ('capabilities=4k', {'capabilities': '4k'}),
        ('profile=high', {'profile': 'high'}),
        ('variant=uhd', {'variant': 'uhd'}),
    ]
    print(f'\n=== MPD tricks for {aid} ===')
    for name, params in tricks:
        st, mx = mpd_max(base, params)
        print(f'{name:20} -> HTTP {st} max={mx}p')


if __name__ == '__main__':
    main()
