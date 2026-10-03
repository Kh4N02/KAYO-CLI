#!/usr/bin/env node
'use strict';

const { ensureCmdDevices } = require('../lib/ensure-cmd-devices');

const copied = ensureCmdDevices();
if (copied.length) {
  console.log(`Device files copied to cmds/: ${copied.join(', ')}`);
}
