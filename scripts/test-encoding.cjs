const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { decodeTextBuffer } = require('../electron/utils/encoding.cjs');
const { readTxtFile } = require('../electron/utils/read-txt-file.cjs');

const utf8 = decodeTextBuffer(Buffer.from('第一章 你好，摸鱼阅读', 'utf8'));
assert.equal(utf8.encoding, 'utf-8');
assert.equal(utf8.content, '第一章 你好，摸鱼阅读');
assert.equal(utf8.content.length, 11);

const utf8Bom = decodeTextBuffer(Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('第一章 BOM 测试', 'utf8'),
]));
assert.equal(utf8Bom.encoding, 'utf-8-bom');
assert.equal(utf8Bom.content.charCodeAt(0), '第'.charCodeAt(0));
assert.equal(utf8Bom.content.includes('\uFEFF'), false);

const gbkBytes = Buffer.from([
  0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xc4, 0xe3, 0xba, 0xc3,
]);
const gb18030 = decodeTextBuffer(gbkBytes);
assert.equal(gb18030.encoding, 'gb18030');
assert.equal(gb18030.content, '第一章 你好');

const empty = decodeTextBuffer(Buffer.alloc(0));
assert.equal(empty.encoding, 'empty');
assert.equal(empty.content, '');

async function runFileReadTests() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moyu-reader-'));

  try {
    const utf8Path = path.join(tempDir, 'utf8.txt');
    await fs.writeFile(utf8Path, '第一章 UTF-8 文件\n中文内容正常显示', 'utf8');
    const utf8File = await readTxtFile(utf8Path);
    assert.equal(utf8File.encoding, 'utf-8');
    assert.equal(utf8File.fileName, 'utf8.txt');
    assert.equal(utf8File.content.includes('中文内容正常显示'), true);
    assert.equal(utf8File.totalChars, utf8File.content.length);

    const bomPath = path.join(tempDir, 'bom.txt');
    await fs.writeFile(bomPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('第一章 BOM 文件\n开头没有异常字符', 'utf8'),
    ]));
    const bomFile = await readTxtFile(bomPath);
    assert.equal(bomFile.encoding, 'utf-8-bom');
    assert.equal(bomFile.content.charCodeAt(0), '第'.charCodeAt(0));
    assert.equal(bomFile.content.includes('\uFEFF'), false);

    const gbkPath = path.join(tempDir, 'gbk.txt');
    await fs.writeFile(gbkPath, Buffer.from([
      0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xc4, 0xe3, 0xba, 0xc3,
    ]));
    const gbkFile = await readTxtFile(gbkPath);
    assert.equal(gbkFile.encoding, 'gb18030');
    assert.equal(gbkFile.content, '第一章 你好');

    const emptyPath = path.join(tempDir, 'empty.txt');
    await fs.writeFile(emptyPath, Buffer.alloc(0));
    await assert.rejects(
      () => readTxtFile(emptyPath),
      (error) => error.code === 'EMPTY_FILE' && error.message.includes('为空'),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

runFileReadTests()
  .then(() => {
    console.log('Encoding tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
