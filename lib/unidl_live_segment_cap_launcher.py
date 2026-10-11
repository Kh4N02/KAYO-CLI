#!/usr/bin/env python3
"""Run `unidl download …` with Kayo live segment burst cap (WSL live record)."""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    lib_dir = Path(__file__).resolve().parent
    if str(lib_dir) not in sys.path:
        sys.path.insert(0, str(lib_dir))

    from unidl_live_segment_cap import install

    install()

    from unidl.__main__ import main as unidl_main

    sys.argv = ["unidl", *sys.argv[1:]]
    return int(unidl_main() or 0)


if __name__ == "__main__":
    raise SystemExit(main())
