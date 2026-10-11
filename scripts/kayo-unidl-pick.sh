#!/usr/bin/env bash
# Pick a saved Kayo live-record command (like hmax for HBO).
# Install: ln -sf "/mnt/c/Users/ozair/.unidl/commands/kayo" ~/kayo-cmds
#           alias kayo='bash /mnt/d/Cricket\ Matches-Shots/Scripts/kayo_cmd/scripts/kayo-unidl-pick.sh'

set -euo pipefail

DEFAULT_WIN="/mnt/d/Cricket Matches-Shots/Scripts/kayo_cmd/unidl-commands"
CMD_DIR="${KAYO_UNIDL_COMMANDS_DIR:-$DEFAULT_WIN}"
if [[ ! -d "$CMD_DIR" && -d "$HOME/.unidl/commands/kayo" ]]; then
  CMD_DIR="$HOME/.unidl/commands/kayo"
fi

if [[ ! -d "$CMD_DIR" ]]; then
  echo "No commands folder: $CMD_DIR"
  echo "Record live once from kayo_cmd (KAYO_LIVE_DOWNLOADER=unidl) to populate it."
  exit 1
fi

mapfile -t SCRIPTS < <(find "$CMD_DIR" -maxdepth 1 -name '*.sh' -type f | sort -r)
if [[ ${#SCRIPTS[@]} -eq 0 ]]; then
  echo "No .sh scripts in $CMD_DIR"
  exit 1
fi

echo "Kayo saved recordings (${#SCRIPTS[@]}):"
i=1
for f in "${SCRIPTS[@]}"; do
  echo "  $i) $(basename "$f")"
  ((i++)) || true
done

read -r -p "Select number (or q): " choice
[[ "$choice" == "q" ]] && exit 0
[[ "$choice" =~ ^[0-9]+$ ]] || { echo "Invalid"; exit 1; }
idx=$((choice - 1))
[[ $idx -ge 0 && $idx -lt ${#SCRIPTS[@]} ]] || { echo "Out of range"; exit 1; }

pick="${SCRIPTS[$idx]}"
port="$(grep -oE '_kayo_bridge_port_[0-9]+' "$CMD_DIR"/*.bat 2>/dev/null | head -1 | grep -oE '[0-9]+$' || true)"
if [[ -n "$port" ]]; then
  bat="$CMD_DIR/_kayo_bridge_port_${port}.bat"
  if [[ -f "/mnt/c/Users/ozair/.unidl/commands/kayo/_kayo_bridge_port_${port}.bat" ]]; then
    bat="/mnt/c/Users/ozair/.unidl/commands/kayo/_kayo_bridge_port_${port}.bat"
  fi
  echo "Ensure Windows bridge is running: $bat"
fi

out_dir="$(grep -E '^KAYO_OUT_DIR=' "$pick" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
out_name="$(grep -E '^KAYO_OUT_NAME=' "$pick" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
if [[ -n "$out_dir" ]]; then
  echo "Output folder: $out_dir"
  [[ -n "$out_name" ]] && echo "Expected file: ${out_name}*.mkv (grows while recording)"
fi
echo "Running: $pick"
exec bash "$pick"
