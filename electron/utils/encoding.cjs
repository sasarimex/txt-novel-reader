const { TextDecoder } = require('node:util');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasUtf8Bom(buffer) {
  return buffer.length >= UTF8_BOM.length && buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
}

function decodeWithFatal(buffer, encoding) {
  return new TextDecoder(encoding, { fatal: true }).decode(buffer);
}

function assertDecodedTextIsUsable(text, encoding) {
  const replacementCount = [...text].filter((char) => char === '\uFFFD').length;
  const replacementRatio = text.length === 0 ? 0 : replacementCount / text.length;

  if (replacementRatio > 0.01) {
    throw new Error(`${encoding} decoded text contains too many replacement characters`);
  }
}

function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodeTextBuffer expects a Buffer');
  }

  if (buffer.length === 0) {
    return {
      encoding: 'empty',
      content: '',
    };
  }

  if (hasUtf8Bom(buffer)) {
    const content = decodeWithFatal(buffer.subarray(UTF8_BOM.length), 'utf-8');
    assertDecodedTextIsUsable(content, 'utf-8-bom');

    return {
      encoding: 'utf-8-bom',
      content,
    };
  }

  try {
    const content = decodeWithFatal(buffer, 'utf-8');
    assertDecodedTextIsUsable(content, 'utf-8');

    return {
      encoding: 'utf-8',
      content,
    };
  } catch {
    const content = decodeWithFatal(buffer, 'gb18030');
    assertDecodedTextIsUsable(content, 'gb18030');

    return {
      encoding: 'gb18030',
      content,
    };
  }
}

module.exports = {
  decodeTextBuffer,
  hasUtf8Bom,
};
