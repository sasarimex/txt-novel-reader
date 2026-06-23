import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useIdleCursor } from './hooks/useIdleCursor';

const CURRENT_TOC_PARSE_VERSION = 3;

// 窗口化渲染：只把当前 section 附近的若干段渲染成真实文本，其它部分用同样高度的占位 <section>，
// 既保证滚轮 / 触摸板的自然连续滚动手感，也避免一次性把整本书 reflow。
const SECTION_RENDER_BEFORE = 2; // 当前 section 之前保留 2 段真实正文
const SECTION_RENDER_AFTER = 4;  // 当前 section 之后保留 4 段真实正文
const MAX_SECTION_CHARS = 8000;  // 单章超过该字数会再切成子段（避免巨长章节占满整个窗口）
const RESIZE_DEBOUNCE_MS = 220;  // ResizeObserver 防抖间隔
const FONT_DEBOUNCE_MS = 220;    // 字号变化防抖间隔（应用到分页/估算的最终值）
const LINE_HEIGHT_DEBOUNCE_MS = 220; // 行间距变化防抖间隔（与字号同一节奏）

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
  bookHash?: string;
  title: string;
  author?: string;
  note?: string;
  categoryId?: string | null;
  filePath: string;
  contentPath?: string;
  originalPath?: string;
  fileSize?: number;
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

export interface BookCategory {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

// 内置分类：全部书籍 + 未分类。这两个虚拟分类不允许删除 / 改名，永远在分类菜单顶部。
export const CATEGORY_ALL_ID = '__all__';
export const CATEGORY_UNCATEGORIZED_ID = '__uncategorized__';

export interface ReaderSettings {
  pageMode: 'scroll' | 'click';
  fontSize: number;
  lineHeight: number;
  theme: 'light' | 'dark' | 'eyeCare';
  bookshelfSort: 'recent' | 'progress';
}

// 行间距推荐范围：最小 1.2，默认 1.8，最大 3.0。与字号一样在 UI 上以滑块呈现，
// 步长 0.1。旧设置里没有 lineHeight 字段时回落到 1.8，不影响其它已保存设置。
const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 3.0;
const LINE_HEIGHT_STEP = 0.1;
const LINE_HEIGHT_DEFAULT = 1.8;

function clampLineHeight(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return LINE_HEIGHT_DEFAULT;
  return Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, Math.round(num * 10) / 10));
}

const READER_SETTINGS_STORAGE_KEY = 'moyu-reader-settings-v1';

function loadStoredReaderSettings(): ReaderSettings {
  const defaults: ReaderSettings = {
    pageMode: 'scroll',
    fontSize: 20,
    lineHeight: LINE_HEIGHT_DEFAULT,
    theme: 'eyeCare',
    bookshelfSort: 'recent',
  };
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      pageMode: parsed.pageMode === 'click' ? 'click' : 'scroll',
      fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize >= 16 && parsed.fontSize <= 32
        ? Math.floor(parsed.fontSize)
        : defaults.fontSize,
      lineHeight: clampLineHeight(parsed.lineHeight ?? defaults.lineHeight),
      theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'eyeCare'
        ? parsed.theme
        : defaults.theme,
      bookshelfSort: parsed.bookshelfSort === 'progress' ? 'progress' : 'recent',
    };
  } catch {
    return defaults;
  }
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

type SyncStatus =
  | '未登录'
  | '已登录'
  | '正在测试'
  | '正在同步'
  | '已同步'
  | '连接成功'
  | '同步失败'
  | '服务器版本过旧'
  | '地址格式错误'
  | '服务器连接失败'
  | '隧道未连接'
  | '网关错误'
  | '证书错误'
  | '跨域被拒'
  | '注册已关闭'
  | '登录失败'
  | '登录已失效'
  | '地址含 /api';

interface SyncUser {
  id: number;
  username: string;
}

interface SyncSettings {
  serverUrl: string;
  token: string;
  user: SyncUser | null;
}

type SyncApiError = Error & {
  code?: string;
  status?: number;
  method?: string;
  requestUrl?: string;
  responseBody?: string;
  responseData?: unknown;
};

interface CloudProgress {
  bookHash: string;
  chapterIndex: number;
  charOffset: number;
  progressPercent: number;
  fontSize?: number | null;
  lineHeight?: number | null;
  theme?: string | null;
  updatedAt: string;
}

