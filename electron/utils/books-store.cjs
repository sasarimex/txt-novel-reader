const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readTxtFile } = require('./read-txt-file.cjs');
const { CURRENT_TOC_PARSE_VERSION, parseChapters } = require('./parse-chapters.cjs');

const BOOKS_JSON = 'books.json';
const CATEGORIES_JSON = 'categories.json';
const BOOK_FILES_DIR = 'books';
const SOURCE_FILE_NAME = 'source.txt';
const CONTENT_CACHE_FILE_NAME = 'content.txt';
const MAX_TITLE_LEN = 120;
const MAX_AUTHOR_LEN = 60;
const MAX_NOTE_LEN = 500;
const MAX_CATEGORY_NAME_LEN = 30;

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
    categoriesJsonPath: path.join(libraryDir, CATEGORIES_JSON),
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

function timestampForBackup() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// 解析失败时，把损坏文件原样备份成 <文件名>.corrupted-backup-YYYYMMDD-HHMMSS.json，
// 然后再按顺序回退到 <文件名>.bak / 空数组。原始损坏文件永远不被覆盖。
async function safeReadJsonFile(filePath, fallback) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: fallback, recovered: false, source: 'missing' };
    throw error;
  }

  try {
    return { value: JSON.parse(raw), recovered: false, source: 'primary' };
  } catch (error) {
    console.error(`[books-store] JSON parse failed for ${filePath}:`, error.message);
    try {
      const backupPath = `${filePath}.corrupted-backup-${timestampForBackup()}.json`;
      await fs.copyFile(filePath, backupPath);
      console.error(`[books-store] Corrupted file preserved at ${backupPath}`);
    } catch (copyError) {
      console.error('[books-store] Failed to write corrupted backup:', copyError.message);
    }

    // 尝试回滚到最近一次有效备份。
    const bakPath = `${filePath}.bak`;
    try {
      const bakRaw = await fs.readFile(bakPath, 'utf8');
      const parsed = JSON.parse(bakRaw);
      console.warn(`[books-store] Recovered from ${bakPath}`);
      return { value: parsed, recovered: true, source: 'bak' };
    } catch (bakError) {
      if (bakError?.code !== 'ENOENT') {
        console.error('[books-store] Bak read failed:', bakError.message);
      }
    }

    // 最后一根稻草：返回 fallback。损坏的原文件还在 .corrupted-backup-* 里。
    console.warn(`[books-store] Falling back to empty value for ${filePath}`);
    return { value: fallback, recovered: true, source: 'fallback' };
  }
}

// 串行化每个 JSON 文件的写入：同一个 path 上的多次 atomicWrite 排队，避免并发写互相清洗 .tmp。
const writeQueues = new Map();
async function withWriteLock(filePath, fn) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  writeQueues.set(filePath, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  }
}

// 原子写入：写入 PID + RNG 命名的 tmp（多进程 / 多 promise 同名也不会撞），重新读回来 JSON.parse 校验，
// 验证通过后把旧文件复制成 .bak，最后 rename tmp → 正式文件。任何一步失败都不会破坏正式文件。
async function atomicWriteJson(filePath, value) {
  return withWriteLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const tempPath = `${filePath}.tmp.${tag}`;

    try {
      await fs.writeFile(tempPath, serialized, 'utf8');
      // 立刻读回来 parse 一遍。任何转义 / 截断异常在这里就能挡掉，避免写入磁盘上的损坏文件。
      const verify = await fs.readFile(tempPath, 'utf8');
      JSON.parse(verify);

      // 旋转 .bak：旧正式文件存为 .bak，给以后做恢复用。.bak 写失败不阻塞主流程。
      try {
        await fs.copyFile(filePath, `${filePath}.bak`);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.error('[books-store] Failed to rotate .bak:', error.message);
        }
      }

      await fs.rename(tempPath, filePath);
    } catch (error) {
      // 失败时尽量清理 tmp，不要留垃圾。
      try { await fs.unlink(tempPath); } catch {}
      throw error;
    }
  });
}

async function readBookRecords(libraryDir) {
  const paths = await ensureLibrary(libraryDir);
  const result = await safeReadJsonFile(paths.booksJsonPath, []);
  return Array.isArray(result.value) ? result.value : [];
}

