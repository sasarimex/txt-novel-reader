const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = path.join(os.homedir(), 'AppData', 'Roaming', '摸鱼阅读', 'library', 'books.json');
const raw = fs.readFileSync(target, 'utf8');

// Find all "orphan numeric fragments" — lines that look like `\n        DIGITS",\n` with NO opening quote.
// Legitimate chapter-id lines look like `\n          "chapter-NNNN",\n` (10 spaces of indent, leading quote).
const orphan = /\n {8}\d+",\n/g;
const matches = [];
let m;
while ((m = orphan.exec(raw)) !== null) {
  matches.push({ idx: m.index, txt: m[0] });
}
console.log('Orphan fragments found:', matches.length);
matches.slice(0, 20).forEach((it) => console.log(it.idx, JSON.stringify(it.txt)));

// Also look for embedded fragments that aren't separated by newline at all, like `... "chapter-1556",        556",`.
const embed = /,\n {8}\d+",/g;
const eMatches = [];
while ((m = embed.exec(raw)) !== null) {
  eMatches.push({ idx: m.index, txt: m[0] });
}
console.log('Embed-style fragments:', eMatches.length);

// Try parsing after removing all orphan-pattern lines.
const repaired = raw.replace(/\n {8}\d+",\n/g, '\n');
try {
  const data = JSON.parse(repaired);
  console.log('Repaired parses OK. Records count:', Array.isArray(data) ? data.length : 'not an array');
  console.log('Size delta:', raw.length - repaired.length, 'chars removed');
  fs.writeFileSync(path.join(__dirname, '..', 'scripts', '_repaired-preview.json'), repaired, 'utf8');
  console.log('Preview written to scripts/_repaired-preview.json');
} catch (e) {
  console.log('Repaired still fails:', e.message);
}
