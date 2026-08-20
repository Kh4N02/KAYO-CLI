#!/usr/bin/env python3
"""Widevine GET playback via curl_cffi (no browser WAF). Works for HD Kayo VOD."""

import base64
import json
import os
import sys
import re
import time
import uuid
from urllib.parse import urlencode

from curl_cffi import requests

PLAYBACK_BASE = 'https://api.playback.indazn.com/v5/Playback'
APP_VERSION = '0.134.1-hotfix.f7e0d40f1'
CAPS_4K = '4k,dd,ddp,hdr,hevc,mta'
# Playback API must use system VPN/TUN — explicit HTTP_PROXY (Clash) often gets CloudFront 403.
NO_PROXY = {'http': None, 'https': None, 'all': None}

UHD_PROFILES = [
    {'id': 'web-playready-4k-cap', 'DrmType': 'PLAYREADY', 'Platform': 'web', 'PlayerId': '@dazn/peng-html5-core/web/web', 'Model': 'Chrome', 'Manufacturer': 'google', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'webos-lg-4k', 'DrmType': 'PLAYREADY', 'Platform': 'webos', 'PlayerId': '@dazn/peng-html5-core/tv-next/tv', 'Model': '43UR8050PSB', 'Manufacturer': 'lg', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'tizen-samsung-4k', 'DrmType': 'PLAYREADY', 'Platform': 'tizen', 'PlayerId': '@dazn/peng-html5-core/tizen/tizen', 'Model': 'QN55Q80AAU', 'Manufacturer': 'samsung', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'androidtv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'androidtv', 'PlayerId': '@dazn/peng-html5-core/androidtv/androidtv', 'Model': 'SHIELD Android TV', 'Manufacturer': 'NVIDIA', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'firetv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'firetv', 'PlayerId': '@dazn/peng-html5-core/firetv/firetv', 'Model': 'AFTKA', 'Manufacturer': 'Amazon', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'hubbl-tv', 'DrmType': 'PLAYREADY', 'Platform': 'hubbl', 'PlayerId': '@dazn/peng-html5-core/hubbl/hubbl', 'Model': 'Hubbl Glass', 'Manufacturer': 'Hubbl', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'xbox-playready', 'DrmType': 'PLAYREADY', 'Platform': 'xboxone', 'PlayerId': '@dazn/peng-html5-core/xbox/xbox', 'Model': 'Xbox Series X', 'Manufacturer': 'Microsoft', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'ps5-playready', 'DrmType': 'PLAYREADY', 'Platform': 'ps5', 'PlayerId': '@dazn/peng-html5-core/ps5/ps5', 'Model': 'PlayStation 5', 'Manufacturer': 'Sony', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'hisense-vidaa-sl3000', 'DrmType': 'PLAYREADY', 'Platform': 'vidaa', 'PlayerId': '@dazn/peng-html5-core/vidaa/vidaa', 'Model': '43A6101EU', 'Manufacturer': 'Hisense', 'PlayReadyInitiator': 'true', 'Capabilities': '4k,hdr,hevc,mta'},
]


def load_dotenv():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    path = os.path.join(root, '.env')
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


def token_payload(token):
    try:
        part = token.split('.')[1]
        part += '=' * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part).decode())
    except Exception:
        return {}


def playback_headers(token, session_id=None, device_id=None):
    pl = token_payload(token)
    headers = {
        'Accept': '*/*',
        'Authorization': f'Bearer {token.replace("Bearer ", "")}',
        'X-BRAND': 'KAYO',
        'Origin': 'https://kayosports.com.au',
        'Referer': 'https://kayosports.com.au/',
        'Accept-Language': 'en-AU,en;q=0.9',
        'x-correlation-id': str(uuid.uuid4()),
    }
    if device_id or pl.get('deviceId'):
        headers['x-dazn-device'] = device_id or pl.get('deviceId')
    if pl.get('user'):
        headers['x-daznid'] = pl['user']
    if session_id:
        headers['x-session-id'] = session_id
    return headers


def build_profile_url(asset_id, token, profile):
    pl = token_payload(token)
    viewer_id = pl.get('viewerId') or ''
    session_id = f'{int(time.time() * 1000)}-{viewer_id}-{asset_id}-67BC9B'
    params = {
        'AppVersion': APP_VERSION,
        'Format': 'MPEG-DASH',
        'Secure': 'true',
        'AssetId': asset_id,
        'MtaLanguageCode': '',
        'LanguageCode': 'en',
        'SessionId': session_id,
        **{k: v for k, v in profile.items() if k != 'id'},
    }
    return f'{PLAYBACK_BASE}?{urlencode(params)}'


