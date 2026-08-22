#!/usr/bin/env python3
"""Verify PlayReady stack: CDM (.prd) + license server vs playback API."""
import base64
import json
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

from curl_cffi import requests

ROOT = Path(__file__).resolve().parents[1]
NO = {'http': None, 'https': None, 'all': None}
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
asset = sys.argv[1] if len(sys.argv) > 1 else 'emfu5j39wp8385wo18re4vq81'

tok = json.loads((ROOT / 'kayo-token.json').read_text(encoding='utf-8'))
token, sid = tok['token'], tok.get('sessionId')

print('=== 1) PlayReady PLAYBACK API (4K ladder gate) ===')
probe = json.loads(subprocess.check_output(
    [sys.executable, str(ROOT / 'lib' / 'curl-playback.py'), 'probe-uhd', asset, token, sid or ''],
    cwd=ROOT, text=True,
))
print('all_blocked:', probe.get('all_blocked'))
print('best 2160p profile:', probe.get('best'))

print('\n=== 2) Widevine manifest (hybrid path) ===')
pb = json.loads(subprocess.check_output(
    [sys.executable, str(ROOT / 'lib' / 'curl-playback.py'), 'playback', asset, token, sid or ''],
    cwd=ROOT, text=True,
))
entry = next(d for d in pb['PlaybackDetails'] if d['CdnName'] == 'dck1-ac-vod')
u = entry['ManifestUrl']
t = entry['CdnToken']
u += ('&' if '?' in u else '?') + f"{t['Name']}={urllib.parse.quote(t['Value'], safe='')}"
mpd = requests.get(u, impersonate='chrome120', timeout=30, proxies=NO).text
hs = sorted({int(x) for x in re.findall(r'height="(\d+)"', mpd)}, reverse=True)
pr_boxes = len(re.findall('9a04f079-9840-4286-ab92-e65be0885f95', mpd))
print('max height:', hs[0] if hs else 0, '| PlayReady PSSH boxes:', pr_boxes)

print('\n=== 3) PlayReady LICENSE + local .prd CDM ===')
init_b64 = None
for m in re.finditer(r'<cenc:pssh[^>]*>([^<]+)</cenc:pssh>', mpd):
    raw = base64.b64decode(m.group(1) + '==')
    if b'\x9a\x04\xf0\x79\x98\x40\x42\x86\xab\x92\xe6\x5b\xe0\x88\x5f\x95' in raw:
        init_b64 = m.group(1)
        break
if not init_b64:
    print('FAIL: no PlayReady PSSH in MPD')
    sys.exit(1)

lic = entry.get('LaUrl') or pb.get('LaUrl')
pr_lic = lic.replace('/widevine/', '/playready/') if '/widevine/' in (lic or '') else lic
print('license URL:', pr_lic[:80], '...')

# Use cdm_local serve via stdin one-shot
prd = ROOT / 'cmds' / 'hisense_smarttv_43a6101eu_sl3000.prd'
wvd = ROOT / 'cmds' / 'motorola_moto_g_v5.0.0-android_d9eff17f_4445_l3.wvd'
proc = subprocess.Popen(
    [sys.executable, str(ROOT / 'lib' / 'cdm_local.py'), 'serve', str(prd), str(wvd)],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
session = 'test-session-1'
proc.stdin.write(json.dumps({'cmd': 'pr_challenge', 'init_data': init_b64, 'session': session}) + '\n')
proc.stdin.flush()
chal_line = proc.stdout.readline()
chal = json.loads(chal_line)
if not chal.get('ok', True) and chal.get('error'):
    print('CDM challenge FAIL:', chal.get('error'))
    proc.kill()
    sys.exit(1)
challenge_b64 = chal['challenge_b64']

lic_resp = subprocess.check_output(
    [sys.executable, str(ROOT / 'lib' / 'curl-playback.py'), 'post', pr_lic, token,
     challenge_b64, 'text/xml; charset=utf-8'],
    cwd=ROOT, text=True,
)
lic_json = json.loads(lic_resp)
license_b64 = lic_json['b64']
print('license HTTP: OK (via curl-playback post)')

proc.stdin.write(json.dumps({'cmd': 'pr_keys', 'session': session, 'license_b64': license_b64}) + '\n')
proc.stdin.flush()
keys_line = proc.stdout.readline()
keys_out = json.loads(keys_line)
proc.kill()
keys = keys_out.get('keys', [])
print('PlayReady keys extracted:', len(keys))
for k in keys[:3]:
    print(' ', k['kid'], k['key'])
if keys:
    print('\nVERDICT: PlayReady CDM + license server WORKING')
    print('          PlayReady playback API for 2160p ladder:', 'BLOCKED' if probe.get('all_blocked') else 'OPEN')
else:
    print('\nVERDICT: PlayReady key path FAILED')
    sys.exit(1)
