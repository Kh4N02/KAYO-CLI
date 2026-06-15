"""Local Widevine (.wvd) + PlayReady (.prd) CDM — Kayo Jinx-style multi-PSSH key extraction."""

import base64
import json
import sys

from pyplayready.cdm import Cdm as PrCdm
from pyplayready.device import Device as PrDevice
from pyplayready.misc.revocation_list import RevocationList
from pyplayready.system.pssh import PSSH as PrPSSH
from pywidevine.cdm import Cdm as WvCdm
from pywidevine.device import Device as WvDevice
from pywidevine.pssh import PSSH as WvPSSH

_sessions: dict[str, tuple[str, object, bytes]] = {}


def pr_challenge(prd_path: str, init_b64: str, session_token: str) -> dict:
    cdm = PrCdm.from_device(PrDevice.load(prd_path))
    session_id = cdm.open()
    pssh = PrPSSH(init_b64)
    wrm = pssh.wrm_headers[0] if pssh.wrm_headers else init_b64
    raw = cdm.get_license_challenge(session_id, wrm, rev_lists=RevocationList.SupportedListIds)
    challenge_b64 = base64.b64encode(raw.encode() if isinstance(raw, str) else raw).decode()
    _sessions[session_token] = ('playready', cdm, session_id)
    return {'challenge_b64': challenge_b64}


def pr_keys(session_token: str, license_b64: str) -> dict:
    drm, cdm, session_id = _sessions.pop(session_token)
    if drm != 'playready':
        raise ValueError('session is not playready')
    lic_xml = base64.b64decode(license_b64).decode('utf-8')
    cdm.parse_license(session_id, lic_xml)
    out = [{'kid': k.key_id.hex, 'key': k.key.hex()} for k in cdm.get_keys(session_id)]
    cdm.close(session_id)
    return {'keys': out}


def wv_challenge(wvd_path: str, pssh_b64: str, session_token: str) -> dict:
    cdm = WvCdm.from_device(WvDevice.load(wvd_path))
    session_id = cdm.open()
    challenge = cdm.get_license_challenge(session_id, WvPSSH(pssh_b64))
    challenge_b64 = base64.b64encode(challenge).decode()
    _sessions[session_token] = ('widevine', cdm, session_id)
    return {'challenge_b64': challenge_b64}


def wv_keys(session_token: str, license_b64: str) -> dict:
    drm, cdm, session_id = _sessions.pop(session_token)
    if drm != 'widevine':
        raise ValueError('session is not widevine')
    lic = base64.b64decode(license_b64)
    cdm.parse_license(session_id, lic)
    out = [
        {'kid': k.kid.hex, 'key': k.key.hex()}
        for k in cdm.get_keys(session_id)
        if k.type == 'CONTENT'
    ]
    cdm.close(session_id)
    return {'keys': out}


def serve(prd_path: str, wvd_path: str) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            cmd = req['cmd']
            if cmd == 'pr_challenge':
                data = pr_challenge(prd_path, req['init_data'], req['session'])
            elif cmd == 'pr_keys':
                data = pr_keys(req['session'], req['license_b64'])
            elif cmd == 'wv_challenge':
                data = wv_challenge(wvd_path, req['pssh'], req['session'])
            elif cmd == 'wv_keys':
                data = wv_keys(req['session'], req['license_b64'])
            else:
                raise ValueError(f'unknown cmd: {cmd}')
            print(json.dumps({'ok': True, **data}), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({'ok': False, 'error': str(exc)}), flush=True)


def main() -> None:
    if len(sys.argv) < 4 or sys.argv[1] != 'serve':
        raise SystemExit('usage: cdm_local.py serve <prd> <wvd>')
    serve(sys.argv[2], sys.argv[3])


if __name__ == '__main__':
    main()
