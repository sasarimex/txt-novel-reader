const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('readerAPI', {
  selectTxtFile: () => ipcRenderer.invoke('reader:select-txt-file'),
  listBooks: () => ipcRenderer.invoke('reader:list-books'),
  openBook: (bookId) => ipcRenderer.invoke('reader:open-book', bookId),
  importTxtBook: (input) => ipcRenderer.invoke('reader:import-txt-book', input),
  deleteBook: (bookId) => ipcRenderer.invoke('reader:delete-book', bookId),
  updateBookProgress: (input) => ipcRenderer.invoke('reader:update-book-progress', input),
  updateBookBookmarks: (input) => ipcRenderer.invoke('reader:update-book-bookmarks', input),
  reparseBookToc: (bookId) => ipcRenderer.invoke('reader:reparse-book-toc', bookId),
});
