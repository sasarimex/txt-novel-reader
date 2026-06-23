export interface SelectedTxtFile {
  ok: true;
  fileName: string;
  filePath: string;
  fileSize: number;
  bookHash: string;
  extension: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'gb18030';
  content: string;
  totalChars: number;
  textCharCount: number;
}

export interface ReaderChapter {
  id: string;
  bookHash?: string;
  title: string;
  volumeId?: string;
  startIndex: number;
  endIndex?: number | null;
  lineNumber?: number;
  page?: number;
}

export interface ReaderVolume {
  id: string;
  title: string;
  startIndex?: number;
  lineNumber?: number;
  chapterIds: string[];
}

export interface ReaderTocItem {
  id: string;
  type: 'volume' | 'chapter';
  title: string;
  startIndex: number;
  lineNumber: number;
  volumeId?: string;
  chapterIds?: string[];
}

export interface ReaderBookmark {
  id: string;
  bookId: string;
  title: string;
  chapterTitle?: string;
  pageIndex?: number;
  position?: number;
  previewText?: string;
  createdAt: number;
}

export interface ReaderBook {
  id: string;
  title: string;
  author?: string;
  note?: string;
  categoryId?: string | null;
  filePath: string;
  contentPath?: string;
  originalPath: string;
  fileSize?: number;
  encoding: 'utf-8' | 'utf-8-bom' | 'gb18030';
  totalChars: number;
  textCharCount?: number;
  nonWhitespaceCharCount?: number;
  chapters: ReaderChapter[];
  volumes: ReaderVolume[];
  toc?: ReaderTocItem[];
  tocParseVersion?: number;
  bookmarks?: ReaderBookmark[];
  currentPage: number;
  totalPages: number;
  position?: number;
  progress: number;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
  content: string;
}

export interface ReaderCategory {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface SelectTxtFileError {
  ok: false;
  errorCode: 'EMPTY_FILE' | 'EMPTY_CONTENT' | 'DECODE_FAILED' | 'READ_FAILED' | string;
  errorMessage: string;
}

export type SelectTxtFileResult = SelectedTxtFile | SelectTxtFileError;

export interface ReaderApiError {
  ok: false;
  errorCode: string;
  errorMessage: string;
}

export interface ImportTxtBookInput {
  originalPath: string;
  bookHash?: string;
  replaceBookId?: string;
  title: string;
  author?: string;
  note?: string;
  categoryId?: string | null;
  chapters?: ReaderChapter[];
  volumes?: ReaderVolume[];
  currentPage: number;
  totalPages: number;
  progress: number;
  position?: number;
  lastReadAt: string | null;
}

export interface UpdateBookMetaInput {
  id: string;
  title?: string;
  author?: string;
  note?: string;
  categoryId?: string | null;
}

export interface CreateCategoryInput {
  name: string;
}

export interface RenameCategoryInput {
  id: string;
  name: string;
}

export interface UpdateBookProgressInput {
  id: string;
  currentPage?: number;
  totalPages?: number;
  progress?: number;
  position?: number;
  lastReadAt?: string | null;
}

export interface UpdateBookBookmarksInput {
  id: string;
  bookmarks: ReaderBookmark[];
}

export interface ReaderAPI {
  selectTxtFile(): Promise<SelectTxtFileResult | null>;
  selectTxtFiles(): Promise<{ ok: true; filePaths: string[] } | ReaderApiError>;
  readTxtFile(filePath: string): Promise<SelectTxtFileResult>;
  listBooks(): Promise<{ ok: true; books: ReaderBook[] } | ReaderApiError>;
  openBook(bookId: string): Promise<{ ok: true; book: ReaderBook | null } | ReaderApiError>;
  importTxtBook(input: ImportTxtBookInput): Promise<{ ok: true; book: ReaderBook } | ReaderApiError>;
  deleteBook(bookId: string): Promise<{ ok: true; deleted: boolean } | ReaderApiError>;
  updateBookProgress(input: UpdateBookProgressInput): Promise<{ ok: true; book: ReaderBook | null } | ReaderApiError>;
  updateBookBookmarks(input: UpdateBookBookmarksInput): Promise<{ ok: true; book: ReaderBook | null } | ReaderApiError>;
  updateBookMeta(input: UpdateBookMetaInput): Promise<{ ok: true; book: ReaderBook | null } | ReaderApiError>;
  reparseBookToc(bookId: string): Promise<{ ok: true; book: ReaderBook | null } | ReaderApiError>;
  listCategories(): Promise<{ ok: true; categories: ReaderCategory[] } | ReaderApiError>;
  createCategory(input: CreateCategoryInput): Promise<{ ok: true; category: ReaderCategory } | ReaderApiError>;
  renameCategory(input: RenameCategoryInput): Promise<{ ok: true; category: ReaderCategory } | ReaderApiError>;
  deleteCategory(categoryId: string): Promise<{ ok: true; movedBooks: number } | ReaderApiError>;
  reorderCategories(orderedIds: string[]): Promise<{ ok: true; categories: ReaderCategory[] } | ReaderApiError>;
}

declare global {
  interface Window {
    readerAPI?: ReaderAPI;
  }
}

export {};
