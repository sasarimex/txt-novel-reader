# 摸鱼阅读 技术架构文档

版本：P0 v0.8  
日期：2026-05-28  
平台：Windows only  

## 1. 技术选型

推荐技术栈：

- 桌面壳：Electron
- 前端：React
- 语言：TypeScript
- 构建：Vite
- 打包：electron-builder
- 状态管理：Zustand 或 React Context
- 文本编码：iconv-lite + jschardet 或等价编码识别库
- 本地数据：JSON 文件，P0 暂不引入数据库

选择理由：

- Electron 适合本地文件读取、复制和 Windows 打包。
- React 适合构建书架、弹窗、阅读器设置等 UI。
- TypeScript 有利于约束书籍、章节、设置等核心数据结构。
- P0 数据规模较小，JSON 文件足够简单稳定。

## 2. 进程架构

```text
┌──────────────────────────────────────┐
│ Electron Main Process                │
│ - 创建窗口                            │
│ - 文件选择                            │
│ - 文件复制/删除                       │
│ - 读写 app data                       │
│ - 编码识别和文本解析                   │
└──────────────────────────────────────┘
                 ▲
                 │ IPC
                 ▼
┌──────────────────────────────────────┐
│ Preload                              │
│ - 暴露安全 API                        │
│ - 隔离 Node 能力                      │
└──────────────────────────────────────┘
                 ▲
                 │ window.moyu API
                 ▼
┌──────────────────────────────────────┐
│ Renderer React App                   │
│ - 书架页面                            │
│ - 阅读器页面                          │
│ - 目录弹窗                            │
│ - 设置弹窗                            │
│ - 分页和滚动 UI                       │
└──────────────────────────────────────┘
```

安全要求：

- 开启 `contextIsolation`。
- 关闭 `nodeIntegration`。
- Renderer 不直接访问 Node 文件系统。
- 所有本地文件操作通过 preload 暴露的受控 API 进行。

## 3. 目录结构建议

```text
moyu-reader/
  package.json
  electron/
    main.ts
    preload.ts
    ipc/
      books.ipc.ts
      settings.ipc.ts
  src/
    app/
      App.tsx
      routes.tsx
    pages/
      BookshelfPage.tsx
      ReaderPage.tsx
    components/
      BookCard.tsx
      CatalogModal.tsx
      SettingsModal.tsx
      ConfirmDialog.tsx
      PageIndicator.tsx
    modules/
      books/
        bookStore.ts
        bookTypes.ts
      reader/
        pagination.ts
        readerStore.ts
        readingPosition.ts
      settings/
        settingsStore.ts
      parser/
        chapterParser.ts
        encoding.ts
    styles/
      theme.css
      layout.css
  tests/
    parser/
      chapterParser.test.ts
    reader/
      pagination.test.ts
```

## 4. 软件数据目录

Windows 下建议使用 Electron 的 `app.getPath('userData')`。

示例：

```text
%APPDATA%/摸鱼阅读/
  library.json
  settings.json
  books/
    {bookId}/
      source.txt
      normalized.txt
      catalog.json
      meta.json
```

说明：

- `source.txt`：导入后复制进软件管理目录的原始副本。
- `normalized.txt`：转换为 UTF-8 后的内部阅读文本。
- `catalog.json`：章节和分卷解析结果。
- `meta.json`：单本书元信息和阅读位置。
- `library.json`：书架索引。
- `settings.json`：全局设置。

P0 可以先不存 `normalized.txt`，每次读取时重新解码。但为了加快打开速度，建议导入时生成 UTF-8 的 `normalized.txt`。

## 5. 核心数据模型

### 5.1 Book

```ts
export interface Book {
  id: string;
  title: string;
  sourcePath: string;
  normalizedPath: string;
  encoding: 'utf8' | 'utf8-bom' | 'gb18030' | 'unknown';
  totalChars: number;
  progressPercent: number;
  readingPosition: ReadingPosition;
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
}
```

### 5.2 ReadingPosition

```ts
export interface ReadingPosition {
  page: number;
  totalPages: number;
  progressRatio: number;
  scrollTop?: number;
  chapterId?: string;
}
```

说明：

