import React, { useState, useMemo, useEffect, useRef } from 'react';

// ==========================================
// 11. 数据结构设计 (TypeScript 类型定义)
// ==========================================

export interface Chapter {
  id: string;
  title: string;
  volumeId?: string;
  startIndex: number;
  page?: number;
}

export interface Volume {
  id: string;
  title: string;
  chapterIds: string[];
}

export interface Book {
  id: string;
  title: string;
  filePath: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'gbk' | 'gb18030' | 'unknown';
  totalChars: number;
  chapters: Chapter[];
  volumes: Volume[];
  currentPage: number;
  totalPages: number;
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

// ==========================================
// 12. Mock 数据准备 (包含3本特征各异的小说)
// ==========================================

const INITIAL_BOOKS: Book[] = [
  {
    id: 'book-1',
    title: '仙路风云',
    filePath: 'C:\\Users\\Downloads\\仙路风云.txt',
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
    filePath: 'D:\\Novel\\夜雨江湖.txt',
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
    filePath: 'E:\\Books\\未分章文本.txt',
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
  const [books, setBooks] = useState<Book[]>(INITIAL_BOOKS);
  const [currentBookId, setCurrentBookId] = useState<string | null>(null);
  const [view, setView] = useState<'bookshelf' | 'reader'>('bookshelf');
  
  // 设置状态
  const [settings, setSettings] = useState<ReaderSettings>({
    pageMode: 'click',
    fontSize: 20,
    theme: 'eyeCare',
    bookshelfSort: 'recent'
  });

  // 弹窗与控制状态
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [deleteConfirmBook, setDeleteConfirmBook] = useState<Book | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // 引用
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 弹出提示消息函数
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // 获取当前正在阅读的书籍
  const currentBook = useMemo(() => {
    return books.find(b => b.id === currentBookId) || null;
  }, [books, currentBookId]);

  // 根据书籍内容和字号模拟生成分页页数及各页文本
  // P0 原型中，我们通过简单的字符切分来模拟精准的分页
  const bookPages = useMemo(() => {
    if (!currentBook) return [];
    const text = currentBook.content;
    // 字符数随字号大小改变而改变每页容量
    const charsPerPage = Math.max(200, 600 - (settings.fontSize - 16) * 15);
    const pages: string[] = [];
    let index = 0;
    while (index < text.length) {
      pages.push(text.slice(index, index + charsPerPage));
      index += charsPerPage;
    }
    return pages.length > 0 ? pages : ['暂无内容'];
  }, [currentBook, settings.fontSize]);

  // 实时同步总页数到当前书籍中
  useEffect(() => {
    if (currentBook && bookPages.length > 0) {
      if (currentBook.totalPages !== bookPages.length) {
        setBooks(prev => prev.map(b => b.id === currentBook.id ? { ...b, totalPages: bookPages.length } : b));
      }
    }
  }, [bookPages, currentBook]);

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
  const handleOpenBook = (bookId: string) => {
    const now = new Date();
    const formattedTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    setBooks(prev => prev.map(b => b.id === bookId ? { ...b, lastReadAt: formattedTime } : b));
    setCurrentBookId(bookId);
    setView('reader');
  };

  // 返回书架
  const handleBackToBookshelf = () => {
    setView('bookshelf');
    setIsCatalogOpen(false);
    setIsSettingsOpen(false);
  };

  // 模拟导入新书
  const handleImportMockBook = () => {
    showToast('P0 前端原型中暂不接入真实文件系统，后续由 Electron / 后端接入 txt 导入功能。');
  };

  // 确认删除书籍
  const handleConfirmDelete = () => {
    if (deleteConfirmBook) {
      setBooks(prev => prev.filter(b => b.id !== deleteConfirmBook.id));
      showToast(`已从书架移除《${deleteConfirmBook.title}》`);
      setDeleteConfirmBook(null);
    }
  };

  // 翻页处理 (点击模式)
  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (settings.pageMode !== 'click' || !currentBook) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;

    if (clickX < width / 2) {
      // 上一页
      if (currentBook.currentPage > 1) {
        updateCurrentPage(currentBook.currentPage - 1);
      } else {
        showToast('已经是第一页了');
      }
    } else {
      // 下一页
      if (currentBook.currentPage < bookPages.length) {
        updateCurrentPage(currentBook.currentPage + 1);
      } else {
        showToast('已经是最后一页了');
      }
    }
  };

  // 滚轮滚动时的页码更新模拟
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (settings.pageMode !== 'scroll' || !currentBook) return;
    const target = e.currentTarget;
    const scrollTop = target.scrollTop;
    const scrollHeight = target.scrollHeight - target.clientHeight;
    if (scrollHeight <= 0) return;
    
    // 根据滚动高度等比例计算页码
    const calculatedPage = Math.min(
      bookPages.length,
      Math.max(1, Math.ceil((scrollTop / scrollHeight) * bookPages.length))
    );
    
    if (calculatedPage !== currentBook.currentPage) {
      updateCurrentPage(calculatedPage);
    }
  };

