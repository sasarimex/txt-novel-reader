const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const file = path.join(os.homedir(), 'AppData', 'Roaming', '摸鱼阅读', 'library', 'books.json');
const raw = fs.readFileSync(file, 'utf8');
const data = JSON.parse(raw);
console.log('Records:', data.length);
data.forEach((b, i) => {
  console.log(`  [${i}] title=${b.title} hash=${(b.bookHash || '').slice(0, 8)}... volumes=${(b.volumes || []).length} chapters=${(b.chapters || []).length} categoryId=${b.categoryId === undefined ? '(undef)' : b.categoryId}`);
});
