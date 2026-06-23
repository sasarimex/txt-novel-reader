const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('node:path');
const {
  createBookHash,
  createCategory,
  deleteBook,
  deleteCategory,
  ensureLibrary,
  getBook,
  importTxtBook,
  listBooks,
  listCategories,
  renameCategory,
  reorderCategories,
  reparseBookToc,
  updateBookBookmarks,
  updateBookMeta,
  updateBookProgress,
} = require('./utils/books-store.cjs');
const { readTxtFile } = require('./utils/read-txt-file.cjs');

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
// When packaged with asar, assets/app.ico is in app.asar.unpacked next to app.asar.
// Resolve to whichever copy actually exists so BrowserWindow.icon works in dev, dir-build, and asar.
function resolveAppIconPath() {
  const inAsarPath = path.join(__dirname, '..', 'assets', 'app.ico');
  const unpackedPath = inAsarPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  try {
    if (require('node:fs').existsSync(unpackedPath)) return unpackedPath;
  } catch {}
  return inAsarPath;
}
const appIconPath = resolveAppIconPath();

app.setName('摸鱼阅读');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.moyu.reading');
}

function getLibraryDir() {
  return path.join(app.getPath('userData'), 'library');
}

function toIpcError(error, fallbackMessage) {
  return {
    ok: false,
    errorCode: typeof error?.code === 'string' ? error.code : 'LOCAL_LIBRARY_ERROR',
    errorMessage: error instanceof Error ? error.message : fallbackMessage,
  };
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 320,
    minHeight: 420,
    title: '摸鱼阅读',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('reader:select-txt-file', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: '选择 TXT 小说',
      properties: ['openFile'],
      filters: [
        { name: 'TXT 小说', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const txtFile = await readTxtFile(result.filePaths[0]);

    return {
      ok: true,
      ...txtFile,
      bookHash: createBookHash(txtFile.content),
    };
  } catch (error) {
    console.error('Failed to select and read txt file:', error);

    return {
      ok: false,
      errorCode: typeof error?.code === 'string' ? error.code : 'READ_FAILED',
      errorMessage: error instanceof Error
        ? error.message
        : '读取 TXT 文件失败，请稍后重试。',
    };
  }
});

// 批量选择：只返回 filePaths，不读取正文（正文按顺序在前端触发逐本导入时再读取，避免一次性把几十本 TXT 全装进内存）。
ipcMain.handle('reader:select-txt-files', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: '选择 TXT 小说（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'TXT 小说', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, filePaths: [] };
    }

    return { ok: true, filePaths: result.filePaths };
  } catch (error) {
    console.error('Failed to select txt files:', error);
    return {
      ok: false,
      errorCode: typeof error?.code === 'string' ? error.code : 'SELECT_FAILED',
      errorMessage: error instanceof Error ? error.message : '选择 TXT 文件失败，请稍后重试。',
    };
  }
});

// 单本读取，仅给批量导入用：根据 filePath 读取内容、识别编码、生成 bookHash。
ipcMain.handle('reader:read-txt-file', async (_event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, errorCode: 'INVALID_INPUT', errorMessage: '缺少文件路径。' };
    }
    const txtFile = await readTxtFile(filePath);
    return {
      ok: true,
      ...txtFile,
      bookHash: createBookHash(txtFile.content),
    };
  } catch (error) {
    console.error('Failed to read txt file:', filePath, error);
    return {
      ok: false,
      errorCode: typeof error?.code === 'string' ? error.code : 'READ_FAILED',
      errorMessage: error instanceof Error ? error.message : '读取 TXT 文件失败，请稍后重试。',
    };
  }
});

ipcMain.handle('reader:list-books', async () => {
  try {
    const books = await listBooks(getLibraryDir());

    return {
      ok: true,
      books,
    };
  } catch (error) {
    console.error('Failed to list books:', error);
    return toIpcError(error, '读取本地书架失败。');
  }
});

