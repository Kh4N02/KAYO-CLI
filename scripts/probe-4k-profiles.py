#!/usr/bin/env python3
"""Probe Kayo Playback API device profiles for 4K MPD ladders."""

import base64
import json
import re
import sys
import time
import uuid

from curl_cffi import requests

APP = '0.134.1-hotfix.f7e0d40f1'
CAPS = '4k,dd,ddp,hdr,hevc,mta'
NO_PROXY = {'http': None, 'https': None, 'all': None}

PROFILES = {
    'web-playready-4k-cap': {
        'DrmType': 'PLAYREADY', 'Platform': 'web',
        'PlayerId': '@dazn/peng-html5-core/web/web',
        'Model': 'Chrome', 'Manufacturer': 'google', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'webos-lg-4k': {
        'DrmType': 'PLAYREADY', 'Platform': 'webos',
        'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
        'Model': '43UR8050PSB', 'Manufacturer': 'lg', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'tizen-samsung-4k': {
        'DrmType': 'PLAYREADY', 'Platform': 'tizen',
        'PlayerId': '@dazn/peng-html5-core/tizen/tizen',
        'Model': 'QN55Q80AAU', 'Manufacturer': 'samsung', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'androidtv-4k': {
        'DrmType': 'PLAYREADY', 'Platform': 'androidtv',
        'PlayerId': '@dazn/peng-html5-core/androidtv/androidtv',
        'Model': 'SHIELD Android TV', 'Manufacturer': 'NVIDIA', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'firetv-4k': {
        'DrmType': 'PLAYREADY', 'Platform': 'firetv',
        'PlayerId': '@dazn/peng-html5-core/firetv/firetv',
        'Model': 'AFTKA', 'Manufacturer': 'Amazon', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'tvos-fairplay': {
        'DrmType': 'FAIRPLAY', 'Platform': 'tvos',
        'PlayerId': '@dazn/peng-html5-core/tvos/tvos',
        'Model': 'AppleTV', 'Manufacturer': 'Apple', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'xbox-playready': {
        'DrmType': 'PLAYREADY', 'Platform': 'xboxone',
        'PlayerId': '@dazn/peng-html5-core/xbox/xbox',
        'Model': 'Xbox Series X', 'Manufacturer': 'Microsoft', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'ps5-playready': {
        'DrmType': 'PLAYREADY', 'Platform': 'ps5',
        'PlayerId': '@dazn/peng-html5-core/ps5/ps5',
        'Model': 'PlayStation 5', 'Manufacturer': 'Sony', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'hubbl-tv': {
        'DrmType': 'PLAYREADY', 'Platform': 'hubbl',
        'PlayerId': '@dazn/peng-html5-core/hubbl/hubbl',
        'Model': 'Hubbl Glass', 'Manufacturer': 'Hubbl', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
    'hisense-vidaa-sl3000': {
        'DrmType': 'PLAYREADY', 'Platform': 'vidaa',
        'PlayerId': '@dazn/peng-html5-core/vidaa/vidaa',
        'Model': '43A6101EU', 'Manufacturer': 'Hisense', 'PlayReadyInitiator': 'true',
        'Capabilities': '4k,hdr,hevc,mta',
    },
    'webos-widevine-4k': {
        'DrmType': 'WIDEVINE', 'Platform': 'webos',
        'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
        'Model': '43UR8050PSB', 'Manufacturer': 'lg', 'PlayReadyInitiator': 'false',
        'Capabilities': CAPS,
    },
}


def token_payload(token):
    part = token.split('.')[1]
    part += '=' * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part).decode())


def headers(token, session_id):
    pl = token_payload(token)
    h = {
        'Accept': '*/*',
        'Authorization': f'Bearer {token.replace("Bearer ", "")}',
        'X-BRAND': 'KAYO',
        'Origin': 'https://kayosports.com.au',
        'Referer': 'https://kayosports.com.au/',
        'Accept-Language': 'en-AU,en;q=0.9',
        'x-correlation-id': str(uuid.uuid4()),
        'x-dazn-device': pl.get('deviceId', ''),
        'x-daznid': pl.get('user', ''),
    }
    if session_id:
        h['x-session-id'] = session_id
    return h


def build_url(asset_id, token, profile):
    pl = token_payload(token)
    viewer = pl.get('viewerId') or ''
    sid = f'{int(time.time() * 1000)}-{viewer}-{asset_id}-67BC9B'
    params = {
        'AppVersion': APP,
        'Format': 'MPEG-DASH',
        'Secure': 'true',
        'AssetId': asset_id,
        'MtaLanguageCode': '',
        'LanguageCode': 'en',
        'SessionId': sid,
        **profile,
    }
    from urllib.parse import urlencode
    return f'https://api.playback.indazn.com/v5/Playback?{urlencode(params)}'


def mpd_stats(mpd_url, hdrs):
    r = requests.get(mpd_url, headers={**hdrs, 'Accept': '*/*'}, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    if r.status_code != 200:
        return {'mpd_status': r.status_code, 'max_h': 0, 'cdn': ''}
    heights = [int(x) for x in re.findall(r'height="(\d+)"', r.text)]
    return {
        'mpd_status': 200,
        'max_h': max(heights) if heights else 0,
        'hevc': 'hvc1' in r.text or 'hevc' in r.text.lower(),
        'pr_pssh': len(re.findall(r'9a04f079-9840-4286-ab92-e65be0885f95', r.text, re.I)),
        'wv_pssh': len(re.findall(r'edef8ba9-79d6-4ace-a3c8-27cdb24df260', r.text, re.I)),
    }


def probe_asset(label, asset_id, token, session_id):
    hdrs = headers(token, session_id)
    print(f'\n=== {label} ({asset_id}) ===')
    for name, profile in PROFILES.items():
        url = build_url(asset_id, token, profile)
        try:
            resp = requests.get(url, headers=hdrs, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
            if resp.status_code != 200:
                print(f'{name:24} playback HTTP {resp.status_code}')
                continue
            pb = resp.json()
            details = pb.get('PlaybackDetails') or []
            best = None
            for d in details:
                cdn = d.get('CdnName') or ''
                if 'ac-vod' in cdn or 'fs-vod' in cdn:
                    best = d
                    if 'ac-vod' in cdn:
                        break
            if not best and details:
                best = details[0]
            if not best:
                print(f'{name:24} no CDN')
                continue
            mpd = best.get('ManifestUrl') or ''
            if best.get('CdnToken'):
                tok = best['CdnToken']
                sep = '&' if '?' in mpd else '?'
                mpd += f'{sep}{tok["Name"]}={tok["Value"]}'
            stats = mpd_stats(mpd, hdrs)
            cdn = best.get('CdnName', '?')
            print(
                f'{name:24} {cdn} max={stats.get("max_h", 0)}p '
                f'pr={stats.get("pr_pssh", 0)} wv={stats.get("wv_pssh", 0)} '
                f'hevc={stats.get("hevc", False)}'
            )
        except Exception as exc:
            print(f'{name:24} ERR {exc}')


def main():
    with open('kayo-token.json', encoding='utf-8') as f:
        sess = json.load(f)
    token = sess['token']
    session_id = sess.get('sessionId', '')
    assets = [
        ('Bangladesh-Test-D4', 'emfu5j39wp8385wo18re4vq81'),
        ('Monaco-Race', 'b9ngas16fad1o4st5jji5d113'),
    ]
    if len(sys.argv) > 1:
        assets = [(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else assets[0][1])]
    for label, aid in assets:
        probe_asset(label, aid, token, session_id)


if __name__ == '__main__':
    main()
