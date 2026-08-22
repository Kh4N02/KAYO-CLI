'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CMD_EXE = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

function ensureDir(dir) {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Open N_m3u8DL-RE in a new cmd.exe window (same as Kayo Jinx). */
function launchNm3u8DlCommand(command, { saveDir = null } = {}) {
  if (!command) {
    throw new Error('No download command to launch');
  }
  ensureDir(saveDir);
  const launch = `start "" "${CMD_EXE}" /k ${command}`;
  spawn(launch, { shell: true, detached: true, stdio: 'ignore' }).unref();
  return { cmdExe: CMD_EXE, saveDir };
}

module.exports = { launchNm3u8DlCommand, ensureDir };