def mpd_max_height(mpd_url, headers):
    resp = requests.get(mpd_url, headers={**headers, 'Accept': '*/*'}, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    if resp.status_code != 200:
        return 0, resp.status_code
    heights = [int(x) for x in re.findall(r'height="(\d+)"', resp.text)]
    return (max(heights) if heights else 0), 200


def pick_cdn_entry(details):
    for name in ('dck1-ac-vod', 'dck1-fs-vod', 'dck1-ac-live', 'dck1-fs-live'):
        entry = next((d for d in details if d.get('CdnName') == name), None)
        if entry and entry.get('ManifestUrl'):
            return entry
    return next((d for d in details if d.get('ManifestUrl')), None)


def probe_uhd_profiles(asset_id, token, session_id):
    headers = playback_headers(token, session_id)
    results = []
    best = None
    for profile in UHD_PROFILES:
        name = profile['id']
        url = build_profile_url(asset_id, token, profile)
        try:
            resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
            if resp.status_code != 200:
                results.append({'profile': name, 'status': resp.status_code, 'max_h': 0})
                continue
            pb = resp.json()
            entry = pick_cdn_entry(pb.get('PlaybackDetails') or [])
            if not entry:
                results.append({'profile': name, 'status': 200, 'max_h': 0, 'note': 'no CDN'})
                continue
            mpd = entry.get('ManifestUrl') or ''
            if entry.get('CdnToken'):
                tok = entry['CdnToken']
                sep = '&' if '?' in mpd else '?'
                mpd += f'{sep}{tok["Name"]}={tok["Value"]}'
            max_h, mpd_status = mpd_max_height(mpd, headers)
            row = {
                'profile': name,
                'status': 200,
                'cdn': entry.get('CdnName'),
                'max_h': max_h,
                'mpd_status': mpd_status,
            }
            results.append(row)
            if max_h >= 2160 and (best is None or max_h > best.get('max_h', 0)):
                best = {**row, 'playback': pb}
        except Exception as exc:
            results.append({'profile': name, 'error': str(exc), 'max_h': 0})
    return {'results': results, 'best': best}


def build_widevine_url(asset_id, token):
    pl = token_payload(token)
    viewer_id = pl.get('viewerId') or ''
    session_id = f'{int(time.time() * 1000)}-{viewer_id}-{asset_id}-67BC9B'
    params = (
        'AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType=WIDEVINE&Format=MPEG-DASH'
        '&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform=webos'
        '&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=false'
        '&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta'
        f'&AssetId={asset_id}&MtaLanguageCode&LanguageCode=en&SessionId={session_id}'
    )
    return f'{PLAYBACK_BASE}?{params}'


def main():
    load_dotenv()
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'usage: curl-playback.py <command> ...'}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == 'probe-uhd':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        session_id = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
        print(json.dumps(probe_uhd_profiles(asset_id, token, session_id)))
        return

    if cmd == 'playback-profile':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        profile_id = sys.argv[4]
        session_id = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
        profile = next((p for p in UHD_PROFILES if p['id'] == profile_id), None)
        if not profile:
            print(json.dumps({'error': f'unknown profile {profile_id}'}))
            sys.exit(2)
        url = build_profile_url(asset_id, token, profile)
        headers = playback_headers(token, session_id)
        resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code != 200:
            print(json.dumps({'error': f'Playback API HTTP {resp.status_code}', 'body': resp.text[:300]}))
            sys.exit(2)
        print(json.dumps(resp.json()))
        return

    if cmd == 'playback':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        session_id = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
        url = build_widevine_url(asset_id, token)
        headers = playback_headers(token, session_id)
        resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code != 200:
            print(json.dumps({
                'error': f'Playback API HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps(resp.json()))
        return

    if cmd == 'get':
        url = sys.argv[2]
        token = sys.argv[3]
        headers = playback_headers(token)
        headers['Accept'] = '*/*'
        resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code < 200 or resp.status_code >= 300:
            print(json.dumps({
                'error': f'HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps({'text': resp.text}))
        return

    if cmd == 'post':
        url = sys.argv[2]
        token = sys.argv[3]
        body_b64 = sys.argv[4]
        content_type = sys.argv[5] if len(sys.argv) > 5 else 'application/octet-stream'
        headers = playback_headers(token)
        headers['Content-Type'] = content_type
        body = base64.b64decode(body_b64)
        resp = requests.post(url, headers=headers, data=body, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code != 200:
            print(json.dumps({
                'error': f'HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps({'b64': base64.b64encode(resp.content).decode()}))
        return

    print(json.dumps({'error': f'unknown command {cmd}'}))
    sys.exit(1)


if __name__ == '__main__':
    main()
