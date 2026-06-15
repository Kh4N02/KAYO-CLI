'use strict';

const BRAND = 'Kayo by Kh4N_PCT';
const KAYO_GREEN = { r: 64, g: 248, b: 127 };
const BANNER_INNER = 56;

function enableWindowsVt() {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    execSync('chcp 65001 >nul 2>&1', { stdio: 'ignore', shell: true });
  } catch { /* ignore */ }
}

function colorEnabled() {
  if (process.env.NO_COLOR || process.env.KAYO_NO_COLOR === '1') return false;
  if (process.stdout.isTTY === false) return false;
  return true;
}

function rgb(r, g, b, text) {
  if (!colorEnabled()) return String(text);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Terminal display width (ASCII=1; wide chars approximated). */
function displayWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const code = ch.codePointAt(0);
    if (code >= 0x1100 && (
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1ffff)
    )) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function visibleLen(s) {
  return displayWidth(s);
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  brightGreen: '\x1b[92m',
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  yellow: '\x1b[33m',
  brightYellow: '\x1b[93m',
  red: '\x1b[31m',
  brightRed: '\x1b[91m',
  magenta: '\x1b[35m',
  brightMagenta: '\x1b[95m',
  blue: '\x1b[34m',
  brightBlue: '\x1b[94m',
  white: '\x1b[37m',
  brightWhite: '\x1b[97m',
  gray: '\x1b[90m',
};

function kayo(text) {
  return rgb(KAYO_GREEN.r, KAYO_GREEN.g, KAYO_GREEN.b, text);
}

function sportCode(sport) {
  const s = String(sport || '').toLowerCase();
  if (/cricket/i.test(s)) return 'CR';
  if (/afl|australian rules|footy/i.test(s)) return 'AF';
  if (/nrl|rugby league/i.test(s)) return 'RL';
  if (/rugby union/i.test(s)) return 'RU';
  if (/basketball/i.test(s)) return 'BB';
  if (/motor|racing|f1|supercars/i.test(s)) return 'MC';
  if (/baseball|mlb/i.test(s)) return 'BS';
  if (/ufc|mma|boxing|fight|bkfc/i.test(s)) return 'FX';
  if (/tennis/i.test(s)) return 'TN';
  if (/golf/i.test(s)) return 'GF';
  if (/soccer|football/i.test(s)) return 'FB';
  if (/netball/i.test(s)) return 'NB';
  if (/hockey/i.test(s)) return 'HK';
  if (/live tv|live &/i.test(s)) return 'LV';
  if (/4k|uhd/i.test(s)) return '4K';
  return 'TV';
}

const TAG_COLORS = {
  CR: C.brightGreen,
  AF: C.brightBlue,
  RL: C.brightYellow,
  RU: C.yellow,
  BB: C.brightMagenta,
  MC: C.brightRed,
  BS: C.cyan,
  FX: C.red,
  TN: C.green,
  GF: C.green,
  FB: C.brightCyan,
  NB: C.magenta,
  HK: C.blue,
  LV: C.brightRed,
  '4K': C.brightMagenta,
  TV: C.gray,
};

function sportTag(sport) {
  const code = sportCode(sport);
  if (!colorEnabled()) return `[${code}]`;
  const color = TAG_COLORS[code] || C.cyan;
  return `${color}[${code}]${C.reset}`;
}

function channelLabel(channel, sport) {
  const tag = sportTag(sport || channel);
  const name = String(channel || 'Kayo');
  if (!colorEnabled()) return `${tag} ${name}`;
  return `${tag} ${C.brightWhite}${name}${C.reset}`;
}

function categoryLabel(label, sport) {
  const text = String(label || '');
  if (/quit|back/i.test(text)) return formatTitleCell(text);
  const tag = sportTag(sport || text);
  if (!colorEnabled()) return `${tag} ${text}`;
  return `${tag} ${C.brightWhite}${text}${C.reset}`;
}

function isNavRow(row) {
  const t = String(row?.Title || row?.Category || row?.Section || '');
  return /back to categories|^quit$/i.test(t);
}