- `page`：最近一次显示页码。
- `totalPages`：最近一次分页总数快照。
- `progressRatio`：阅读进度比例，范围 0 到 1。
- 当窗口、字号、主题变化导致分页改变时，优先用 `progressRatio` 恢复到接近位置。

### 5.3 Catalog

```ts
export interface Catalog {
  volumes: Volume[];
  chapters: Chapter[];
  hasVolumes: boolean;
  hasChapters: boolean;
}

export interface Volume {
  id: string;
  title: string;
  startOffset: number;
  chapterIds: string[];
}

export interface Chapter {
  id: string;
  title: string;
  volumeId: string | null;
  startOffset: number;
  endOffset: number | null;
}
```

说明：

- `startOffset` 使用正文字符偏移，方便目录跳转。
- `endOffset` 可以在解析完成后根据下一章起点推导。
- 没有分卷时，章节的 `volumeId` 为 `null`。

### 5.4 Settings

```ts
export type PageMode = 'wheel' | 'click';
export type ThemeMode = 'light' | 'dark' | 'eye';
export type BookshelfSortMode = 'lastRead' | 'progress';

export interface AppSettings {
  pageMode: PageMode;
  fontSize: number;
  theme: ThemeMode;
  bookshelfSortMode: BookshelfSortMode;
}
```

默认值：

```ts
export const defaultSettings: AppSettings = {
  pageMode: 'wheel',
  fontSize: 20,
  theme: 'light',
  bookshelfSortMode: 'lastRead',
};
```

## 6. 文件导入流程

```text
用户点击导入 TXT
  ↓
Main Process 打开文件选择器
  ↓
获取文件路径
  ↓
从文件名生成书名
  ↓
检查书架是否已有同名书
  ↓
若重复，Renderer 弹窗询问跳过或覆盖
  ↓
复制文件到 app data/books/{bookId}/source.txt
  ↓
识别编码
  ↓
转换为 UTF-8 normalized.txt
  ↓
解析章节和分卷
  ↓
写入 catalog.json 和 meta.json
  ↓
更新 library.json
  ↓
Renderer 刷新书架，留在书架页
```

覆盖导入：

- 复用原书名。
- 可以生成新 bookId，也可以复用旧 bookId。
- P0 建议复用旧 bookId，减少书架引用变动。
- 覆盖后阅读位置重置。

## 7. 编码识别

推荐流程：

```text
读取 Buffer
  ↓
检测 BOM
  ↓
若 UTF-8 BOM，按 UTF-8 解码并移除 BOM
  ↓
尝试 UTF-8 严格解码
  ↓
若失败或异常字符过多，尝试 GB18030
  ↓
输出 UTF-8 字符串
```

异常字符判断：

- 统计 `�` 替换字符数量。
- 若比例超过阈值，认为该编码不可信。

依赖建议：

- `iconv-lite`：GBK/GB18030 解码。
- `jschardet`：辅助判断编码。

P0 目标不是完美识别所有编码，而是覆盖中文 txt 最常见场景。

## 8. 章节解析

### 8.1 标题匹配

P0 主要匹配中文数字：

```ts
const cnNumber = '[零〇一二三四五六七八九十百千万两]+';
const volumePattern = new RegExp(`^\\s*第${cnNumber}卷[^\\n]{0,40}\\s*$`);
const chapterPattern = new RegExp(`^\\s*第${cnNumber}章[^\\n]{0,60}\\s*$`);
```

解析策略：

- 按行扫描文本。
- 记录每一行在全文中的字符偏移。
- 先判断分卷，再判断章节。
- 当前分卷影响后续章节归属。
- 分卷标题本身不作为章节。

边界：

- 如果章节出现在第一个分卷前，章节 `volumeId` 为 `null`。
- 如果没有任何分卷，则目录直接展示章节。
- 如果没有任何章节，则 `hasChapters` 为 `false`，阅读器允许无目录阅读。

## 9. 阅读器渲染架构

### 9.1 滚轮模式

DOM 策略：

- 正文容器正常垂直滚动。
- 监听 `scroll` 更新页码。
- 左右半屏点击层不启用。

页码计算：

```ts
currentPage = Math.floor(scrollTop / viewportHeight) + 1;
totalPages = Math.ceil(scrollHeight / viewportHeight);
progressRatio = scrollTop / (scrollHeight - viewportHeight);
```

注意：

