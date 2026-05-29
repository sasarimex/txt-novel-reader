import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';

const CURRENT_TOC_PARSE_VERSION = 2;

// 窗口化渲染：只把当前 section 附近的若干段渲染成真实文本，其它部分用同样高度的占位 <section>，
// 既保证滚轮 / 触摸板的自然连续滚动手感，也避免一次性把整本书 reflow。
const SECTION_RENDER_BEFORE = 2; // 当前 section 之前保留 2 段真实正文
const SECTION_RENDER_AFTER = 4;  // 当前 section 之后保留 4 段真实正文
const MAX_SECTION_CHARS = 8000;  // 单章超过该字数会再切成子段（避免巨长章节占满整个窗口）
const RESIZE_DEBOUNCE_MS = 220;  // ResizeObserver 防抖间隔
const FONT_DEBOUNCE_MS = 220;    // 字号变化防抖间隔（应用到分页/估算的最终值）

interface FlatSection {
  id: string;
  chapterId: string | null;     // 仅当这是某章节的"首段"时填章节 id（用于章节锚点 / 章节跳转）
  parentChapterId: string | null; // 该段所属章节 id（含子段）
  startIndex: number;
  endIndex: number;
}

// ==========================================
// 11. 数据结构设计 (TypeScript 类型定义)
// ==========================================

export interface Chapter {
  id: string;
  title: string;
  volumeId?: string;
  startIndex: number;
  endIndex?: number | null;
  lineNumber?: number;
  page?: number;
}

export interface Volume {
  id: string;
  title: string;
  startIndex?: number;
  lineNumber?: number;
  chapterIds: string[];
}

export interface TocItem {
  id: string;
  type: 'volume' | 'chapter';
  title: string;
  startIndex: number;
  lineNumber: number;
  volumeId?: string;
  chapterIds?: string[];
}

export interface Bookmark {
  id: string;
  bookId: string;
  title: string;
  chapterTitle?: string;
  pageIndex?: number;
  position?: number;
  previewText?: string;
  createdAt: number;
}

export interface Book {
  id: string;
  title: string;
  filePath: string;
  contentPath?: string;
  originalPath?: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'gbk' | 'gb18030' | 'unknown';
  totalChars: number;
  textCharCount?: number;
  nonWhitespaceCharCount?: number;
  chapters: Chapter[];
  volumes: Volume[];
  toc?: TocItem[];
  tocParseVersion?: number;
  bookmarks?: Bookmark[];
  currentPage: number;
  totalPages: number;
  position?: number;
  progress: number;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
  content: string;
}

export interface ReaderSettings {
  pageMode: 'scroll' | 'click';
  fontSize: number;
  theme: 'light' | 'dark' | 'eyeCare';
  bookshelfSort: 'recent' | 'progress';
}

function formatWordCount(book: Book): string {
  const count = typeof book.nonWhitespaceCharCount === 'number' && book.nonWhitespaceCharCount > 0
    ? book.nonWhitespaceCharCount
    : typeof book.textCharCount === 'number' && book.textCharCount > 0
    ? book.textCharCount
    : book.totalChars;
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 10000) return String(count);
  const wan = count / 10000;
  // 10,000 ~ 99,999 之间保留 1 位小数；10 万以上取整。
  const formatted = wan >= 10 ? Math.round(wan).toString() : wan.toFixed(1);
  return `${formatted}万`;
}

function formatBookmarkTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPositionPercent(position: number | undefined, totalChars: number): string {
  if (!Number.isFinite(position) || !Number.isFinite(totalChars) || totalChars <= 0) return '';
  const percent = Math.min(100, Math.max(0, Math.round(((position ?? 0) / totalChars) * 100)));
  return `${percent}%`;
}

type ProgressUpdateInput = {
  id: string;
  currentPage?: number;
  totalPages?: number;
  progress?: number;
  position?: number;
  lastReadAt?: string | null;
};

// ==========================================
// 12. Mock 数据准备 (包含3本特征各异的小说)
// ==========================================

const INITIAL_BOOKS: Book[] = [
  {
    id: 'book-1',
    title: '仙路风云',
    filePath: '示例/仙路风云.txt',
    encoding: 'utf-8',
    totalChars: 12500,
    currentPage: 28,
    totalPages: 88,
    progress: 32,
    lastReadAt: '2026-05-28 10:30',
    createdAt: '2026-05-10 14:00',
    updatedAt: '2026-05-28 10:30',
    volumes: [
      { id: 'v-1', title: '第一卷 风起', chapterIds: ['c-1', 'c-2'] },
      { id: 'v-2', title: '第二卷 山河', chapterIds: ['c-3', 'c-4'] }
    ],
    chapters: [
      { id: 'c-1', title: '第一章 少年出山', volumeId: 'v-1', startIndex: 0, page: 1 },
      { id: 'c-2', title: '第二章 夜雨听风', volumeId: 'v-1', startIndex: 2500, page: 15 },
      { id: 'c-3', title: '第三章 风云入京', volumeId: 'v-2', startIndex: 5800, page: 35 },
      { id: 'c-4', title: '第四章 故人重逢', volumeId: 'v-2', startIndex: 9200, page: 65 }
    ],
    content: `第一卷 风起

第一章 少年出山

夜色沉沉，山风吹过竹林。
少年推开木门，看见远处的灯火。那灯火摇曳在飘渺的夜雾中，如同他此时此刻波澜起伏的心境。
自幼在深山跟随师父修行，今日终于到了下山历练的时刻。师父交给他一柄锈迹斑斑的长剑，以及一封泛黄的信件，便将他赶出了柴门。
“外面的世界很大，风云变幻，切记坚守本心。”师父的话语还在耳畔回荡。
少年深吸一口气，紧了紧背后的包袱，踏上了青石铺就的下山小道。夜雨，似乎在悄然酝酿。

第二章 夜雨听风

雨声落在瓦片上，像细密的鼓点。
客栈的小窗被风吹得轻轻作响，少年盘膝坐在简陋的木床上，闭目冥想。
内力在经脉中流淌，带来阵阵温热。这是他下山后的第三天。在这三天里，他见识到了集市的繁华，也看到了江湖的险恶。
隔壁房间不时传来粗鲁的谈笑声与兵刃碰撞的闷响，都在提醒着他，这里不再是宁静的深山古观。
忽然，一阵轻微的破空声传来，一缕极细的寒芒刺破窗纸，直奔少年面门！
少年双眼骤睁，身形如落叶般凭空后掠三尺，险险避开这一记淬毒的暗器。江湖的凶险，比想象中来得更快。

第二卷 山河

第三章 风云入京

巍峨的京城城墙宛如一条巨龙盘踞在平原之上。
少年站在城门外，仰望着高达数丈的玄铁城门，感受着扑面而来的喧嚣与庄严。
这里是权力的中心，也是风云汇聚之地。师父信中提到的那个人，就在这座深不可测的巨城之中。
街道两旁商铺林立，车水马龙，叫卖声此起彼伏。然而在这繁华的表象之下，少年敏锐地察觉到了一股压抑的气流。
探子、死士、高官、豪侠，无数势力的触角在暗中交错。少年拍了拍腰间的古剑，迈步走入城中。

第四章 故人重逢

酒楼临窗的座位上，一名白衣书生正自斟自饮，神色落寞。
少年走到桌前，静静地看着他。书生抬起头，眼中闪过一丝震惊，随即化作浓浓的狂喜。
“师弟！真的是你？！”书生猛地站起身，由于动作过大，酒杯险些倾倒。
“师兄，好久不见。”少年脸上终于心出一抹真挚的笑容。
当年的竹林论剑，一别已有三载。如今师兄已成了京城闻名的谋士，而少年才刚刚踏入这片浑水。
两人对视一眼，无数往事涌上心头。在这风雨欲来的京城，两兄弟的重逢，注定将掀起一场惊天巨浪。`
  },
  {
    id: 'book-2',
    title: '夜雨江湖',
    filePath: '示例/夜雨江湖.txt',
    encoding: 'gbk',
    totalChars: 6200,
    currentPage: 3,
    totalPages: 40,
    progress: 5,
    lastReadAt: '2026-05-25 21:15',
    createdAt: '2026-05-12 09:00',
    updatedAt: '2026-05-25 21:15',
    volumes: [],
    chapters: [
      { id: 'c2-1', title: '第一章 孤舟夜雨', startIndex: 0, page: 1 },
      { id: 'c2-2', title: '第二章 剑起沧海', startIndex: 2200, page: 15 },
      { id: 'c2-3', title: '第三章 恩怨难断', startIndex: 4500, page: 30 }
    ],
    content: `第一章 孤舟夜雨

大江东去，浪潮拍打着江畔的孤舟。
一个戴着斗笠的刀客静静地坐在船头，任由冰冷的雨水打湿他的衣襟。
他的刀就放在膝盖上，刀鞘陈旧，但散发着一股令人胆寒的血腥气。他已经在这里等了三个时辰。
他在等一个仇人，一个毁灭了他整个宗门的绝顶高手。
远处的江面上，一盏孤灯缓缓驶来。刀客缓缓睁开眼，双眸如鹰隼般锐利。

第二章 剑起沧海

江面之上的雨水仿佛在一瞬间凝固。
来者同样是一艘小船，船头站着一名负手而立的青衣中年人。
“你终究还是来了。”青衣人淡淡开口，声音穿透密集的雨幕，清晰地传入刀客耳中。
“血海深仇，岂能不报！”刀客暴喝一声，膝上长刀化作一道惊雷出鞘，撕裂了漫天夜雨。
两股绝强的气劲在江心碰撞，激起滔天巨浪！

第三章 恩怨难断

长刀断裂，长剑折损。
两人各自退回船头，嘴角皆挂着一缕鲜血。
大雨渐渐停歇，天边泛起一抹鱼肚白。这场生死之战，竟然谁也没能奈何得了谁。
“你的刀法长进了。”青衣人抹去血迹，神色复杂，“但你想杀我，还差了三年火候。”
刀客紧握着断刀，眼中满是不甘。江湖恩怨，交织如网，一旦踏入，便再无抽身之日。`
  },
  {
    id: 'book-3',
    title: '无目录小说示例',
    filePath: '示例/未分章文本.txt',
    encoding: 'unknown',
    totalChars: 3000,
    currentPage: 1,
    totalPages: 10,
    progress: 0,
    lastReadAt: null,
    createdAt: '2026-05-27 18:00',
    updatedAt: '2026-05-27 18:00',
    volumes: [],
    chapters: [],
    content: `这这是一篇完全没有识别到任何章节标题的小说纯文本内容。
这里既没有“第一章”，也没有“卷一”之类的标识，仅仅是连续不断的长篇大论。
为了测试摸鱼神器本地txt小说阅读器在面对不规则或未排版文本时的强壮性与兼容度，特此提供该测试用例。
用户在日常摸鱼中经常会遇到这类由网络爬虫直接抓取、没有任何排版标识的纯文本。
此时，阅读器的章节目录应当正确显示为“未识别到章节”的空状态，同时不妨碍用户通过滚轮或点击进行流畅的翻页和阅读。
字号调整、主题切换、页面进度追踪等核心摸鱼功能，在这里都应该保持完美可用，保障极致、隐蔽且高效的阅读体验。
让我们继续在这个没有章节的空白区域模拟更多文字，确保测试有足够的页数与行数：
春去秋来，岁月如梭。在这个不知名的大陆上，人们日出而作，日落而息。
有人在追寻着虚无缥缈的仙道，有人在世俗的泥潭中挣扎求生，亦有人在角落里默默注视着这一切。
没有开端，没有高潮，也没有结局，这就是未排版小说的奇特魅力所在。
安安静静地读完这些文字，或许能让人在忙碌的工作间隙找到一丝难得的平静与松弛。`
  }
];