interface CloudBookmark {
  id: number;
  bookHash: string;
  chapterIndex: number;
  charOffset: number;
  text: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

interface CloudBook {
  id: number;
  bookHash: string;
  title: string;
  author?: string | null;
  note?: string | null;
  categoryId?: string | null;
  fileSize: number;
  totalChars: number;
  chapterCount: number;
  createdAt: string;
  updatedAt: string;
}

const SYNC_STORAGE_KEY = 'moyu-txt-novel-server-settings-v1';

// 服务器地址只接受“根地址”，例如 https://novel.mydomain.com。
// 用户可能误填 https://novel.mydomain.com/api 或末尾带斜杠，这里统一裁剪：
//   1. 去掉首尾空白
//   2. 去掉末尾若干个 `/`
//   3. 去掉末尾的 `/api` 或 `/api/`
function normalizeSyncServerUrl(serverUrl: string): string {
  let trimmed = serverUrl.trim().replace(/\/+$/, '');
  while (/\/api$/i.test(trimmed)) {
    trimmed = trimmed.replace(/\/api$/i, '').replace(/\/+$/, '');
  }
  return trimmed;
}

function hasApiSuffix(serverUrl: string): boolean {
  return /\/api\/?$/i.test(serverUrl.trim());
}

function isLikelyValidServerUrl(serverUrl: string): boolean {
  const normalized = normalizeSyncServerUrl(serverUrl);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local')) return true;
  if (host.startsWith('192.168.')) return true;
  if (host.startsWith('10.')) return true;
  const match = host.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function isPublicHttpUrl(serverUrl: string): boolean {
  try {
    const url = new URL(normalizeSyncServerUrl(serverUrl));
    return url.protocol === 'http:' && !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

function classifySyncError(error: unknown, fallback: SyncStatus): { status: SyncStatus; message: string } {
  const anyError = error as SyncApiError;
  const message = anyError?.message || '';
  const code = anyError?.code || '';
  const status = anyError?.status;

  if (code === 'INVALID_SERVER_URL') {
    return { status: '地址格式错误', message: '服务器地址格式不正确，请填写形如 https://novel.mydomain.com 的根地址。' };
  }

  if (code === 'SERVER_URL_HAS_API_SUFFIX') {
    return { status: '地址含 /api', message: '服务器地址只需要填写根地址，不需要包含 /api。已自动去除。' };
  }

  if (code === 'REGISTER_DISABLED') {
    return { status: '注册已关闭', message: '当前服务器未开放注册，请联系管理员。' };
  }

  if (code === 'INVALID_CREDENTIALS') {
    return { status: '登录失败', message: '用户名或密码错误。' };
  }

  if (code === 'UNAUTHORIZED' || status === 401 || status === 403) {
    return { status: '登录已失效', message: '登录状态已失效，请重新登录。' };
  }

  if (status === 404 || status === 405) {
    return { status: '服务器版本过旧', message: '服务器版本过旧或接口不存在，请更新同步服务器。' };
  }

  if (/cert|certificate|ssl|tls|ERR_CERT|CERT_/i.test(`${code} ${message}`)) {
    return { status: '证书错误', message: 'HTTPS 证书错误：请检查域名解析与同步服务配置。' };
  }

  if (/cors|cross[- ]?origin|preflight/i.test(message)) {
    return { status: '跨域被拒', message: '跨域被拒绝：请把客户端来源加入服务器 ALLOWED_ORIGINS。' };
  }

  if (status === 502 || status === 503 || status === 504 || status === 521 || status === 522 || status === 523 || status === 524 || status === 530) {
    return { status: '隧道未连接', message: `网关返回 ${status}：隧道、反向代理或服务器离线，请检查同步服务器地址。` };
  }

  if (status && status >= 500) {
    return { status: '网关错误', message: `服务器返回 ${status}：请检查服务器日志。` };
  }

  if (/failed to fetch|network|load failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout|aborted/i.test(message)) {
    return { status: '服务器连接失败', message: '无法连接服务器：请检查地址、网络连接或同步服务是否在线。' };
  }

  return { status: fallback, message: anyError?.message || String(fallback) };
}

function classifyCloudDeleteError(error: unknown): { status: SyncStatus; message: string } {
  const anyError = error as SyncApiError;
  const message = anyError?.message || '';
  const status = anyError?.status;

  if (anyError?.code === 'UNAUTHORIZED' || status === 401 || status === 403) {
    return { status: '登录已失效', message: '登录状态已失效，请重新登录。' };
  }

  if (status === 404 || status === 405) {
    return { status: '服务器版本过旧', message: '服务器版本过旧或删除接口不存在，请更新同步服务器。' };
  }

  if (status && status >= 500) {
    return { status: '网关错误', message: '服务器删除失败，请查看服务端日志。' };
  }

  if (/timeout|请求超时|aborted/i.test(message)) {
    return { status: '服务器连接失败', message: '连接服务器超时，请检查网络或服务器状态。' };
  }

  if (/failed to fetch|network|load failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return { status: '服务器连接失败', message: '连接服务器失败，请检查网络或服务器状态。' };
  }

  return { status: '同步失败', message: '删除云端书籍失败，请检查网络或服务器。' };
}

function loadStoredSyncSettings(): SyncSettings {
  if (typeof window === 'undefined') {
    return { serverUrl: '', token: '', user: null };
  }

  try {
    const raw = window.localStorage.getItem(SYNC_STORAGE_KEY);
    if (!raw) return { serverUrl: '', token: '', user: null };
    const parsed = JSON.parse(raw);
    return {
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
      user: parsed.user && typeof parsed.user.username === 'string'
        ? { id: Number(parsed.user.id), username: parsed.user.username }
        : null,
    };
  } catch {
    return { serverUrl: '', token: '', user: null };
  }
}

function parseSyncTime(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.includes(' ') ? value.replace(' ', 'T') : value;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

// 所有同步相关网络请求统一 8 秒超时。请求超时后抛出 timeout 错误，
// classifySyncError 会把它归类为「服务器连接失败」，UI 上的 loading 也会立刻复位。
const SYNC_REQUEST_TIMEOUT_MS = 8000;

async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs: number = SYNC_REQUEST_TIMEOUT_MS): Promise<Response> {
  if (init.signal) {
    return fetch(input, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getChapterIndexForPosition(book: Book, position: number): number {
  const chapters = book.chapters ?? [];
  let matched = 0;
  for (let index = 0; index < chapters.length; index += 1) {
    if ((chapters[index].startIndex ?? 0) <= position) {
      matched = index;
    } else {
      break;
    }
  }
  return matched;
}

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
      { id: 'c-2', title: '第二章 夜雨听风', volumeId: 'v-1', startIndex: 224, page: 15 },
      { id: 'c-3', title: '第三章 风云入京', volumeId: 'v-2', startIndex: 485, page: 35 },
      { id: 'c-4', title: '第四章 故人重逢', volumeId: 'v-2', startIndex: 702, page: 65 }
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
      { id: 'c2-2', title: '第二章 剑起沧海', startIndex: 171, page: 15 },
      { id: 'c2-3', title: '第三章 恩怨难断', startIndex: 336, page: 30 }
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
为了测试摸鱼阅读本地 TXT 小说阅读器在面对不规则或未排版文本时的强壮性与兼容度，特此提供该测试用例。
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

// 全屏加载遮罩。隐藏时返回 null，DOM 真正卸载，绝对不会用透明遮挡输入框。
// 用 useEffect 一旦 visible=false 立刻去 DOM，pointer-events 也不会残留。
function LoadingOverlay({
  visible,
  message,
  currentStyle,
}: {
  visible: boolean;
  message: string;
  currentStyle: { uiBg: string; uiBorder: string; text: string; accent: string };
}) {
  if (!visible) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      role="status"
      aria-live="polite"
    >
      <div
        className="flex flex-col items-center gap-3 px-6 py-5 rounded-xl border shadow-2xl min-w-[220px]"
        style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
      >
        <svg className="w-8 h-8 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: currentStyle.accent }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 0113.657-5.657M20 12a8 8 0 01-13.657 5.657" />
        </svg>
        <div className="text-sm font-medium text-center">{message || '正在加载，请稍候…'}</div>
      </div>
    </div>
  );
}

export default function App() {
  // 主状态
  const [books, setBooks] = useState<Book[]>([]);
  const [currentBookId, setCurrentBookId] = useState<string | null>(null);
  const [view, setView] = useState<'bookshelf' | 'reader'>('bookshelf');
  
  // 设置状态。默认使用自然连续滚动，鼠标滚轮 / 触摸板不再被劫持成翻页。
  // 初始值优先从 localStorage 读取，让字号、行间距、主题等阅读偏好在重启后保持。
  // 旧版本没有 lineHeight 字段时 loadStoredReaderSettings 会自动回退到默认 1.8。
  const [settings, setSettings] = useState<ReaderSettings>(() => loadStoredReaderSettings());
  const settingsSaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 设置变化时把整份偏好写回 localStorage（同步、轻量；不会触发 TXT 重新解析）。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (settingsSaveDebounceRef.current) {
      clearTimeout(settingsSaveDebounceRef.current);
    }
    settingsSaveDebounceRef.current = setTimeout(() => {
      settingsSaveDebounceRef.current = null;
      try {
        window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // 隐私模式或磁盘满都不阻塞 UI；下一次保存还会重试。
      }
    }, 300);
    return () => {
      if (settingsSaveDebounceRef.current) {
        clearTimeout(settingsSaveDebounceRef.current);
        settingsSaveDebounceRef.current = null;
      }
    };
  }, [settings]);

  // 弹窗与控制状态
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState<'toc' | 'bookmarks'>('toc');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isReaderChromeHidden, setIsReaderChromeHidden] = useState(false);
  // 设置面板的 DOM ref 用于「点击外部 / Esc 关闭」检测。
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  // 设置触发按钮的 ref：pointerdown 监听里如果点的是这个按钮，要忽略，否则它会立刻又打开又关闭。
  const settingsToggleRef = useRef<HTMLButtonElement>(null);
  const [deleteConfirmBook, setDeleteConfirmBook] = useState<Book | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(() => loadStoredSyncSettings());
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => loadStoredSyncSettings().token ? '已登录' : '未登录');
  const [isSyncPanelOpen, setIsSyncPanelOpen] = useState(false);
  // 登录 / 注册 / 更换服务器三页拆分；默认进入登录页。
  const [syncPanelMode, setSyncPanelMode] = useState<'login' | 'register' | 'serverSetup'>('login');
  // 更换同步服务器时临时编辑的地址，确认后才覆盖 syncSettings.serverUrl。
  const [pendingServerUrl, setPendingServerUrl] = useState('');
  // 把异步状态拆开：登录/注册、测试连接、更换服务器各有独立的 loading。
  // 不再用 displaySyncStatus === '正在同步' 控制按钮 disabled，避免请求超时残留把按钮永久禁用。
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isTestingServer, setIsTestingServer] = useState(false);
  const [isChangingServer, setIsChangingServer] = useState(false);
  // 分类菜单：用户自定义分类列表 + 当前选中的分类筛选 + 是否处于管理（重命名 / 删除）模式。
  const [categories, setCategories] = useState<BookCategory[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<string>(CATEGORY_ALL_ID);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  // 分类管理弹窗：新建 / 重命名 / 删除确认。
  // Electron renderer 里 window.prompt / window.confirm 默认是 no-op，旧版「+ 新建」按钮点了没反应就是因为这个，
  // 这里改成自己的 React 弹窗。
  const [isCreateCategoryOpen, setIsCreateCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isSavingCategory, setIsSavingCategory] = useState(false);
  const [renameCategoryTarget, setRenameCategoryTarget] = useState<BookCategory | null>(null);
  const [renameCategoryDraft, setRenameCategoryDraft] = useState('');
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState<BookCategory | null>(null);
  // 浮动菜单：左键 ⋯ 和右键 onContextMenu 共用同一份 state，确保两种入口的菜单内容完全一致。
  // category 是要操作的分类对象；x / y 是屏幕坐标（已 clamp 到视口内）；如果 anchor === 'button' 则不显示坐标，由 CSS 决定位置。
  const [categoryMenu, setCategoryMenu] = useState<{ category: BookCategory; x: number; y: number } | null>(null);
  // 书籍 / 分类拖拽时的高亮目标分类（含 __uncategorized__ / __all__）。null 表示当前没在 hover 任何分类。
  const [dragOverCategoryId, setDragOverCategoryId] = useState<string | null>(null);
  // 正在拖动的书籍 id：拖出后给书架原卡片打半透明。
  const [draggingBookId, setDraggingBookId] = useState<string | null>(null);
  // 正在拖动的分类 id（用户自定义分类排序）。
  const [draggingCategoryId, setDraggingCategoryId] = useState<string | null>(null);
  // 分类拖拽时的目标位置：drop 到目标分类项的上半 / 下半。
  const [categoryDropIndicator, setCategoryDropIndicator] = useState<{ overId: string; position: 'before' | 'after' } | null>(null);
  // 编辑书籍元数据弹窗
  const [editBookInfo, setEditBookInfo] = useState<Book | null>(null);
  const [editBookDraft, setEditBookDraft] = useState<{ title: string; author: string; note: string; categoryId: string | null }>({
    title: '',
    author: '',
    note: '',
    categoryId: null,
  });
  const [isSavingBookMeta, setIsSavingBookMeta] = useState(false);
  // 批量导入进度
  const [batchImport, setBatchImport] = useState<{ current: number; total: number; failures: Array<{ name: string; reason: string }>; running: boolean }>({
    current: 0,
    total: 0,
    failures: [],
    running: false,
  });

  // 全局加载遮罩：只在「明显的、用户主动触发的」长操作里显示（更换服务器、打开书、登录、注册、批量导入、应用启动）。
  // 后台同步、阅读进度保存、滚动、字号变化都不显示这个，避免高频闪烁。
  // 同时附带一个看门狗：超过 15 秒强制隐藏，防止因为某个 finally 漏写导致永久 spinner。
  const [loadingOverlay, setLoadingOverlay] = useState<{ visible: boolean; message: string; startedAt: number }>({
    visible: false,
    message: '',
    startedAt: 0,
  });
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showLoading = useCallback((message: string) => {
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    setLoadingOverlay({ visible: true, message, startedAt: Date.now() });
    // 15 秒看门狗：到时间自动隐藏 + 给用户一条 toast 提示，避免被无限 spinner 卡住。
    loadingTimerRef.current = setTimeout(() => {
      setLoadingOverlay((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      setToastMessage('操作耗时较长，已隐藏遮罩。如长时间无响应请检查网络或重试。');
    }, 15000);
  }, []);
  const hideLoading = useCallback(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    setLoadingOverlay({ visible: false, message: '', startedAt: 0 });
  }, []);
  useEffect(() => {
    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    };
  }, []);
  const [cloudBooks, setCloudBooks] = useState<Book[]>([]);
  const [syncForm, setSyncForm] = useState(() => {
    const stored = loadStoredSyncSettings();
    return {
      serverUrl: stored.serverUrl,
      username: stored.user?.username || '',
      password: '',
      confirmPassword: '',
    };
  });

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
  const currentBookRef = useRef<Book | null>(null);
  const syncSettingsRef = useRef(syncSettings);
  const syncInFlightRef = useRef(false);
  const lastSuccessfulSyncSignatureRef = useRef<string | null>(null);
  const syncRequestCountRef = useRef(0);
  const progressSaveCountRef = useRef(0);
  const readerChromeScrollTopBeforeHideRef = useRef<number | null>(null);
  const settingsSyncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 失败退避：5s → 15s → 30s，连续失败会被节流。成功后清零。
  const SYNC_BACKOFF_STEPS_MS = [5000, 15000, 30000];
  const syncBackoffRef = useRef<{ nextAttemptAt: number; step: number }>({ nextAttemptAt: 0, step: 0 });
  // resize / 字号变化的 anchor position：变化开始前用户正在看的文字 position，
  // 变化结束后据此回滚 scrollTop，保证用户原本看到的文字不会漂走。
  const anchorPositionRef = useRef(0);
  // 是否正在做 resize / 字号调整：用于标记"开始一次 burst"，期间 scroll listener 不写回 position。
  const isAdjustingSizeRef = useRef(false);
  const isAdjustingFontRef = useRef(false);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fontDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeStartedAtRef = useRef(0);
  const fontAdjustStartedAtRef = useRef(0);
  const lineHeightAdjustStartedAtRef = useRef(0);
  // 容器测量：只在 ResizeObserver debounce 沉淀后才 setReaderSize，避免拖窗口时高频重排
  const [readerSize, setReaderSize] = useState({ width: 672, height: 640 });

  // 设置中的字号会立即应用到 CSS（视觉无延迟），但 charsPerPage / 段高度估算 / 重定位 都用 debounce 后的值，
  // 避免拖滑块时频繁对整本书做无意义的运算。
  const [paginationFontSize, setPaginationFontSize] = useState(settings.fontSize);
  // 记录已经"确认"的字号，用于辨别字号是否真正变化（与初始 mount 区分）
  const prevAppliedFontRef = useRef(settings.fontSize);

  // 行间距同样用 debounce 后的值参与分页 / 段高估算；视觉上 inline style 会立即应用。
  // 整套抑制 / anchor 流程与字号共用一份逻辑，保证拖动滑块时阅读位置不漂走。
  const [paginationLineHeight, setPaginationLineHeight] = useState(settings.lineHeight);
  const prevAppliedLineHeightRef = useRef(settings.lineHeight);
  const isAdjustingLineHeightRef = useRef(false);
  const lineHeightDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        resizeStartedAtRef.current = performance.now();
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
          if (import.meta.env.DEV && resizeStartedAtRef.current > 0) {
            console.info('[reader-perf] resize stable', {
              ms: Math.round(performance.now() - resizeStartedAtRef.current),
              width,
              height,
            });
          }
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
      fontAdjustStartedAtRef.current = performance.now();
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
        if (import.meta.env.DEV && fontAdjustStartedAtRef.current > 0) {
          console.info('[reader-perf] font stable', {
            ms: Math.round(performance.now() - fontAdjustStartedAtRef.current),
            fontSize: settings.fontSize,
          });
        }
      }));
    }, FONT_DEBOUNCE_MS);

    return () => {
      // 注意：不要在这里清理 timer，否则会在 settings.fontSize 每次变化时把 debounce 重置成 effect 卸载
    };
  }, [settings.fontSize]);

  // 行间距变化：同字号一样走 debounce + anchor 回滚，避免每动一步就重排整本书。
  // CSS 行高（contentTextRef 上的 inline style）即时跟随 settings.lineHeight，
  // 但分页 / 段高估算 / scroll anchor 都用 paginationLineHeight（debounce 后）。
  useEffect(() => {
    if (settings.lineHeight === prevAppliedLineHeightRef.current) return;

    if (!isAdjustingLineHeightRef.current) {
      isAdjustingLineHeightRef.current = true;
      lineHeightAdjustStartedAtRef.current = performance.now();
      anchorPositionRef.current = currentPositionRef.current;
    }
    suppressScrollSyncUntilRef.current = performance.now() + 1500;

    if (lineHeightDebounceRef.current) clearTimeout(lineHeightDebounceRef.current);
    lineHeightDebounceRef.current = setTimeout(() => {
      lineHeightDebounceRef.current = null;
      prevAppliedLineHeightRef.current = settings.lineHeight;
      setPaginationLineHeight(settings.lineHeight);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        scrollToPositionRef.current?.(anchorPositionRef.current);
        suppressScrollSyncUntilRef.current = performance.now() + 400;
        isAdjustingLineHeightRef.current = false;
        if (import.meta.env.DEV && lineHeightAdjustStartedAtRef.current > 0) {
          console.info('[reader-perf] line-height stable', {
            ms: Math.round(performance.now() - lineHeightAdjustStartedAtRef.current),
            lineHeight: settings.lineHeight,
          });
        }
      }));
    }, LINE_HEIGHT_DEBOUNCE_MS);
  }, [settings.lineHeight]);

  // scrollToPosition 的 ref：因为它被 ResizeObserver / 字号变化的 useEffect 用到，
  // 而那些 effect 不能把 scrollToPosition 写进依赖（会无限重建 observer）。
  const scrollToPositionRef = useRef<((position: number) => void) | null>(null);

  // 弹出提示消息函数
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const PRE_LOGIN_DISPLAYABLE_STATUS: SyncStatus[] = [
    '正在测试',
    '连接成功',
    '地址格式错误',
    '服务器连接失败',
    '隧道未连接',
    '网关错误',
    '服务器版本过旧',
    '证书错误',
    '跨域被拒',
    '注册已关闭',
    '登录失败',
    '登录已失效',
    '地址含 /api',
  ];
  const displaySyncStatus = syncSettings.token && syncStatus === '已登录'
    ? `已登录：${syncSettings.user?.username || syncForm.username || '用户'}`
    : (syncSettings.token
        ? syncStatus
        : (PRE_LOGIN_DISPLAYABLE_STATUS.includes(syncStatus) ? syncStatus : '未登录'));
  const syncErrorStatuses: SyncStatus[] = [
    '同步失败',
    '地址格式错误',
    '服务器连接失败',
    '隧道未连接',
    '网关错误',
    '服务器版本过旧',
    '证书错误',
    '跨域被拒',
    '注册已关闭',
    '登录失败',
    '登录已失效',
    '地址含 /api',
  ];
  const isSyncErrorStatus = syncErrorStatuses.includes(displaySyncStatus as SyncStatus);
  const readerSyncStatusLabel = syncStatus === '已同步'
    ? '已同步'
    : syncStatus === '正在同步'
      ? '同步中'
      : syncErrorStatuses.includes(syncStatus)
        ? '同步失败'
        : '未同步';
  const readerSyncStatusColor = readerSyncStatusLabel === '已同步'
    ? '#16A34A'
    : readerSyncStatusLabel === '同步中'
      ? '#4F46E5'
      : readerSyncStatusLabel === '同步失败'
        ? '#DC2626'
        : undefined;

  const requestSyncApi = useCallback(async (
    apiPath: string,
    init: RequestInit = {},
    options: { keepalive?: boolean; serverUrl?: string; token?: string } = {},
  ) => {
    const serverUrl = normalizeSyncServerUrl(options.serverUrl ?? syncSettingsRef.current.serverUrl);
    const token = options.token ?? syncSettingsRef.current.token;

    if (!serverUrl) {
      throw new Error('请先设置同步服务器地址');
    }

    if (!token) {
      throw new Error('请先登录同步账号');
    }

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has('Content-Type') && typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }

    const requestUrl = `${serverUrl}${apiPath}`;
    const method = init.method || 'GET';
    let response: Response;
    if (import.meta.env.DEV) {
      syncRequestCountRef.current += 1;
      console.info('[reader-perf] sync request', {
        count: syncRequestCountRef.current,
        method,
        apiPath,
      });
    }
    try {
      response = await fetchWithTimeout(requestUrl, {
        ...init,
        headers,
        keepalive: options.keepalive ?? init.keepalive,
      });
    } catch (error) {
      const syncError = error as SyncApiError;
      syncError.method = method;
      syncError.requestUrl = requestUrl;
      if (import.meta.env.DEV) {
        console.error('[sync-api] request failed', { method, requestUrl, error });
      }
      throw syncError;
    }
    const raw = await response.text();
    let data: any = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const error = new Error(data?.message || data?.error || raw || `同步请求失败：${response.status}`) as SyncApiError;
      error.code = data?.error;
      error.status = response.status;
      error.method = method;
      error.requestUrl = requestUrl;
      error.responseBody = raw;
      error.responseData = data;
      if (import.meta.env.DEV) {
        console.error('[sync-api] HTTP error', {
          method,
          requestUrl,
          status: response.status,
          responseBody: raw,
          response: data,
        });
      }
      throw error;
    }

    return data;
  }, []);

  const requestPublicSyncApi = useCallback(async (serverUrlInput: string, apiPath: string, body: unknown) => {
    const serverUrl = normalizeSyncServerUrl(serverUrlInput);
    if (!serverUrl) {
      throw new Error('请先设置同步服务器地址');
    }

    const requestUrl = `${serverUrl}${apiPath}`;
    const response = await fetchWithTimeout(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let data: any = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const error = new Error(data?.message || data?.error || raw || `同步请求失败：${response.status}`) as SyncApiError;
      error.code = data?.error;
      error.status = response.status;
      error.method = 'POST';
      error.requestUrl = requestUrl;
      error.responseBody = raw;
      error.responseData = data;
      if (import.meta.env.DEV) {
        console.error('[sync-api] HTTP error', {
          method: 'POST',
          requestUrl,
          status: response.status,
          responseBody: raw,
          response: data,
        });
      }
      throw error;
    }

    return data;
  }, []);

  const syncCharsPerPage = useMemo(() => {
    const contentWidth = Math.max(220, Math.min(672, readerSize.width - 48));
    const contentHeight = Math.max(220, readerSize.height - 48);
    const estimatedCharWidth = Math.max(12, paginationFontSize * 1.02);
    const estimatedLineHeight = Math.max(22, paginationFontSize * Math.max(LINE_HEIGHT_MIN, paginationLineHeight));
    const charsPerLine = Math.max(8, Math.floor(contentWidth / estimatedCharWidth));
    const linesPerPage = Math.max(6, Math.floor(contentHeight / estimatedLineHeight));
    return Math.max(120, charsPerLine * linesPerPage);
  }, [paginationFontSize, paginationLineHeight, readerSize.height, readerSize.width]);

  const buildBookSyncPayload = useCallback((book: Book) => ({
    bookHash: book.bookHash,
    title: book.title,
    author: book.author ?? '',
    note: book.note ?? '',
    categoryId: book.categoryId ?? null,
    fileSize: book.fileSize ?? 0,
    totalChars: book.totalChars,
    chapterCount: book.chapters?.length ?? 0,
    updatedAt: book.updatedAt,
  }), []);

  const buildProgressSyncPayload = useCallback((book: Book) => {
    const position = Number.isFinite(book.position)
      ? Math.max(0, Math.floor(book.position ?? 0))
      : Math.max(0, (book.currentPage - 1) * syncCharsPerPage);

    return {
      chapterIndex: getChapterIndexForPosition(book, position),
      charOffset: position,
      progressPercent: book.progress,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      theme: settings.theme,
      updatedAt: book.updatedAt,
    };
  }, [settings.fontSize, settings.lineHeight, settings.theme, syncCharsPerPage]);

  const buildBookmarkSyncSignature = useCallback((book: Book) => (
    (book.bookmarks ?? [])
      .map((bookmark) => {
        const charOffset = Number.isFinite(bookmark.position)
          ? Math.max(0, Math.floor(bookmark.position ?? 0))
          : Math.max(0, ((bookmark.pageIndex ?? 1) - 1) * syncCharsPerPage);
        return {
          chapterIndex: getChapterIndexForPosition(book, charOffset),
          charOffset,
          text: bookmark.previewText || bookmark.title || '',
          note: bookmark.chapterTitle || bookmark.title || '',
        };
      })
      .sort((a, b) => (a.charOffset - b.charOffset) || a.text.localeCompare(b.text))
  ), [syncCharsPerPage]);

  const syncBookmarksForBook = useCallback(async (book: Book) => {
    if (!book.bookHash) return;

    const localBookmarks = (book.bookmarks ?? []).map((bookmark) => {
      const charOffset = Number.isFinite(bookmark.position)
        ? Math.max(0, Math.floor(bookmark.position ?? 0))
        : Math.max(0, ((bookmark.pageIndex ?? 1) - 1) * syncCharsPerPage);
      return {
        bookHash: book.bookHash,
        chapterIndex: getChapterIndexForPosition(book, charOffset),
        charOffset,
        text: bookmark.previewText || bookmark.title || '',
        note: bookmark.chapterTitle || bookmark.title || '',
      };
    });

    const remoteResult = await requestSyncApi(`/api/bookmarks/${book.bookHash}`);
    const remoteBookmarks = Array.isArray(remoteResult?.bookmarks)
      ? remoteResult.bookmarks as CloudBookmark[]
      : [];
    const localKeys = new Set(localBookmarks.map((bookmark) => `${bookmark.chapterIndex}:${bookmark.charOffset}`));

    for (const remoteBookmark of remoteBookmarks) {
      const key = `${remoteBookmark.chapterIndex}:${remoteBookmark.charOffset}`;
      if (!localKeys.has(key)) {
        await requestSyncApi(`/api/bookmarks/${remoteBookmark.id}`, { method: 'DELETE' });
      }
    }

    for (const bookmark of localBookmarks) {
      await requestSyncApi('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookmark),
      });
    }
  }, [requestSyncApi, syncCharsPerPage]);

  const syncBookToServer = useCallback(async (
    book: Book,
    options: { silent?: boolean; keepalive?: boolean } = {},
  ) => {
    if (!syncSettingsRef.current.token || !syncSettingsRef.current.serverUrl) {
      setSyncStatus('未登录');
      return false;
    }

    if (!book.bookHash) {
      if (!options.silent && !options.keepalive) {
        showToast('当前书籍缺少 bookHash，请重新导入该 TXT');
      }
      return false;
    }

    if (syncInFlightRef.current && !options.keepalive) {
      return false;
    }

    // 静默 / keepalive 同步遵循失败退避（避免后台 30s interval 在断网时疯狂重试），
    // 明确触发（非 silent）的同步则忽略 backoff、立刻尝试。
    const nowTs = performance.now();
    if (options.silent && nowTs < syncBackoffRef.current.nextAttemptAt) {
      return false;
    }

    if (!options.keepalive) {
      syncInFlightRef.current = true;
    }

    if (!options.silent && !options.keepalive) {
      setSyncStatus('正在同步');
    }

    const bookPayload = buildBookSyncPayload(book);
    const progressPayload = buildProgressSyncPayload(book);
    const syncSignature = JSON.stringify({
      bookHash: book.bookHash,
      book: bookPayload,
      progress: progressPayload,
      bookmarks: buildBookmarkSyncSignature(book),
    });

    if (options.silent && !options.keepalive && lastSuccessfulSyncSignatureRef.current === syncSignature) {
      if (!options.keepalive) {
        syncInFlightRef.current = false;
      }
      return false;
    }

    try {
      await requestSyncApi('/api/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookPayload),
      }, { keepalive: options.keepalive });

      await requestSyncApi(`/api/progress/${book.bookHash}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(progressPayload),
      }, { keepalive: options.keepalive });

      if (!options.keepalive) {
        await syncBookmarksForBook(book);
      }

      // 成功：清退避。
      syncBackoffRef.current = { nextAttemptAt: 0, step: 0 };
      lastSuccessfulSyncSignatureRef.current = syncSignature;

      if (!options.silent && !options.keepalive) {
        setSyncStatus('已同步');
      }
      return true;
    } catch (error) {
      console.error('Failed to sync book:', error);
      // 失败：按 5/15/30s 递增退避；静默重试在到期前直接被跳过。
      const stepIdx = Math.min(syncBackoffRef.current.step, SYNC_BACKOFF_STEPS_MS.length - 1);
      const delay = SYNC_BACKOFF_STEPS_MS[stepIdx];
      syncBackoffRef.current = {
        nextAttemptAt: performance.now() + delay,
        step: stepIdx + 1,
      };
      if (!options.keepalive) {
        const classified = classifySyncError(error, '同步失败');
        setSyncStatus(classified.status);
        if (!options.silent) showToast(classified.message);
      }
      return false;
    } finally {
      if (!options.keepalive) {
        syncInFlightRef.current = false;
      }
    }
  }, [buildBookmarkSyncSignature, buildBookSyncPayload, buildProgressSyncPayload, requestSyncApi, syncBookmarksForBook]);

  const deleteCloudBookByHash = useCallback(async (bookHash: string) => {
    const safeHash = encodeURIComponent(bookHash);
    const apiPath = `/api/books/${safeHash}`;
    const serverUrl = normalizeSyncServerUrl(syncSettingsRef.current.serverUrl);
    const requestUrl = serverUrl ? `${serverUrl}${apiPath}` : apiPath;
    try {
      if (import.meta.env.DEV) {
        console.info('[sync-delete] DELETE cloud book', { requestUrl, bookHash });
      }
      return await requestSyncApi(apiPath, { method: 'DELETE' });
    } catch (error) {
      const syncError = error as SyncApiError;
      if (import.meta.env.DEV) {
        console.error('[sync-delete] failed', {
          requestUrl: syncError.requestUrl || requestUrl,
          status: syncError.status,
          responseBody: syncError.responseBody,
          bookHash,
          error,
        });
      }
      throw error;
    }
  }, [requestSyncApi]);

  const syncCurrentBook = useCallback(async (options: { silent?: boolean; keepalive?: boolean } = {}) => {
    const book = currentBookRef.current;
    if (!book) return false;
    return syncBookToServer(book, options);
  }, [syncBookToServer]);

  const hydrateBookWithCloudProgress = useCallback(async (book: Book): Promise<Book> => {
    if (!syncSettingsRef.current.token || !syncSettingsRef.current.serverUrl || !book.bookHash) {
      return book;
    }

    try {
      setSyncStatus('正在同步');
      await requestSyncApi('/api/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBookSyncPayload(book)),
      });

      let nextBook = book;
      const result = await requestSyncApi(`/api/progress/${book.bookHash}`);
      const cloudProgress = result?.progress as CloudProgress | null;

      if (cloudProgress) {
        const localUpdatedAt = parseSyncTime(book.updatedAt || book.lastReadAt);
        const cloudUpdatedAt = parseSyncTime(cloudProgress.updatedAt);
        const cloudPosition = Math.max(0, Math.floor(cloudProgress.charOffset ?? 0));
        const localPosition = Number.isFinite(book.position)
          ? Math.max(0, Math.floor(book.position ?? 0))
          : Math.max(0, (book.currentPage - 1) * syncCharsPerPage);

        if (cloudUpdatedAt > localUpdatedAt + 1000 && Math.abs(cloudPosition - localPosition) > 10) {
          const shouldJump = window.confirm('云端进度比本地新，是否跳转到云端进度？');
          if (shouldJump) {
            if (typeof cloudProgress.fontSize === 'number' || typeof cloudProgress.lineHeight === 'number' || cloudProgress.theme) {
              setSettings(prev => ({
                ...prev,
                fontSize: typeof cloudProgress.fontSize === 'number'
                  ? Math.min(32, Math.max(16, Math.floor(cloudProgress.fontSize)))
                  : prev.fontSize,
                lineHeight: typeof cloudProgress.lineHeight === 'number'
                  ? clampLineHeight(cloudProgress.lineHeight)
                  : prev.lineHeight,
                theme: cloudProgress.theme === 'light' || cloudProgress.theme === 'dark' || cloudProgress.theme === 'eyeCare'
                  ? cloudProgress.theme
                  : prev.theme,
              }));
            }

            nextBook = {
              ...nextBook,
              position: Math.min(Math.max(0, book.content.length - 1), cloudPosition),
              currentPage: Math.max(1, Math.floor(cloudPosition / syncCharsPerPage) + 1),
              progress: Math.max(0, Math.min(100, Math.round(cloudProgress.progressPercent))),
              updatedAt: cloudProgress.updatedAt,
            };
          }
        }
      }

      const bookmarkResult = await requestSyncApi(`/api/bookmarks/${book.bookHash}`);
      const cloudBookmarks = Array.isArray(bookmarkResult?.bookmarks)
        ? bookmarkResult.bookmarks as CloudBookmark[]
        : [];

      if (cloudBookmarks.length > 0) {
        const localBookmarks = nextBook.bookmarks ?? [];
        const localKeys = new Set(localBookmarks.map((bookmark) => {
          const position = Number.isFinite(bookmark.position) ? bookmark.position ?? 0 : 0;
          return `${Math.floor(position)}:${bookmark.previewText || bookmark.title || ''}`;
        }));
        const importedBookmarks = cloudBookmarks
          .filter((bookmark) => !localKeys.has(`${bookmark.charOffset}:${bookmark.text || bookmark.note || ''}`))
          .map((bookmark): Bookmark => ({
            id: `cloud-${bookmark.id}`,
            bookId: nextBook.id,
            title: bookmark.note || bookmark.text || '云端书签',
            chapterTitle: bookmark.note || undefined,
            pageIndex: Math.max(1, Math.floor(bookmark.charOffset / syncCharsPerPage) + 1),
            position: bookmark.charOffset,
            previewText: bookmark.text,
            createdAt: parseSyncTime(bookmark.createdAt) || Date.now(),
          }));

        if (importedBookmarks.length > 0) {
          nextBook = {
            ...nextBook,
            bookmarks: [...localBookmarks, ...importedBookmarks].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
          };
        }
      }

      setSyncStatus('已同步');
      return nextBook;
    } catch (error) {
      console.error('Failed to load cloud progress:', error);
      const classified = classifySyncError(error, '同步失败');
      setSyncStatus(classified.status);
      showToast(classified.message);
      return book;
    }
  }, [buildBookSyncPayload, requestSyncApi, syncCharsPerPage]);

  const pullCloudState = useCallback(async (serverUrl?: string, token?: string) => {
    const state = await requestSyncApi('/api/sync/state', {}, { serverUrl, token });
    const remoteBooks = Array.isArray(state?.books) ? state.books as CloudBook[] : [];
    const remoteProgress = Array.isArray(state?.progress) ? state.progress as CloudProgress[] : [];
    const progressByHash = new Map(remoteProgress.map((progress) => [progress.bookHash, progress]));
    const localHashes = new Set(books.map((book) => book.bookHash).filter(Boolean));

    const cloudOnlyBooks = remoteBooks
      .filter((book) => !localHashes.has(book.bookHash))
      .map((book): Book => {
        const progress = progressByHash.get(book.bookHash);
        const charOffset = progress?.charOffset ?? 0;
        return {
          id: `cloud:${book.bookHash}`,
          bookHash: book.bookHash,
          title: book.title,
          author: typeof book.author === 'string' ? book.author : '',
          note: typeof book.note === 'string' ? book.note : '',
          categoryId: typeof book.categoryId === 'string' ? book.categoryId : null,
          filePath: '',
          originalPath: '',
          fileSize: book.fileSize,
          encoding: 'unknown',
          totalChars: book.totalChars,
          textCharCount: book.totalChars,
          nonWhitespaceCharCount: book.totalChars,
          chapters: [],
          volumes: [],
          bookmarks: [],
          currentPage: Math.max(1, Math.floor(charOffset / syncCharsPerPage) + 1),
          totalPages: Math.max(1, Math.ceil(Math.max(1, book.totalChars) / syncCharsPerPage)),
          position: charOffset,
          progress: Math.round(progress?.progressPercent ?? 0),
          lastReadAt: progress?.updatedAt || book.updatedAt,
          createdAt: book.createdAt,
          updatedAt: progress?.updatedAt || book.updatedAt,
          content: '',
        };
      });

    setCloudBooks(cloudOnlyBooks);
    return {
      remoteBookCount: remoteBooks.length,
      cloudOnlyCount: cloudOnlyBooks.length,
    };
  }, [books, requestSyncApi, syncCharsPerPage]);

  useEffect(() => {
    if (!syncSettings.token || !syncSettings.serverUrl) return;
    void pullCloudState().catch((error) => {
      const classified = classifySyncError(error, '同步失败');
      setSyncStatus(classified.status);
    });
  }, [pullCloudState, syncSettings.serverUrl, syncSettings.token]);

  // 打开同步弹窗：根据登录态选默认子页（未登录 → 登录页，已登录 → 登录页展示账号信息），
  // 清空敏感字段以避免上一次输入残留。
  const openSyncPanel = useCallback(() => {
    setIsSyncPanelOpen(true);
    setSyncPanelMode('login');
    setSyncForm(prev => ({
      ...prev,
      serverUrl: syncSettingsRef.current.serverUrl || prev.serverUrl,
      password: '',
      confirmPassword: '',
    }));
    setPendingServerUrl(syncSettingsRef.current.serverUrl || '');
  }, []);

  const handleSyncAuth = async (mode: 'login' | 'register') => {
    // 已经在发送了，避免双击产生两条并发请求把状态搞乱。
    if (isAuthenticating) return;

    // 登录用已保存的服务器地址；注册时才允许用户在表单中填写并保存。
    const rawServerUrl = mode === 'login'
      ? (syncSettings.serverUrl || syncSettingsRef.current.serverUrl)
      : syncForm.serverUrl;

    if (!rawServerUrl || !rawServerUrl.trim()) {
      setSyncStatus('地址格式错误');
      if (mode === 'login') {
        showToast('尚未配置同步服务器，请先注册或在“更换同步服务器”中填写');
        setSyncPanelMode('register');
      } else {
        showToast('请填写服务器地址，例如 https://novel.mydomain.com');
      }
      return;
    }

    if (!isLikelyValidServerUrl(rawServerUrl)) {
      setSyncStatus('地址格式错误');
      showToast('服务器地址格式不正确，请填写形如 https://novel.mydomain.com 的根地址');
      return;
    }

    const wasApiSuffixed = hasApiSuffix(rawServerUrl);
    const normalizedUrl = normalizeSyncServerUrl(rawServerUrl);
    if (mode === 'register' && wasApiSuffixed) {
      setSyncForm(prev => ({ ...prev, serverUrl: normalizedUrl }));
      showToast('服务器地址只需要填写根地址，不需要包含 /api，已自动去除');
    }

    if (isPublicHttpUrl(normalizedUrl)) {
      showToast('公网访问建议使用 HTTPS');
    }
    if (mode === 'register' && syncForm.password !== syncForm.confirmPassword) {
      setSyncStatus('同步失败');
      showToast('两次输入的密码不一致');
      return;
    }
    if (syncForm.password.length < 8) {
      setSyncStatus(mode === 'login' ? '登录失败' : '同步失败');
      showToast('密码至少需要 8 位');
      return;
    }

    setIsAuthenticating(true);
    setSyncStatus('正在同步');
    showLoading(mode === 'register' ? '正在注册同步账号…' : '正在登录同步服务…');
    try {
      if (mode === 'register') {
        await requestPublicSyncApi(
          normalizedUrl,
          '/api/auth/register',
          { username: syncForm.username, password: syncForm.password },
        );
      }

      const data = await requestPublicSyncApi(
        normalizedUrl,
        '/api/auth/login',
        { username: syncForm.username, password: syncForm.password },
      );

      setSyncSettings({
        serverUrl: normalizedUrl,
        token: data.token,
        user: data.user,
      });
      syncSettingsRef.current = {
        serverUrl: normalizedUrl,
        token: data.token,
        user: data.user,
      };
      // 注册成功后，让登录页面的 serverUrl 同步成新值；并清空密码字段。
      setSyncForm(prev => ({ ...prev, serverUrl: normalizedUrl, password: '', confirmPassword: '' }));
      setIsSyncPanelOpen(false);
      setSyncPanelMode('login');
      setSyncStatus('已登录');
      await pullCloudState(syncSettingsRef.current.serverUrl, data.token);
      showToast(mode === 'login' ? '已登录同步服务' : '已注册并登录同步服务');
    } catch (error) {
      console.error('Failed to authenticate sync account:', error);
      const classified = classifySyncError(error, mode === 'login' ? '登录失败' : '同步失败');
      setSyncStatus(classified.status);
      showToast(classified.message);
    } finally {
      // 无论成功失败、超时还是异常，必须复位 loading，不然输入框 / 按钮会被永久 disable。
      setIsAuthenticating(false);
      hideLoading();
    }
  };

  const handleSyncLogout = () => {
    setSyncSettings(prev => ({ ...prev, token: '', user: null }));
    setSyncForm(prev => ({ ...prev, password: '', confirmPassword: '' }));
    setCloudBooks([]);
    setSyncStatus('未登录');
    setIsAuthenticating(false);
    setIsTestingServer(false);
    showToast('已退出登录');
  };

  // 更换服务器：弹出二次确认（提醒账号 / 数据可能不匹配），清空 token、清空云端书架、
  // 用新地址回到登录页，让用户用该服务器的账号重新登录。
  const handleChangeServer = () => {
    if (isChangingServer) return;
    const candidate = pendingServerUrl.trim();
    if (!candidate) {
      showToast('请填写新的服务器地址');
      return;
    }
    if (!isLikelyValidServerUrl(candidate)) {
      setSyncStatus('地址格式错误');
      showToast('服务器地址格式不正确，请填写形如 https://novel.mydomain.com 的根地址');
      return;
    }
    const normalized = normalizeSyncServerUrl(candidate);
    if (typeof window !== 'undefined' && !window.confirm('更换服务器后，当前账号和云端数据可能无法继续匹配。是否继续？')) {
      return;
    }
    // 同步是纯本地状态切换（没有网络请求），但仍然走 try/finally 模式，
    // 保证未来若加上网络握手也不会有 loading 残留把输入框 disable。
    setIsChangingServer(true);
    showLoading('正在保存同步服务器设置…');
    try {
      // 1. 一次性清空旧 token、旧账号、旧云端书架、旧 loading、旧错误
      setSyncSettings({ serverUrl: normalized, token: '', user: null });
      syncSettingsRef.current = { serverUrl: normalized, token: '', user: null };
      setSyncForm({
        serverUrl: normalized,
        username: '',
        password: '',
        confirmPassword: '',
      });
      setCloudBooks([]);
      setIsAuthenticating(false);
      setIsTestingServer(false);
      // 2. 切回登录页（输入框立刻可用）
      setSyncPanelMode('login');
      setPendingServerUrl(normalized);
      // 3. 状态条复位
      setSyncStatus('未登录');
      showToast('已保存新的服务器地址，请使用该服务器的账号登录');
    } finally {
      setIsChangingServer(false);
      // 显式 hide：这一步是关键。即使上面任何 setState 卡顿，遮罩也保证在 finally 关闭。
      hideLoading();
    }
  };

  const handleTestConnection = async () => {
    const rawInput = syncForm.serverUrl;
    if (!rawInput.trim()) {
      setSyncStatus('地址格式错误');
      showToast('请填写服务器地址，例如 https://novel.mydomain.com');
      return;
    }

    if (!isLikelyValidServerUrl(rawInput)) {
      setSyncStatus('地址格式错误');
      showToast('服务器地址格式不正确，请填写形如 https://novel.mydomain.com 的根地址');
      return;
    }

    const normalized = normalizeSyncServerUrl(rawInput);
    const wasApiSuffixed = hasApiSuffix(rawInput);
    if (wasApiSuffixed && normalized !== rawInput.trim()) {
      setSyncForm(prev => ({ ...prev, serverUrl: normalized }));
      showToast('服务器地址只需要填写根地址，不需要包含 /api，已自动去除');
    }

    if (isPublicHttpUrl(normalized)) {
      showToast('公网访问建议使用 HTTPS');
    }

    try {
      setSyncStatus('正在测试');
      setIsTestingServer(true);
      const response = await fetchWithTimeout(`${normalized}/api/health`, { method: 'GET' });
      const raw = await response.text();
      const data = raw ? JSON.parse(raw) : null;

      if (!response.ok) {
        const error = new Error(data?.message || `健康检查失败：${response.status}`) as Error & { code?: string; status?: number };
        error.code = data?.error;
        error.status = response.status;
        throw error;
      }

      if (!data || data.ok !== true) {
        setSyncStatus('服务器连接失败');
        showToast('已连接到该地址，但没有返回有效的同步服务健康状态，请确认地址是否正确');
        return;
      }

      setSyncStatus('连接成功');
      showToast(`连接成功，服务器版本可用（端口 ${data.port ?? 3300}）`);
    } catch (error) {
      console.error('Failed to test connection:', error);
      const classified = classifySyncError(error, '服务器连接失败');
      setSyncStatus(classified.status);
      showToast(classified.message);
    } finally {
      setIsTestingServer(false);
    }
  };

  const saveBookProgressNow = (input: ProgressUpdateInput) => {
    if (import.meta.env.DEV) {
      progressSaveCountRef.current += 1;
      console.info('[reader-perf] progress save', {
        count: progressSaveCountRef.current,
        id: input.id,
        position: input.position,
      });
    }
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
    if (view !== 'reader' || !currentBookId || !syncSettings.token) return;

    const intervalId = window.setInterval(() => {
      void syncCurrentBook({ silent: true });
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, [currentBookId, syncCurrentBook, syncSettings.token, view]);

  useEffect(() => {
    if (settingsSyncDebounceRef.current) {
      clearTimeout(settingsSyncDebounceRef.current);
      settingsSyncDebounceRef.current = null;
    }
    if (view !== 'reader' || !currentBookId || !syncSettings.token || !syncSettings.serverUrl) return;

    settingsSyncDebounceRef.current = setTimeout(() => {
      settingsSyncDebounceRef.current = null;
      void syncCurrentBook({ silent: true });
    }, 700);

    return () => {
      if (settingsSyncDebounceRef.current) {
        clearTimeout(settingsSyncDebounceRef.current);
        settingsSyncDebounceRef.current = null;
      }
    };
  }, [
    currentBookId,
    settings.fontSize,
    settings.lineHeight,
    settings.theme,
    syncCurrentBook,
    syncSettings.serverUrl,
    syncSettings.token,
    view,
  ]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushPendingProgressSave();
      void syncCurrentBook({ silent: true, keepalive: true });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [syncCurrentBook]);

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

  // 初始加载分类列表（Electron 环境）。浏览器预览时保持空数组即可。
  useEffect(() => {
    if (!window.readerAPI?.listCategories) return;
    let isMounted = true;
    window.readerAPI.listCategories()
      .then((result) => {
        if (!isMounted || !result.ok) return;
        setCategories(result.categories);
      })
      .catch((error) => console.error('Failed to load categories:', error));
    return () => {
      isMounted = false;
    };
  }, []);

  // 分类浮动菜单：点击任何地方 / 按 Escape 都关闭。菜单自身已 stopPropagation。
  useEffect(() => {
    if (!categoryMenu) return;
    const close = () => setCategoryMenu(null);
    const closeOnEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setCategoryMenu(null); };
    // 用 pointerdown 而不是 click：原生右键菜单弹出时 click 不会触发，但 pointerdown 在右键释放前就触发，
    // 还能避免按下后拖动产生的关闭副作用。
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEsc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeOnEsc);
    };
  }, [categoryMenu]);

  // 设置面板：点击面板外区域 / 按 Esc 都会关闭。点在「设置」触发按钮上不算外部点击（避免一开就关）。
  // 用 pointerdown 是为了能在 click 派发之前就早一步判断（拖 slider 时 mousedown 在 slider 内部，不会触发外部关闭）。
  useEffect(() => {
    if (!isSettingsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (settingsPanelRef.current?.contains(target)) return;
      if (settingsToggleRef.current?.contains(target)) return;
      setIsSettingsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSettingsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isSettingsOpen]);

  // 获取当前正在阅读的书籍
  const currentBook = useMemo(() => {
    return books.find(b => b.id === currentBookId) || null;
  }, [books, currentBookId]);

  const shouldKeepReaderCursorVisible = useCallback(() => {
    if (isCatalogOpen || isSettingsOpen || isSyncPanelOpen || deleteConfirmBook || loadingOverlay.visible) {
      return true;
    }
    if (typeof window !== 'undefined') {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return true;
    }
    return false;
  }, [deleteConfirmBook, isCatalogOpen, isSettingsOpen, isSyncPanelOpen, loadingOverlay.visible]);

  const isReaderCursorIdleEnabled = view === 'reader'
    && Boolean(currentBook)
    && !isCatalogOpen
    && !isSettingsOpen
    && !isSyncPanelOpen
    && !deleteConfirmBook
    && !loadingOverlay.visible;

  const { isCursorHidden, showCursorAndRestartTimer } = useIdleCursor({
    enabled: isReaderCursorIdleEnabled,
    targetRef: scrollContainerRef,
    delayMs: 2000,
    shouldStayVisible: shouldKeepReaderCursorVisible,
  });

  useEffect(() => {
    setIsReaderChromeHidden(false);
  }, [currentBook?.id, view]);

  useEffect(() => {
    syncSettingsRef.current = syncSettings;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(syncSettings));
    }
    if (!syncSettings.token) {
      setSyncStatus('未登录');
    }
  }, [syncSettings]);

  useEffect(() => {
    currentBookRef.current = currentBook;
  }, [currentBook]);

  // 估算每"页"等价字符数（仅用于运行时显示 X/Y 这种近似页数；真正的位置始终用 position）。
  const charsPerPage = useMemo(() => {
    const contentWidth = Math.max(220, Math.min(672, readerSize.width - 48));
    const contentHeight = Math.max(220, readerSize.height - 48);
    const estimatedCharWidth = Math.max(12, paginationFontSize * 1.02);
    const estimatedLineHeight = Math.max(22, paginationFontSize * Math.max(LINE_HEIGHT_MIN, paginationLineHeight));
    const charsPerLine = Math.max(8, Math.floor(contentWidth / estimatedCharWidth));
    const linesPerPage = Math.max(6, Math.floor(contentHeight / estimatedLineHeight));
    return Math.max(120, charsPerLine * linesPerPage);
  }, [paginationFontSize, paginationLineHeight, readerSize.height, readerSize.width]);

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

  const chapterTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const chapter of currentBook?.chapters ?? []) {
      map.set(chapter.id, chapter.title);
    }
    return map;
  }, [currentBook?.chapters]);

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

  // 按段估算高度：用 paginationFontSize / paginationLineHeight（均 debounce 后）+ 容器宽度估算每行字符数和行高，
  // 然后按 \n 分段累加每段行数。中文小说基本接近真实高度，scrollHeight 不会大幅跳变。
  const layoutMetrics = useMemo(() => {
    const fontSize = paginationFontSize;
    const ratio = Math.max(LINE_HEIGHT_MIN, paginationLineHeight);
    const contentWidth = Math.max(220, Math.min(672, readerSize.width - 48));
    const estimatedCharWidth = Math.max(12, fontSize * 1.02);
    const estimatedLineHeight = Math.max(22, fontSize * ratio);
    const charsPerLine = Math.max(8, Math.floor(contentWidth / estimatedCharWidth));
    return { charsPerLine, lineHeight: estimatedLineHeight };
  }, [paginationFontSize, paginationLineHeight, readerSize.width]);

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
        const updatedAt = new Date().toISOString();
        setBooks(prev => prev.map(b => b.id === currentBook.id ? { ...b, currentPage, totalPages, progress, position: currentPosition, updatedAt } : b));
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

  // 已知分类 ID 集合：用于把指向已删除分类的旧书都视为「未分类」。
  const categoryIdSet = useMemo(() => new Set(categories.map((category) => category.id)), [categories]);

  // 排序后的书籍列表（按当前分类筛选 + 按用户选的排序）
  const sortedBooks = useMemo(() => {
    const localHashes = new Set(books.map((book) => book.bookHash).filter(Boolean));
    const visibleBooks = [
      ...books,
      ...cloudBooks.filter((book) => book.bookHash && !localHashes.has(book.bookHash)),
    ];

    const filtered = visibleBooks.filter((book) => {
      if (activeCategoryId === CATEGORY_ALL_ID) return true;
      const bookCategoryId = book.categoryId && categoryIdSet.has(book.categoryId) ? book.categoryId : null;
      if (activeCategoryId === CATEGORY_UNCATEGORIZED_ID) {
        return !bookCategoryId;
      }
      return bookCategoryId === activeCategoryId;
    });

    return filtered.sort((a, b) => {
      if (settings.bookshelfSort === 'recent') {
        const timeA = a.lastReadAt ? new Date(a.lastReadAt).getTime() : 0;
        const timeB = b.lastReadAt ? new Date(b.lastReadAt).getTime() : 0;
        return timeB - timeA; // 倒序
      } else {
        return a.progress - b.progress; // 从低到高
      }
    });
  }, [activeCategoryId, books, categoryIdSet, cloudBooks, settings.bookshelfSort]);

  // 计算每个分类（含「全部 / 未分类」）下的书数，给侧边栏展示。
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set(CATEGORY_ALL_ID, books.length);
    let uncategorized = 0;
    for (const book of books) {
      const id = book.categoryId && categoryIdSet.has(book.categoryId) ? book.categoryId : null;
      if (id === null) {
        uncategorized += 1;
      } else {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    counts.set(CATEGORY_UNCATEGORIZED_ID, uncategorized);
    return counts;
  }, [books, categoryIdSet]);

  // 进入阅读器
  const handleOpenBook = async (bookId: string) => {
    if (bookId.startsWith('cloud:')) {
      showToast('这本书只在云端书架中；请先在本机导入同一本 TXT，客户端会用 SHA256 自动匹配进度。');
      return;
    }

    const openBookStartedAt = performance.now();
    showLoading('正在打开书籍…');
    try {
      if (currentBookId && currentBookId !== bookId) {
        flushPendingProgressSave();
        void syncCurrentBook({ silent: true });
      }

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

      if (loadedBook) {
        loadedBook = await hydrateBookWithCloudProgress(loadedBook);
      }

      setBooks(prev => prev.map(b => b.id === bookId ? { ...b, ...(loadedBook ?? {}), lastReadAt: formattedTime } : b));
      saveBookProgressNow({
        id: bookId,
        lastReadAt: formattedTime,
      });
      if (loadedBook?.bookmarks) {
        const savePromise = window.readerAPI?.updateBookBookmarks?.({ id: bookId, bookmarks: loadedBook.bookmarks });
        void savePromise?.catch((error) => {
          console.error('Failed to save cloud bookmarks locally:', error);
        });
      }
      setCurrentBookId(bookId);
      setCatalogTab('toc');
      setView('reader');

      if (loadedBook) {
        void syncBookToServer({ ...loadedBook, lastReadAt: formattedTime }, { silent: true });
      }
    } finally {
      if (import.meta.env.DEV) {
        console.info('[reader-perf] open book', {
          bookId,
          ms: Math.round(performance.now() - openBookStartedAt),
        });
      }
      hideLoading();
    }
  };

  // 返回书架
  const handleBackToBookshelf = async () => {
    flushPendingProgressSave();
    await syncCurrentBook({ silent: true });
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
      const existingBook = books.find((book) => !book.id.startsWith('cloud:') && book.bookHash && book.bookHash === selectedFile.bookHash);
      let replaceBookId: string | undefined;

      if (existingBook) {
        const shouldSkip = window.confirm(`书架中已存在相同内容的 TXT：《${existingBook.title}》，是否跳过？\n\n确定：跳过\n取消：覆盖并重置阅读进度`);

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
        bookHash: selectedFile.bookHash,
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

      void syncBookToServer(importResult.book, { silent: true });

      const fileSizeKb = (selectedFile.fileSize / 1024).toFixed(1);
      showToast(`已读取 ${selectedFile.fileName}（${selectedFile.encoding}，${fileSizeKb} KB，${selectedFile.totalChars} 字）`);
    } catch (error) {
      console.error('Failed to select txt file:', error);
      showToast('选择 TXT 文件失败，请稍后重试。');
    }
  };

  // 批量导入：用 selectTxtFiles 一次拿到多个 filePath，按顺序读取 + 导入。
  // 重复 TXT 根据 bookHash 自动跳过；单本失败不影响其他文件；最后给出统计 toast。
  const handleBatchImport = async () => {
    if (batchImport.running) return;
    if (!window.readerAPI?.selectTxtFiles || !window.readerAPI?.readTxtFile || !window.readerAPI?.importTxtBook) {
      showToast('当前运行环境未接入 Electron，本地文件选择功能仅在 Electron 窗口中可用。');
      return;
    }

    const selectResult = await window.readerAPI.selectTxtFiles();
    if (!selectResult.ok) {
      showToast(selectResult.errorMessage);
      return;
    }
    const filePaths = selectResult.filePaths || [];
    if (filePaths.length === 0) {
      return; // 用户取消，不弹 toast。
    }

    setBatchImport({ current: 0, total: filePaths.length, failures: [], running: true });
    showLoading(`正在导入 0 / ${filePaths.length}`);
    let imported = 0;
    let skipped = 0;
    const failures: Array<{ name: string; reason: string }> = [];

    // 边导边把 books 累加进 React state，避免一次性追加丢失中间结果；
    // 同步只在最后一本完成后做一次（avoid 高频请求服务器）。
    // 我们用闭包变量 currentBooks 维护「最新书架」用于查重，因为 setBooks 是异步的。
    let currentBooks = books;
    const targetCategoryId = activeCategoryId !== CATEGORY_ALL_ID && activeCategoryId !== CATEGORY_UNCATEGORIZED_ID
      ? activeCategoryId
      : null;
    const lastImported: Book[] = [];

    for (let i = 0; i < filePaths.length; i += 1) {
      const filePath = filePaths[i];
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      setBatchImport((prev) => ({ ...prev, current: i + 1 }));
      // 每本更新一下遮罩文案，让用户知道进度。覆盖之前的 setTimeout watchdog（showLoading 内部会重置）。
      showLoading(`正在导入 ${i + 1} / ${filePaths.length}：${fileName}`);

      try {
        const txtFile = await window.readerAPI.readTxtFile(filePath);
        if (!txtFile.ok) {
          failures.push({ name: fileName, reason: txtFile.errorMessage || '读取失败' });
          continue;
        }

        const existing = currentBooks.find((book) => !book.id.startsWith('cloud:') && book.bookHash && book.bookHash === txtFile.bookHash);
        if (existing) {
          skipped += 1;
          continue;
        }

        const title = txtFile.fileName.replace(/\.txt$/i, '');
        const importCharsPerPage = Math.max(200, 600 - (paginationFontSize - 16) * 15);
        const importedTotalPages = Math.max(1, Math.ceil(txtFile.content.length / importCharsPerPage));

        const importResult = await window.readerAPI.importTxtBook({
          originalPath: txtFile.filePath,
          bookHash: txtFile.bookHash,
          title,
          categoryId: targetCategoryId,
          currentPage: 1,
          totalPages: importedTotalPages,
          progress: 0,
          lastReadAt: null,
        });

        if (!importResult.ok) {
          failures.push({ name: fileName, reason: importResult.errorMessage || '导入失败' });
          continue;
        }

        currentBooks = [importResult.book as Book, ...currentBooks];
        lastImported.push(importResult.book as Book);
        imported += 1;
        // 实时刷新书架（让用户看到逐本入架）
        setBooks((prev) => [importResult.book as Book, ...prev]);
      } catch (error) {
        console.error('Batch import failed for', filePath, error);
        failures.push({ name: fileName, reason: error instanceof Error ? error.message : '未知错误' });
      }
    }

    setBatchImport({ current: filePaths.length, total: filePaths.length, failures, running: false });
    hideLoading();

    if (imported > 0 && syncSettingsRef.current.token && syncSettingsRef.current.serverUrl) {
      // 批量结束后只同步一次：选最后一本走 syncBookToServer，把书架元数据 push 上去。
      // 不在循环内同步，避免高频请求 NAS。
      void syncBookToServer(lastImported[lastImported.length - 1], { silent: true });
    }

    const failedCount = failures.length;
    const summary = [
      `成功导入 ${imported} 本`,
      skipped > 0 ? `跳过重复 ${skipped} 本` : '',
      failedCount > 0 ? `失败 ${failedCount} 本` : '',
    ].filter(Boolean).join('，');
    showToast(summary || '没有可导入的文件');
  };

  // 编辑书籍信息：打开弹窗并填入当前值。
  const openEditBookInfo = (book: Book) => {
    setEditBookInfo(book);
    setEditBookDraft({
      title: book.title || '',
      author: book.author || '',
      note: book.note || '',
      categoryId: book.categoryId && categoryIdSet.has(book.categoryId) ? book.categoryId : null,
    });
  };

  const closeEditBookInfo = () => {
    if (isSavingBookMeta) return;
    setEditBookInfo(null);
  };

  const handleSaveBookInfo = async () => {
    if (!editBookInfo) return;
    const title = editBookDraft.title.trim();
    if (!title) {
      showToast('书名不能为空');
      return;
    }
    if (!window.readerAPI?.updateBookMeta) {
      // 浏览器预览：只更新内存状态。
      const updated: Book = {
        ...editBookInfo,
        title,
        author: editBookDraft.author.trim(),
        note: editBookDraft.note,
        categoryId: editBookDraft.categoryId,
      };
      setBooks((prev) => prev.map((book) => (book.id === editBookInfo.id ? updated : book)));
      setEditBookInfo(null);
      showToast('已保存（仅本会话生效）');
      return;
    }

    setIsSavingBookMeta(true);
    try {
      const result = await window.readerAPI.updateBookMeta({
        id: editBookInfo.id,
        title,
        author: editBookDraft.author.trim(),
        note: editBookDraft.note,
        categoryId: editBookDraft.categoryId,
      });
      if (!result.ok) {
        showToast(result.errorMessage);
        return;
      }
      const updatedBook = result.book;
      if (updatedBook) {
        setBooks((prev) => prev.map((book) => (
          book.id === editBookInfo.id
            ? { ...book, ...updatedBook, content: book.content }
            : book
        )));
        // 同步元数据到云端（如果已登录），让其他设备也能拿到新书名 / 作者 / 备注 / 分类。
        if (syncSettingsRef.current.token && syncSettingsRef.current.serverUrl) {
          const merged: Book = { ...editBookInfo, ...updatedBook, content: editBookInfo.content };
          void syncBookToServer(merged, { silent: true });
        }
      }
      setEditBookInfo(null);
      showToast('已保存书籍信息');
    } catch (error) {
      console.error('Failed to update book meta:', error);
      showToast(error instanceof Error ? error.message : '保存失败');
    } finally {
      setIsSavingBookMeta(false);
    }
  };

  // 分类：新建 / 重命名 / 删除。所有交互走 React 弹窗，不用 window.prompt / window.confirm（在 Electron 渲染进程里它们是 no-op）。
  const openCreateCategoryDialog = () => {
    setNewCategoryName('');
    setIsCreateCategoryOpen(true);
  };

  const handleConfirmCreateCategory = async () => {
    const name = newCategoryName.trim().slice(0, 30);
    if (!name) {
      showToast('请填写分类名称');
      return;
    }
    if (categories.some((category) => category.name === name)) {
      showToast(`该分类已存在：${name}`);
      return;
    }

    if (!window.readerAPI?.createCategory) {
      setCategories((prev) => {
        const nextOrder = prev.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;
        const fallback: BookCategory = {
          id: `cat-local-${Date.now()}`,
          name,
          sortOrder: nextOrder,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return [...prev, fallback];
      });
      setIsCreateCategoryOpen(false);
      setNewCategoryName('');
      showToast(`已新建分类「${name}」（仅本会话生效）`);
      return;
    }

    setIsSavingCategory(true);
    try {
      const result = await window.readerAPI.createCategory({ name });
      if (!result.ok) {
        showToast(result.errorMessage);
        return;
      }
      setCategories((prev) => [...prev, result.category as BookCategory]);
      setIsCreateCategoryOpen(false);
      setNewCategoryName('');
      showToast(`已新建分类「${name}」`);
    } catch (error) {
      console.error('Failed to create category:', error);
      showToast('新建分类失败');
    } finally {
      setIsSavingCategory(false);
    }
  };

  const openRenameCategoryDialog = (category: BookCategory) => {
    setRenameCategoryTarget(category);
    setRenameCategoryDraft(category.name);
    setCategoryMenu(null);
  };

  const handleConfirmRenameCategory = async () => {
    if (!renameCategoryTarget) return;
    const name = renameCategoryDraft.trim().slice(0, 30);
    if (!name) {
      showToast('请填写分类名称');
      return;
    }
    if (name === renameCategoryTarget.name) {
      setRenameCategoryTarget(null);
      return;
    }
    if (categories.some((category) => category.id !== renameCategoryTarget.id && category.name === name)) {
      showToast(`该分类已存在：${name}`);
      return;
    }

    if (!window.readerAPI?.renameCategory) {
      setCategories((prev) => prev.map((category) => (
        category.id === renameCategoryTarget.id ? { ...category, name, updatedAt: Date.now() } : category
      )));
      setRenameCategoryTarget(null);
      showToast('已重命名分类');
      return;
    }

    setIsSavingCategory(true);
    try {
      const result = await window.readerAPI.renameCategory({ id: renameCategoryTarget.id, name });
      if (!result.ok) {
        showToast(result.errorMessage);
        return;
      }
      setCategories((prev) => prev.map((category) => (
        category.id === renameCategoryTarget.id ? (result.category as BookCategory) : category
      )));
      setRenameCategoryTarget(null);
      showToast('已重命名分类');
    } catch (error) {
      console.error('Failed to rename category:', error);
      showToast('重命名失败');
    } finally {
      setIsSavingCategory(false);
    }
  };

  // 保留原内联重命名的占位实现：当前不再走它，但万一未来想加 Enter 提交可以复用。
  // 故意空函数体，避免 TypeScript noUnused 抱怨。
  void editingCategoryId; void editingCategoryName; void setEditingCategoryId; void setEditingCategoryName;

  const openDeleteCategoryDialog = (category: BookCategory) => {
    setDeleteCategoryTarget(category);
    setCategoryMenu(null);
  };

  // 在指定坐标弹出分类操作菜单（同时给左键 ⋯ 和右键 onContextMenu 使用）。
  // x / y 是 client 坐标；会在视口边界 clamp，避免超出窗口。菜单约 140x80px。
  const openCategoryMenuAt = useCallback((category: BookCategory, clientX: number, clientY: number) => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const h = typeof window !== 'undefined' ? window.innerHeight : 768;
    const menuW = 140;
    const menuH = 80;
    const x = Math.max(8, Math.min(clientX, w - menuW - 8));
    const y = Math.max(8, Math.min(clientY, h - menuH - 8));
    setCategoryMenu({ category, x, y });
  }, []);

  // ============== 拖拽：书籍 -> 分类 ==============
  // 数据通道：text/book-id（书籍拖动），text/category-id（分类拖动）。
  // 分类项 onDrop 时根据 dataTransfer.types 来分发，避免两种行为互相误触发。
  const handleAssignBookToCategory = useCallback(async (bookId: string, categoryId: string | null) => {
    if (!bookId) return;
    const book = books.find((b) => b.id === bookId);
    if (!book) return;
    // 已经在目标分类，不做任何事，避免无意义的写盘 + 同步。
    const current = book.categoryId && categoryIdSet.has(book.categoryId) ? book.categoryId : null;
    if (current === categoryId) return;

    // 乐观更新：UI 立刻挪过去；写盘 / 同步在后台跑。失败时回滚 + toast。
    const prevCategoryId = book.categoryId ?? null;
    setBooks((prev) => prev.map((b) => (b.id === bookId ? { ...b, categoryId } : b)));

    const targetName = categoryId === null
      ? '未分类'
      : (categories.find((c) => c.id === categoryId)?.name || '该分类');
    showToast(`已移动到「${targetName}」`);

    if (!window.readerAPI?.updateBookMeta) return;
    try {
      const result = await window.readerAPI.updateBookMeta({ id: bookId, categoryId });
      if (!result.ok) {
        setBooks((prev) => prev.map((b) => (b.id === bookId ? { ...b, categoryId: prevCategoryId } : b)));
        showToast(result.errorMessage);
        return;
      }
      if (result.book) {
        setBooks((prev) => prev.map((b) => (
          b.id === bookId ? { ...b, ...result.book, content: b.content } : b
        )));
        if (syncSettingsRef.current.token && syncSettingsRef.current.serverUrl) {
          const merged: Book = { ...book, ...result.book, content: book.content };
          void syncBookToServer(merged, { silent: true });
        }
      }
    } catch (error) {
      console.error('Failed to assign book category:', error);
      setBooks((prev) => prev.map((b) => (b.id === bookId ? { ...b, categoryId: prevCategoryId } : b)));
      showToast('保存分类失败');
    }
  }, [books, categories, categoryIdSet, syncBookToServer]);

  // ============== 拖拽：分类排序 ==============
  // drop 时把 draggingCategoryId 插入到 overId 的 before / after，重新生成 sortOrder。
  const handleReorderCategories = useCallback(async (sourceId: string, overId: string, position: 'before' | 'after') => {
    if (sourceId === overId) return;
    const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
    const sourceIdx = sorted.findIndex((c) => c.id === sourceId);
    if (sourceIdx === -1) return;
    const [moved] = sorted.splice(sourceIdx, 1);
    let targetIdx = sorted.findIndex((c) => c.id === overId);
    if (targetIdx === -1) {
      // overId 不在剩余列表里（理论上不会），回滚。
      sorted.splice(sourceIdx, 0, moved);
      return;
    }
    if (position === 'after') targetIdx += 1;
    sorted.splice(targetIdx, 0, moved);

    const reassigned = sorted.map((c, idx) => ({ ...c, sortOrder: idx, updatedAt: Date.now() }));
    // 乐观更新
    setCategories(reassigned);

    if (!window.readerAPI?.reorderCategories) return;
    try {
      const result = await window.readerAPI.reorderCategories(reassigned.map((c) => c.id));
      if (!result.ok) {
        showToast(result.errorMessage);
        return;
      }
      setCategories(result.categories as BookCategory[]);
      // 分类顺序变化不需要 syncBookToServer：服务器端目前没存分类，本地持久化就够了。
    } catch (error) {
      console.error('Failed to reorder categories:', error);
      showToast('保存分类顺序失败');
    }
  }, [categories]);

  const handleConfirmDeleteCategory = async () => {
    if (!deleteCategoryTarget) return;
    const target = deleteCategoryTarget;
    if (!window.readerAPI?.deleteCategory) {
      setCategories((prev) => prev.filter((c) => c.id !== target.id));
      setBooks((prev) => prev.map((book) => (book.categoryId === target.id ? { ...book, categoryId: null } : book)));
      if (activeCategoryId === target.id) setActiveCategoryId(CATEGORY_ALL_ID);
      setDeleteCategoryTarget(null);
      showToast(`已删除分类「${target.name}」`);
      return;
    }

    setIsSavingCategory(true);
    try {
      const result = await window.readerAPI.deleteCategory(target.id);
      if (!result.ok) {
        showToast(result.errorMessage);
        return;
      }
      setCategories((prev) => prev.filter((c) => c.id !== target.id));
      setBooks((prev) => prev.map((book) => (book.categoryId === target.id ? { ...book, categoryId: null } : book)));
      if (activeCategoryId === target.id) setActiveCategoryId(CATEGORY_ALL_ID);
      setDeleteCategoryTarget(null);
      showToast(`已删除分类，${result.movedBooks ?? 0} 本书移动到未分类`);
    } catch (error) {
      console.error('Failed to delete category:', error);
      showToast('删除分类失败');
    } finally {
      setIsSavingCategory(false);
    }
  };

  // 确认删除书籍
  const handleConfirmDelete = async () => {
    if (!deleteConfirmBook) return;

    const target = deleteConfirmBook;
    const isCloudOnly = target.id.startsWith('cloud:');
    const bookHash = target.bookHash;

    try {
      if (isCloudOnly) {
        if (!bookHash) {
          showToast('云端书籍缺少 bookHash，无法安全删除。');
          return;
        }
        await deleteCloudBookByHash(bookHash);
        setCloudBooks(prev => prev.filter(book => book.bookHash !== bookHash));
        showToast(`已删除云端书籍《${target.title}》`);
        setDeleteConfirmBook(null);
        return;
      }

      if (window.readerAPI?.deleteBook) {
        const result = await window.readerAPI.deleteBook(target.id);

        if (!result.ok) {
          showToast(result.errorMessage);
          return;
        }
      }

      setBooks(prev => prev.filter(book => book.id !== target.id));
      setCloudBooks(prev => bookHash ? prev.filter(book => book.bookHash !== bookHash) : prev);

      if (bookHash && syncSettingsRef.current.token && syncSettingsRef.current.serverUrl) {
        try {
          await deleteCloudBookByHash(bookHash);
        } catch (error) {
          console.error('Failed to delete cloud book:', error);
          const classified = classifyCloudDeleteError(error);
          setSyncStatus(classified.status);
          if (classified.status === '登录已失效') {
            setSyncSettings(prev => ({ ...prev, token: '', user: null }));
          }
          showToast(`本地书籍已删除，但云端删除失败：${classified.message}`);
          setDeleteConfirmBook(null);
          return;
        }
      }

      showToast(`已从书架移除《${target.title}》`);
      setDeleteConfirmBook(null);
    } catch (error) {
      console.error('Failed to delete book:', error);
      if (isCloudOnly) {
        const classified = classifyCloudDeleteError(error);
        setSyncStatus(classified.status);
        if (classified.status === '登录已失效') {
          setSyncSettings(prev => ({ ...prev, token: '', user: null }));
        }
        showToast(classified.message);
        return;
      }
      showToast('删除书籍失败。');
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
      progress: progressPercent,
      updatedAt: new Date().toISOString()
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

  // 正文单击切换沉浸式阅读。切换前后都以当前 position 作为 anchor，避免布局收放导致阅读点漂移。
  const handleReaderBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!currentBook) return;
    if (isCatalogOpen || isSettingsOpen || isSyncPanelOpen || deleteConfirmBook) return;
    if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;

    const target = e.target as Node | null;
    if (!target || !contentTextRef.current?.contains(target)) return;
    if (target instanceof HTMLElement) {
      const interactiveTarget = target.closest('button,input,textarea,select,a,[role="button"],[role="slider"]');
      if (interactiveTarget) return;
    }

    const container = scrollContainerRef.current;
    const scrollTopBeforeToggle = container?.scrollTop ?? 0;
    let anchorPosition = currentPositionRef.current;

    if (container && currentBook) {
      const probeTop = container.scrollTop + Math.min(24, Math.max(0, container.clientHeight * 0.08));
      const offsets = sectionOffsetsRef.current;
      if (offsets.length > 0) {
        let lo = 0;
        let hi = offsets.length - 1;
        let activeIdx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (offsets[mid].top <= probeTop + 4) {
            activeIdx = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (activeIdx >= 0) {
          const sec = offsets[activeIdx];
          const within = sec.height > 0
            ? Math.max(0, Math.min(0.999, (probeTop - sec.top) / sec.height))
            : 0;
          anchorPosition = Math.round(sec.startIndex + within * (sec.endIndex - sec.startIndex));
        }
      }
      anchorPosition = Math.max(0, Math.min(anchorPosition, Math.max(0, currentBook.content.length - 1)));
    }

    const isHidingChrome = !isReaderChromeHidden;
    if (isHidingChrome) {
      readerChromeScrollTopBeforeHideRef.current = scrollTopBeforeToggle;
    }
    const storedScrollTopBeforeHide = readerChromeScrollTopBeforeHideRef.current;
    const restoreScrollTopTarget = (!isHidingChrome && container && storedScrollTopBeforeHide !== null)
      ? (() => {
          const currentMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
          const wasClampedAtHiddenBottom = storedScrollTopBeforeHide > currentMaxScrollTop + 2
            && Math.abs(scrollTopBeforeToggle - currentMaxScrollTop) <= 2;
          return wasClampedAtHiddenBottom ? storedScrollTopBeforeHide : scrollTopBeforeToggle;
        })()
      : scrollTopBeforeToggle;

    const restoreScrollTop = () => {
      const latestContainer = scrollContainerRef.current;
      if (!latestContainer) return;
      suppressScrollSyncUntilRef.current = performance.now() + 900;
      const maxScrollTop = Math.max(0, latestContainer.scrollHeight - latestContainer.clientHeight);
      latestContainer.scrollTop = Math.min(maxScrollTop, Math.max(0, restoreScrollTopTarget));
      currentPositionRef.current = anchorPosition;
      if (!isHidingChrome) {
        readerChromeScrollTopBeforeHideRef.current = null;
      }
    };

    anchorPositionRef.current = anchorPosition;
    currentPositionRef.current = anchorPosition;
    suppressScrollSyncUntilRef.current = performance.now() + 900;
    showCursorAndRestartTimer();
    setIsReaderChromeHidden((value) => !value);
    requestAnimationFrame(() => requestAnimationFrame(restoreScrollTop));
    window.setTimeout(restoreScrollTop, 220);
    window.setTimeout(restoreScrollTop, 420);
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

  const currentChapterIndex = useMemo(() => {
    const chapters = currentBook?.chapters ?? [];
    if (!chapters.length || !currentChapter) return -1;
    return chapters.findIndex((chapter) => chapter.id === currentChapter.id);
  }, [currentBook?.chapters, currentChapter]);
  const hasChapterNavigation = (currentBook?.chapters.length ?? 0) > 0;
  const previousChapter = currentChapterIndex > 0
    ? currentBook?.chapters[currentChapterIndex - 1] ?? null
    : null;
  const nextChapter = hasChapterNavigation && currentBook
    ? currentBook.chapters[currentChapterIndex < 0 ? 0 : currentChapterIndex + 1] ?? null
    : null;

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

    const targetBook = currentBookRef.current;
    if (targetBook?.id === bookId) {
      void syncBookToServer({ ...targetBook, bookmarks }, { silent: true });
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
    const commitTargetPosition = () => {
      suppressScrollSyncUntilRef.current = performance.now() + 800;
      updateCurrentPosition(targetPosition);
    };

    anchorPositionRef.current = targetPosition;
    suppressScrollSyncUntilRef.current = performance.now() + 800;
    updateCurrentPosition(targetPosition);
    scrollToPosition(targetPosition);
    requestAnimationFrame(() => requestAnimationFrame(commitTargetPosition));
    window.setTimeout(commitTargetPosition, 260);
    setIsCatalogOpen(false);
    showToast('已跳转到指定章节');
  };

  const handlePreviousChapter = () => {
    if (!previousChapter) return;
    handleChapterJump(previousChapter);
  };

  const handleNextChapter = () => {
    if (!nextChapter) return;
    handleChapterJump(nextChapter);
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
  }, [view, currentBook?.id, flatSections, renderWindow.start, renderWindow.end, readerSize.width, readerSize.height, paginationFontSize, paginationLineHeight, settings.pageMode]);

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
        if (isAdjustingSizeRef.current || isAdjustingFontRef.current || isAdjustingLineHeightRef.current) return;
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
  const deleteConfirmIsCloudBook = deleteConfirmBook?.id.startsWith('cloud:') ?? false;
  const deleteConfirmHasCloudSync = Boolean(syncSettings.token && syncSettings.serverUrl);

  return (
    <div
      className="w-full h-screen flex flex-col font-sans select-none overflow-hidden transition-colors duration-200"
      style={{ backgroundColor: currentStyle.bg, color: currentStyle.text }}
    >

      {/* ==========================================
          全局加载遮罩（更换服务器 / 打开书 / 登录 / 注册 / 批量导入会显示，
          后台同步 / 阅读进度保存 / 滚动 / 字号变化都不显示）
          ========================================== */}
      <LoadingOverlay
        visible={loadingOverlay.visible}
        message={loadingOverlay.message}
        currentStyle={currentStyle}
      />

      {/* 分类浮动菜单：左键 ⋯ 和右键 onContextMenu 共用同一份菜单 */}
      {categoryMenu && (
        <div
          className="fixed z-50 rounded border shadow-lg min-w-[140px] py-1"
          style={{
            left: categoryMenu.x,
            top: categoryMenu.y,
            backgroundColor: currentStyle.uiBg,
            borderColor: currentStyle.uiBorder,
            color: currentStyle.text,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => openRenameCategoryDialog(categoryMenu.category)}
            className="block w-full text-left text-xs px-3 py-1.5 hover:bg-black/5"
          >
            重命名
          </button>
          <button
            type="button"
            onClick={() => openDeleteCategoryDialog(categoryMenu.category)}
            className="block w-full text-left text-xs px-3 py-1.5 hover:bg-red-500/10 text-red-600"
          >
            删除分类
          </button>
        </div>
      )}

      {/* ==========================================
          4. 书架页面
          ========================================== */}
      {view === 'bookshelf' && (
        <div className="flex-1 flex flex-col h-full overflow-hidden p-4 sm:p-6 max-w-6xl w-full mx-auto">
          {/* 顶部工具栏 */}
          <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-4 pb-4 sm:pb-5 border-b mb-4 sm:mb-6" style={{ borderColor: currentStyle.uiBorder }}>
            <div className="flex items-center space-x-3 min-w-0">
              <span className="text-xl sm:text-2xl font-bold tracking-wide">摸鱼阅读</span>
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

              <button
                onClick={() => openSyncPanel()}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs border font-medium hover:opacity-80 transition-all"
                style={{ borderColor: currentStyle.uiBorder, color: isSyncErrorStatus ? '#DC2626' : currentStyle.text }}
                title={syncSettings.token ? '同步账号' : '点击登录同步账号'}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M20 9A8 8 0 006.34 5.34L4 8m16 8l-2.34 2.66A8 8 0 014 15" />
                </svg>
                <span>{displaySyncStatus}</span>
              </button>

              {/* 导入按钮：支持多选 */}
              <button
                onClick={() => void handleBatchImport()}
                disabled={batchImport.running}
                className="flex items-center space-x-1.5 px-4 py-1.5 rounded text-sm font-medium shadow-sm active:scale-95 transition-all text-white disabled:opacity-50"
                style={{ backgroundColor: currentStyle.accent }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span>{batchImport.running ? `导入中 ${batchImport.current}/${batchImport.total}` : '导入 TXT 小说'}</span>
              </button>
            </div>
          </div>

          {/* 移动端分类下拉（md 以下显示）*/}
          <div className="md:hidden mb-2 flex items-center gap-2">
            <span className="text-xs" style={{ color: currentStyle.uiTextMuted }}>分类:</span>
            <select
              value={activeCategoryId}
              onChange={(e) => setActiveCategoryId(e.target.value)}
              className="rounded px-2 py-1 outline-none border text-xs cursor-pointer font-medium flex-1 min-w-0"
              style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
            >
              <option value={CATEGORY_ALL_ID}>全部书籍 ({categoryCounts.get(CATEGORY_ALL_ID) ?? 0})</option>
              <option value={CATEGORY_UNCATEGORIZED_ID}>未分类 ({categoryCounts.get(CATEGORY_UNCATEGORIZED_ID) ?? 0})</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name} ({categoryCounts.get(category.id) ?? 0})</option>
              ))}
            </select>
            <button
              type="button"
              onClick={openCreateCategoryDialog}
              className="text-[11px] px-2 py-1 rounded border"
              style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
            >
              + 新建
            </button>
          </div>

          <div className="flex-1 flex flex-row min-h-0 gap-4 sm:gap-6">
            {/* 分类侧边栏 */}
            <aside
              className="hidden md:flex flex-col w-44 lg:w-52 flex-shrink-0 border rounded-lg p-3 overflow-y-auto"
              style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            >
              <div className="flex items-center justify-between mb-2 pb-2 border-b" style={{ borderColor: currentStyle.uiBorder }}>
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: currentStyle.uiTextMuted }}>分类</span>
                <button
                  type="button"
                  onClick={openCreateCategoryDialog}
                  className="text-[11px] px-2 py-0.5 rounded border hover:opacity-80"
                  style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                  title="新建分类"
                >
                  + 新建
                </button>
              </div>

              {([
                { id: CATEGORY_ALL_ID, name: '全部书籍', builtin: true as const, category: null },
                { id: CATEGORY_UNCATEGORIZED_ID, name: '未分类', builtin: true as const, category: null },
                ...[...categories]
                  .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.createdAt - b.createdAt))
                  .map((category) => ({ id: category.id, name: category.name, builtin: false as const, category })),
              ]).map((item) => {
                const isActive = activeCategoryId === item.id;
                const count = categoryCounts.get(item.id) ?? 0;
                const isDropTarget = dragOverCategoryId === item.id;
                const isDraggingThisCategory = !item.builtin && draggingCategoryId === item.id;
                const indicator = !item.builtin && categoryDropIndicator?.overId === item.id ? categoryDropIndicator.position : null;
                return (
                  <div
                    key={item.id}
                    draggable={!item.builtin}
                    onClick={() => setActiveCategoryId(item.id)}
                    onContextMenu={(e) => {
                      if (item.builtin) return; // 内置分类右键直接不响应。
                      e.preventDefault();
                      openCategoryMenuAt(item.category, e.clientX, e.clientY);
                    }}
                    onDragStart={(e) => {
                      if (item.builtin) { e.preventDefault(); return; }
                      e.dataTransfer.setData('text/category-id', item.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDraggingCategoryId(item.id);
                    }}
                    onDragEnd={() => {
                      setDraggingCategoryId(null);
                      setCategoryDropIndicator(null);
                      setDragOverCategoryId(null);
                    }}
                    onDragOver={(e) => {
                      const types = e.dataTransfer.types;
                      const isBookDrag = types.includes('text/book-id');
                      const isCategoryDrag = types.includes('text/category-id');
                      // 「全部书籍」不接收任何 drop。
                      if (item.id === CATEGORY_ALL_ID) return;

                      if (isBookDrag) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragOverCategoryId !== item.id) setDragOverCategoryId(item.id);
                        return;
                      }

                      if (isCategoryDrag && !item.builtin) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        // 决定插到上半还是下半：根据光标 y 在行内的相对位置。
                        const rect = e.currentTarget.getBoundingClientRect();
                        const position: 'before' | 'after' = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
                        if (!categoryDropIndicator || categoryDropIndicator.overId !== item.id || categoryDropIndicator.position !== position) {
                          setCategoryDropIndicator({ overId: item.id, position });
                        }
                      }
                    }}
                    onDragLeave={(e) => {
                      // 离开自己（而不是子元素）时才清理。pointer 进到子元素时 relatedTarget 仍在自身内。
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                        if (dragOverCategoryId === item.id) setDragOverCategoryId(null);
                        if (categoryDropIndicator?.overId === item.id) setCategoryDropIndicator(null);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const bookId = e.dataTransfer.getData('text/book-id');
                      const categoryId = e.dataTransfer.getData('text/category-id');
                      setDragOverCategoryId(null);
                      setCategoryDropIndicator(null);

                      if (bookId) {
                        if (item.id === CATEGORY_ALL_ID) {
                          showToast('「全部书籍」不是分类，请拖动到具体分类');
                          return;
                        }
                        const target = item.id === CATEGORY_UNCATEGORIZED_ID ? null : item.id;
                        void handleAssignBookToCategory(bookId, target);
                        return;
                      }

                      if (categoryId && !item.builtin) {
                        const pos = categoryDropIndicator?.overId === item.id ? categoryDropIndicator.position : 'before';
                        void handleReorderCategories(categoryId, item.id, pos);
                      }
                    }}
                    className="relative flex items-center justify-between gap-1 px-2 py-1.5 rounded cursor-pointer text-xs mb-1"
                    style={{
                      backgroundColor: isDropTarget
                        ? (isActive ? currentStyle.accent : `${currentStyle.accent}33`)
                        : (isActive ? currentStyle.accent : 'transparent'),
                      color: isActive ? '#FFFFFF' : currentStyle.text,
                      outline: isDropTarget ? `2px dashed ${currentStyle.accent}` : 'none',
                      outlineOffset: isDropTarget ? '-2px' : undefined,
                      opacity: isDraggingThisCategory ? 0.5 : 1,
                    }}
                  >
                    {/* 分类排序指示线 */}
                    {indicator === 'before' && (
                      <span aria-hidden="true" className="absolute left-0 right-0 -top-0.5 h-0.5" style={{ backgroundColor: currentStyle.accent }} />
                    )}
                    {indicator === 'after' && (
                      <span aria-hidden="true" className="absolute left-0 right-0 -bottom-0.5 h-0.5" style={{ backgroundColor: currentStyle.accent }} />
                    )}
                    <span className="truncate flex-1">{item.name}</span>
                    <span className="text-[10px] font-mono opacity-70 flex-shrink-0">{count}</span>
                    {!item.builtin && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCategoryMenuAt(item.category, e.clientX, e.clientY);
                        }}
                        className="text-xs px-1 rounded flex-shrink-0"
                        title="管理分类（也可右键）"
                        style={{ color: isActive ? '#FFFFFF' : currentStyle.uiTextMuted }}
                      >
                        ⋯
                      </button>
                    )}
                  </div>
                );
              })}
            </aside>

            {/* 书籍列表区域 */}
            <div className="flex-1 overflow-y-auto pr-1 min-w-0">
            {sortedBooks.length === 0 ? (
              <div className="h-64 flex flex-col items-center justify-center space-y-2">
                <svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth="1" viewBox="0 0 24 24" style={{ color: currentStyle.uiTextMuted }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
                <p className="text-sm font-medium" style={{ color: currentStyle.uiTextMuted }}>{activeCategoryId === CATEGORY_ALL_ID ? '书架空空如也，请点击右上角导入书籍' : '当前分类下还没有书籍'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-6">
                {sortedBooks.map(book => {
                  const displayAuthor = book.author?.trim() || '';
                  return (
                  <div
                    key={book.id}
                    draggable={!book.id.startsWith('cloud:')}
                    onDragStart={(e) => {
                      if (book.id.startsWith('cloud:')) { e.preventDefault(); return; }
                      e.dataTransfer.setData('text/book-id', book.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDraggingBookId(book.id);
                    }}
                    onDragEnd={() => {
                      setDraggingBookId(null);
                      setDragOverCategoryId(null);
                    }}
                    onClick={() => handleOpenBook(book.id)}
                    className="group relative border p-4 rounded-lg cursor-pointer shadow-sm hover:shadow-md transition-all flex flex-col justify-between"
                    style={{
                      backgroundColor: currentStyle.uiBg,
                      borderColor: currentStyle.uiBorder,
                      opacity: draggingBookId === book.id ? 0.5 : 1,
                    }}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <h3 className="min-w-0 flex-1 font-bold text-base line-clamp-1 group-hover:text-indigo-500 transition-colors">
                          {book.title}
                        </h3>
                        <div
                          className="book-card-actions flex items-center gap-2 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          {!book.id.startsWith('cloud:') && (
                            <button
                              type="button"
                              draggable={false}
                              onClick={(e) => { e.stopPropagation(); openEditBookInfo(book); }}
                              className="w-9 h-9 rounded border inline-flex items-center justify-center hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 transition-all"
                              style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}
                              title="编辑书籍信息"
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                          )}
                          <button
                            type="button"
                            draggable={false}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirmBook(book);
                            }}
                            className="w-9 h-9 rounded border inline-flex items-center justify-center text-red-600 hover:bg-red-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 transition-all"
                            style={{ borderColor: '#FCA5A5' }}
                            title={book.id.startsWith('cloud:') ? '删除云端书籍' : '删除书籍'}
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-4v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {/* 导入来源 */}
                      <p className="text-xs font-mono line-clamp-1 mb-1" style={{ color: currentStyle.uiTextMuted }}>
                        {book.id.startsWith('cloud:') ? '云端书架 · 需导入同一本 TXT' : (book.originalPath ? '本地 TXT' : '示例书籍')}
                      </p>
                      {displayAuthor && (
                        <p className="text-xs line-clamp-1 mb-1" style={{ color: currentStyle.uiTextMuted }}>
                          作者：{displayAuthor}
                        </p>
                      )}
                      {book.categoryId && categoryIdSet.has(book.categoryId) && (
                        <span className="inline-flex max-w-full truncate px-1.5 py-0.5 rounded border text-[10px]" style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}>
                          {categories.find((c) => c.id === book.categoryId)?.name}
                        </span>
                      )}
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
                  );
                })}
              </div>
            )}
            </div>
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
            className={`reader-chrome reader-topbar h-12 border-b px-2 sm:px-4 flex items-center justify-between select-none z-10 gap-2 ${isReaderChromeHidden ? 'reader-chrome-hidden reader-topbar-hidden' : ''}`}
            style={{ backgroundColor: currentStyle.uiBg, borderColor: isReaderChromeHidden ? 'transparent' : currentStyle.uiBorder }}
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
                onClick={() => openSyncPanel()}
                className="flex items-center space-x-1 px-3 py-1 rounded text-xs border font-medium hover:opacity-80 transition-all"
                style={{ borderColor: currentStyle.uiBorder, color: isSyncErrorStatus ? '#DC2626' : currentStyle.text }}
                title={syncSettings.token ? '同步账号' : '点击登录同步账号'}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M20 9A8 8 0 006.34 5.34L4 8m16 8l-2.34 2.66A8 8 0 014 15" />
                </svg>
                <span className="hidden sm:inline">{displaySyncStatus}</span>
              </button>

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
                ref={settingsToggleRef}
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
              onClick={handleReaderBodyClick}
              className={`flex-1 w-full overflow-y-auto overscroll-contain relative px-4 sm:px-6 md:px-8 pt-4 sm:pt-6 flex justify-center select-text ${settings.pageMode === 'click' ? 'cursor-pointer' : ''} ${isCursorHidden ? 'reader-cursor-hidden' : ''}`}
            >
              <div
                ref={contentTextRef}
                className="reader-content w-full max-w-2xl whitespace-pre-wrap tracking-wide font-serif break-words"
                style={{
                  '--reader-font-size': `${settings.fontSize}px`,
                  '--reader-line-height': settings.lineHeight,
                  paddingBottom: isReaderChromeHidden
                    ? 'calc(env(safe-area-inset-bottom, 0px) + 24px)'
                    : 'calc(env(safe-area-inset-bottom, 0px) + 112px)',
                  transition: 'padding-bottom 180ms ease',
                } as React.CSSProperties}
                onClick={(e) => {
                  // 划词选中时，点击不应该触发沉浸模式切换
                  if (typeof window !== 'undefined' && window.getSelection()?.toString()) {
                    e.stopPropagation();
                  }
                }}
              >
                {flatSections.map((section, idx) => {
                  const inWindow = idx >= renderWindow.start && idx <= renderWindow.end;
                  const estimatedHeight = sectionHeightEstimates[idx] ?? 0;
                  // 不在窗口的段：渲染成等高占位 <section>（不包文本，浏览器不会对它做行布局）；
                  // 这样 scrollHeight 接近真实值，自然连续滚动手感不变，但只有 ~6 段文本会真正 reflow。
                  const rawText = inWindow
                    ? (currentBook.content ?? '').slice(section.startIndex, section.endIndex)
                    : '';
                  const chapterTitle = section.chapterId ? chapterTitleById.get(section.chapterId) : '';
                  let text = rawText;
                  if (inWindow && chapterTitle) {
                    if (text.startsWith(chapterTitle)) {
                      text = text.slice(chapterTitle.length).replace(/^\r?\n/, '');
                    } else {
                      const firstLine = text.match(/^([^\r\n]*)(\r?\n)?/);
                      if (firstLine?.[1]?.trim() === chapterTitle.trim()) {
                        text = text.slice(firstLine[0].length);
                      }
                    }
                  }
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
                      {inWindow && chapterTitle && (
                        <h2 className="reader-chapter-title">{chapterTitle}</h2>
                      )}
                      {text}
                    </section>
                  );
                })}
              </div>
            </div>

            {/* 当前可视范围内有书签时，左上角显示书签 chip。位置基于 bookmark.position，
                 窗口缩放 / 字号变化也能跟着内容流走。 */}
            {!isReaderChromeHidden && visibleBookmarkMarkers.length > 0 && (
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

            {/* 8. 底部章节导航 + 状态栏：进度信息以独立 flex 行存在，不再以 absolute 覆盖正文。 */}
            <div
              className={`reader-chrome reader-bottom-chrome flex-shrink-0 border-t select-none ${isReaderChromeHidden ? 'reader-chrome-hidden' : ''}`}
              style={{
                backgroundColor: `${currentStyle.uiBg}E6`,
                borderColor: isReaderChromeHidden ? 'transparent' : currentStyle.uiBorder,
                color: currentStyle.uiTextMuted,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {hasChapterNavigation && (
                <div
                  className="px-3 py-2 border-b flex items-center justify-between gap-3"
                  style={{ borderColor: currentStyle.uiBorder }}
                >
                  <button
                    type="button"
                    disabled={!previousChapter}
                    onClick={handlePreviousChapter}
                    className="reader-chapter-nav-button min-h-[38px] min-w-[112px] inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-45"
                    style={{
                      backgroundColor: `${currentStyle.bg}99`,
                      borderColor: currentStyle.uiBorder,
                      color: previousChapter ? currentStyle.text : currentStyle.uiTextMuted,
                    }}
                  >
                    <span aria-hidden="true">←</span>
                    <span>上一章</span>
                  </button>
                  <button
                    type="button"
                    disabled={!nextChapter}
                    onClick={handleNextChapter}
                    className="reader-chapter-nav-button min-h-[38px] min-w-[112px] inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-45"
                    style={{
                      backgroundColor: `${currentStyle.bg}99`,
                      borderColor: currentStyle.uiBorder,
                      color: nextChapter ? currentStyle.text : currentStyle.uiTextMuted,
                    }}
                  >
                    <span>下一章</span>
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
              )}
              <div className="px-3 py-1.5 flex items-center justify-between text-[11px] font-mono pointer-events-none">
                <span className="truncate max-w-[55%]">
                  {currentChapter?.title ? `当前：${currentChapter.title}` : ''}
                </span>
                <span>
                  {currentBook.currentPage} / {totalPages} · {currentBook.progress}% ·{' '}
                  <span style={{ color: readerSyncStatusColor }}>{readerSyncStatusLabel}</span>
                </span>
              </div>
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
              ref={settingsPanelRef}
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

              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <label className="font-semibold" style={{ color: currentStyle.uiTextMuted }}>阅读行间距</label>
                  <span className="font-mono font-bold">{settings.lineHeight.toFixed(1)}</span>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    disabled={settings.lineHeight <= LINE_HEIGHT_MIN}
                    onClick={() => setSettings(prev => ({ ...prev, lineHeight: clampLineHeight(prev.lineHeight - LINE_HEIGHT_STEP) }))}
                    className="w-8 h-8 rounded border flex items-center justify-center font-bold disabled:opacity-40 active:bg-black/5"
                    style={{ borderColor: currentStyle.uiBorder }}
                    title="减小阅读行间距"
                  >
                    -
                  </button>
                  <input
                    type="range"
                    min={LINE_HEIGHT_MIN}
                    max={LINE_HEIGHT_MAX}
                    step={LINE_HEIGHT_STEP}
                    value={settings.lineHeight}
                    onChange={(e) => setSettings(prev => ({ ...prev, lineHeight: clampLineHeight(e.target.value) }))}
                    className="flex-1 accent-indigo-600 cursor-pointer h-1 rounded-lg"
                    style={{ backgroundColor: currentStyle.bg }}
                    aria-label="阅读行间距"
                  />
                  <button
                    disabled={settings.lineHeight >= LINE_HEIGHT_MAX}
                    onClick={() => setSettings(prev => ({ ...prev, lineHeight: clampLineHeight(prev.lineHeight + LINE_HEIGHT_STEP) }))}
                    className="w-8 h-8 rounded border flex items-center justify-center font-bold disabled:opacity-40 active:bg-black/5"
                    style={{ borderColor: currentStyle.uiBorder }}
                    title="增大阅读行间距"
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

      {isSyncPanelOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4"
          onClick={() => setIsSyncPanelOpen(false)}
        >
          <div
            className="w-full max-w-[460px] p-5 rounded-xl border shadow-2xl space-y-4"
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: currentStyle.uiBorder }}>
              <div>
                <h4 className="font-bold text-base">云端同步</h4>
                <p className="text-xs mt-1" style={{ color: currentStyle.uiTextMuted }}>
                  {syncPanelMode === 'register'
                    ? '注册'
                    : syncPanelMode === 'serverSetup'
                      ? '更换同步服务器'
                      : (syncSettings.user ? `当前账号：${syncSettings.user.username}` : '登录')}
                </p>
              </div>
              <span
                className="text-xs px-2 py-1 rounded border"
                style={{
                  borderColor: currentStyle.uiBorder,
                  color: isSyncErrorStatus ? '#DC2626' : currentStyle.text,
                }}
              >
                {displaySyncStatus}
              </span>
            </div>

            {syncPanelMode === 'login' && (
              <>
                <div className="rounded border p-3 text-xs leading-relaxed" style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}>
                  只同步书架、阅读进度、书签和阅读设置，不上传 TXT 小说正文。换设备后请在本机重新导入同一本 TXT，客户端会用 SHA256 bookHash 自动匹配云端进度。
                </div>

                {!syncSettings.serverUrl && !syncSettings.token && (
                  <div className="rounded border p-3 text-xs leading-relaxed border-amber-400" style={{ color: '#B45309', backgroundColor: 'rgba(245, 158, 11, 0.08)' }}>
                    尚未配置同步服务器，请先注册或在“更换同步服务器”中填写服务器地址。
                  </div>
                )}

                {syncSettings.token ? (
                  <div className="rounded border p-3 text-xs leading-relaxed" style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}>
                    已登录账号：<span className="font-semibold" style={{ color: currentStyle.text }}>{syncSettings.user?.username || '用户'}</span>
                    <br />
                    同步服务器：<span className="font-mono">{syncSettings.serverUrl}</span>
                    <br />
                    同步在后台自动进行，无需手动触发。
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>用户名</label>
                      <input
                        value={syncForm.username}
                        onChange={(event) => setSyncForm(prev => ({ ...prev, username: event.target.value }))}
                        autoComplete="username"
                        disabled={isAuthenticating}
                        className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                        style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>密码</label>
                      <input
                        type="password"
                        value={syncForm.password}
                        onChange={(event) => setSyncForm(prev => ({ ...prev, password: event.target.value }))}
                        autoComplete="current-password"
                        disabled={isAuthenticating}
                        className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                        style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap justify-end gap-2 pt-1">
                  {syncSettings.token ? (
                    <button
                      onClick={handleSyncLogout}
                      className="px-3 py-1.5 rounded text-xs border font-medium active:scale-95 transition-all"
                      style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                    >
                      退出登录
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setSyncPanelMode('register');
                          setSyncForm(prev => ({ ...prev, password: '', confirmPassword: '' }));
                        }}
                        disabled={isAuthenticating}
                        className="px-3 py-1.5 rounded text-xs border font-medium active:scale-95 transition-all disabled:opacity-50"
                        style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                      >
                        注册
                      </button>
                      <button
                        onClick={() => void handleSyncAuth('login')}
                        disabled={isAuthenticating}
                        className="px-3 py-1.5 rounded text-xs font-medium text-white active:scale-95 transition-all shadow-sm disabled:opacity-50"
                        style={{ backgroundColor: currentStyle.accent }}
                      >
                        {isAuthenticating ? '登录中…' : '登录'}
                      </button>
                    </>
                  )}
                </div>

                <div className="pt-2 border-t flex justify-between items-center text-[11px]" style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}>
                  <span>{syncSettings.serverUrl ? `同步服务器：${syncSettings.serverUrl}` : '尚未配置服务器'}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingServerUrl(syncSettings.serverUrl || '');
                      setSyncPanelMode('serverSetup');
                    }}
                    className="underline opacity-80 hover:opacity-100"
                  >
                    更换同步服务器
                  </button>
                </div>
              </>
            )}

            {syncPanelMode === 'register' && (
              <>
                <div className="rounded border p-3 text-xs leading-relaxed" style={{ borderColor: currentStyle.uiBorder, color: currentStyle.uiTextMuted }}>
                  注册成功后，服务器地址会被保存到本地，后续登录、同步无需再次输入。
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>
                    同步服务器地址
                  </label>
                  <input
                    value={syncForm.serverUrl}
                    onChange={(event) => setSyncForm(prev => ({ ...prev, serverUrl: event.target.value }))}
                    onBlur={(event) => {
                      const value = event.target.value;
                      const normalized = normalizeSyncServerUrl(value);
                      if (normalized && normalized !== value.trim()) {
                        setSyncForm(prev => ({ ...prev, serverUrl: normalized }));
                      }
                    }}
                    placeholder="https://novel.mydomain.com"
                    className="w-full rounded border px-3 py-2 text-sm outline-none"
                    style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                  />
                  <p className="text-[11px]" style={{ color: currentStyle.uiTextMuted }}>
                    填写根地址即可，无需 /api 或 :3300。例如：https://novel.mydomain.com
                  </p>
                  {hasApiSuffix(syncForm.serverUrl) && (
                    <p className="text-[11px] text-amber-600">
                      服务器地址只需要填写根地址，不需要包含 /api。注册时会自动去除。
                    </p>
                  )}
                  {isPublicHttpUrl(syncForm.serverUrl) && (
                    <p className="text-[11px] text-amber-600">公网访问建议使用 HTTPS。</p>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleTestConnection()}
                    disabled={isTestingServer || isAuthenticating || !syncForm.serverUrl.trim()}
                    className="px-3 py-1.5 rounded text-xs border font-medium active:scale-95 transition-all disabled:opacity-50"
                    style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                  >
                    {isTestingServer ? '测试中…' : '测试连接'}
                  </button>
                </div>

                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>用户名</label>
                    <input
                      value={syncForm.username}
                      onChange={(event) => setSyncForm(prev => ({ ...prev, username: event.target.value }))}
                      autoComplete="username"
                      disabled={isAuthenticating}
                      className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                      style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>密码（至少 8 位）</label>
                    <input
                      type="password"
                      value={syncForm.password}
                      onChange={(event) => setSyncForm(prev => ({ ...prev, password: event.target.value }))}
                      autoComplete="new-password"
                      disabled={isAuthenticating}
                      className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                      style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>确认密码</label>
                    <input
                      type="password"
                      value={syncForm.confirmPassword}
                      onChange={(event) => setSyncForm(prev => ({ ...prev, confirmPassword: event.target.value }))}
                      autoComplete="new-password"
                      disabled={isAuthenticating}
                      className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                      style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap justify-end gap-2 pt-1">
                  <button
                    onClick={() => {
                      setSyncPanelMode('login');
                      setSyncForm(prev => ({ ...prev, confirmPassword: '' }));
                    }}
                    disabled={isAuthenticating}
                    className="px-3 py-1.5 rounded text-xs border font-medium active:scale-95 transition-all disabled:opacity-50"
                    style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                  >
                    返回登录
                  </button>
                  <button
                    onClick={() => void handleSyncAuth('register')}
                    disabled={isAuthenticating}
                    className="px-3 py-1.5 rounded text-xs font-medium text-white active:scale-95 transition-all shadow-sm disabled:opacity-50"
                    style={{ backgroundColor: currentStyle.accent }}
                  >
                    {isAuthenticating ? '注册中…' : '注册'}
                  </button>
                </div>
              </>
            )}

            {syncPanelMode === 'serverSetup' && (
              <>
                <div className="rounded border p-3 text-xs leading-relaxed border-amber-400" style={{ color: '#B45309', backgroundColor: 'rgba(245, 158, 11, 0.08)' }}>
                  更换服务器后，当前账号和云端数据可能无法继续匹配。保存后将自动退出登录，请使用新服务器的账号重新登录。
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>
                    新的同步服务器地址
                  </label>
                  <input
                    value={pendingServerUrl}
                    onChange={(event) => setPendingServerUrl(event.target.value)}
                    onBlur={(event) => {
                      const value = event.target.value;
                      const normalized = normalizeSyncServerUrl(value);
                      if (normalized && normalized !== value.trim()) {
                        setPendingServerUrl(normalized);
                      }
                    }}
                    placeholder="https://novel.mydomain.com"
                    className="w-full rounded border px-3 py-2 text-sm outline-none"
                    style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                  />
                  <p className="text-[11px]" style={{ color: currentStyle.uiTextMuted }}>
                    填写根地址即可，无需 /api 或 :3300。
                  </p>
                </div>

                <div className="flex flex-wrap justify-end gap-2 pt-1">
                  <button
                    onClick={() => setSyncPanelMode('login')}
                    className="px-3 py-1.5 rounded text-xs border font-medium active:scale-95 transition-all"
                    style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                  >
                    返回
                  </button>
                  <button
                    onClick={handleChangeServer}
                    disabled={!pendingServerUrl.trim() || isChangingServer}
                    className="px-3 py-1.5 rounded text-xs font-medium text-white active:scale-95 transition-all shadow-sm disabled:opacity-50"
                    style={{ backgroundColor: currentStyle.accent }}
                  >
                    {isChangingServer ? '保存中…' : '保存'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==========================================
          分类管理弹窗：新建 / 重命名 / 删除
          ========================================== */}
      {isCreateCategoryOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => { if (!isSavingCategory) setIsCreateCategoryOpen(false); }}
        >
          <div
            className="w-full max-w-[360px] p-5 rounded-xl border shadow-2xl space-y-3"
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-bold text-base">新建分类</h4>
            <div className="space-y-1">
              <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>分类名称（最多 30 字）</label>
              <input
                autoFocus
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newCategoryName.trim()) { e.preventDefault(); void handleConfirmCreateCategory(); }
                  if (e.key === 'Escape' && !isSavingCategory) setIsCreateCategoryOpen(false);
                }}
                disabled={isSavingCategory}
                maxLength={30}
                className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
                placeholder="例如：科幻 / 正在阅读 / 收藏"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCreateCategoryOpen(false)}
                disabled={isSavingCategory}
                className="px-3 py-1.5 rounded text-xs border font-medium disabled:opacity-50"
                style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmCreateCategory()}
                disabled={isSavingCategory || !newCategoryName.trim()}
                className="px-3 py-1.5 rounded text-xs font-medium text-white shadow-sm disabled:opacity-50"
                style={{ backgroundColor: currentStyle.accent }}
              >
                {isSavingCategory ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {renameCategoryTarget && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => { if (!isSavingCategory) setRenameCategoryTarget(null); }}
        >
          <div
            className="w-full max-w-[360px] p-5 rounded-xl border shadow-2xl space-y-3"
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-bold text-base">重命名分类</h4>
            <div className="space-y-1">
              <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>分类名称</label>
              <input
                autoFocus
                value={renameCategoryDraft}
                onChange={(e) => setRenameCategoryDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renameCategoryDraft.trim()) { e.preventDefault(); void handleConfirmRenameCategory(); }
                  if (e.key === 'Escape' && !isSavingCategory) setRenameCategoryTarget(null);
                }}
                disabled={isSavingCategory}
                maxLength={30}
                className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRenameCategoryTarget(null)}
                disabled={isSavingCategory}
                className="px-3 py-1.5 rounded text-xs border font-medium disabled:opacity-50"
                style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmRenameCategory()}
                disabled={isSavingCategory || !renameCategoryDraft.trim()}
                className="px-3 py-1.5 rounded text-xs font-medium text-white shadow-sm disabled:opacity-50"
                style={{ backgroundColor: currentStyle.accent }}
              >
                {isSavingCategory ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteCategoryTarget && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => { if (!isSavingCategory) setDeleteCategoryTarget(null); }}
        >
          <div
            className="w-full max-w-[360px] p-5 rounded-xl border shadow-2xl space-y-3"
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-bold text-base text-red-500">删除分类</h4>
            <p className="text-xs leading-relaxed" style={{ color: currentStyle.text }}>
              确定删除分类「{deleteCategoryTarget.name}」吗？
              <br />
              该分类下的书籍会移动到「未分类」，不会被删除。
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteCategoryTarget(null)}
                disabled={isSavingCategory}
                className="px-3 py-1.5 rounded text-xs border font-medium disabled:opacity-50"
                style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDeleteCategory()}
                disabled={isSavingCategory}
                className="px-3 py-1.5 rounded text-xs font-medium bg-red-600 hover:bg-red-700 text-white shadow-sm disabled:opacity-50"
              >
                {isSavingCategory ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          编辑书籍信息弹窗
          ========================================== */}
      {editBookInfo && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4"
          onClick={closeEditBookInfo}
        >
          <div
            className="w-full max-w-[440px] p-5 rounded-xl border shadow-2xl space-y-3"
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: currentStyle.uiBorder }}>
              <h4 className="font-bold text-base">编辑书籍信息</h4>
              <button
                onClick={closeEditBookInfo}
                disabled={isSavingBookMeta}
                className="text-xs hover:underline disabled:opacity-50"
              >
                关闭
              </button>
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>书名</label>
              <input
                value={editBookDraft.title}
                onChange={(e) => setEditBookDraft((prev) => ({ ...prev, title: e.target.value }))}
                disabled={isSavingBookMeta}
                maxLength={120}
                className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>作者（可选）</label>
              <input
                value={editBookDraft.author}
                onChange={(e) => setEditBookDraft((prev) => ({ ...prev, author: e.target.value }))}
                disabled={isSavingBookMeta}
                maxLength={60}
                className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>备注（可选，最多 500 字）</label>
              <textarea
                value={editBookDraft.note}
                onChange={(e) => setEditBookDraft((prev) => ({ ...prev, note: e.target.value }))}
                disabled={isSavingBookMeta}
                rows={3}
                maxLength={500}
                className="w-full rounded border px-3 py-2 text-sm outline-none resize-y disabled:opacity-60"
                style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold" style={{ color: currentStyle.uiTextMuted }}>分类</label>
              <select
                value={editBookDraft.categoryId ?? ''}
                onChange={(e) => setEditBookDraft((prev) => ({ ...prev, categoryId: e.target.value || null }))}
                disabled={isSavingBookMeta}
                className="w-full rounded border px-3 py-2 text-sm outline-none disabled:opacity-60"
                style={{ backgroundColor: currentStyle.bg, borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              >
                <option value="">未分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </div>

            <p className="text-[11px]" style={{ color: currentStyle.uiTextMuted }}>
              修改只更新软件内的书籍信息，不会改动你电脑上的原 TXT 文件，也不会重新解析章节。
            </p>

            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={closeEditBookInfo}
                disabled={isSavingBookMeta}
                className="px-3 py-1.5 rounded text-xs border font-medium active:scale-95 transition-all disabled:opacity-50"
                style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              >
                取消
              </button>
              <button
                onClick={() => void handleSaveBookInfo()}
                disabled={isSavingBookMeta || !editBookDraft.title.trim()}
                className="px-3 py-1.5 rounded text-xs font-medium text-white active:scale-95 transition-all shadow-sm disabled:opacity-50"
                style={{ backgroundColor: currentStyle.accent }}
              >
                {isSavingBookMeta ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          批量导入失败列表展示（导入结束 + 有失败时显示）
          ========================================== */}
      {!batchImport.running && batchImport.failures.length > 0 && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4"
          onClick={() => setBatchImport((prev) => ({ ...prev, failures: [] }))}
        >
          <div
            className="w-full max-w-[440px] p-5 rounded-xl border shadow-2xl space-y-3"
            style={{ backgroundColor: currentStyle.uiBg, borderColor: currentStyle.uiBorder }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-bold text-base">部分 TXT 导入失败</h4>
            <div className="max-h-60 overflow-y-auto space-y-2">
              {batchImport.failures.map((failure, idx) => (
                <div key={idx} className="text-xs rounded border p-2" style={{ borderColor: currentStyle.uiBorder }}>
                  <div className="font-mono truncate">{failure.name}</div>
                  <div className="mt-1 text-[11px]" style={{ color: currentStyle.uiTextMuted }}>{failure.reason}</div>
                </div>
              ))}
            </div>
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setBatchImport((prev) => ({ ...prev, failures: [] }))}
                className="px-3 py-1.5 rounded text-xs border font-medium"
                style={{ borderColor: currentStyle.uiBorder, color: currentStyle.text }}
              >
                关闭
              </button>
            </div>
          </div>
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
              <span>{deleteConfirmIsCloudBook ? '确认删除云端书籍' : '确认移除书籍'}</span>
            </h4>
            <div className="space-y-2 text-xs leading-relaxed" style={{ color: currentStyle.text }}>
              {deleteConfirmIsCloudBook ? (
                <>
                  <p>确认删除云端书籍“{deleteConfirmBook.title}”吗？</p>
                  <p>删除后，这本书的云端阅读进度、书签、阅读设置和书架记录将被删除。本机 TXT 原文件不会受到影响。</p>
                </>
              ) : (
                <>
                  <p>确定要删除《{deleteConfirmBook.title}》吗？</p>
                  <p>
                    删除后会移除本地书架记录、阅读进度和书签，不会删除用户电脑上的原始 TXT 文件。
                    {deleteConfirmHasCloudSync ? ' 当前已登录云同步，也会按 bookHash 删除对应云端记录。' : ''}
                  </p>
                </>
              )}
            </div>
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