ipcMain.handle('reader:open-book', async (_event, bookId) => {
  try {
    const book = await getBook(getLibraryDir(), bookId);

    return {
      ok: true,
      book,
    };
  } catch (error) {
    console.error('Failed to open book:', error);
    return toIpcError(error, '打开书籍失败。');
  }
});

ipcMain.handle('reader:import-txt-book', async (_event, input) => {
  try {
    const book = await importTxtBook(getLibraryDir(), input);

    return {
      ok: true,
      book,
    };
  } catch (error) {
    console.error('Failed to import txt book:', error);
    return toIpcError(error, '导入 TXT 书籍失败。');
  }
});

ipcMain.handle('reader:delete-book', async (_event, bookId) => {
  try {
    const deleted = await deleteBook(getLibraryDir(), bookId);

    return {
      ok: true,
      deleted,
    };
  } catch (error) {
    console.error('Failed to delete book:', error);
    return toIpcError(error, '删除书籍失败。');
  }
});

ipcMain.handle('reader:update-book-progress', async (_event, input) => {
  try {
    const book = await updateBookProgress(getLibraryDir(), input);

    return {
      ok: true,
      book,
    };
  } catch (error) {
    console.error('Failed to update book progress:', error);
    return toIpcError(error, '保存阅读进度失败。');
  }
});

ipcMain.handle('reader:update-book-bookmarks', async (_event, input) => {
  try {
    const book = await updateBookBookmarks(getLibraryDir(), input);

    return {
      ok: true,
      book,
    };
  } catch (error) {
    console.error('Failed to update book bookmarks:', error);
    return toIpcError(error, '保存书签失败。');
  }
});

ipcMain.handle('reader:update-book-meta', async (_event, input) => {
  try {
    const book = await updateBookMeta(getLibraryDir(), input);

    return {
      ok: true,
      book,
    };
  } catch (error) {
    console.error('Failed to update book meta:', error);
    return toIpcError(error, '保存书籍信息失败。');
  }
});

ipcMain.handle('reader:list-categories', async () => {
  try {
    const categories = await listCategories(getLibraryDir());
    return { ok: true, categories };
  } catch (error) {
    console.error('Failed to list categories:', error);
    return toIpcError(error, '读取分类失败。');
  }
});

ipcMain.handle('reader:create-category', async (_event, input) => {
  try {
    const category = await createCategory(getLibraryDir(), input);
    return { ok: true, category };
  } catch (error) {
    console.error('Failed to create category:', error);
    return toIpcError(error, '新建分类失败。');
  }
});

ipcMain.handle('reader:rename-category', async (_event, input) => {
  try {
    const category = await renameCategory(getLibraryDir(), input);
    return { ok: true, category };
  } catch (error) {
    console.error('Failed to rename category:', error);
    return toIpcError(error, '重命名分类失败。');
  }
});

ipcMain.handle('reader:delete-category', async (_event, categoryId) => {
  try {
    const result = await deleteCategory(getLibraryDir(), categoryId);
    return { ok: true, ...result };
  } catch (error) {
    console.error('Failed to delete category:', error);
    return toIpcError(error, '删除分类失败。');
  }
});

ipcMain.handle('reader:reorder-categories', async (_event, orderedIds) => {
  try {
    const categories = await reorderCategories(getLibraryDir(), orderedIds);
    return { ok: true, categories };
  } catch (error) {
    console.error('Failed to reorder categories:', error);
    return toIpcError(error, '保存分类顺序失败。');
  }
});

ipcMain.handle('reader:reparse-book-toc', async (_event, bookId) => {
  try {
    const book = await reparseBookToc(getLibraryDir(), bookId);

    return {
      ok: true,
      book,
    };
  } catch (error) {
    console.error('Failed to reparse book toc:', error);
    return toIpcError(error, '重新识别目录失败。');
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await ensureLibrary(getLibraryDir());
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
