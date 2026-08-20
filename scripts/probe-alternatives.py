#!/usr/bin/env python3
"""Probe alternative Kayo 4K/UHD playback endpoints and methods."""

import base64
import json
import re
import time
import uuid
from urllib.parse import urlencode

from curl_cffi import requests

NO_PROXY = {'http': None, 'https': None, 'all': None}
APP = '0.134.1-hotfix.f7e0d40f1'
CAPS_FULL = '4k,dd,ddp,hdr,hevc,mta'
CAPS_4K_ONLY = '4k'
CAPS_HEVC = 'hevc,4k'

with open('kayo-token.json', encoding='utf-8') as f:
    sess = json.load(f)
TOKEN = sess['token']
SESSION_ID = sess.get('sessionId', '')


def token_payload(token):
    part = token.split('.')[1]
    part += '=' * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part).decode())


PL = token_payload(TOKEN)
VIEWER = PL.get('viewerId', '')
DEVICE = PL.get('deviceId', '')

ASSETS = [
    ('Bangladesh-D4', 'emfu5j39wp8385wo18re4vq81'),
    ('Monaco', 'b9ngas16fad1o4st5jji5d113'),
]


def make_session_id(aid):
    return f'{int(time.time() * 1000)}-{VIEWER}-{aid}-67BC9B'


def make_headers(origin='https://kayosports.com.au', referer=None, extra=None):
    h = {
        'Accept': '*/*',
        'Authorization': f'Bearer {TOKEN}',
        'X-BRAND': 'KAYO',
        'Origin': origin,
        'Referer': referer or (origin + '/'),
        'Accept-Language': 'en-AU,en;q=0.9',
        'x-correlation-id': str(uuid.uuid4()),
        'x-dazn-device': DEVICE,
        'x-daznid': PL.get('user', ''),
    }
    if SESSION_ID:
        h['x-session-id'] = SESSION_ID
    if extra:
        h.update(extra)
    return h


AD_PARAMS = {
    'useMT': False,
    'isLat': '0',
    'deviceOs': 'vidaa',
    'optout': '0',
    'deviceBrand': 'HISENSE',
    'idType': '',
    'startPos': -1,
    'deviceType': 'Tv',
    'playerName': '@dazn/peng-html5-core/vidaa/vidaa',
    'playerVersion': APP,
    'vpmute': '0',
    'wta': '0',
    'requestPausedAdsUrl': False,
}

AD_PARAMS_WEBOS = {
    **AD_PARAMS,
    'deviceOs': 'webos',
    'deviceBrand': 'LG',
    'playerName': '@dazn/peng-html5-core/tv-next/tv',
}

HEIGHT_RE = re.compile(r'height="(\d+)"')
PR_RE = re.compile(r'9a04f079-9840-4286-ab92-e65be0885f95', re.I)
WV_RE = re.compile(r'edef8ba9-79d6-4ace-a3c8-27cdb24df260', re.I)


def mpd_max(mpd_url, h):
    try:
        r = requests.get(
            mpd_url,
            headers={**h, 'Accept': '*/*'},
            impersonate='chrome120',
            timeout=45,
            proxies=NO_PROXY,
        )
        if r.status_code != 200:
            return r.status_code, 0, 0, 0
        heights = [int(x) for x in HEIGHT_RE.findall(r.text)]
        pr = len(PR_RE.findall(r.text))
        wv = len(WV_RE.findall(r.text))
        return 200, max(heights) if heights else 0, pr, wv
    except Exception as exc:
        return str(exc)[:40], 0, 0, 0


def pick_entry(pb):
    for name in ('dck1-ac-vod', 'dck1-fs-vod', 'dck1-ac-live', 'dck1-fs-live'):
        entry = next(
            (d for d in (pb.get('PlaybackDetails') or []) if d.get('CdnName') == name),
            None,
        )
        if entry and entry.get('ManifestUrl'):
            return entry
    return next((d for d in (pb.get('PlaybackDetails') or []) if d.get('ManifestUrl')), None)


def safe_request(method, url, **kwargs):
    try:
        if method == 'GET':
            return requests.get(url, **kwargs)
        return requests.post(url, **kwargs)
    except Exception as exc:
        return exc


def summarize_playback(r, h):
    if isinstance(r, Exception):
        return f'ERR {str(r)[:60]}'
    if r.status_code != 200:
        return f'HTTP {r.status_code}'
    try:
        pb = r.json()
    except json.JSONDecodeError:
        return f'non-JSON {r.text[:80]}'
    if pb.get('odata.error'):
        msg = pb['odata.error'].get('message', {}).get('value', '')
        return f'odata: {str(msg)[:60]}'
    entry = pick_entry(pb)
    if not entry:
        return 'no CDN'
    mpd = entry.get('ManifestUrl', '')
    if entry.get('CdnToken'):
        tok = entry['CdnToken']
        sep = '&' if '?' in mpd else '?'
        mpd += f'{sep}{tok["Name"]}={tok["Value"]}'
    st, mx, pr, wv = mpd_max(mpd, h)
    return f'{entry.get("CdnName", "?")} mpd={st} max={mx}p pr={pr} wv={wv}'


def build_params(aid, profile):
    return {
        'AppVersion': APP,
        'Format': 'MPEG-DASH',
        'Secure': 'true',
        'AssetId': aid,
        'MtaLanguageCode': '',
        'LanguageCode': 'en',
        'SessionId': make_session_id(aid),
        **profile,
    }


