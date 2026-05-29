const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readTxtFile } = require('./read-txt-file.cjs');
const { CURRENT_TOC_PARSE_VERSION, parseChapters } = require('./parse-chapters.cjs');

const BOOKS_JSON = 'books.json';
const BOOK_FILES_DIR = 'books';
const SOURCE_FILE_NAME = 'source.txt';
const CONTENT_CACHE_FILE_NAME = 'content.txt';

class LibraryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}

function getLibraryPaths(libraryDir) {
  return {
    libraryDir,
    booksJsonPath: path.join(libraryDir, BOOKS_JSON),
    booksDir: path.join(libraryDir, BOOK_FILES_DIR),
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(parentDir, targetPath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertTxtFilePath(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.txt') {
    throw new LibraryError('INVALID_FILE_TYPE', '只能导入 .txt 文件。');
  }
}

async function ensureLibrary(libraryDir) {
  const paths = getLibraryPaths(libraryDir);
  await fs.mkdir(paths.booksDir, { recursive: true });

  if (!(await pathExists(paths.booksJsonPath))) {
    await writeBookRecords(libraryDir, []);
  }

  return paths;
}

async function readBookRecords(libraryDir) {
  const paths = await ensureLibrary(libraryDir);

  try {
    const raw = await fs.readFile(paths.booksJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function writeBookRecords(libraryDir, records) {
  const paths = getLibraryPaths(libraryDir);
  await fs.mkdir(paths.libraryDir, { recursive: true });
  await fs.mkdir(paths.booksDir, { recursive: true });

  const tempPath = `${paths.booksJsonPath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, paths.booksJsonPath);
}

function getNowString() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join(':');

  return `${date} ${time}`;
}

function createBookId() {
  return `book-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function createBookmarkId() {
  return `bookmark-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function getTitleFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function getManagedBookDir(paths, bookId) {
  const bookDir = path.join(paths.booksDir, bookId);
  if (!isPathInside(paths.booksDir, bookDir)) {
    throw new LibraryError('INVALID_BOOK_PATH', '书籍缓存路径非法。');
  }
  return bookDir;
}

function buildTocCache(content) {
  const parsedCatalog = parseChapters(content);
  const nonWhitespaceCharCount = content.replace(/\s/g, '').length;

  return {
    chapters: parsedCatalog.chapters,
    volumes: parsedCatalog.volumes,
    toc: parsedCatalog.toc,
    tocParseVersion: CURRENT_TOC_PARSE_VERSION,
    totalChars: content.length,
    textCharCount: nonWhitespaceCharCount,
    nonWhitespaceCharCount,
  };
}

async function writeContentCache(contentPath, content) {
  await fs.mkdir(path.dirname(contentPath), { recursive: true });
  await fs.writeFile(contentPath, content, 'utf8');
}

async function readCachedContent(record) {
  if (record.contentPath && await pathExists(record.contentPath)) {
    return fs.readFile(record.contentPath, 'utf8');
  }

  if (record.filePath && await pathExists(record.filePath)) {
    const txtFile = await readTxtFile(record.filePath);
    return txtFile.content;
  }

  return '';
}

function needsTocMigration(record) {
  return (
    record.tocParseVersion !== CURRENT_TOC_PARSE_VERSION ||
    !Array.isArray(record.chapters) ||
    !Array.isArray(record.volumes) ||
    !Array.isArray(record.toc) ||
    typeof record.totalChars !== 'number' ||
    typeof record.textCharCount !== 'number' ||
    typeof record.nonWhitespaceCharCount !== 'number'
  );
}

async function hydrateBookRecord(libraryDir, record) {
  const paths = await ensureLibrary(libraryDir);
  const bookDir = getManagedBookDir(paths, record.id);
  const contentPath = record.contentPath || path.join(bookDir, CONTENT_CACHE_FILE_NAME);
  let nextRecord = { ...record, contentPath };
  let content = '';
  let changed = record.contentPath !== contentPath;

  try {
    content = await readCachedContent(nextRecord);

    if (content && !(await pathExists(contentPath))) {
      await writeContentCache(contentPath, content);
      changed = true;
    }

    if (content && needsTocMigration(nextRecord)) {
      nextRecord = {
        ...nextRecord,
        ...buildTocCache(content),
      };
      changed = true;
    }
  } catch {
    content = '';
  }

  return {
    record: nextRecord,
    book: {
      ...nextRecord,
      content,
      bookmarks: Array.isArray(nextRecord.bookmarks) ? nextRecord.bookmarks : [],
    },
    changed,
  };
}

async function listBooks(libraryDir) {
  const records = await readBookRecords(libraryDir);
  return records.map((record) => ({
    ...record,
    content: '',
    bookmarks: Array.isArray(record.bookmarks) ? record.bookmarks : [],
  }));
}

async function getBook(libraryDir, bookId) {
  const records = await readBookRecords(libraryDir);
  const index = records.findIndex((record) => record.id === bookId);

  if (index === -1) {
    return null;
  }

  const hydrated = await hydrateBookRecord(libraryDir, records[index]);

  if (hydrated.changed) {
    records[index] = hydrated.record;
    await writeBookRecords(libraryDir, records);
  }

  return hydrated.book;
}

async function importTxtBook(libraryDir, input) {
  if (!input?.originalPath) {
    throw new LibraryError('INVALID_INPUT', '缺少要导入的 TXT 文件路径。');
  }

  assertTxtFilePath(input.originalPath);

  const txtFile = await readTxtFile(input.originalPath);
  const paths = await ensureLibrary(libraryDir);
  const records = await readBookRecords(libraryDir);
  const title = input.title || getTitleFromPath(input.originalPath);
  const replaceIndex = input.replaceBookId
    ? records.findIndex((record) => record.id === input.replaceBookId)
    : -1;

  if (input.replaceBookId && replaceIndex === -1) {
    throw new LibraryError('BOOK_NOT_FOUND', '要覆盖的书籍不存在。');
  }

  const duplicate = records.find((record) => record.title === title && record.id !== input.replaceBookId);

  if (duplicate) {
    throw new LibraryError('DUPLICATE_TITLE', `书架中已存在《${title}》。`);
  }

  const existingRecord = replaceIndex >= 0 ? records[replaceIndex] : null;
  const id = existingRecord?.id || createBookId();
  const bookDir = getManagedBookDir(paths, id);
  const copiedPath = path.join(bookDir, SOURCE_FILE_NAME);
  const contentPath = path.join(bookDir, CONTENT_CACHE_FILE_NAME);
  const now = getNowString();
  const tocCache = buildTocCache(txtFile.content);

  await fs.mkdir(bookDir, { recursive: true });
  await fs.copyFile(input.originalPath, copiedPath);
  await writeContentCache(contentPath, txtFile.content);

  const record = {
    id,
    title,
    filePath: copiedPath,
    contentPath,
    originalPath: input.originalPath,
    encoding: txtFile.encoding,
    totalChars: tocCache.totalChars,
    textCharCount: tocCache.textCharCount,
    nonWhitespaceCharCount: tocCache.nonWhitespaceCharCount,
    chapters: tocCache.chapters,
    volumes: tocCache.volumes,
    toc: tocCache.toc,
    tocParseVersion: tocCache.tocParseVersion,
    bookmarks: [],
    currentPage: 1,
    totalPages: Number.isFinite(input.totalPages) ? input.totalPages : 1,
    position: 0,
    progress: 0,
    lastReadAt: null,
    importedAt: Date.now(),
    createdAt: existingRecord?.createdAt || now,
    updatedAt: now,
  };

  if (replaceIndex >= 0) {
    records[replaceIndex] = record;
  } else {
    records.unshift(record);
  }

  await writeBookRecords(libraryDir, records);

  return {
    ...record,
    content: txtFile.content,
  };
}

async function deleteBook(libraryDir, bookId) {
  const paths = await ensureLibrary(libraryDir);
  const records = await readBookRecords(libraryDir);
  const target = records.find((record) => record.id === bookId);

  if (!target) {
    return false;
  }

  const nextRecords = records.filter((record) => record.id !== bookId);
  await writeBookRecords(libraryDir, nextRecords);

  const managedBookDir = path.dirname(target.filePath || path.join(paths.booksDir, bookId, SOURCE_FILE_NAME));
  if (isPathInside(paths.booksDir, managedBookDir)) {
    await fs.rm(managedBookDir, { recursive: true, force: true });
  }

  return true;
}

async function updateBookProgress(libraryDir, input) {
  const records = await readBookRecords(libraryDir);
  const index = records.findIndex((record) => record.id === input?.id);

  if (index === -1) {
    return null;
  }

  const now = getNowString();
  records[index] = {
    ...records[index],
    currentPage: Number.isFinite(input.currentPage) ? input.currentPage : records[index].currentPage,
    totalPages: Number.isFinite(input.totalPages) ? input.totalPages : records[index].totalPages,
    position: Number.isFinite(input.position) ? Math.max(0, Math.floor(input.position)) : records[index].position,
    progress: Number.isFinite(input.progress) ? input.progress : records[index].progress,
    lastReadAt: input.lastReadAt ?? records[index].lastReadAt,
    updatedAt: now,
  };

  await writeBookRecords(libraryDir, records);
  return {
    ...records[index],
    content: '',
  };
}

function normalizeBookmark(bookId, bookmark) {
  const now = Date.now();
  const pageIndex = Number.isFinite(bookmark.pageIndex) ? Math.max(1, Math.floor(bookmark.pageIndex)) : undefined;
  const position = Number.isFinite(bookmark.position) ? Math.max(0, Math.floor(bookmark.position)) : undefined;

  return {
    id: typeof bookmark.id === 'string' && bookmark.id ? bookmark.id : createBookmarkId(),
    bookId,
    title: String(bookmark.title || '书签').slice(0, 80),
    chapterTitle: bookmark.chapterTitle ? String(bookmark.chapterTitle).slice(0, 80) : undefined,
    pageIndex,
    position,
    previewText: bookmark.previewText ? String(bookmark.previewText).slice(0, 120) : '',
    createdAt: Number.isFinite(bookmark.createdAt) ? bookmark.createdAt : now,
  };
}

async function updateBookBookmarks(libraryDir, input) {
  const records = await readBookRecords(libraryDir);
  const index = records.findIndex((record) => record.id === input?.id);

  if (index === -1) {
    return null;
  }

  const bookmarks = Array.isArray(input.bookmarks)
    ? input.bookmarks.slice(0, 500).map((bookmark) => normalizeBookmark(input.id, bookmark))
    : [];

  records[index] = {
    ...records[index],
    bookmarks,
    updatedAt: getNowString(),
  };

  await writeBookRecords(libraryDir, records);
  return {
    ...records[index],
    content: '',
  };
}

async function reparseBookToc(libraryDir, bookId) {
  const records = await readBookRecords(libraryDir);
  const index = records.findIndex((record) => record.id === bookId);

  if (index === -1) {
    return null;
  }

  const content = await readCachedContent(records[index]);
  if (!content.trim()) {
    throw new LibraryError('EMPTY_CONTENT', '当前书籍没有可重新识别的正文内容。');
  }

  records[index] = {
    ...records[index],
    ...buildTocCache(content),
    updatedAt: getNowString(),
  };

  await writeBookRecords(libraryDir, records);
  return {
    ...records[index],
    content,
    bookmarks: Array.isArray(records[index].bookmarks) ? records[index].bookmarks : [],
  };
}

module.exports = {
  CURRENT_TOC_PARSE_VERSION,
  deleteBook,
  ensureLibrary,
  getLibraryPaths,
  getBook,
  importTxtBook,
  listBooks,
  readBookRecords,
  reparseBookToc,
  updateBookBookmarks,
  updateBookProgress,
  writeBookRecords,
};
