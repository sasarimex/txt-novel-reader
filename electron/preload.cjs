const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('readerAPI', {
  selectTxtFile: () => ipcRenderer.invoke('reader:select-txt-file'),
  selectTxtFiles: () => ipcRenderer.invoke('reader:select-txt-files'),
  readTxtFile: (filePath) => ipcRenderer.invoke('reader:read-txt-file', filePath),
  listBooks: () => ipcRenderer.invoke('reader:list-books'),
  openBook: (bookId) => ipcRenderer.invoke('reader:open-book', bookId),
  importTxtBook: (input) => ipcRenderer.invoke('reader:import-txt-book', input),
  deleteBook: (bookId) => ipcRenderer.invoke('reader:delete-book', bookId),
  updateBookProgress: (input) => ipcRenderer.invoke('reader:update-book-progress', input),
  updateBookBookmarks: (input) => ipcRenderer.invoke('reader:update-book-bookmarks', input),
  updateBookMeta: (input) => ipcRenderer.invoke('reader:update-book-meta', input),
  reparseBookToc: (bookId) => ipcRenderer.invoke('reader:reparse-book-toc', bookId),
  listCategories: () => ipcRenderer.invoke('reader:list-categories'),
  createCategory: (input) => ipcRenderer.invoke('reader:create-category', input),
  renameCategory: (input) => ipcRenderer.invoke('reader:rename-category', input),
  deleteCategory: (categoryId) => ipcRenderer.invoke('reader:delete-category', categoryId),
  reorderCategories: (orderedIds) => ipcRenderer.invoke('reader:reorder-categories', orderedIds),
});
