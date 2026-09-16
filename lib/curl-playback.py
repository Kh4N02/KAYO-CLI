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
    # Kayo help article — https://help.kayosports.com.au/4k
    {'id': 'androidtv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'androidtv', 'PlayerId': '@dazn/peng-html5-core/androidtv/androidtv', 'Model': 'SHIELD Android TV', 'Manufacturer': 'NVIDIA', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'appletv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'appletv', 'PlayerId': '@dazn/peng-html5-core/appletv/appletv', 'Model': 'Apple TV 4K', 'Manufacturer': 'Apple', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'chromecast-4k', 'DrmType': 'PLAYREADY', 'Platform': 'chromecast', 'PlayerId': '@dazn/peng-html5-core/chromecast/chromecast', 'Model': 'Chromecast with Google TV 4K', 'Manufacturer': 'Google', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'hisense-vidaa-sl3000', 'DrmType': 'PLAYREADY', 'Platform': 'vidaa', 'PlayerId': '@dazn/peng-html5-core/vidaa/vidaa', 'Model': '43A6101EU', 'Manufacturer': 'Hisense', 'PlayReadyInitiator': 'true', 'Capabilities': '4k,hdr,hevc,mta'},
    {'id': 'webos-lg-4k', 'DrmType': 'PLAYREADY', 'Platform': 'webos', 'PlayerId': '@dazn/peng-html5-core/tv-next/tv', 'Model': '43UR8050PSB', 'Manufacturer': 'lg', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'ps5-playready', 'DrmType': 'PLAYREADY', 'Platform': 'ps5', 'PlayerId': '@dazn/peng-html5-core/ps5/ps5', 'Model': 'PlayStation 5', 'Manufacturer': 'Sony', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'tizen-samsung-4k', 'DrmType': 'PLAYREADY', 'Platform': 'tizen', 'PlayerId': '@dazn/peng-html5-core/tizen/tizen', 'Model': 'QN55Q80AAU', 'Manufacturer': 'samsung', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'sony-androidtv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'androidtv', 'PlayerId': '@dazn/peng-html5-core/androidtv/androidtv', 'Model': 'BRAVIA 4K GB', 'Manufacturer': 'Sony', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'firetv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'firetv', 'PlayerId': '@dazn/peng-html5-core/firetv/firetv', 'Model': 'AFTKA', 'Manufacturer': 'Amazon', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'xbox-playready', 'DrmType': 'PLAYREADY', 'Platform': 'xboxone', 'PlayerId': '@dazn/peng-html5-core/xbox/xbox', 'Model': 'Xbox Series X', 'Manufacturer': 'Microsoft', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'web-playready-4k-cap', 'DrmType': 'PLAYREADY', 'Platform': 'web', 'PlayerId': '@dazn/peng-html5-core/web/web', 'Model': 'Chrome', 'Manufacturer': 'google', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
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
        'Origin': 'https://tv.kayosports.com.au',
        'Referer': 'https://tv.kayosports.com.au/',
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


def jinx_playback_headers(token, device_uuid):
    pl = token_payload(token)
    return {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': f'Bearer {token.replace("Bearer ", "")}',
        'Origin': 'https://tv.kayosports.com.au',
        'Referer': 'https://tv.kayosports.com.au/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'x-brand': 'KAYO',
        'x-correlation-id': str(uuid.uuid4()),
        'x-dazn-device': device_uuid,
        'x-daznid': pl.get('user') or '',
    }


def playback_post_hisense_url(asset_id):
    params = {
        'AppVersion': APP_VERSION,
        'DrmType': 'PLAYREADY',
        'Format': 'MPEG-DASH',
        'PlayerId': '@dazn/peng-html5-core/vidaa/vidaa',
        'Platform': 'vidaa',
        'Model': '43A6101EU',
        'Secure': 'true',
        'Manufacturer': 'Hisense',
        'PlayReadyInitiator': 'true',
        'Capabilities': '4k,hdr,hevc,mta',
        'AssetId': asset_id,
        'MtaLanguageCode': '',
        'LanguageCode': 'en',
    }
    return f'{PLAYBACK_BASE}?{urlencode(params)}'


def playback_post_hisense_body():
    return json.dumps({
        'adParams': {
            'useMT': False,
            'isLat': '0',
            'deviceOs': 'vidaa',
            'optout': '0',
            'deviceBrand': 'HISENSE',
            'idType': '',
            'startPos': -1,
            'deviceType': 'Tv',
            'playerName': '@dazn/peng-html5-core/vidaa/vidaa',
            'playerVersion': APP_VERSION,
            'vpmute': '0',
            'wta': '0',
            'requestPausedAdsUrl': False,
        },
    })


def kayo_site_headers(token, session_id=None):
    headers = playback_headers(token, session_id)
    headers['Content-Type'] = 'application/json; charset=UTF-8'
    headers['Origin'] = 'https://kayosports.com.au'
    headers['Referer'] = 'https://kayosports.com.au/'
    return headers


def probe_playback_row(asset_id, token, profile, headers, auth_mode='jwt', method='GET'):
    name = profile['id'] if isinstance(profile, dict) else profile
    label = f'{name}+{auth_mode}' if method == 'GET' else f'{name}+post'
    try:
        if method == 'POST':
            url = playback_post_hisense_url(asset_id)
            body = playback_post_hisense_body()
            resp = requests.post(url, headers=headers, data=body, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        else:
            url = build_profile_url(asset_id, token, profile)
            resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code != 200:
            return {'profile': name, 'auth': auth_mode, 'method': method, 'status': resp.status_code, 'max_h': 0}
        pb = resp.json()
        entry = pick_cdn_entry(pb.get('PlaybackDetails') or [])
        if not entry:
            return {'profile': name, 'auth': auth_mode, 'method': method, 'status': 200, 'max_h': 0, 'note': 'no CDN'}
        mpd = entry.get('ManifestUrl') or ''
        if entry.get('CdnToken'):
            tok = entry['CdnToken']
            sep = '&' if '?' in mpd else '?'
            mpd += f'{sep}{tok["Name"]}={tok["Value"]}'
        seg_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://kayosports.com.au/',
            'Origin': 'https://tv.kayosports.com.au',
            'Accept': '*/*',
        }
        max_h, mpd_status = mpd_max_height(mpd, seg_headers)
        row = {
            'profile': name,
            'auth': auth_mode,
            'method': method,
            'status': 200,
            'cdn': entry.get('CdnName'),
            'max_h': max_h,
            'mpd_status': mpd_status,
        }
        if max_h >= 2160:
            row['playback'] = pb
        return row
    except Exception as exc:
        return {'profile': name, 'auth': auth_mode, 'method': method, 'error': str(exc), 'max_h': 0}


def probe_uhd_profiles(asset_id, token, session_id):
    results = []
    best = None
    best_any = None
    device_uuid = str(uuid.uuid4())

    post_row = probe_playback_row(
        asset_id, token, {'id': 'hisense-vidaa-post'}, kayo_site_headers(token, session_id), auth_mode='post', method='POST',
    )
    results.append(post_row)
    if post_row.get('status') == 200 and post_row.get('max_h', 0) >= 2160:
        best = post_row
    if post_row.get('status') == 200 and (best_any is None or post_row.get('max_h', 0) > best_any.get('max_h', 0)):
        best_any = post_row

    for profile in UHD_PROFILES:
        attempts = [
            ('jwt', playback_headers(token, session_id)),
            ('tv-uuid', jinx_playback_headers(token, device_uuid)),
        ]
        profile_best = None
        for auth_mode, headers in attempts:
            row = probe_playback_row(asset_id, token, profile, headers, auth_mode=auth_mode, method='GET')
            results.append(row)
            if row.get('status') != 200:
                continue
            if profile_best is None or row.get('max_h', 0) > profile_best.get('max_h', 0):
                profile_best = row
        if not profile_best:
            continue
        if profile_best.get('max_h', 0) >= 2160 and (best is None or profile_best['max_h'] > best.get('max_h', 0)):
            best = profile_best
        if best_any is None or profile_best.get('max_h', 0) > best_any.get('max_h', 0):
            best_any = profile_best

    playready_blocked = all(
        r.get('status') == 403
        for r in results
        if r.get('method') in ('GET', 'POST')
    )
    return {'results': results, 'best': best, 'best_any': best_any, 'all_blocked': playready_blocked}


WEB_WIDEVINE = {
    'id': 'web-widevine',
    'DrmType': 'WIDEVINE',
    'Platform': 'web',
    'PlayerId': '@dazn/peng-html5-core/web/web',
    'Model': 'Chrome',
    'Manufacturer': 'google',
    'PlayReadyInitiator': 'false',
    'Capabilities': 'hdr,hevc,mta',
}

WEBOS_WIDEVINE = {
    'id': 'webos-widevine',
    'DrmType': 'WIDEVINE',
    'Platform': 'webos',
    'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
    'Model': '43UR8050PSB',
    'Manufacturer': 'lg',
    'PlayReadyInitiator': 'false',
    'Capabilities': '4k,dd,ddp,hdr,hevc,mta',
}


def web_widevine_ad_body():
    return json.dumps({
        'adParams': {
            'useMT': False,
            'isLat': '0',
            'deviceOs': 'web',
            'optout': '0',
            'deviceBrand': '',
            'idType': '',
            'startPos': -1,
            'deviceType': 'Web',
            'playerName': '@dazn/peng-html5-core/web/web',
            'playerVersion': APP_VERSION,
            'vpmute': '0',
            'wta': '0',
            'requestPausedAdsUrl': False,
        },
    })


def build_widevine_url(asset_id, token):
    """Default HD profile — web Widevine (matches browser JWT)."""
    return build_profile_url(asset_id, token, WEB_WIDEVINE)


def fetch_playback_widevine(asset_id, token, session_id):
    """Try web JWT profile first; fall back to legacy TV webos profile."""
    attempts = [
        ('web-get', 'GET', build_profile_url(asset_id, token, WEB_WIDEVINE), kayo_site_headers(token, session_id), None),
        ('web-post', 'POST', build_profile_url(asset_id, token, WEB_WIDEVINE), kayo_site_headers(token, session_id), web_widevine_ad_body()),
        ('webos-get', 'GET', build_profile_url(asset_id, token, WEBOS_WIDEVINE), playback_headers(token, session_id), None),
    ]
    last_status = 0
    last_body = ''
    for _name, method, url, headers, body in attempts:
        if method == 'POST':
            resp = requests.post(url, headers=headers, data=body, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        else:
            get_headers = {k: v for k, v in headers.items() if k.lower() != 'content-type'}
            resp = requests.get(url, headers=get_headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code == 200:
            return resp.json()
        last_status = resp.status_code
        last_body = resp.text[:300]
    return {'error': f'Playback API HTTP {last_status}', 'body': last_body}


def fetch_playready_jinx(asset_id, token, device_uuid):
    url = build_widevine_url(asset_id, token).replace('DrmType=WIDEVINE', 'DrmType=PLAYREADY')
    headers = jinx_playback_headers(token, device_uuid)
    resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    if resp.status_code != 200:
        return {'ok': False, 'status': resp.status_code, 'body': resp.text[:300]}
    return {'ok': True, 'playback': resp.json()}


def probe_live_cdn(manifest_url):
    import re
    from urllib.parse import unquote

    # MPD + init: no Referer/Origin/UA — Kayo CDN tokens 401 when browser headers are sent.
    resp = requests.get(manifest_url, impersonate='chrome120', timeout=25, proxies=NO_PROXY)
    if resp.status_code != 200:
        return {'ok': False, 'mpd_status': resp.status_code, 'init_status': 0}

    base = manifest_url.split('index.mpd')[0]
    match = re.search(r'initialization="([^"]+)"', resp.text)
    if not match:
        return {'ok': False, 'mpd_status': 200, 'init_status': 0, 'error': 'no init template'}

    seg = match.group(1).replace('&amp;', '&')
    if 'dazn-token' not in seg:
        tok = re.search(r'dazn-token=([^&]+)', manifest_url)
        if tok:
            sep = '&' if '?' in seg else '?'
            seg += f"{sep}dazn-token={unquote(tok.group(1))}"

    init_url = base + seg
    init_resp = requests.get(init_url, impersonate='chrome120', timeout=25, proxies=NO_PROXY)
    return {
        'ok': init_resp.status_code == 200,
        'mpd_status': 200,
        'init_status': init_resp.status_code,
    }


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
        result = fetch_playback_widevine(asset_id, token, session_id)
        if result.get('error'):
            print(json.dumps(result))
            sys.exit(2)
        print(json.dumps(result))
        return

    if cmd == 'playback-playready-jinx':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        device_uuid = sys.argv[4]
        print(json.dumps(fetch_playready_jinx(asset_id, token, device_uuid)))
        return

    if cmd == 'probe-live-cdn':
        url = sys.argv[2]
        print(json.dumps(probe_live_cdn(url)))
        return

    if cmd == 'get-mpd-auth':
        url = sys.argv[2]
        token = sys.argv[3]
        headers = playback_headers(token)
        headers.update({
            'Accept': '*/*',
            'Origin': 'https://tv.kayosports.com.au',
            'Referer': 'https://tv.kayosports.com.au/',
        })
        resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code < 200 or resp.status_code >= 300:
            print(json.dumps({
                'error': f'HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps({'text': resp.text}))
        return

    if cmd == 'get-mpd':
        url = sys.argv[2]
        resp = requests.get(url, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code < 200 or resp.status_code >= 300:
            print(json.dumps({
                'error': f'HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps({'text': resp.text}))
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