function statusBadge(status) {
  const s = String(status || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'live') return `${C.bold}${C.brightRed}* LIVE${C.reset}`;
  if (lower === 'upcoming') return `${C.brightYellow}~ ${s}${C.reset}`;
  if (lower === 'catchup') return `${C.brightBlue}< ${s}${C.reset}`;
  return `${C.cyan}${s}${C.reset}`;
}

function qualityBadge(quality) {
  const q = String(quality || '').trim();
  if (!q) return '';
  if (/4k|uhd/i.test(q)) return `${C.bold}${C.brightMagenta}${q}${C.reset}`;
  return `${C.brightCyan}${q}${C.reset}`;
}

function padCenter(text, width) {
  const vis = displayWidth(text);
  const left = Math.max(0, Math.floor((width - vis) / 2));
  const right = Math.max(0, width - vis - left);
  return `${' '.repeat(left)}${text}${' '.repeat(right)}`;
}

function bannerLine(text) {
  return `${C.gray}|${C.reset}${padCenter(text, BANNER_INNER)}${C.gray}|${C.reset}`;
}

function printBanner() {
  enableWindowsVt();
  const rule = `${C.gray}+${'-'.repeat(BANNER_INNER)}+${C.reset}`;
  console.log([
    '',
    rule,
    bannerLine(kayo(`${C.bold}KAYO${C.reset}`)),
    bannerLine(`${C.dim}by ${C.reset}${kayo('Kh4N_PCT')}`),
    bannerLine(`${C.gray}MPD / Keys / N_m3u8DL-RE${C.reset}`),
    rule,
    '',
  ].join('\n'));
}

function logInfo(msg) {
  console.log(`${C.brightCyan}*${C.reset} ${C.cyan}${msg}${C.reset}`);
}

function logOk(msg) {
  console.log(`${C.brightGreen}+${C.reset} ${C.green}${msg}${C.reset}`);
}

function logWarn(msg) {
  console.log(`${C.brightYellow}!${C.reset} ${C.yellow}${msg}${C.reset}`);
}

function logErr(msg) {
  console.log(`${C.brightRed}-${C.reset} ${C.red}${msg}${C.reset}`);
}

function sectionTitle(title) {
  if (!colorEnabled()) return `\n=== ${title} ===\n`;
  return `\n${kayo(` ${title} `)}${C.gray}${' '.repeat(Math.max(2, 40 - title.length))}${C.reset}\n`;
}

function prompt(text) {
  if (!colorEnabled()) return `${text}`;
  return `${kayo('>')}${C.reset} ${C.bold}${text}${C.reset}`;
}

function formatTitleCell(title) {
  const t = String(title || '');
  if (!colorEnabled()) return t;
  if (/back to categories|quit/i.test(t)) return `${C.dim}${t}${C.reset}`;
  return `${C.bold}${C.brightWhite}${t}${C.reset}`;
}

function formatIdxCell(idx, row) {
  if (isNavRow(row)) {
    return colorEnabled() ? `${C.dim}${idx}${C.reset}` : idx;
  }
  return colorEnabled() ? `${C.brightCyan}${idx}${C.reset}` : idx;
}

function divider(label) {
  const text = label ? ` ${label} ` : '';
  if (!colorEnabled()) return `${'─'.repeat(16)}${text}${'─'.repeat(16)}`;
  return `${C.gray}${'─'.repeat(10)}${C.reset}${kayo(text)}${C.gray}${'─'.repeat(10)}${C.reset}`;
}

module.exports = {
  BRAND,
  C,
  enableWindowsVt,
  colorEnabled,
  stripAnsi,
  visibleLen,
  displayWidth,
  kayo,
  sportCode,
  sportTag,
  channelLabel,
  categoryLabel,
  isNavRow,
  statusBadge,
  qualityBadge,
  printBanner,
  logInfo,
  logOk,
  logWarn,
  logErr,
  sectionTitle,
  prompt,
  formatTitleCell,
  formatIdxCell,
  divider,
};
