#!/usr/bin/env python3
"""Headless UniDL Kayo VOD download (same N_m3u8 + CDN bridge path as the Kayo service)."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_kayo_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> int:
    parser = argparse.ArgumentParser(description="UniDL Kayo download via kayo_cmd bridge")
    parser.add_argument("--asset-id", required=True)
    parser.add_argument("--title", default="")
    parser.add_argument("--item-json", default="{}")
    args = parser.parse_args()

    _load_kayo_env()
    os.environ.setdefault("KAYO_CMD_PATH", str(ROOT))

    try:
        item = json.loads(args.item_json or "{}")
    except json.JSONDecodeError as exc:
        print(f"Invalid --item-json: {exc}", file=sys.stderr)
        return 2

    try:
        from unidl import services as unidl_services
        from unidl.core.config import Config
        from unidl.core.engine import Engine, TrackSet
        from unidl.core.settings import SettingsStore
        from unidl.core.service import registry
        from unidl.services.kayo import Kayo, api
        from unidl.services.kayo.nm3u8_vod import install
    except ImportError as exc:
        print(
            "UniDL is not installed for this Python. Install unidl on PATH or set KAYO_UNIDL_PYTHON.",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 2

    install()
    config = Config.load(None)
    unidl_services.load_all(config)

    title = str(args.title or item.get("title") or args.asset_id)
    item = dict(item)
    item.setdefault("title", title)
    item.setdefault("fetchKeys", True)

    print(f"[unidl] Resolving {args.asset_id} via kayo_cmd bridge…", flush=True)
    try:
        data = api.resolve_playback(args.asset_id, title, item=item)
    except api.KayoError as exc:
        print(f"[unidl] Resolve failed: {exc}", file=sys.stderr)
        return 1

    store = SettingsStore(config)
    svc = registry.build(Kayo, config, store)
    playback = svc._playback_from_resolve(data, item=item)
    settings = svc.settings
    engine = Engine(config, log=lambda line: print(line, flush=True))

    print(f"[unidl] Downloading: {playback.save_name}", flush=True)
    result = engine.run(playback, settings, TrackSet(), service=svc)
    if result.failure:
        print(result.failure, file=sys.stderr)
    return int(result.exit_code)


if __name__ == "__main__":
    raise SystemExit(main())
