'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const MIN_MAJOR = 3;
const MIN_MINOR = 10;

const AUTO_CANDIDATES = ['py -3', 'py', 'python', 'python3'];

/** Prefer the Python that has `unidl` (often 3.11 while `py -3` is Store 3.12). */
const UNIDL_PYTHON_CANDIDATES = [
  () => process.env.KAYO_UNIDL_PYTHON,
  () => process.env.KAYO_PYTHON,
  () => pythonFromUnidlExeOnPath(),
  'python',
  'py -3.11',
  'py -3.10',
  'py -3',
  'py',
  'python3',
];

let cached = null;

function parsePythonCommand(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return { raw: parts.join(' '), command: parts[0], prefix: parts.slice(1) };
}

function probePython(raw) {
  const parsed = parsePythonCommand(raw);
  if (!parsed) return null;

  const result = spawnSync(
    parsed.command,
    [...parsed.prefix, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], 
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  if (result.status !== 0) return null;

  const version = String(result.stdout || '').trim();
  const [major, minor] = version.split('.').map(Number);
  if (major !== MIN_MAJOR || !Number.isFinite(minor) || minor < MIN_MINOR) return null;

  return { ...parsed, version };
}

function pythonHasModule(py, moduleName) {
  if (!py) return false;
  const result = spawnSync(
    py.command,
    [...py.prefix, '-c', `import ${moduleName}`],
    { encoding: 'utf8', timeout: 20000, windowsHide: true },
  );
  return result.status === 0;
}

/** Derive python.exe next to unidl.exe (…/Python311/Scripts/unidl.exe → …/python.exe). */
function pythonFromUnidlExeOnPath() {
  const result = spawnSync('where', ['unidl'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (result.status !== 0) return null;
  const line = String(result.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  const scriptsDir = path.dirname(line);
  const root = path.dirname(scriptsDir);
  const exe = path.join(root, 'python.exe');
  try {
    if (require('fs').existsSync(exe)) return exe;
  } catch {
    /* ignore */
  }
  return null;
}

function resolveUnidlPython() {
  for (const entry of UNIDL_PYTHON_CANDIDATES) {
    const raw = typeof entry === 'function' ? entry() : entry;
    if (!raw) continue;
    const hit = probePython(raw);
    if (hit && pythonHasModule(hit, 'unidl')) return hit;
  }
  throw new Error(
    'UniDL Python package not found. Your unidl.exe is on PATH but kayo_cmd needs the same Python '
    + '(e.g. set KAYO_UNIDL_PYTHON=C:\\Users\\you\\AppData\\Local\\Programs\\Python\\Python311\\python.exe '
    + 'or run: python -m pip install unidl). Or use KAYO_UNIDL=tui to launch the unidl app instead.',
  );
}

function resolvePython() {
  if (cached) return cached;

  if (process.env.KAYO_PYTHON) {
    const fromEnv = probePython(process.env.KAYO_PYTHON);
    if (fromEnv) {
      cached = fromEnv;
      return cached;
    }
    throw new Error(
      `KAYO_PYTHON is set to "${process.env.KAYO_PYTHON}" but Python ${MIN_MAJOR}.${MIN_MINOR}+ was not found. `
      + 'Install Python from https://www.python.org/downloads/ or fix KAYO_PYTHON in .env',
    );
  }

  for (const candidate of AUTO_CANDIDATES) {
    const hit = probePython(candidate);
    if (hit) {
      cached = hit;
      return cached;
    }
  }

  throw new Error(
    `Python ${MIN_MAJOR}.${MIN_MINOR}+ not found. Install from https://www.python.org/downloads/ `
    + '(check "Add python.exe to PATH"). On Windows, the "py" launcher is optional — "python" also works. '
    + 'Or set KAYO_PYTHON in .env (e.g. KAYO_PYTHON=python).',
  );
}

function pythonCommandArgs(suffixArgs, resolved = null) {
  const py = resolved || resolvePython();
  return { command: py.command, args: [...py.prefix, ...suffixArgs], python: py };
}

module.exports = {
  resolvePython,
  resolveUnidlPython,
  pythonCommandArgs,
  MIN_MAJOR,
  MIN_MINOR,
};
