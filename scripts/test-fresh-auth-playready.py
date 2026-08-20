#!/usr/bin/env python3
"""Fresh SignIn token + PlayReady GET test (NO_PROXY)."""

import base64
import json
import os
import random
import string
import sys
import uuid
import time
from urllib.parse import urlencode

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, ROOT)

from curl_cffi import requests

NO_PROXY = {'http': None, 'https': None, 'all': None}


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
            if key.strip() and key.strip() not in os.environ:
                os.environ[key.strip()] = value.strip()


def decode_jwt(token):
    part = token.split('.')[1]
    part += '=' * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part).decode())


def main():
    load_dotenv()
    email = os.environ.get('KAYO_EMAIL', '')
    password = os.environ.get('KAYO_PASSWORD', '')
    if not email or not password:
        print('Missing KAYO_EMAIL/KAYO_PASSWORD in .env')
        return

    device_uuid = str(uuid.uuid4())
    dazn_device = '00' + device_uuid.split('-')[4][2:]
    profiling = ''.join(random.choices(string.ascii_lowercase + string.digits, k=20))
    base_h = {
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://tv.kayosports.com.au',
        'Referer': 'https://tv.kayosports.com.au/',
        'x-brand': 'KAYO',
    }

    r1 = requests.post(
        'https://authentication-prod.ar.indazn.com/v5/SignIn',
        json={
            'Email': email,
            'Password': password,
            'Platform': 'webos',
            'DeviceId': dazn_device,
            'ProfilingSessionId': profiling,
            'Brand': 'KAYO',
        },
        headers=base_h,
        impersonate='chrome120',
        proxies=NO_PROXY,
        timeout=20,
    )
    print('SignIn', r1.status_code)
    if r1.status_code != 200:
        return

    initial = r1.json()['AuthToken']['Token']
    pl = decode_jwt(initial)
    prof_h = {
        **base_h,
        'Authorization': f'Bearer {initial}',
        'x-daznid': pl.get('user'),
        'x-session-id': str(uuid.uuid4()),
    }
    r2 = requests.get(
        'https://user-profile.ar.indazn.com/v4/UserProfile',
        headers=prof_h,
        impersonate='chrome120',
        proxies=NO_PROXY,
        timeout=20,
    )
    print('Profile', r2.status_code)
    profile_id = r2.json().get('ViewerId')

    r3 = requests.post(
        'https://authentication-prod.ar.indazn.com/v1/SwitchProfile',
        headers=prof_h,
        json={'brand': 'kayo', 'profileId': profile_id},
        impersonate='chrome120',
        proxies=NO_PROXY,
        timeout=20,
    )
    print('Switch', r3.status_code)
    token = r3.json()['AuthToken']['Token']
    pl = decode_jwt(token)

    for label, aid in [
        ('Bangladesh-D4', 'emfu5j39wp8385wo18re4vq81'),
        ('Monaco', 'b9ngas16fad1o4st5jji5d113'),
    ]:
        sid = f'{int(time.time() * 1000)}-{pl.get("viewerId", "")}-{aid}-67BC9B'
        params = {
            'AppVersion': '0.134.1-hotfix.f7e0d40f1',
            'DrmType': 'PLAYREADY',
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
        h = {
            **base_h,
            'Authorization': f'Bearer {token}',
            'x-correlation-id': str(uuid.uuid4()),
            'x-dazn-device': device_uuid,
            'x-daznid': pl.get('user'),
        }
        r4 = requests.get(url, headers=h, impersonate='chrome120', proxies=NO_PROXY, timeout=45)
        print(f'{label} PlayReady GET -> HTTP {r4.status_code}', r4.text[:80].replace('\n', ' '))


if __name__ == '__main__':
    main()