- `progressRatio` 需要限制在 0 到 1。
- 滚动保存需要节流，例如 300ms 到 800ms。

### 9.2 点击翻页模式

DOM 策略建议：

- 使用固定高度阅读容器。
- 通过 CSS columns 或分页测量生成页。
- 鼠标滚轮事件 `preventDefault`。
- 左右半屏点击层启用。

点击行为：

```text
点击左半屏：page - 1
点击右半屏：page + 1
```

限制：

- 页码不能小于 1。
- 页码不能大于总页数。
- 顶部栏、目录弹窗、设置弹窗点击不触发翻页。

页码保存：

```ts
progressRatio = (page - 1) / Math.max(totalPages - 1, 1);
```

### 9.3 模式切换

从滚轮模式切到点击翻页：

- 根据当前 `progressRatio` 计算目标页。
- 渲染到对应页。

从点击翻页切到滚轮模式：

- 根据当前 `progressRatio` 计算目标 `scrollTop`。
- 滚动到对应位置。

## 10. 主题系统

使用 CSS variables：

```css
:root[data-theme='light'] {
  --reader-bg: #F7F7F3;
  --reader-text: #202124;
}

:root[data-theme='dark'] {
  --reader-bg: #101214;
  --reader-text: #D8D8D8;
}

:root[data-theme='eye'] {
  --reader-bg: #DCE8D2;
  --reader-text: #243024;
}
```

字号：

- 用 CSS variable 控制。
- `--reader-font-size: 20px`。

主题或字号变化后：

- Reader 触发布局测量。
- 重新计算页码。
- 按 `progressRatio` 恢复阅读位置。

## 11. IPC API 设计

Preload 暴露：

```ts
window.moyu = {
  books: {
    list(): Promise<Book[]>;
    importTxt(): Promise<ImportResult>;
    resolveDuplicate(input: DuplicateDecision): Promise<ImportResult>;
    delete(bookId: string): Promise<void>;
    readText(bookId: string): Promise<string>;
    readCatalog(bookId: string): Promise<Catalog>;
    updatePosition(bookId: string, position: ReadingPosition): Promise<void>;
  },
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  },
};
```

说明：

- `importTxt()` 可以在检测到重复时返回 `duplicate` 状态，由 Renderer 弹窗后调用 `resolveDuplicate()`。
- 也可以由 Main Process 直接弹原生对话框，但 P0 建议用 Renderer 统一弹窗风格。

## 12. 错误处理

常见错误：

- 文件不存在。
- 文件读取失败。
- 编码识别失败。
- 文件复制失败。
- 删除失败。
- JSON 数据损坏。

策略：

- Main Process 返回结构化错误。
- Renderer 显示用户可理解文案。
- 对 `library.json`、`settings.json` 写入时使用临时文件替换，降低写坏风险。

## 13. 测试策略

### 单元测试

重点：

- 编码识别。
- 章节解析。
- 分卷和章节归属。
- 无目录解析结果。
- 页码计算。
- 阅读进度百分比。

### 集成测试

重点：

- 导入 txt。
- 重复书名跳过。
- 重复书名覆盖。
- 删除书籍。
- 设置保存和读取。

### UI 测试

重点：

- 书架排序。
- 目录弹窗跳转。
- 设置切换字号和主题。
- 滚轮模式点击无效。
- 点击翻页模式滚轮无效。

## 14. 打包发布

P0 打包目标：

- Windows `.exe` 安装包。

建议：

- 使用 electron-builder。
- 应用名：`摸鱼阅读`。
- 安装后数据目录使用 `%APPDATA%/摸鱼阅读`。

## 15. 技术风险

### 分页准确性

不同字体、窗口大小和主题会影响分页。P0 需要保证页码稳定、阅读位置大致恢复，不要求做到像专业电子书引擎一样逐字精确。

### 编码识别

中文 txt 编码复杂，P0 重点覆盖 UTF-8 和 GBK/GB18030。少数异常编码可以提示失败。

### 大文件性能

长篇小说可能有数 MB 到数十 MB。P0 可以一次性加载文本，但需要避免每次渲染都重新解析全量文本。章节解析结果应缓存。

### 数据写入可靠性

阅读位置频繁变化时不能频繁写磁盘。需要节流保存，并使用安全写入策略。