PROFILES = {
    'hisense-pr': {
        'DrmType': 'PLAYREADY',
        'Platform': 'vidaa',
        'PlayerId': '@dazn/peng-html5-core/vidaa/vidaa',
        'Model': '43A6101EU',
        'Manufacturer': 'Hisense',
        'PlayReadyInitiator': 'true',
        'Capabilities': '4k,hdr,hevc,mta',
    },
    'webos-pr': {
        'DrmType': 'PLAYREADY',
        'Platform': 'webos',
        'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
        'Model': '43UR8050PSB',
        'Manufacturer': 'lg',
        'PlayReadyInitiator': 'false',
        'Capabilities': CAPS_FULL,
    },
    'web-pr-post': {
        'DrmType': 'PLAYREADY',
        'Platform': 'web',
        'PlayerId': '@dazn/peng-html5-core/web/web',
        'Model': 'Chrome',
        'Manufacturer': 'google',
        'PlayReadyInitiator': 'false',
        'Capabilities': CAPS_FULL,
    },
    'webos-wv-4k': {
        'DrmType': 'WIDEVINE',
        'Platform': 'webos',
        'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
        'Model': '43UR8050PSB',
        'Manufacturer': 'lg',
        'PlayReadyInitiator': 'false',
        'Capabilities': CAPS_FULL,
    },
    'webos-wv-hevc': {
        'DrmType': 'WIDEVINE',
        'Platform': 'webos',
        'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
        'Model': '43UR8050PSB',
        'Manufacturer': 'lg',
        'PlayReadyInitiator': 'false',
        'Capabilities': CAPS_HEVC,
    },
    'webos-wv-4konly': {
        'DrmType': 'WIDEVINE',
        'Platform': 'webos',
        'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
        'Model': '43UR8050PSB',
        'Manufacturer': 'lg',
        'PlayReadyInitiator': 'false',
        'Capabilities': CAPS_4K_ONLY,
    },
}

BASES = [
    ('v5', 'https://api.playback.indazn.com/v5/Playback'),
    ('v4', 'https://api.playback.indazn.com/v4/Playback'),
    ('v3', 'https://api.playback.indazn.com/v3/Playback'),
    ('v5-au', 'https://api.playback.indazn.com/au/v5/Playback'),
    ('playback-prod', 'https://playback-prod.ar.indazn.com/v5/Playback'),
    ('playback-au', 'https://playback.au.indazn.com/v5/Playback'),
]

PROXIES = [
    ('kayo-bff', 'https://kayosports.com.au/api/playback/v5/Playback'),
    ('kayo-play', 'https://play.kayosports.com.au/v5/Playback'),
    ('tv-kayo', 'https://tv.kayosports.com.au/api/playback/v5/Playback'),
    ('ott-bff', 'https://ott-authz-bff-prod.ar.indazn.com/v5/Playback'),
]


def probe_asset(aname, aid):
    print(f'\n========== {aname} ({aid}) ==========')

    for bname, base in BASES:
        for pname in ('webos-wv-4k', 'hisense-pr'):
            profile = PROFILES[pname]
            url = f'{base}?{urlencode(build_params(aid, profile))}'
            h = make_headers()
            r = safe_request('GET', url, headers=h, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
            print(f'GET  {bname:16} {pname:14} -> {summarize_playback(r, h)}')

    for pname, adp in (
        ('hisense-pr', AD_PARAMS),
        ('webos-pr', AD_PARAMS_WEBOS),
        ('web-pr-post', AD_PARAMS),
    ):
        profile = PROFILES[pname]
        url = f'https://api.playback.indazn.com/v5/Playback?{urlencode(build_params(aid, profile))}'
        h = make_headers(extra={'Content-Type': 'application/json; charset=UTF-8'})
        body = json.dumps({'adParams': adp})
        r = safe_request('POST', url, headers=h, data=body, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        print(f'POST v5            {pname:14} -> {summarize_playback(r, h)}')

    profile = PROFILES['webos-pr']
    url = f'https://api.playback.indazn.com/v5/Playback?{urlencode(build_params(aid, profile))}'
    h = make_headers(origin='https://tv.kayosports.com.au', referer='https://tv.kayosports.com.au/')
    r = safe_request('GET', url, headers=h, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    print(f'GET  tv-origin-pr               -> {summarize_playback(r, h)}')

    for pname in ('webos-wv-hevc', 'webos-wv-4konly'):
        profile = PROFILES[pname]
        url = f'https://api.playback.indazn.com/v5/Playback?{urlencode(build_params(aid, profile))}'
        h = make_headers()
        r = safe_request('GET', url, headers=h, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        print(f'GET  caps-variant    {pname:14} -> {summarize_playback(r, h)}')

    profile = PROFILES['hisense-pr']
    for pname, purl in PROXIES:
        url = f'{purl}?{urlencode(build_params(aid, profile))}'
        try:
            r = requests.get(url, headers=make_headers(), impersonate='chrome120', timeout=20, proxies=NO_PROXY)
            snippet = r.text[:60].replace('\n', ' ')
            print(f'GET  proxy {pname:12} -> HTTP {r.status_code} ({snippet})')
        except Exception as exc:
            print(f'GET  proxy {pname:12} -> ERR {str(exc)[:50]}')

    profile = dict(PROFILES['webos-wv-4k'])
    params = build_params(aid, profile)
    params['Secure'] = 'false'
    url = f'https://api.playback.indazn.com/v5/Playback?{urlencode(params)}'
    h = make_headers()
    r = safe_request('GET', url, headers=h, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    print(f'GET  secure=false                 -> {summarize_playback(r, h)}')


def main():
    for aname, aid in ASSETS:
        probe_asset(aname, aid)
    print('\nDONE')


if __name__ == '__main__':
    main()