  // 统一更新页码与进度
  const updateCurrentPage = (pageNumber: number) => {
    if (!currentBook) return;
    const total = bookPages.length;
    const progressPercent = Math.round((pageNumber / total) * 100);
    
    setBooks(prev => prev.map(b => b.id === currentBook.id ? {
      ...b,
      currentPage: pageNumber,
      progress: progressPercent
    } : b));
  };

  // 章节跳转
  const handleChapterJump = (chapterPage: number) => {
    const targetPage = Math.min(bookPages.length, Math.max(1, chapterPage));
    updateCurrentPage(targetPage);
    setIsCatalogOpen(false);
    showToast('已跳转到指定章节');

    // 如果是滚轮模式，同步把滚动条移到对应的大概位置
    if (settings.pageMode === 'scroll' && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const targetScrollTop = ((targetPage - 1) / bookPages.length) * container.scrollHeight;
      container.scrollTop = targetScrollTop;
    }
  };

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
        <div className="flex-1 flex flex-col h-full overflow-hidden p-6 max-w-6xl w-full mx-auto">
          {/* 顶部工具栏 */}
          <div className="flex items-center justify-between pb-5 border-b mb-6" style={{ borderColor: currentStyle.uiBorder }}>
            <div className="flex items-center space-x-3">
              <span className="text-2xl font-bold tracking-wide">摸鱼神器</span>
              <span className="text-xs px-2 py-0.5 rounded border font-mono" style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}>Windows P0 原型版</span>
            </div>
            
            <div className="flex items-center space-x-4">
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

                      {/* 文件路径路径 */}
                      <p className="text-xs font-mono line-clamp-1 mb-4" style={{ color: currentStyle.uiTextMuted }}>
                        {book.filePath}
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
                        <span>字数: {(book.totalChars / 1000).toFixed(1)}k</span>
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
            className="h-12 border-b px-4 flex items-center justify-between select-none z-10" 
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()} // 14. 顶部栏点击不能触发翻页
          >
            <div className="flex items-center space-x-4">
              <button
                onClick={handleBackToBookshelf}
                className="flex items-center space-x-1 px-2 py-1 rounded text-xs border font-medium hover:opacity-80 transition-all"
                style={{ borderColor: currentStyle.uiBorder }}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                <span>返回书架</span>
              </button>
              <h2 className="font-bold text-sm line-clamp-1">{currentBook.title}</h2>
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={() => { setIsCatalogOpen(true); setIsSettingsOpen(false); }}
                className="flex items-center space-x-1 px-3 py-1 rounded text-xs border font-medium hover:opacity-80 transition-all"
                style={{ borderColor: currentStyle.uiBorder }}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
                </svg>
                <span>目录</span>
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

          {/* 6. 正文阅读区域 */}
          <div className="flex-1 w-full relative flex justify-center overflow-hidden">
            
            {/* 7.1 滚轮模式布局 */}
            {settings.pageMode === 'scroll' ? (
              <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="w-full h-full overflow-y-auto px-8 py-6 select-text"
                style={{ scrollBehavior: 'smooth' }}
              >
                <div 
                  className="max-w-2xl mx-auto whitespace-pre-wrap leading-relaxed tracking-wide font-serif pb-32"
                  style={{ fontSize: `${settings.fontSize}px` }}
                >
                  {/* 滚轮模式直接渲染全部文本以供自如滚动 */}
                  {currentBook.content}
                </div>
              </div>
            ) : (
              /* 7.2 点击翻页模式布局 */
              <div
                onClick={handlePageClick}
                className="w-full h-full cursor-pointer relative px-8 py-6 flex justify-center"
              >
                {/* 左右分屏提示(隐蔽摸鱼风格，平时透明) */}
                <div className="absolute left-0 top-0 w-1/2 h-full group">
                  <div className="absolute inset-y-0 left-0 w-8 bg-black/5 opacity-0 group-hover:opacity-100 flex items-center justify-center text-xs" style={{ color: currentStyle.uiTextMuted }}>
                    <span>上一页</span>
                  </div>
                </div>
                <div className="absolute right-0 top-0 w-1/2 h-full group">
                  <div className="absolute inset-y-0 right-0 w-8 bg-black/5 opacity-0 group-hover:opacity-100 flex items-center justify-center text-xs" style={{ color: currentStyle.uiTextMuted }}>
                    <span>下一页</span>
                  </div>
                </div>

                {/* 核心单页文本容器 */}
                <div 
                  className="w-full max-w-2xl whitespace-pre-wrap leading-relaxed tracking-wide font-serif select-text pointer-events-auto"
                  style={{ fontSize: `${settings.fontSize}px` }}
                  onClick={(e) => {
                    // 允许在正文划词，不干扰翻页
                    if (window.getSelection()?.toString()) {
                      e.stopPropagation();
                    }
                  }}
                >
                  {bookPages[currentBook.currentPage - 1] || '加载中...'}
                </div>
              </div>
            )}

            {/* 8. 页码固定显示在右下角 */}
            <div 
              className="absolute bottom-4 right-6 px-2.5 py-1 rounded text-xs font-mono backdrop-blur-sm border shadow-sm select-none pointer-events-none z-10"
              style={{ 
                backgroundColor: `${currentStyle.uiBg}B3`, // 70% opacity
                borderColor: currentStyle.uiBorder,
                color: currentStyle.uiTextMuted
              }}
            >
              {currentBook.currentPage} / {bookPages.length}
            </div>
          </div>

          {/* ==========================================
              9. 目录弹窗 (居中弹窗)
              ========================================== */}
          {isCatalogOpen && (
            <div 
              className="absolute inset-0 bg-black/40 flex items-center justify-center z-30 animate-fade-in"
              onClick={() => setIsCatalogOpen(false)}
            >
              <div 
                className="w-[420px] max-h-[500px] rounded-xl border shadow-2xl flex flex-col overflow-hidden"
                style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
                onClick={(e) => e.stopPropagation()} // 14. 目录弹窗点击不触发翻页
              >
                <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: currentStyle.uiBorder }}>
                  <span className="font-bold text-sm">书籍目录</span>
                  <button 
                    onClick={() => setIsCatalogOpen(false)}
                    className="text-xs font-bold px-2 py-1 rounded hover:bg-black/5"
                  >
                    关闭
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
                  {/* 情况3：未识别到章节 */}
                  {currentBook.chapters.length === 0 && currentBook.volumes.length === 0 && (
                    <div className="py-8 text-center text-xs" style={{ color: currentStyle.uiTextMuted }}>
                      未识别到章节
                    </div>
                  )}

                  {/* 情况1：有分卷 */}
                  {currentBook.volumes.length > 0 && currentBook.volumes.map(vol => (
                    <div key={vol.id} className="space-y-1">
                      <div className="font-bold text-xs px-2 py-1 rounded opacity-70" style={{ backgroundColor: currentStyle.bg }}>
                        {vol.title}
                      </div>
                      <div className="pl-3 space-y-0.5">
                        {vol.chapterIds.map(chId => {
                          const ch = currentBook.chapters.find(c => c.id === chId);
                          if (!ch) return null;
                          const isCurrentCh = currentBook.currentPage === ch.page;
                          return (
                            <div
                              key={ch.id}
                              onClick={() => handleChapterJump(ch.page || 1)}
                              className="px-2 py-1.5 rounded cursor-pointer transition-colors text-xs flex justify-between items-center hover:bg-black/5"
                              style={{ color: isCurrentCh ? currentStyle.accent : currentStyle.text, fontWeight: isCurrentCh ? 'bold' : 'normal' }}
                            >
                              <span>{ch.title}</span>
                              {isCurrentCh && <span className="text-[10px] border px-1 rounded">当前位置</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {/* 情况2：无分卷，直铺章节 */}
                  {currentBook.volumes.length === 0 && currentBook.chapters.length > 0 && (
                    <div className="space-y-0.5">
                      {currentBook.chapters.map(ch => {
                        const isCurrentCh = currentBook.currentPage === ch.page;
                        return (
                          <div
                            key={ch.id}
                            onClick={() => handleChapterJump(ch.page || 1)}
                            className="px-2 py-1.5 rounded cursor-pointer transition-colors text-xs flex justify-between items-center hover:bg-black/5"
                            style={{ color: isCurrentCh ? currentStyle.accent : currentStyle.text, fontWeight: isCurrentCh ? 'bold' : 'normal' }}
                          >
                            <span>{ch.title}</span>
                            {isCurrentCh && <span className="text-[10px] border px-1 rounded">当前位置</span>}
                          </div>
                        );
                      })}
                    </div>
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
              className="absolute right-0 top-12 bottom-0 w-72 border-l shadow-xl z-20 p-4 flex flex-col space-y-5 animate-slide-in"
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
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
          onClick={() => setDeleteConfirmBook(null)}
        >
          <div 
            className="w-[360px] p-5 rounded-xl border shadow-2xl space-y-4"
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
