const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  deleteBook,
  ensureLibrary,
  getBook,
  getLibraryPaths,
  importTxtBook,
  listBooks,
  readBookRecords,
  reparseBookToc,
  updateBookBookmarks,
  updateBookProgress,
} = require('../electron/utils/books-store.cjs');

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moyu-library-'));

  try {
    const libraryDir = path.join(tempDir, 'library');
    const originalPath = path.join(tempDir, 'original.txt');
    await fs.writeFile(originalPath, '第一卷 风起\n\n第一章 少年出山\n中文内容正常显示', 'utf8');

    await ensureLibrary(libraryDir);
    const paths = getLibraryPaths(libraryDir);

    assert.equal(await exists(paths.libraryDir), true);
    assert.equal(await exists(paths.booksDir), true);
    assert.equal(await exists(paths.booksJsonPath), true);

    const imported = await importTxtBook(libraryDir, {
      originalPath,
      title: '测试小说',
      chapters: [
        { id: 'chapter-1', title: '第一章 少年出山', startIndex: 8, page: 1 },
      ],
      volumes: [
        { id: 'volume-1', title: '第一卷 风起', chapterIds: ['chapter-1'] },
      ],
      currentPage: 1,
      totalPages: 3,
      progress: 0,
      lastReadAt: null,
    });

    assert.equal(imported.title, '测试小说');
    assert.equal(imported.originalPath, originalPath);
    assert.notEqual(imported.filePath, originalPath);
    assert.equal(imported.content.includes('中文内容正常显示'), true);
    assert.equal(await exists(imported.filePath), true);
    assert.equal(await exists(originalPath), true);

    const records = await readBookRecords(libraryDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, imported.id);
    assert.equal(records[0].title, '测试小说');
    assert.equal(records[0].content, undefined);
    assert.equal(typeof records[0].contentPath, 'string');
    assert.equal(await exists(records[0].contentPath), true);
    assert.equal(records[0].chapters.length, 1);
    assert.equal(records[0].volumes.length, 1);
    assert.equal(records[0].tocParseVersion, 2);
    assert.equal(records[0].toc.length, 2);

    const listed = await listBooks(libraryDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].content, '');

    const opened = await getBook(libraryDir, imported.id);
    assert.equal(opened.content.includes('中文内容正常显示'), true);

    const updated = await updateBookProgress(libraryDir, {
      id: imported.id,
      currentPage: 2,
      totalPages: 3,
      position: 12,
      progress: 67,
      lastReadAt: '2026-05-28 12:00',
    });
    assert.equal(updated.currentPage, 2);
    assert.equal(updated.totalPages, 3);
    assert.equal(updated.position, 12);
    assert.equal(updated.progress, 67);
    assert.equal(updated.lastReadAt, '2026-05-28 12:00');

    const updatedRecords = await readBookRecords(libraryDir);
    assert.equal(updatedRecords[0].currentPage, 2);
    assert.equal(updatedRecords[0].totalPages, 3);
    assert.equal(updatedRecords[0].position, 12);
    assert.equal(updatedRecords[0].progress, 67);
    assert.equal(updatedRecords[0].lastReadAt, '2026-05-28 12:00');
    assert.equal(updatedRecords[0].content, undefined);

    const bookmark = {
      id: 'bookmark-1',
      bookId: imported.id,
      title: '第一章 少年出山',
      chapterTitle: '第一章 少年出山',
      pageIndex: 2,
      position: 6,
      previewText: '少年出山',
      createdAt: 1770000000000,
    };
    await updateBookBookmarks(libraryDir, {
      id: imported.id,
      bookmarks: [bookmark],
    });
    const bookmarkedRecords = await readBookRecords(libraryDir);
    assert.equal(bookmarkedRecords[0].bookmarks.length, 1);
    assert.equal(bookmarkedRecords[0].bookmarks[0].bookId, imported.id);

    const reparsed = await reparseBookToc(libraryDir, imported.id);
    assert.equal(reparsed.chapters.length, 1);
    assert.equal(reparsed.volumes.length, 1);

    await assert.rejects(
      () => importTxtBook(libraryDir, {
        originalPath,
        title: '测试小说',
        chapters: [],
        volumes: [],
        currentPage: 1,
        totalPages: 1,
        progress: 0,
        lastReadAt: null,
      }),
      (error) => error.code === 'DUPLICATE_TITLE',
    );

    const replacementPath = path.join(tempDir, 'replacement.txt');
    await fs.writeFile(replacementPath, '第一章 覆盖后的正文', 'utf8');
    const replaced = await importTxtBook(libraryDir, {
      originalPath: replacementPath,
      replaceBookId: imported.id,
      title: '测试小说',
      chapters: [
        { id: 'chapter-1', title: '第一章 覆盖后的正文', startIndex: 0, page: 1 },
      ],
      volumes: [],
      currentPage: 1,
      totalPages: 1,
      progress: 0,
      lastReadAt: null,
    });

    assert.equal(replaced.id, imported.id);
    assert.equal(replaced.progress, 0);
    assert.equal(replaced.currentPage, 1);
    assert.equal(replaced.lastReadAt, null);
    assert.equal(replaced.content.includes('覆盖后的正文'), true);
    assert.equal(await exists(replacementPath), true);
    assert.equal((await readBookRecords(libraryDir)).length, 1);

    const deleted = await deleteBook(libraryDir, replaced.id);
    assert.equal(deleted, true);
    assert.equal(await exists(originalPath), true);
    assert.equal(await exists(replacementPath), true);
    assert.equal(await exists(replaced.filePath), false);
    assert.equal((await readBookRecords(libraryDir)).length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

run()
  .then(() => {
    console.log('Books store tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