export default function App() {
  // 主状态
  const [books, setBooks] = useState<Book[]>([]);
  const [currentBookId, setCurrentBookId] = useState<string | null>(null);
  const [view, setView] = useState<'bookshelf' | 'reader'>('bookshelf');
  
  // 设置状态。默认使用自然连续滚动，鼠标滚轮 / 触摸板不再被劫持成翻页。
  const [settings, setSettings] = useState<ReaderSettings>({
    pageMode: 'scroll',
    fontSize: 20,
    theme: 'eyeCare',
    bookshelfSort: 'recent'
  });

  // 弹窗与控制状态
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState<'toc' | 'bookmarks'>('toc');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [deleteConfirmBook, setDeleteConfirmBook] = useState<Book | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // 引用
  const readerViewportRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentTextRef = useRef<HTMLDivElement>(null);
  const catalogScrollRef = useRef<HTMLDivElement>(null);
  const saveProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProgressInputRef = useRef<ProgressUpdateInput | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const lastScrollSyncRef = useRef({ at: 0, position: 0 });
  // 每个 section 的 DOM 引用（包括占位 section），用于跳转 / 二分定位
  const sectionRefMap = useRef<Map<string, HTMLElement>>(new Map());
  // 全量 section 布局缓存（top/height）。窗口化下我们也能拿到占位 section 的 offsetTop，
  // 所以无论 section 是否被渲染成真实文字，二分查找都能命中。
  const sectionOffsetsRef = useRef<Array<{ idx: number; startIndex: number; endIndex: number; top: number; height: number }>>([]);
  // 编程式滚动（章节跳转 / 书签跳转 / 翻页按钮 / resize/字号 恢复）发生后，
  // 短暂抑制 scroll → position 同步，避免 ratio 立刻把我们刚跳好的 position 覆写掉。
  const suppressScrollSyncUntilRef = useRef(0);
  // 当前阅读位置的最新值（不引起 React 重渲染），供 ResizeObserver / 字号变化时即时取 anchor。
  const currentPositionRef = useRef(0);
  // resize / 字号变化的 anchor position：变化开始前用户正在看的文字 position，
  // 变化结束后据此回滚 scrollTop，保证用户原本看到的文字不会漂走。
  const anchorPositionRef = useRef(0);
  // 是否正在做 resize / 字号调整：用于标记"开始一次 burst"，期间 scroll listener 不写回 position。
  const isAdjustingSizeRef = useRef(false);
  const isAdjustingFontRef = useRef(false);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fontDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 容器测量：只在 ResizeObserver debounce 沉淀后才 setReaderSize，避免拖窗口时高频重排
  const [readerSize, setReaderSize] = useState({ width: 672, height: 640 });

  // 设置中的字号会立即应用到 CSS（视觉无延迟），但 charsPerPage / 段高度估算 / 重定位 都用 debounce 后的值，
  // 避免拖滑块时频繁对整本书做无意义的运算。
  const [paginationFontSize, setPaginationFontSize] = useState(settings.fontSize);
  // 记录已经"确认"的字号，用于辨别字号是否真正变化（与初始 mount 区分）
  const prevAppliedFontRef = useRef(settings.fontSize);

  useEffect(() => {
    const target = readerViewportRef.current;
    if (!target) return;

    let didInit = false;
    let lastWidth = 0;
    let lastHeight = 0;

    const handle = () => {
      const rect = target.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));

      if (!didInit) {
        // 第一次 ResizeObserver 回调（observe 时会立刻触发一次）只用来同步初始尺寸，
        // 不触发 anchor / suppression 流程，避免开书时被误判为 resize。
        didInit = true;
        lastWidth = width;
        lastHeight = height;
        setReaderSize({ width, height });
        return;
      }

      if (width === lastWidth && height === lastHeight) {
        return;
      }

      // Burst 第一次：记录 anchor，开启抑制（不立刻 setReaderSize，避免每次 resize 触发整本重算）
      if (!isAdjustingSizeRef.current) {
        isAdjustingSizeRef.current = true;
        anchorPositionRef.current = currentPositionRef.current;
      }
      suppressScrollSyncUntilRef.current = performance.now() + 1500;

      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = setTimeout(() => {
        resizeDebounceRef.current = null;
        lastWidth = width;
        lastHeight = height;
        setReaderSize(prev => (prev.width === width && prev.height === height) ? prev : { width, height });
        // 两次 RAF：等待新尺寸应用、布局重算、section offsets 重建之后再回到 anchor
        requestAnimationFrame(() => requestAnimationFrame(() => {
          scrollToPositionRef.current?.(anchorPositionRef.current);
          // scrollTo 之后再放宽抑制时间，避免 scroll listener 立刻把 anchor 改掉
          suppressScrollSyncUntilRef.current = performance.now() + 400;
          isAdjustingSizeRef.current = false;
        }));
      }, RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(handle);
    observer.observe(target);
    return () => {
      observer.disconnect();
      if (resizeDebounceRef.current) {
        clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
    };
  }, [view, currentBookId]);

  // 字号变化：滑块每动一格 settings.fontSize 都会变，但我们只在停下 220ms 后才 setPaginationFontSize，
  // 这样 charsPerPage / 段高估算 / anchor 回滚都只算一次。字号视觉本身已经通过 contentTextRef 的 inline style 即时生效。
  useEffect(() => {
    if (settings.fontSize === prevAppliedFontRef.current) return;

    if (!isAdjustingFontRef.current) {
      isAdjustingFontRef.current = true;
      // 在拖动开始时就记下 anchor —— 此时 scroll listener 还没被字号变化"污染"
      anchorPositionRef.current = currentPositionRef.current;
    }
    suppressScrollSyncUntilRef.current = performance.now() + 1500;

    if (fontDebounceRef.current) clearTimeout(fontDebounceRef.current);
    fontDebounceRef.current = setTimeout(() => {
      fontDebounceRef.current = null;
      prevAppliedFontRef.current = settings.fontSize;
      setPaginationFontSize(settings.fontSize);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        scrollToPositionRef.current?.(anchorPositionRef.current);
        suppressScrollSyncUntilRef.current = performance.now() + 400;
        isAdjustingFontRef.current = false;
      }));
    }, FONT_DEBOUNCE_MS);

    return () => {
      // 注意：不要在这里清理 timer，否则会在 settings.fontSize 每次变化时把 debounce 重置成 effect 卸载
    };
  }, [settings.fontSize]);

  // scrollToPosition 的 ref：因为它被 ResizeObserver / 字号变化的 useEffect 用到，
  // 而那些 effect 不能把 scrollToPosition 写进依赖（会无限重建 observer）。
  const scrollToPositionRef = useRef<((position: number) => void) | null>(null);

  // 弹出提示消息函数
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const saveBookProgressNow = (input: ProgressUpdateInput) => {
    const savePromise = window.readerAPI?.updateBookProgress?.(input);

    if (savePromise) {
      void savePromise.catch((error) => {
        console.error('Failed to save reading progress:', error);
      });
    }
  };

  const flushPendingProgressSave = () => {
    if (saveProgressTimerRef.current) {
      clearTimeout(saveProgressTimerRef.current);
      saveProgressTimerRef.current = null;
    }

    if (pendingProgressInputRef.current) {
      saveBookProgressNow(pendingProgressInputRef.current);
      pendingProgressInputRef.current = null;
    }
  };

  const saveBookProgressDebounced = (input: ProgressUpdateInput) => {
    pendingProgressInputRef.current = input;

    if (saveProgressTimerRef.current) {
      clearTimeout(saveProgressTimerRef.current);
    }

    saveProgressTimerRef.current = setTimeout(() => {
      saveProgressTimerRef.current = null;
      if (pendingProgressInputRef.current) {
        saveBookProgressNow(pendingProgressInputRef.current);
        pendingProgressInputRef.current = null;
      }
    }, 600);
  };

  useEffect(() => {
    return () => {
      flushPendingProgressSave();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    if (!window.readerAPI?.listBooks) {
      if (import.meta.env.DEV) {
        // 浏览器开发预览（npm run dev 单独打开 http://localhost:5173）时使用示例书展示 UI。
        // Electron 窗口（开发或打包）始终通过 readerAPI 从 books.json 读取真实数据。
        setBooks(INITIAL_BOOKS);
      } else {
        setBooks([]);
      }
      return () => {
        isMounted = false;
      };
    }

    window.readerAPI.listBooks()
      .then((result) => {
        if (!isMounted) return;

        if (result.ok) {
          setBooks(result.books);
        } else {
          showToast(result.errorMessage);
        }
      })
      .catch((error) => {
        console.error('Failed to load books:', error);
        if (isMounted) {
          showToast('读取本地书架失败。');
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // 获取当前正在阅读的书籍
  const currentBook = useMemo(() => {
    return books.find(b => b.id === currentBookId) || null;
  }, [books, currentBookId]);

  // 估算每"页"等价字符数（仅用于运行时显示 X/Y 这种近似页数；真正的位置始终用 position）。
  const charsPerPage = useMemo(() => {
    const contentWidth = Math.max(220, Math.min(672, readerSize.width - 48));
    const contentHeight = Math.max(220, readerSize.height - 48);
    const estimatedCharWidth = Math.max(12, paginationFontSize * 1.02);
    const estimatedLineHeight = Math.max(22, paginationFontSize * 1.68);
    const charsPerLine = Math.max(8, Math.floor(contentWidth / estimatedCharWidth));
    const linesPerPage = Math.max(6, Math.floor(contentHeight / estimatedLineHeight));
    return Math.max(120, charsPerLine * linesPerPage);
  }, [paginationFontSize, readerSize.height, readerSize.width]);

  const totalPages = useMemo(() => {
    if (!currentBook?.content) return 1;
    return Math.max(1, Math.ceil(currentBook.content.length / charsPerPage));
  }, [currentBook?.content, charsPerPage]);

  const currentPosition = useMemo(() => {
    if (!currentBook) return 0;
    const contentLength = currentBook.content.length;
    const fallbackPosition = Math.max(0, (currentBook.currentPage - 1) * charsPerPage);
    const position = Number.isFinite(currentBook.position) ? currentBook.position ?? 0 : fallbackPosition;
    return Math.min(Math.max(0, position), Math.max(0, contentLength - 1));
  }, [currentBook?.content.length, currentBook?.currentPage, currentBook?.position, charsPerPage]);

  // 按章节切 sections；超长章节再被切成最多 MAX_SECTION_CHARS 字的子段，让窗口化粒度更细。
  // sections 不在这里 slice 文本，避免在渲染前白白拷贝整本书。文本是在渲染窗口内才 slice 出来。
  const flatSections = useMemo<FlatSection[]>(() => {
    const content = currentBook?.content ?? '';
    if (!content) {
      return [{ id: 'empty', chapterId: null, parentChapterId: null, startIndex: 0, endIndex: 0 }];
    }

    const chs = currentBook?.chapters ?? [];
    const result: FlatSection[] = [];

    const pushChunked = (chapterId: string | null, start: number, end: number) => {
      if (end <= start) return;
      let cursor = start;
      let subIdx = 0;
      while (cursor < end) {
        const next = Math.min(end, cursor + MAX_SECTION_CHARS);
        const id = chapterId
          ? (subIdx === 0 ? chapterId : `${chapterId}__${subIdx}`)
          : `__chunk__:${cursor}`;
        result.push({
          id,
          chapterId: chapterId && subIdx === 0 ? chapterId : null,
          parentChapterId: chapterId,
          startIndex: cursor,
          endIndex: next,
        });
        cursor = next;
        subIdx += 1;
      }
    };

    if (chs.length === 0) {
      pushChunked(null, 0, content.length);
      return result;
    }

    const sorted = [...chs].sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0));
    const firstStart = sorted[0].startIndex ?? 0;
    if (firstStart > 0) {
      pushChunked(null, 0, firstStart);
    }
    for (let i = 0; i < sorted.length; i += 1) {
      const start = sorted[i].startIndex ?? 0;
      const end = i + 1 < sorted.length ? (sorted[i + 1].startIndex ?? content.length) : content.length;
      pushChunked(sorted[i].id, start, end);
    }
    return result;
  }, [currentBook?.content, currentBook?.chapters]);

  // 工具：根据 position 找到所属 section index（二分）
  const findSectionIdxByPosition = useCallback((position: number) => {
    const sections = flatSections;
    if (sections.length === 0) return 0;
    let lo = 0;
    let hi = sections.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((sections[mid].startIndex ?? 0) <= position) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }, [flatSections]);

  // 按段估算高度：用 paginationFontSize（debounce 后）+ 容器宽度估算每行字符数和行高，
  // 然后按 \n 分段累加每段行数。中文小说基本接近真实高度，scrollHeight 不会大幅跳变。
  const layoutMetrics = useMemo(() => {
    const fontSize = paginationFontSize;
    const contentWidth = Math.max(220, Math.min(672, readerSize.width - 48));
    const estimatedCharWidth = Math.max(12, fontSize * 1.02);
    const estimatedLineHeight = Math.max(22, fontSize * 1.68);
    const charsPerLine = Math.max(8, Math.floor(contentWidth / estimatedCharWidth));
    return { charsPerLine, lineHeight: estimatedLineHeight };
  }, [paginationFontSize, readerSize.width]);

  // 段内换行数缓存：一次扫描，后续 layoutMetrics 改变只需要重新乘以行高，不必再扫文本
  const sectionNewlineCounts = useMemo<number[]>(() => {
    const content = currentBook?.content ?? '';
    if (!content || flatSections.length === 0) return [];
    const counts: number[] = new Array(flatSections.length);
    for (let i = 0; i < flatSections.length; i += 1) {
      const s = flatSections[i];
      let n = 0;
      for (let j = s.startIndex; j < s.endIndex; j += 1) {
        if (content.charCodeAt(j) === 10 /* \n */) n += 1;
      }
      counts[i] = n;
    }
    return counts;
  }, [flatSections, currentBook?.content]);

  const sectionHeightEstimates = useMemo<number[]>(() => {
    if (flatSections.length === 0) return [];
    const { charsPerLine, lineHeight } = layoutMetrics;
    const out: number[] = new Array(flatSections.length);
    for (let i = 0; i < flatSections.length; i += 1) {
      const s = flatSections[i];
      const len = Math.max(0, s.endIndex - s.startIndex);
      if (len === 0) {
        out[i] = 0;
        continue;
      }
      // 字符行数 + 段落换行造成的额外行数；leading-relaxed (1.625) 已经包含段间距，所以不再额外补
      const wrapLines = Math.max(1, Math.ceil(len / charsPerLine));
      const extraLines = sectionNewlineCounts[i] ?? 0;
      out[i] = (wrapLines + extraLines) * lineHeight;
    }
    return out;
  }, [flatSections, layoutMetrics, sectionNewlineCounts]);

  // 渲染窗口：当前 section 前 SECTION_RENDER_BEFORE / 后 SECTION_RENDER_AFTER。
  // 用 state 而不是直接由 currentPosition 派生，是为了不在每次 scroll 时疯狂重渲染。
  const [renderWindow, setRenderWindow] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

  // 切书 / sections 重建时，把窗口重新对齐到保存的阅读位置
  useEffect(() => {
    if (!currentBook || flatSections.length === 0) {
      setRenderWindow({ start: 0, end: 0 });
      return;
    }
    const savedPosition = Number.isFinite(currentBook.position) ? (currentBook.position ?? 0) : 0;
    const idx = (() => {
      let lo = 0;
      let hi = flatSections.length - 1;
      let found = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((flatSections[mid].startIndex ?? 0) <= savedPosition) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return found;
    })();
    const start = Math.max(0, idx - SECTION_RENDER_BEFORE);
    const end = Math.min(flatSections.length - 1, idx + SECTION_RENDER_AFTER);
    setRenderWindow(prev => (prev.start === start && prev.end === end) ? prev : { start, end });
  }, [currentBook?.id, flatSections]);

  // 实时同步运行时的 currentPage / totalPages / progress 到 books 状态（不会立刻写盘——saveBookProgressDebounced 自己 600ms debounce）
  useEffect(() => {
    if (currentBook && totalPages > 0) {
      const currentPage = Math.min(totalPages, Math.max(1, Math.floor(currentPosition / charsPerPage) + 1));
      const progress = currentBook.content.length > 0
        ? Math.min(100, Math.round((currentPosition / currentBook.content.length) * 100))
        : 0;

      if (
        currentBook.totalPages !== totalPages ||
        currentBook.currentPage !== currentPage ||
        currentBook.progress !== progress ||
        currentBook.position !== currentPosition
      ) {
        setBooks(prev => prev.map(b => b.id === currentBook.id ? { ...b, currentPage, totalPages, progress, position: currentPosition } : b));
        saveBookProgressDebounced({
          id: currentBook.id,
          currentPage,
          totalPages,
          progress,
          position: currentPosition,
        });
      }
    }
  }, [currentBook, totalPages, charsPerPage, currentPosition]);

  // 排序后的书籍列表
  const sortedBooks = useMemo(() => {
    return [...books].sort((a, b) => {
      if (settings.bookshelfSort === 'recent') {
        const timeA = a.lastReadAt ? new Date(a.lastReadAt).getTime() : 0;
        const timeB = b.lastReadAt ? new Date(b.lastReadAt).getTime() : 0;
        return timeB - timeA; // 倒序
      } else {
        return a.progress - b.progress; // 从低到高
      }
    });
  }, [books, settings.bookshelfSort]);

  // 进入阅读器
  const handleOpenBook = async (bookId: string) => {
    const now = new Date();
    const formattedTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    let loadedBook: Book | null = null;

    if (window.readerAPI?.openBook) {
      try {
        const result = await window.readerAPI.openBook(bookId);

        if (!result.ok) {
          showToast(result.errorMessage);
          return;
        }

        if (!result.book) {
          showToast('书籍不存在。');
          return;
        }

        loadedBook = result.book;
      } catch (error) {
        console.error('Failed to open book:', error);
        showToast('打开书籍失败。');
        return;
      }
    }
    
    setBooks(prev => prev.map(b => b.id === bookId ? { ...b, ...(loadedBook ?? {}), lastReadAt: formattedTime } : b));
    saveBookProgressNow({
      id: bookId,
      lastReadAt: formattedTime,
    });
    setCurrentBookId(bookId);
    setCatalogTab('toc');
    setView('reader');
  };

  // 返回书架
  const handleBackToBookshelf = () => {
    flushPendingProgressSave();
    setView('bookshelf');
    setIsCatalogOpen(false);
    setIsSettingsOpen(false);
    setCatalogTab('toc');
  };

  // 导入 TXT 文件：读取内容、解析目录、复制到软件管理目录并写入本地书架。
  const handleImportMockBook = async () => {
    if (!window.readerAPI?.selectTxtFile) {
      showToast('当前运行环境未接入 Electron，本地文件选择功能仅在 Electron 窗口中可用。');
      return;
    }

    try {
      const selectedFile = await window.readerAPI.selectTxtFile();

      if (!selectedFile) {
        showToast('已取消选择文件');
        return;
      }

      if (!selectedFile.ok) {
        showToast(selectedFile.errorMessage);
        return;
      }

      const title = selectedFile.fileName.replace(/\.txt$/i, '');
      const existingBook = books.find((book) => book.title === title);
      let replaceBookId: string | undefined;

      if (existingBook) {
        const shouldSkip = window.confirm(`书架中已存在《${title}》，是否跳过？\n\n确定：跳过\n取消：覆盖并重置阅读进度`);

        if (shouldSkip) {
          showToast(`已跳过《${title}》`);
          return;
        }

        replaceBookId = existingBook.id;
      }

      const importCharsPerPage = Math.max(200, 600 - (paginationFontSize - 16) * 15);
      const importedTotalPages = Math.max(1, Math.ceil(selectedFile.content.length / importCharsPerPage));
      const importResult = await window.readerAPI.importTxtBook({
        originalPath: selectedFile.filePath,
        replaceBookId,
        title,
        currentPage: 1,
        totalPages: importedTotalPages,
        progress: 0,
        lastReadAt: null,
      });

      if (!importResult.ok) {
        showToast(importResult.errorMessage);
        return;
      }

      setBooks(prev => replaceBookId
        ? prev.map(book => book.id === replaceBookId ? importResult.book : book)
        : [importResult.book, ...prev]
      );

      const fileSizeKb = (selectedFile.fileSize / 1024).toFixed(1);
      showToast(`已读取 ${selectedFile.fileName}（${selectedFile.encoding}，${fileSizeKb} KB，${selectedFile.totalChars} 字）`);
    } catch (error) {
      console.error('Failed to select txt file:', error);
      showToast('选择 TXT 文件失败，请稍后重试。');
    }
  };

  // 确认删除书籍
  const handleConfirmDelete = async () => {
    if (deleteConfirmBook) {
      try {
        if (window.readerAPI?.deleteBook) {
          const result = await window.readerAPI.deleteBook(deleteConfirmBook.id);

          if (!result.ok) {
            showToast(result.errorMessage);
            return;
          }
        }

        setBooks(prev => prev.filter(b => b.id !== deleteConfirmBook.id));
        showToast(`已从书架移除《${deleteConfirmBook.title}》`);
        setDeleteConfirmBook(null);
      } catch (error) {
        console.error('Failed to delete book:', error);
        showToast('删除书籍失败。');
      }
    }
  };

  // section 锚定优先：找到 position 所在 section，scrollTop = section.offsetTop + 段内比例 * section.offsetHeight。
  // 由于占位 section 也在 DOM 中且 offsetTop 是真实的，无论目标段是否真渲染了文字，二分定位都能命中。
  // 若目标段当前不在渲染窗口里，先把渲染窗口扩到它，再等两次 RAF 后再滚动。
  const scrollToPosition = useCallback((position: number) => {
    const container = scrollContainerRef.current;
    if (!currentBook || !container || flatSections.length === 0) return;
    const contentLength = currentBook.content.length;
    if (contentLength <= 0) {
      container.scrollTop = 0;
      return;
    }

    const safePosition = Math.max(0, Math.min(position, Math.max(0, contentLength - 1)));
    suppressScrollSyncUntilRef.current = performance.now() + 600;

    const targetIdx = findSectionIdxByPosition(safePosition);
    const section = flatSections[targetIdx];

    // 确保目标段在窗口内；如果不在，扩窗口（这里 setState 安全，因为 scrollToPosition 调用频次不高）
    setRenderWindow(prev => {
      if (targetIdx >= prev.start && targetIdx <= prev.end) return prev;
      return {
        start: Math.max(0, targetIdx - SECTION_RENDER_BEFORE),
        end: Math.min(flatSections.length - 1, targetIdx + SECTION_RENDER_AFTER),
      };
    });

    const performScroll = () => {
      const el = sectionRefMap.current.get(section.id);
      if (!el) return;
      const sLen = Math.max(1, section.endIndex - section.startIndex);
      const within = Math.max(0, Math.min(0.999, (safePosition - section.startIndex) / sLen));
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const desired = el.offsetTop + within * el.offsetHeight;
      container.scrollTop = Math.min(maxScrollTop, Math.max(0, desired));
    };

    // 两次 RAF：等 React 把扩窗后的 sections 渲染好、布局完成后再用 ref 计算 offsetTop
    requestAnimationFrame(() => requestAnimationFrame(performScroll));
  }, [currentBook?.id, currentBook?.content.length, flatSections, findSectionIdxByPosition]);

  // 给 ResizeObserver / 字号 effect 用的 ref（这些 effect 不能把 scrollToPosition 写进依赖，否则会被重建）
  useEffect(() => {
    scrollToPositionRef.current = scrollToPosition;
  }, [scrollToPosition]);

  // 维护 currentPositionRef，供 anchor 捕获使用
  useEffect(() => {
    currentPositionRef.current = currentPosition;
  }, [currentPosition]);

  // 统一更新阅读位置、运行时页码与进度；长期定位以 position 为准。
  const updateCurrentPosition = useCallback((position: number) => {
    if (!currentBook) return;
    const total = totalPages;
    const maxPosition = Math.max(0, currentBook.content.length - 1);
    const safePosition = Math.min(maxPosition, Math.max(0, Math.floor(position)));
    const safePage = Math.min(total, Math.max(1, Math.floor(safePosition / charsPerPage) + 1));
    const progressPercent = currentBook.content.length > 0
      ? Math.min(100, Math.round((safePosition / currentBook.content.length) * 100))
      : 0;
    
    setBooks(prev => prev.map(b => b.id === currentBook.id ? {
      ...b,
      currentPage: safePage,
      totalPages: total,
      position: safePosition,
      progress: progressPercent
    } : b));
    saveBookProgressDebounced({
      id: currentBook.id,
      currentPage: safePage,
      totalPages: total,
      progress: progressPercent,
      position: safePosition,
    });
  }, [charsPerPage, currentBook?.content.length, currentBook?.id, totalPages]);

  // 翻页按钮 / 键盘左右键 / 点击翻页 都基于"滚动一屏"实现，正文始终连续渲染，滚轮 + 触摸板继续是自然连续滚动。
  const scrollByViewport = useCallback((direction: 1 | -1) => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const overlap = 40;
    const delta = Math.max(80, container.clientHeight - overlap) * direction;
    const next = Math.max(0, Math.min(maxScrollTop, container.scrollTop + delta));
    suppressScrollSyncUntilRef.current = performance.now() + 200;
    container.scrollTop = next;
    return true;
  }, []);

  const goToPreviousPage = useCallback(() => {
    if (!currentBook) return;
    const container = scrollContainerRef.current;
    if (container && container.scrollTop <= 1) {
      showToast('已经是开头了');
      return;
    }
    scrollByViewport(-1);
  }, [currentBook?.id, scrollByViewport]);

  const goToNextPage = useCallback(() => {
    if (!currentBook) return;
    const container = scrollContainerRef.current;
    if (container) {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      if (maxScrollTop - container.scrollTop <= 1) {
        showToast('已经是最后一页了');
        return;
      }
    }
    scrollByViewport(1);
  }, [currentBook?.id, scrollByViewport]);

  // 点击翻页模式下，左 / 右半屏点击 = 翻一页（滚动一屏）；划词时不触发翻页。
  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (settings.pageMode !== 'click' || !currentBook) return;
    if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    if (clickX < rect.width / 2) {
      goToPreviousPage();
    } else {
      goToNextPage();
    }
  };

  const currentChapter = useMemo(() => {
    if (!currentBook?.chapters.length) return null;
    let matched: Chapter | null = null;

    for (const chapter of currentBook.chapters) {
      if (chapter.startIndex <= currentPosition) {
        matched = chapter;
      } else {
        break;
      }
    }

    return matched;
  }, [currentBook?.chapters, currentPosition]);

  const currentBookmarks = useMemo(
    () => currentBook?.bookmarks ?? [],
    [currentBook?.bookmarks]
  );

  const currentPageBookmarks = useMemo(() => {
    if (!currentBook) return [];
    const pageEnd = currentPosition + charsPerPage;
    return currentBookmarks.filter((bookmark) => {
      const position = Number.isFinite(bookmark.position) ? bookmark.position ?? -1 : -1;
      return position >= currentPosition && position < pageEnd;
    });
  }, [charsPerPage, currentBook?.id, currentBookmarks, currentPosition]);

  const currentPageBookmark = currentPageBookmarks?.[0] ?? null;

  const visibleBookmarkMarkers = useMemo(() => {
    if (!currentBook) return [];
    const visibleStart = currentPosition;
    const visibleEnd = settings.pageMode === 'scroll'
      ? currentPosition + charsPerPage * 2
      : currentPosition + charsPerPage;

    return currentBookmarks.filter((bookmark) => {
      const position = Number.isFinite(bookmark.position) ? bookmark.position ?? -1 : -1;
      return position >= visibleStart && position < visibleEnd;
    });
  }, [charsPerPage, currentBook?.id, currentBookmarks, currentPosition, settings.pageMode]);

  const catalogViewData = useMemo(() => {
    const chapters = currentBook?.chapters ?? [];
    const volumes = currentBook?.volumes ?? [];
    const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
    const orphans = chapters.filter((chapter) => !chapter.volumeId);
    const groupedVolumes = volumes.map((volume) => ({
      volume,
      chapters: volume.chapterIds
        .map((chapterId) => chapterById.get(chapterId))
        .filter((chapter): chapter is Chapter => Boolean(chapter)),
    }));

    return {
      chapters,
      volumes,
      orphans,
      groupedVolumes,
      hasChapters: chapters.length > 0,
      hasVolumes: volumes.length > 0,
    };
  }, [currentBook?.chapters, currentBook?.volumes]);

  useEffect(() => {
    if (!isCatalogOpen || catalogTab !== 'toc' || !currentChapter?.id) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      const target = catalogScrollRef.current?.querySelector<HTMLElement>(`[data-chapter-id="${currentChapter.id}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'auto' });
    });

    return () => cancelAnimationFrame(frameId);
  }, [catalogTab, currentChapter?.id, isCatalogOpen]);

  const saveBookmarks = (bookId: string, bookmarks: Bookmark[]) => {
    const savePromise = window.readerAPI?.updateBookBookmarks?.({ id: bookId, bookmarks });

    if (savePromise) {
      void savePromise.catch((error) => {
        console.error('Failed to save bookmarks:', error);
      });
    }
  };

  const handleToggleBookmark = () => {
    if (!currentBook) return;

    const nextBookmarks = currentPageBookmark
      ? currentBookmarks.filter((bookmark) => bookmark.id !== currentPageBookmark.id)
      : [
          ...currentBookmarks,
          {
            id: `bookmark-${Date.now()}`,
            bookId: currentBook.id,
            title: currentChapter?.title || `第 ${currentBook.currentPage} 页`,
            chapterTitle: currentChapter?.title,
            pageIndex: currentBook.currentPage,
            position: currentPosition,
            previewText: currentBook.content
              .slice(currentPosition, currentPosition + 90)
              .replace(/\s+/g, ' ')
              .trim(),
            createdAt: Date.now(),
          },
        ];

    setBooks(prev => prev.map(book => book.id === currentBook.id ? { ...book, bookmarks: nextBookmarks } : book));
    saveBookmarks(currentBook.id, nextBookmarks);
    showToast(currentPageBookmark ? '已取消当前页书签' : '已添加书签');
  };

  const handleBookmarkJump = (bookmark: Bookmark) => {
    const targetPosition = typeof bookmark.position === 'number'
      ? bookmark.position
      : Math.max(0, ((bookmark.pageIndex ?? 1) - 1) * charsPerPage);

    anchorPositionRef.current = targetPosition;
    suppressScrollSyncUntilRef.current = performance.now() + 800;
    updateCurrentPosition(targetPosition);
    scrollToPosition(targetPosition);
    setIsCatalogOpen(false);
    showToast('已跳转到书签');
  };

  const handleDeleteBookmark = (bookmarkId: string, e?: React.MouseEvent<HTMLButtonElement>) => {
    e?.stopPropagation();
    if (!currentBook) return;

    const nextBookmarks = currentBookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
    setBooks(prev => prev.map(book => book.id === currentBook.id ? { ...book, bookmarks: nextBookmarks } : book));
    saveBookmarks(currentBook.id, nextBookmarks);
    showToast('已删除书签');
  };

  const handleReparseToc = async () => {
    if (!currentBook || !window.readerAPI?.reparseBookToc) return;

    try {
      const result = await window.readerAPI.reparseBookToc(currentBook.id);

      if (!result.ok) {
        showToast(result.errorMessage);
        return;
      }

      const reparsedBook = result.book;
      if (reparsedBook) {
        setBooks(prev => prev.map(book => book.id === currentBook.id ? { ...book, ...reparsedBook, content: reparsedBook.content || book.content } : book));
      }

      showToast('目录已重新识别');
    } catch (error) {
      console.error('Failed to reparse toc:', error);
      showToast('重新识别目录失败。');
    }
  };

  // 章节跳转：以章节 startIndex 作为目标 position，由 scrollToPosition 负责
  // （包含"目标段不在窗口时先扩窗口再 RAF 定位"），并立即抑制 scroll 监听器写回，避免 anchor 漂移。
  const handleChapterJump = (chapter: Chapter) => {
    const targetPosition = chapter.startIndex ?? 0;
    anchorPositionRef.current = targetPosition;
    suppressScrollSyncUntilRef.current = performance.now() + 800;
    updateCurrentPosition(targetPosition);
    scrollToPosition(targetPosition);
    setIsCatalogOpen(false);
    showToast('已跳转到指定章节');
  };

  // 重新排版后（窗口大小 / 字号变化 / 切书 / sections 变化 / 渲染窗口变化），
  // 重新测量每个 section 的 top/height。包括占位 section（offsetTop 来自其 minHeight 估算）。
  useEffect(() => {
    if (view !== 'reader' || !currentBook || !scrollContainerRef.current) return;

    let frameId: number | null = null;
    const recompute = () => {
      frameId = null;
      const entries: Array<{ idx: number; startIndex: number; endIndex: number; top: number; height: number }> = [];
      for (let i = 0; i < flatSections.length; i += 1) {
        const s = flatSections[i];
        const el = sectionRefMap.current.get(s.id);
        if (!el) continue;
        entries.push({
          idx: i,
          startIndex: s.startIndex,
          endIndex: s.endIndex,
          top: el.offsetTop,
          height: el.offsetHeight,
        });
      }
      entries.sort((a, b) => a.top - b.top);
      sectionOffsetsRef.current = entries;
    };

    frameId = requestAnimationFrame(recompute);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [view, currentBook?.id, flatSections, renderWindow.start, renderWindow.end, readerSize.width, readerSize.height, paginationFontSize, settings.pageMode]);

  // 滚动监听：RAF 节流；用 section offsetTop 二分；resize/字号/编程跳转期间被 suppress 抑制；
  // 同时根据当前 scrollTop 所在 section 决定是否扩展渲染窗口（接近边界时再扩，不每次都 setState）。
  useEffect(() => {
    if (view !== 'reader' || !currentBook || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    lastScrollSyncRef.current = { at: performance.now(), position: currentPositionRef.current };

    // 进入阅读器或换书时还原到保存的 position（用 ref，避免被 currentPosition 依赖耦合）
    requestAnimationFrame(() => scrollToPosition(currentPositionRef.current));

    const handleScroll = () => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        // resize / 字号 / 编程跳转期间，scroll listener 不写回 position（防止 anchor 被覆盖）
        if (isAdjustingSizeRef.current || isAdjustingFontRef.current) return;
        const now = performance.now();
        if (now < suppressScrollSyncUntilRef.current) return;

        const scrollTop = container.scrollTop;
        const offsets = sectionOffsetsRef.current;
        let position = 0;
        let activeSectionIdx = -1;

        if (offsets.length > 0) {
          // 二分找到 top <= scrollTop 的最后一个 section
          let lo = 0;
          let hi = offsets.length - 1;
          let activeIdx = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (offsets[mid].top <= scrollTop + 4) {
              activeIdx = mid;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
          if (activeIdx >= 0) {
            const sec = offsets[activeIdx];
            const within = sec.height > 0 ? Math.max(0, Math.min(0.999, (scrollTop - sec.top) / sec.height)) : 0;
            position = Math.round(sec.startIndex + within * (sec.endIndex - sec.startIndex));
            activeSectionIdx = sec.idx;
          } else {
            const maxScroll = Math.max(1, container.scrollHeight - container.clientHeight);
            const contentLen = currentBook.content.length;
            position = Math.round((scrollTop / maxScroll) * contentLen);
          }
        } else {
          const maxScroll = Math.max(1, container.scrollHeight - container.clientHeight);
          const contentLen = currentBook.content.length;
          position = Math.round((scrollTop / maxScroll) * contentLen);
        }

        // 渲染窗口跟随：仅在接近边界时才扩窗口；正常滚动不触发任何 setState
        if (activeSectionIdx >= 0) {
          setRenderWindow(prev => {
            const buffer = 1; // 距离窗口边界 buffer 个 section 内开始扩
            if (activeSectionIdx > prev.start + buffer && activeSectionIdx < prev.end - buffer) {
              return prev;
            }
            const nextStart = Math.max(0, activeSectionIdx - SECTION_RENDER_BEFORE);
            const nextEnd = Math.min(flatSections.length - 1, activeSectionIdx + SECTION_RENDER_AFTER);
            if (nextStart === prev.start && nextEnd === prev.end) return prev;
            return { start: nextStart, end: nextEnd };
          });
        }

        // 节流：滚动过程中限制 setState 频率，避免 React 重渲染过快
        const last = lastScrollSyncRef.current;
        if (now - last.at < 160 && Math.abs(position - last.position) < Math.max(120, charsPerPage / 3)) {
          return;
        }
        lastScrollSyncRef.current = { at: now, position };
        updateCurrentPosition(position);
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [view, charsPerPage, currentBook?.content.length, currentBook?.id, flatSections.length, scrollToPosition, updateCurrentPosition]);

  // 切书 / pageMode 切换后做一次 anchor 回滚（窗口尺寸 / 字号变化的回滚已经由它们各自的 debounce 完成）。
  // 这里专门处理 view/book/pageMode 等"非用户操作触发"的重排版。
  useEffect(() => {
    if (view !== 'reader' || !currentBook || !scrollContainerRef.current) return;
    const frameId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // 切书 / pageMode 切换时，anchor 取保存的 position，不取实时 ref（避免被滚动残留污染）
        const savedPosition = Number.isFinite(currentBook.position) ? (currentBook.position ?? 0) : 0;
        scrollToPositionRef.current?.(savedPosition);
      });
    });
    return () => cancelAnimationFrame(frameId);
    // 故意不把 readerSize / paginationFontSize 写进依赖：它们的 anchor 回滚由各自 debounce effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentBook?.id, settings.pageMode]);

  useEffect(() => {
    if (view !== 'reader' || !currentBook || isCatalogOpen || isSettingsOpen || deleteConfirmBook) {
      return;
    }

    const isInteractiveTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName.toLowerCase();
      return (
        ['input', 'textarea', 'select', 'button'].includes(tagName) ||
        target.getAttribute('role') === 'slider' ||
        target.isContentEditable
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToNextPage();
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToPreviousPage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    view,
    currentBook?.id,
    currentBook?.currentPage,
    isCatalogOpen,
    isSettingsOpen,
    deleteConfirmBook,
    goToNextPage,
    goToPreviousPage,
  ]);

  // 主题样式映射
  const themeStyles = {
    light: {
      bg: '#F7F7F3',
      text: '#202124',
      uiBg: '#FFFFFF',
      uiBorder: '#E0E0D8',
      uiTextMuted: '#5F6368',
      accent: '#4F46E5'
    },
    dark: {
      bg: '#101214',
      text: '#D8D8D8',
      uiBg: '#1A1D21',
      uiBorder: '#2D3139',
      uiTextMuted: '#888E96',
      accent: '#6366F1'
    },
    eyeCare: {
      bg: '#DCE8D2',
      text: '#243024',
      uiBg: '#E6F0DC',
      uiBorder: '#C8D5BC',
      uiTextMuted: '#4A5A4A',
      accent: '#15803D'
    }
  };

  const currentStyle = themeStyles[settings.theme];

  return (
    <div 
      className="w-full h-screen flex flex-col font-sans select-none overflow-hidden transition-colors duration-200"
      style={{ backgroundColor: currentStyle.bg, color: currentStyle.text }}
    >
      
      {/* ==========================================
          4. 书架页面 
          ========================================== */}
      {view === 'bookshelf' && (
        <div className="flex-1 flex flex-col h-full overflow-hidden p-4 sm:p-6 max-w-6xl w-full mx-auto">
          {/* 顶部工具栏 */}
          <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-4 pb-4 sm:pb-5 border-b mb-4 sm:mb-6" style={{ borderColor: currentStyle.uiBorder }}>
            <div className="flex items-center space-x-3 min-w-0">
              <span className="text-xl sm:text-2xl font-bold tracking-wide">摸鱼神器</span>
              <span className="hidden sm:inline text-xs px-2 py-0.5 rounded border font-mono" style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}>Windows P0 原型版</span>
            </div>

            <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
              {/* 排序选择器 */}
              <div className="flex items-center space-x-2 text-sm">
                <span style={{ color: currentStyle.uiTextMuted }}>排序方式:</span>
                <select
                  value={settings.bookshelfSort}
                  onChange={(e) => setSettings(prev => ({ ...prev, bookshelfSort: e.target.value as 'recent' | 'progress' }))}
                  className="rounded px-2 py-1 outline-none border text-xs cursor-pointer font-medium"
                  style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                >
                  <option value="recent">最近阅读时间倒序</option>
                  <option value="progress">阅读进度从低到高</option>
                </select>
              </div>

              {/* 导入按钮 */}
              <button
                onClick={handleImportMockBook}
                className="flex items-center space-x-1.5 px-4 py-1.5 rounded text-sm font-medium shadow-sm active:scale-95 transition-all text-white"
                style={{ backgroundColor: currentStyle.accent }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span>导入 TXT 小说</span>
              </button>
            </div>
          </div>

          {/* 书籍列表区域 */}
          <div className="flex-1 overflow-y-auto pr-1">
            {sortedBooks.length === 0 ? (
              <div className="h-64 flex flex-col items-center justify-center space-y-2">
                <svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth="1" viewBox="0 0 24 24" style={{ color: currentStyle.uiTextMuted }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
                <p className="text-sm font-medium" style={{ color: currentStyle.uiTextMuted }}>书架空空如也，请点击右上角导入书籍</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-6">
                {sortedBooks.map(book => (
                  <div
                    key={book.id}
                    onClick={() => handleOpenBook(book.id)}
                    className="group relative border p-4 rounded-lg cursor-pointer shadow-sm hover:shadow-md transition-all flex flex-col justify-between"
                    style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
                  >
                    <div>
                      {/* 书名与删除按钮 */}
                      <div className="flex justify-between items-start mb-2">
                        <h3 className="font-bold text-base line-clamp-1 group-hover:text-indigo-500 transition-colors">
                          {book.title}
                        </h3>
                        <button
                          onClick={(e) => {
                            e.stopPropagation(); // 14. 阻止事件冒泡防止进入阅读器
                            setDeleteConfirmBook(book);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/10 text-red-500 transition-all"
                          title="从书架移除"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-4v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>

                      {/* 导入来源 */}
                      <p className="text-xs font-mono line-clamp-1 mb-4" style={{ color: currentStyle.uiTextMuted }}>
                        {book.originalPath ? '本地 TXT' : '示例书籍'}
                      </p>
                    </div>

                    {/* 进度与时间信息 */}
                    <div className="mt-4 pt-3 border-t" style={{ borderColor: currentStyle.uiBorder }}>
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="font-semibold" style={{ color: currentStyle.accent }}>
                          进度：{book.progress}%
                        </span>
                        <span className="text-[10px] uppercase font-bold border px-1 rounded" style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}>
                          {book.encoding}
                        </span>
                      </div>
                      
                      {/* 进度条可视化 */}
                      <div className="w-full h-1.5 rounded-full overflow-hidden mb-2" style={{ backgroundColor: currentStyle.bg }}>
                        <div 
                          className="h-full transition-all duration-300" 
                          style={{ width: `${book.progress}%`, backgroundColor: currentStyle.accent }}
                        />
                      </div>

                      <div className="text-[11px] flex justify-between" style={{ color: currentStyle.uiTextMuted }}>
                        <span>字数: {formatWordCount(book)}</span>
                        <span>最近阅读: {book.lastReadAt || '从未'}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==========================================
          5. 阅读器页面
          ========================================== */}
      {view === 'reader' && currentBook && (
        <div className="flex-1 flex flex-col h-full relative overflow-hidden">
          
          {/* 5.2 顶部栏 */}
          <div
            className="h-12 border-b px-2 sm:px-4 flex items-center justify-between select-none z-10 gap-2"
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()} // 14. 顶部栏点击不能触发翻页
          >
            <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
              <button
                onClick={handleBackToBookshelf}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs border font-medium hover:opacity-80 transition-all flex-shrink-0"
                style={{ borderColor: currentStyle.uiBorder }}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                <span className="hidden sm:inline">返回书架</span>
              </button>
              <h2 className="font-bold text-sm truncate min-w-0">{currentBook.title}</h2>
            </div>

            <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
              <button
                onClick={() => { setCatalogTab('toc'); setIsCatalogOpen(true); setIsSettingsOpen(false); }}
                className="flex items-center space-x-1 px-3 py-1 rounded text-xs border font-medium hover:opacity-80 transition-all"
                style={{ borderColor: currentStyle.uiBorder }}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
                </svg>
                <span>目录</span>
              </button>

              <button
                onClick={handleToggleBookmark}
                className="flex items-center space-x-1 px-3 py-1 rounded text-xs border font-medium hover:opacity-80 transition-all"
                style={{
                  borderColor: currentPageBookmark ? currentStyle.accent : currentStyle.uiBorder,
                  color: currentPageBookmark ? currentStyle.accent : currentStyle.text,
                }}
              >
                <svg className="w-3.5 h-3.5" fill={currentPageBookmark ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z" />
                </svg>
                <span>书签</span>
              </button>

              <button
                onClick={() => { setIsSettingsOpen(prev => !prev); setIsCatalogOpen(false); }}
                className="flex items-center space-x-1 px-3 py-1 rounded text-xs border font-medium hover:opacity-80 transition-all"
                style={{ borderColor: currentStyle.uiBorder }}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span>设置</span>
              </button>
            </div>
          </div>

          {/* 6. 正文阅读区域：滚动模式 + 点击模式共用同一个 overflow-y-auto 容器，
                 章节按 section 切片以便 scrollIntoView，滚轮 / 触摸板始终走原生连续滚动。 */}
          <div ref={readerViewportRef} className="flex-1 w-full relative flex flex-col overflow-hidden">
            <div
              ref={scrollContainerRef}
              onClick={settings.pageMode === 'click' ? handlePageClick : undefined}
              className={`flex-1 w-full overflow-y-auto overscroll-contain relative px-4 sm:px-6 md:px-8 pt-4 sm:pt-6 flex justify-center select-text ${settings.pageMode === 'click' ? 'cursor-pointer' : ''}`}
            >
              <div
                ref={contentTextRef}
                className="w-full max-w-2xl whitespace-pre-wrap leading-relaxed tracking-wide font-serif break-words"
                style={{ fontSize: `${settings.fontSize}px`, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }}
                onClick={(e) => {
                  // 划词选中时，点击不应该触发翻页
                  if (settings.pageMode === 'click' && typeof window !== 'undefined' && window.getSelection()?.toString()) {
                    e.stopPropagation();
                  }
                }}
              >
                {flatSections.map((section, idx) => {
                  const inWindow = idx >= renderWindow.start && idx <= renderWindow.end;
                  const estimatedHeight = sectionHeightEstimates[idx] ?? 0;
                  // 不在窗口的段：渲染成等高占位 <section>（不包文本，浏览器不会对它做行布局）；
                  // 这样 scrollHeight 接近真实值，自然连续滚动手感不变，但只有 ~6 段文本会真正 reflow。
                  const text = inWindow
                    ? (currentBook.content ?? '').slice(section.startIndex, section.endIndex)
                    : '';
                  return (
                    <section
                      key={`${currentBook.id}:${section.id}`}
                      data-section-id={section.id}
                      data-section-idx={idx}
                      data-section-start={section.startIndex}
                      data-chapter-id={section.chapterId || ''}
                      style={inWindow ? undefined : { height: estimatedHeight, minHeight: estimatedHeight }}
                      ref={(el) => {
                        if (el) {
                          sectionRefMap.current.set(section.id, el);
                        } else {
                          sectionRefMap.current.delete(section.id);
                        }
                      }}
                    >
                      {text}
                    </section>
                  );
                })}
              </div>
            </div>

            {/* 当前可视范围内有书签时，左上角显示书签 chip。位置基于 bookmark.position，
                 窗口缩放 / 字号变化也能跟着内容流走。 */}
            {visibleBookmarkMarkers.length > 0 && (
              <div className="absolute left-3 top-3 z-20 flex flex-col gap-1 pointer-events-none">
                {visibleBookmarkMarkers.slice(0, 3).map((bookmark) => (
                  <div
                    key={bookmark.id}
                    className="px-2 py-0.5 rounded-full border shadow-sm flex items-center gap-1 backdrop-blur-sm"
                    style={{
                      backgroundColor: `${currentStyle.uiBg}E6`,
                      borderColor: currentStyle.accent,
                      color: currentStyle.accent,
                    }}
                    title={bookmark.previewText || bookmark.title}
                  >
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z" />
                    </svg>
                    <span className="text-[10px] font-medium leading-none">书签</span>
                  </div>
                ))}
              </div>
            )}

            {/* 8. 底部状态栏：进度信息以独立 flex 行存在，不再以 absolute 覆盖正文。 */}
            <div
              className="flex-shrink-0 border-t px-3 py-1.5 flex items-center justify-between text-[11px] font-mono select-none pointer-events-none"
              style={{
                backgroundColor: `${currentStyle.uiBg}E6`,
                borderColor: currentStyle.uiBorder,
                color: currentStyle.uiTextMuted,
              }}
            >
              <span className="truncate max-w-[55%]">
                {currentChapter?.title ? `当前：${currentChapter.title}` : ''}
              </span>
              <span>{currentBook.currentPage} / {totalPages} · {currentBook.progress}%</span>
            </div>
          </div>

          {/* ==========================================
              9. 目录弹窗 (居中弹窗)
              ========================================== */}
          {isCatalogOpen && (
            <div
              className="absolute inset-0 bg-black/40 flex items-center justify-center z-30 animate-fade-in p-4"
              onClick={() => setIsCatalogOpen(false)}
            >
              <div
                className="w-full max-w-[640px] max-h-[86vh] rounded-xl border shadow-2xl flex flex-col overflow-hidden"
                style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
                onClick={(e) => e.stopPropagation()} // 14. 目录弹窗点击不触发翻页
              >
                <div className="px-4 py-3 border-b flex items-center justify-between gap-3" style={{ borderColor: currentStyle.uiBorder }}>
                  <span className="font-bold text-sm flex-shrink-0">书籍目录</span>
                  <div className="flex items-center rounded border overflow-hidden text-xs" style={{ borderColor: currentStyle.uiBorder }}>
                    <button
                      onClick={() => setCatalogTab('toc')}
                      className="px-3 py-1.5 font-medium"
                      style={{
                        backgroundColor: catalogTab === 'toc' ? currentStyle.accent : 'transparent',
                        color: catalogTab === 'toc' ? '#FFFFFF' : currentStyle.text,
                      }}
                    >
                      目录
                    </button>
                    <button
                      onClick={() => setCatalogTab('bookmarks')}
                      className="px-3 py-1.5 font-medium border-l"
                      style={{
                        borderColor: currentStyle.uiBorder,
                        backgroundColor: catalogTab === 'bookmarks' ? currentStyle.accent : 'transparent',
                        color: catalogTab === 'bookmarks' ? '#FFFFFF' : currentStyle.text,
                      }}
                    >
                      书签
                    </button>
                  </div>
                  <button 
                    onClick={() => setIsCatalogOpen(false)}
                    className="text-xs font-bold px-2 py-1 rounded hover:bg-black/5 flex-shrink-0"
                  >
                    关闭
                  </button>
                </div>

                <div className="px-4 py-2 border-b flex items-center justify-between gap-3 text-xs" style={{ borderColor: currentStyle.uiBorder }}>
                  <span style={{ color: currentStyle.uiTextMuted }}>
                    {catalogTab === 'toc'
                      ? `版本 ${currentBook.tocParseVersion ?? 0}/${CURRENT_TOC_PARSE_VERSION} · ${catalogViewData.volumes.length} 卷 · ${catalogViewData.chapters.length} 章`
                      : `${currentBookmarks.length} 个书签`}
                  </span>
                  {catalogTab === 'toc' && (
                    <button
                      onClick={handleReparseToc}
                      className="px-2 py-1 rounded border font-medium hover:opacity-80"
                      style={{ borderColor: currentStyle.uiBorder }}
                    >
                      重新识别目录
                    </button>
                  )}
                </div>

                <div ref={catalogScrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
                  {catalogTab === 'toc' ? (() => {
                    const renderChapterRow = (ch: Chapter) => {
                      const isCurrentCh = currentChapter?.id === ch.id;
                      return (
                        <div
                          key={ch.id}
                          data-chapter-id={ch.id}
                          onClick={() => handleChapterJump(ch)}
                          className="px-2 py-1.5 rounded cursor-pointer transition-colors text-xs flex justify-between items-center hover:bg-black/5"
                          style={{ color: isCurrentCh ? currentStyle.accent : currentStyle.text, fontWeight: isCurrentCh ? 'bold' : 'normal' }}
                        >
                          <span className="truncate pr-2">{ch.title}</span>
                          {isCurrentCh && (
                          <span className="text-[10px] flex-shrink-0" style={{ color: currentStyle.accent }}>
                            当前位置
                          </span>
                          )}
                        </div>
                      );
                    };

                    if (!catalogViewData.hasVolumes && !catalogViewData.hasChapters) {
                      return (
                        <div className="py-8 text-center text-xs" style={{ color: currentStyle.uiTextMuted }}>
                          未识别到章节，可继续无目录阅读
                        </div>
                      );
                    }

                    if (!catalogViewData.hasVolumes) {
                      return <div className="space-y-0.5">{catalogViewData.chapters.map(renderChapterRow)}</div>;
                    }

                    return (
                      <>
                        {catalogViewData.orphans.length > 0 && (
                          <div className="space-y-1">
                            <div className="font-bold text-xs px-2 py-1 rounded opacity-70" style={{ backgroundColor: currentStyle.bg }}>
                              未分卷
                            </div>
                            <div className="pl-3 space-y-0.5">{catalogViewData.orphans.map(renderChapterRow)}</div>
                          </div>
                        )}
                        {catalogViewData.groupedVolumes.map(({ volume, chapters }) => (
                          <div key={volume.id} className="space-y-1">
                            <div className="font-bold text-xs px-2 py-1 rounded opacity-70" style={{ backgroundColor: currentStyle.bg }}>
                              {volume.title}
                            </div>
                            {chapters.length > 0 ? (
                              <div className="pl-3 space-y-0.5">{chapters.map(renderChapterRow)}</div>
                            ) : (
                              <div className="pl-3 py-1 text-[11px]" style={{ color: currentStyle.uiTextMuted }}>
                                本卷暂未识别到章节
                              </div>
                            )}
                          </div>
                        ))}
                      </>
                    );
                  })() : (
                    currentBookmarks.length === 0 ? (
                      <div className="py-8 text-center text-xs" style={{ color: currentStyle.uiTextMuted }}>
                        暂无书签
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {currentBookmarks
                          .slice()
                          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                          .map((bookmark) => (
                            <div
                              key={bookmark.id}
                              onClick={() => handleBookmarkJump(bookmark)}
                              className="p-3 rounded border cursor-pointer hover:bg-black/5 transition-colors"
                              style={{ borderColor: currentStyle.uiBorder }}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-xs font-bold truncate">{bookmark.chapterTitle || bookmark.title}</div>
                                  <div className="text-[11px] mt-1 line-clamp-2" style={{ color: currentStyle.uiTextMuted }}>
                                    {bookmark.previewText || '无预览文本'}
                                  </div>
                                </div>
                                <button
                                  onClick={(e) => handleDeleteBookmark(bookmark.id, e)}
                                  className="text-[11px] px-2 py-1 rounded border flex-shrink-0 hover:bg-red-500/10 text-red-500"
                                  style={{ borderColor: currentStyle.uiBorder }}
                                >
                                  删除
                                </button>
                              </div>
                              <div className="mt-2 flex justify-between text-[10px]" style={{ color: currentStyle.uiTextMuted }}>
                                <span>{formatPositionPercent(bookmark.position, currentBook.totalChars) || '未知位置'}</span>
                                <span>{formatBookmarkTime(bookmark.createdAt)}</span>
                              </div>
                            </div>
                          ))}
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ==========================================
              10. 设置面板 (右侧抽屉面板设计)
              ========================================== */}
          {isSettingsOpen && (
            <div
              className="absolute right-0 top-12 bottom-0 w-72 max-w-[85vw] border-l shadow-xl z-20 p-4 flex flex-col space-y-5 overflow-y-auto animate-slide-in"
              style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
              onClick={(e) => e.stopPropagation()} // 14. 点击设置面板不能触发翻页
            >
              <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: currentStyle.uiBorder }}>
                <span className="font-bold text-xs uppercase tracking-wider" style={{ color: currentStyle.uiTextMuted }}>阅读器设置</span>
                <button onClick={() => setIsSettingsOpen(false)} className="text-xs hover:underline">隐藏</button>
              </div>

              {/* 10.1 翻页模式设置 */}
              <div className="space-y-2">
                <label className="text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>翻页模式</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setSettings(prev => ({ ...prev, pageMode: 'scroll' }))}
                    className="py-1.5 rounded text-xs font-medium border transition-all"
                    style={{ 
                      backgroundColor: settings.pageMode === 'scroll' ? currentStyle.accent : 'transparent',
                      color: settings.pageMode === 'scroll' ? '#FFFFFF' : currentStyle.text,
                      borderColor: settings.pageMode === 'scroll' ? currentStyle.accent : currentStyle.uiBorder
                    }}
                  >
                    滚轮模式
                  </button>
                  <button
                    onClick={() => setSettings(prev => ({ ...prev, pageMode: 'click' }))}
                    className="py-1.5 rounded text-xs font-medium border transition-all"
                    style={{ 
                      backgroundColor: settings.pageMode === 'click' ? currentStyle.accent : 'transparent',
                      color: settings.pageMode === 'click' ? '#FFFFFF' : currentStyle.text,
                      borderColor: settings.pageMode === 'click' ? currentStyle.accent : currentStyle.uiBorder
                    }}
                  >
                    点击翻页
                  </button>
                </div>
              </div>

              {/* 10.2 字号设置 */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <label className="font-semibold" style={{ color: currentStyle.uiTextMuted }}>阅读字号</label>
                  <span className="font-mono font-bold">{settings.fontSize}px</span>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    disabled={settings.fontSize <= 16}
                    onClick={() => setSettings(prev => ({ ...prev, fontSize: Math.max(16, prev.fontSize - 1) }))}
                    className="w-8 h-8 rounded border flex items-center justify-center font-bold disabled:opacity-40 active:bg-black/5"
                    style={{ borderColor: currentStyle.uiBorder }}
                  >
                    -
                  </button>
                  <input
                    type="range"
                    min="16"
                    max="32"
                    step="1"
                    value={settings.fontSize}
                    onChange={(e) => setSettings(prev => ({ ...prev, fontSize: parseInt(e.target.value) }))}
                    className="flex-1 accent-indigo-600 cursor-pointer h-1 rounded-lg"
                    style={{ backgroundColor: currentStyle.bg }}
                  />
                  <button
                    disabled={settings.fontSize >= 32}
                    onClick={() => setSettings(prev => ({ ...prev, fontSize: Math.min(32, prev.fontSize + 1) }))}
                    className="w-8 h-8 rounded border flex items-center justify-center font-bold disabled:opacity-40 active:bg-black/5"
                    style={{ borderColor: currentStyle.uiBorder }}
                  >
                    +
                  </button>
                </div>
              </div>

              {/* 10.3 主题设置 */}
              <div className="space-y-2">
                <label className="text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>阅读主题</label>
                <div className="space-y-2">
                  {/* 白色主题 */}
                  <div
                    onClick={() => setSettings(prev => ({ ...prev, theme: 'light' }))}
                    className="flex items-center justify-between p-2 rounded border cursor-pointer text-xs font-medium transition-all"
                    style={{ 
                      backgroundColor: '#F7F7F3', 
                      color: '#202124',
                      borderColor: settings.theme === 'light' ? '#4F46E5' : '#E0E0D8',
                      borderWidth: settings.theme === 'light' ? '2px' : '1px'
                    }}
                  >
                    <span>白色主题 (默认)</span>
                    <span className="text-[10px] opacity-60">#F7F7F3</span>
                  </div>

                  {/* 黑色主题 */}
                  <div
                    onClick={() => setSettings(prev => ({ ...prev, theme: 'dark' }))}
                    className="flex items-center justify-between p-2 rounded border cursor-pointer text-xs font-medium transition-all"
                    style={{ 
                      backgroundColor: '#101214', 
                      color: '#D8D8D8',
                      borderColor: settings.theme === 'dark' ? '#6366F1' : '#2D3139',
                      borderWidth: settings.theme === 'dark' ? '2px' : '1px'
                    }}
                  >
                    <span>黑色暗夜</span>
                    <span className="text-[10px] opacity-60">#101214</span>
                  </div>

                  {/* 护眼主题 */}
                  <div
                    onClick={() => setSettings(prev => ({ ...prev, theme: 'eyeCare' }))}
                    className="flex items-center justify-between p-2 rounded border cursor-pointer text-xs font-medium transition-all"
                    style={{ 
                      backgroundColor: '#DCE8D2', 
                      color: '#243024',
                      borderColor: settings.theme === 'eyeCare' ? '#15803D' : '#C8D5BC',
                      borderWidth: settings.theme === 'eyeCare' ? '2px' : '1px'
                    }}
                  >
                    <span>极致护眼</span>
                    <span className="text-[10px] opacity-60">#DCE8D2</span>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      )}

      {/* ==========================================
          13. 弹出弹窗 (二次删除确认弹窗)
          ========================================== */}
      {deleteConfirmBook && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4"
          onClick={() => setDeleteConfirmBook(null)}
        >
          <div
            className="w-full max-w-[360px] p-5 rounded-xl border shadow-2xl space-y-4"
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()} // 14. 阻止冒泡
          >
            <h4 className="font-bold text-base text-red-500 flex items-center space-x-1.5">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>确认移除书籍</span>
            </h4>
            <p className="text-xs leading-relaxed" style={{ color: currentStyle.text }}>
              确定要删除《{deleteConfirmBook.title}》吗？此操作不会删除原始文件。
            </p>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setDeleteConfirmBook(null)}
                className="px-3 py-1.5 rounded text-xs border font-medium active:scale-95 transition-all"
                style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              >
                取消
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-3 py-1.5 rounded text-xs font-medium bg-red-600 hover:bg-red-700 text-white active:scale-95 transition-all shadow-sm"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          全局快捷浮动 Toast 提示
          ========================================== */}
      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-bounce">
          <div className="px-4 py-2 bg-neutral-900 text-neutral-100 text-xs rounded-full shadow-xl flex items-center space-x-2 border border-neutral-800">
            <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-medium tracking-wide">{toastMessage}</span>
          </div>
        </div>
      )}

    </div>
  );
}
