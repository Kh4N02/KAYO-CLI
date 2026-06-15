'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_KEY_FILE = path.join(__dirname, '..', 'keys.txt');

function keyFilePath() {
  return process.env.KAYO_KEYS_FILE || DEFAULT_KEY_FILE;
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('-').replace(/-(\d{2}-\d{2})-/, ' $1 '); // YYYY MM-DD HH:mm:ss style
}

function streamBlockLines(s, index) {
  const lines = [];
  lines.push('');
  lines.push(`[ Stream ${index} - CDN: ${s.cdnName || 'unknown'} ]`);
  lines.push('Manifest URL:');
  lines.push(s.manifestUrl || '');
  if (s.licenseUrl) {
    lines.push('License URL:');
    lines.push(s.licenseUrl);
  }
  if (s.keys?.length) {
    lines.push('[*] Keys:');
    for (const k of s.keys) {
      lines.push(`--key ${k.kid}:${k.key}`);
    }
  }
  if (s.cmd) {
    lines.push('N_m3u8DL-RE command:');
    lines.push(s.cmd);
  }
  return lines;
}

function appendPlaybackKeys({ title, streams }) {
  const file = keyFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    '',
    '='.repeat(72),
    `[${stamp}] ${title || 'Kayo'}`,
    '='.repeat(72),
  ];

  for (let i = 0; i < streams.length; i++) {
    lines.push(...streamBlockLines(streams[i], i + 1));
  }

  lines.push('');
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function resetKeyFile() {
  const file = keyFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
  return file;
}

function appendStreamHeader({ title }) {
  const file = resetKeyFile();

  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    '='.repeat(72),
    `[${stamp}] ${title || 'Kayo'}`,
    '='.repeat(72),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function appendSingleStream({ stream, index }) {
  const file = keyFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [...streamBlockLines(stream, index), ''];
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

module.exports = {
  appendPlaybackKeys,
  appendStreamHeader,
  appendSingleStream,
  resetKeyFile,
  keyFilePath,
  formatTimestamp,
};
