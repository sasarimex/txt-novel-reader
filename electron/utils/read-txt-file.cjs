const fs = require('node:fs/promises');
const path = require('node:path');
const { decodeTextBuffer } = require('./encoding.cjs');

class TxtFileReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TxtFileReadError';
    this.code = code;
  }
}

async function readTxtFile(filePath) {
  const stats = await fs.stat(filePath);

  if (stats.size === 0) {
    throw new TxtFileReadError('EMPTY_FILE', '选择的 TXT 文件为空，无法导入。');
  }

  const buffer = await fs.readFile(filePath);
  let decoded;

  try {
    decoded = decodeTextBuffer(buffer);
  } catch {
    throw new TxtFileReadError(
      'DECODE_FAILED',
      'TXT 文件编码识别失败，暂时只支持 UTF-8、UTF-8 BOM、GBK/GB18030。',
    );
  }

  if (!decoded.content.trim()) {
    throw new TxtFileReadError('EMPTY_CONTENT', '选择的 TXT 文件没有可阅读的文本内容。');
  }

  return {
    fileName: path.basename(filePath),
    filePath,
    fileSize: stats.size,
    extension: path.extname(filePath).toLowerCase(),
    encoding: decoded.encoding,
    content: decoded.content,
    totalChars: decoded.content.length,
    textCharCount: decoded.content.replace(/\s/g, '').length,
  };
}

module.exports = {
  TxtFileReadError,
  readTxtFile,
};
