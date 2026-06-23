// One-shot repair: removes orphan numeric fragments (8-space indent + bare digits + ",) from books.json.
// Writes corrupted backup with timestamp, verifies repaired output parses, then atomically swaps in.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = path.join(os.homedir(), 'AppData', 'Roaming', '摸鱼阅读', 'library', 'books.json');
if (!fs.existsSync(target)) {
  console.error('No books.json at', target);
  process.exit(1);
}

const raw = fs.readFileSync(target, 'utf8');
let beforeOk = true;
try { JSON.parse(raw); } catch { beforeOk = false; }

if (beforeOk) {
  console.log('books.json already parses OK. No repair needed.');
  process.exit(0);
}

// 1. Save corrupted-backup with timestamp.
const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
const corruptedBackup = `${target}.corrupted-backup-${stamp}.json`;
fs.copyFileSync(target, corruptedBackup);
console.log('Corrupted backup saved:', corruptedBackup);

// 2. Repair: drop lines matching `\n {8}\d+",\n` (orphan numeric tail).
//    These can only have come from a partially-overwritten chapter-id array element.
const repaired = raw.replace(/\n {8}\d+",\n/g, '\n');

// 3. Verify repaired parses.
let parsed;
try {
  parsed = JSON.parse(repaired);
} catch (e) {
  console.error('Repair did not produce valid JSON:', e.message);
  console.error('Original is preserved at', corruptedBackup);
  process.exit(1);
}

const recordCount = Array.isArray(parsed) ? parsed.length : -1;
console.log(`Repaired JSON has ${recordCount} records.`);

// 4. Atomic write: temp file -> rename. Also rotate previous file to .bak.
const tempPath = `${target}.tmp`;
const bakPath = `${target}.bak`;
fs.writeFileSync(tempPath, repaired, 'utf8');

// Sanity check the temp file before swapping.
const verifyRaw = fs.readFileSync(tempPath, 'utf8');
JSON.parse(verifyRaw);

if (fs.existsSync(target)) {
  fs.copyFileSync(target, bakPath);
}
fs.renameSync(tempPath, target);

console.log('Repaired books.json in place. Previous corrupted file at:');
console.log('  ', corruptedBackup);
console.log('  ', bakPath, '(.bak rotation)');
