const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const outputDir = packageJson.build?.directories?.output || 'release';
const productName = packageJson.build?.productName || packageJson.productName || packageJson.name;
const exePath = path.join(rootDir, outputDir, 'win-unpacked', `${productName}.exe`);
const iconPath = path.join(rootDir, 'assets', 'app.ico');

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function findRcedit() {
  if (process.env.RCEDIT_PATH && fs.existsSync(process.env.RCEDIT_PATH)) {
    return process.env.RCEDIT_PATH;
  }

  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign'
  );

  if (!fs.existsSync(cacheRoot)) {
    return null;
  }

  const candidates = [];
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(cacheRoot, entry.name, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) {
      candidates.push({
        path: candidate,
        mtimeMs: fs.statSync(candidate).mtimeMs,
      });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path || null;
}

assertFile(exePath, 'Windows executable');
assertFile(iconPath, 'Windows icon');

const rceditPath = findRcedit();
if (!rceditPath) {
  throw new Error(
    'rcedit-x64.exe was not found. Run electron-builder once so it downloads winCodeSign, ' +
      'or set RCEDIT_PATH to a local rcedit-x64.exe path.'
  );
}

const result = spawnSync(
  rceditPath,
  [
    exePath,
    '--set-icon',
    iconPath,
    '--set-version-string',
    'FileDescription',
    productName,
    '--set-version-string',
    'ProductName',
    productName,
    '--set-version-string',
    'InternalName',
    `${productName}.exe`,
    '--set-version-string',
    'OriginalFilename',
    `${productName}.exe`,
  ],
  { stdio: 'inherit' }
);

if (result.status !== 0) {
  throw new Error(`rcedit failed with exit code ${result.status}`);
}

console.log(`Updated Windows exe icon: ${exePath}`);
