const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('node:path');
const {
  deleteBook,
  ensureLibrary,
  getBook,
  importTxtBook,
  listBooks,
  reparseBookToc,
  updateBookBookmarks,
  updateBookProgress,
} = require('./utils/books-store.cjs');
const { readTxtFile } = require('./utils/read-txt-file.cjs');

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
app.setName('摸鱼神器');

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
    title: '摸鱼神器',
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
