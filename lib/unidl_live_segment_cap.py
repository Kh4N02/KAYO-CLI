"""Cap how many new DASH live segments UniDL muxes per refresh (Kayo patches often burst 7×~2s)."""

from __future__ import annotations

import os


def _max_per_cycle() -> int:
    raw = os.environ.get("KAYO_UNIDL_LIVE_MAX_SEGMENTS_PER_CYCLE", "1").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 1


def install() -> bool:
    """Monkeypatch UniDL live group alignment to slice bursts. Idempotent."""
    max_n = _max_per_cycle()
    if max_n <= 0:
        return False

    try:
        from unidl.downloader import live as live_mod
    except ImportError:
        return False

    if getattr(live_mod, "_kayo_live_segment_cap_installed", False):
        return True

    original = live_mod._aligned_group_media_segments

    def capped_aligned(states, media_by_state):
        aligned = original(states, media_by_state)
        if max_n <= 0:
            return aligned
        return {state_id: segments[:max_n] for state_id, segments in aligned.items()}

    live_mod._aligned_group_media_segments = capped_aligned
    live_mod._kayo_live_segment_cap_installed = True
    return True