async function writeBookRecords(libraryDir, records) {
  const paths = getLibraryPaths(libraryDir);
  await fs.mkdir(paths.libraryDir, { recursive: true });
  await fs.mkdir(paths.booksDir, { recursive: true });
  await atomicWriteJson(paths.booksJsonPath, records);
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

function createBookHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
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

    if (content && !nextRecord.bookHash) {
      nextRecord = {
        ...nextRecord,
        bookHash: createBookHash(content),
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
      author: typeof nextRecord.author === 'string' ? nextRecord.author : '',
      note: typeof nextRecord.note === 'string' ? nextRecord.note : '',
      categoryId: nextRecord.categoryId === undefined ? null : nextRecord.categoryId,
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
    author: typeof record.author === 'string' ? record.author : '',
    note: typeof record.note === 'string' ? record.note : '',
    categoryId: record.categoryId === undefined ? null : record.categoryId,
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
  const bookHash = createBookHash(txtFile.content);
  const replaceIndex = input.replaceBookId
    ? records.findIndex((record) => record.id === input.replaceBookId)
    : -1;

  if (input.replaceBookId && replaceIndex === -1) {
    throw new LibraryError('BOOK_NOT_FOUND', '要覆盖的书籍不存在。');
  }

  const duplicate = records.find((record) => record.bookHash === bookHash && record.id !== input.replaceBookId);

  if (duplicate) {
    throw new LibraryError('DUPLICATE_BOOK_HASH', `书架中已存在相同内容的 TXT：《${duplicate.title}》。`);
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

  // 覆盖导入时保留旧的 author / note / categoryId（用户已经编辑过的元数据不应被改名而丢失）。
  const preservedAuthor = existingRecord && typeof existingRecord.author === 'string' ? existingRecord.author : '';
  const preservedNote = existingRecord && typeof existingRecord.note === 'string' ? existingRecord.note : '';
  const preservedCategoryId = existingRecord && existingRecord.categoryId !== undefined ? existingRecord.categoryId : null;

  const record = {
    id,
    bookHash,
    title,
    author: typeof input.author === 'string' ? sanitizeText(input.author, MAX_AUTHOR_LEN).trim() : preservedAuthor,
    note: typeof input.note === 'string' ? sanitizeText(input.note, MAX_NOTE_LEN) : preservedNote,
    categoryId: input.categoryId === undefined ? preservedCategoryId : (input.categoryId || null),
    filePath: copiedPath,
    contentPath,
    originalPath: input.originalPath,
    fileSize: txtFile.fileSize,
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

function sanitizeText(value, maxLen) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, maxLen);
}

async function updateBookMeta(libraryDir, input) {
  if (!input?.id) {
    throw new LibraryError('INVALID_INPUT', '缺少书籍 ID。');
  }

  const records = await readBookRecords(libraryDir);
  const index = records.findIndex((record) => record.id === input.id);

  if (index === -1) {
    throw new LibraryError('BOOK_NOT_FOUND', '书籍不存在。');
  }

  // 只覆盖元数据：title / author / note / categoryId。不动 bookHash、原文、章节、书签、进度。
  const next = { ...records[index] };

  if (typeof input.title === 'string') {
    const title = sanitizeText(input.title, MAX_TITLE_LEN).trim();
    if (!title) {
      throw new LibraryError('INVALID_TITLE', '书名不能为空。');
    }
    next.title = title;
  }
  if (input.author !== undefined) {
    next.author = sanitizeText(input.author, MAX_AUTHOR_LEN).trim() || '';
  }
  if (input.note !== undefined) {
    next.note = sanitizeText(input.note, MAX_NOTE_LEN);
  }
  if (input.categoryId !== undefined) {
    next.categoryId = input.categoryId === null || input.categoryId === ''
      ? null
      : String(input.categoryId).slice(0, 64);
  }

  next.updatedAt = getNowString();
  records[index] = next;
  await writeBookRecords(libraryDir, records);

  return {
    ...next,
    content: '',
    bookmarks: Array.isArray(next.bookmarks) ? next.bookmarks : [],
  };
}

// 分类：本地 JSON 文件管理，跟 books.json 平级。读写都走原子 + 容错路径。
async function readCategories(libraryDir) {
  const paths = await ensureLibrary(libraryDir);
  const result = await safeReadJsonFile(paths.categoriesJsonPath, []);
  return Array.isArray(result.value) ? result.value : [];
}

async function writeCategories(libraryDir, categories) {
  const paths = getLibraryPaths(libraryDir);
  await fs.mkdir(paths.libraryDir, { recursive: true });
  await atomicWriteJson(paths.categoriesJsonPath, categories);
}

function createCategoryId() {
  return `cat-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeCategoryName(name) {
  return sanitizeText(name, MAX_CATEGORY_NAME_LEN).trim();
}

// 归一化 sortOrder：旧数据没有这字段时按数组下标回填，保证 listCategories 输出永远稳定有序。
function normalizeCategoryList(rawList) {
  return rawList.map((category, index) => ({
    id: String(category.id),
    name: String(category.name || ''),
    sortOrder: Number.isFinite(category.sortOrder) ? Math.floor(category.sortOrder) : index,
    createdAt: Number.isFinite(category.createdAt) ? category.createdAt : Date.now(),
    updatedAt: Number.isFinite(category.updatedAt) ? category.updatedAt : Date.now(),
  }));
}

async function listCategories(libraryDir) {
  const categories = await readCategories(libraryDir);
  const normalized = normalizeCategoryList(categories);
  // 按 sortOrder 升序输出；sortOrder 相同时按 createdAt 升序兜底。
  normalized.sort((a, b) => (a.sortOrder - b.sortOrder) || (a.createdAt - b.createdAt));
  return normalized;
}

async function createCategory(libraryDir, input) {
  const name = normalizeCategoryName(input?.name);
  if (!name) {
    throw new LibraryError('INVALID_CATEGORY_NAME', '分类名称不能为空。');
  }
  const categories = normalizeCategoryList(await readCategories(libraryDir));
  if (categories.some((category) => category.name === name)) {
    throw new LibraryError('DUPLICATE_CATEGORY', `已存在同名分类「${name}」。`);
  }
  const now = Date.now();
  // 新分类排到列表末尾。
  const nextOrder = categories.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;
  const category = {
    id: createCategoryId(),
    name,
    sortOrder: nextOrder,
    createdAt: now,
    updatedAt: now,
  };
  categories.push(category);
  await writeCategories(libraryDir, categories);
  return category;
}

// 接收用户指定的「自定义分类 id 顺序数组」，重写 sortOrder。
// 未出现在 orderedIds 中的分类保持原 sortOrder（追加在末尾）。
async function reorderCategories(libraryDir, orderedIds) {
  if (!Array.isArray(orderedIds)) {
    throw new LibraryError('INVALID_INPUT', '缺少分类顺序列表。');
  }
  const categories = normalizeCategoryList(await readCategories(libraryDir));
  const idToCategory = new Map(categories.map((c) => [c.id, c]));
  const orderedSet = new Set();
  let nextOrder = 0;
  const now = Date.now();
  const result = [];

  for (const id of orderedIds) {
    const category = idToCategory.get(String(id));
    if (!category || orderedSet.has(category.id)) continue;
    orderedSet.add(category.id);
    result.push({ ...category, sortOrder: nextOrder, updatedAt: now });
    nextOrder += 1;
  }
  // 没在 orderedIds 中提及的分类追加在末尾，保持相对顺序。
  for (const category of categories) {
    if (orderedSet.has(category.id)) continue;
    result.push({ ...category, sortOrder: nextOrder });
    nextOrder += 1;
  }

  await writeCategories(libraryDir, result);
  return result;
}

async function renameCategory(libraryDir, input) {
  if (!input?.id) {
    throw new LibraryError('INVALID_INPUT', '缺少分类 ID。');
  }
  const name = normalizeCategoryName(input.name);
  if (!name) {
    throw new LibraryError('INVALID_CATEGORY_NAME', '分类名称不能为空。');
  }
  const categories = normalizeCategoryList(await readCategories(libraryDir));
  const index = categories.findIndex((category) => category.id === input.id);
  if (index === -1) {
    throw new LibraryError('CATEGORY_NOT_FOUND', '分类不存在。');
  }
  if (categories.some((category) => category.id !== input.id && category.name === name)) {
    throw new LibraryError('DUPLICATE_CATEGORY', `已存在同名分类「${name}」。`);
  }
  const now = Date.now();
  categories[index] = { ...categories[index], name, updatedAt: now };
  await writeCategories(libraryDir, categories);
  return categories[index];
}

async function deleteCategory(libraryDir, categoryId) {
  if (!categoryId) {
    throw new LibraryError('INVALID_INPUT', '缺少分类 ID。');
  }
  const categories = await readCategories(libraryDir);
  const next = categories.filter((category) => category.id !== categoryId);
  if (next.length === categories.length) {
    // 不存在视为成功（幂等）。
    return { ok: true, movedBooks: 0 };
  }
  await writeCategories(libraryDir, next);

  // 把属于该分类的书籍 categoryId 置空（视为未分类）。
  const books = await readBookRecords(libraryDir);
  let moved = 0;
  for (let i = 0; i < books.length; i += 1) {
    if (books[i].categoryId === categoryId) {
      books[i] = { ...books[i], categoryId: null, updatedAt: getNowString() };
      moved += 1;
    }
  }
  if (moved > 0) {
    await writeBookRecords(libraryDir, books);
  }
  return { ok: true, movedBooks: moved };
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
  createBookHash,
  createCategory,
  deleteBook,
  deleteCategory,
  ensureLibrary,
  getLibraryPaths,
  getBook,
  importTxtBook,
  listBooks,
  listCategories,
  readBookRecords,
  renameCategory,
  reorderCategories,
  reparseBookToc,
  updateBookBookmarks,
  updateBookMeta,
  updateBookProgress,
  writeBookRecords,
};
