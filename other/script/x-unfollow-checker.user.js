// ==UserScript==
// @name         X互关检测助手 (X followers Checker)
// @namespace    https://github.com/ScienceNoBorders/ExperienceSharing/blob/master/other/script/x-unfollow-checker.user
// @version      2.6.1
// @description  支持在"正在关注"与"已验证的关注者"两种列表页面使用。点击面板上的"开始扫描"后才会自动滚动列表，滚动过程中实时检测每个用户是否回关你；切换到其它页面会自动暂停，回到原页面自动恢复；滚动到底部即完成。鼠标悬停在任意一行上会弹出类似 X 原生的资料悬浮卡（头像/昵称/简介/回关状态），支持在卡片内直接打开主页、复制、取消关注。未回关名单支持勾选后一键批量取消关注，每人间隔约1~2秒模拟真实点击执行，进度会缓存到后台可断点续传。全程基于网页 DOM 解析实现，不调用官方 API，不需要开发者 Token 或 Bearer Token。
// @author       新之助(@xinzhizhu9795)
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes     false
// @license      Apache 2.0
// ==/UserScript==

/*
 * ============================================================================
 * X 互关检测助手
 * ----------------------------------------------------------------------------
 * 功能概述：
 *   1. 当用户访问 https://x.com/<用户名>/following 页面时自动启动。
 *   2. 自动无限滚动关注列表查看互关状态；全部人的回关状态也已经确定，不需要再额外访问任何用户主页。
 *   3. 不发起任何官方 API 请求、不使用 Bearer Token、不批量使用隐藏 iframe
 *      访问主页（隐藏 iframe 仅作为"手动重新扫描单个用户"且其卡片已被
 *      虚拟列表回收、不在当前 DOM 中时的一次性兜底方案）。
 *   4. 结果通过 GM_setValue / GM_getValue 持久化缓存，刷新页面后仍然保留。
 *   5. 右侧浮动面板展示实时扫描进度、统计数据、可搜索/排序/分类查看的
 *      用户名列表，支持暂停/继续扫描、单个用户重新扫描、整体重新扫描、
 *      CSV/TXT 导出、复制用户名、折叠与关闭。
 *
 * 模块划分：
 *   - CONFIG / 常量区      : 集中管理所有可配置数值，杜绝魔法数字。
 *   - Logger               : 彩色 Console 日志输出模块。
 *   - Utils                : 通用工具函数模块（延时、随机数、格式化、文件导出等）。
 *   - Storage 类           : 基于 GM_setValue / GM_getValue 的持久化缓存模块。
 *   - Parser 类            : DOM 解析模块，负责识别页面结构、提取用户名、
 *                            判断回关状态（核心依据：userFollowIndicator）。
 *   - TaskQueue 类         : 通用异步并发任务队列模块，供"手动重新扫描单个
 *                            用户"时的隐藏 iframe 兜底探测使用。
 *   - Prober 类            : 基于隐藏 iframe 的兜底探测模块（仅用于手动重扫）。
 *   - Scanner 类           : 扫描调度模块，实现"边滚动边探测"核心流程。
 *   - Panel 类             : 右侧固定 UI 面板模块。
 *   - 启动引导 main()      : 检测页面类型、处理 SPA 路由变化、组装以上模块。
 *
 * 声明：本脚本完全基于浏览器可见的网页 DOM 内容工作，不调用任何私有/官方
 *       GraphQL 或 REST API，不需要任何形式的 Token。由于 X 网站的前端结构
 *       可能随时调整，Parser 模块中的选择器均采用"多重候选 + 兜底"策略，
 *       以尽量适配版本变化，但不能保证在网站重大改版后 100% 有效。
 * ============================================================================
 */

(function () {
  'use strict';

  // 防止脚本被重复注入（例如某些环境下 document-idle 被触发多次）。
  if (window.__ufsScriptLoaded) {
    return;
  }
  window.__ufsScriptLoaded = true;

  /* ==========================================================================
   * 1. 常量与配置区（CONFIG）
   *    所有魔法数字统一在此声明，便于维护与调优。
   * ======================================================================== */

  /** 脚本版本号，用于面板标题展示与日志输出。 */
  const SCRIPT_VERSION = '2.6.1';

  /**
   * 三种扫描结果状态 + 一种初始占位状态。
   * MUTUAL   : 对方已回关（互相关注）。
   * NOT_BACK : 对方未回关。
   * FAILED   : 扫描失败 / 页面不存在 / 账号被封 / 超时（统一归为"失败"分类）。
   * PENDING  : 尚未开始扫描的初始占位状态。
   */
  const SCAN_STATUS = Object.freeze({
    PENDING: 'pending',
    MUTUAL: 'mutual',
    NOT_BACK: 'not_back',
    FAILED: 'failed',
  });

  /** 全局可调参数集中配置，避免代码中出现裸露的数字。 */
  const CONFIG = Object.freeze({
    // 并发探测数量（建议 2~3，过高容易触发风控）。
    DEFAULT_CONCURRENCY: 2,
    MAX_CONCURRENCY: 3,

    // 每个探测任务开始前的随机等待区间（毫秒）。
    MIN_TASK_DELAY_MS: 500,
    MAX_TASK_DELAY_MS: 1500,

    // 失败重试相关。
    MAX_RETRIES: 3,
    RETRY_BACKOFF_BASE_MS: 1500,

    // 自动滚动关注列表相关。为保证数据准确性，采用"小步增量滚动 + 较长
    // 随机等待"的保守策略，而不是直接跳到页面最底部——一次性跳到底部
    // 可能导致虚拟列表来不及渲染中间的用户卡片（以及其中的
    // userFollowIndicator 回关标识），造成漏判/误判。
    SCROLL_STEP_RATIO: 0.7, // 每次滚动视口高度的比例。
    MIN_SCROLL_STEP_PX: 260, // 每次滚动的最小像素数（应对极小视口）。
    // 判定"已经滚动到底"不再依赖对整个 document.body 的 MutationObserver
    // （页面里与关注列表无关的其它区域——通知红点、动画、广告等——的变动
    // 会不断刷新"最近一次变动时间"，导致永远无法判定为空闲，滚动停不
    // 下来）。改为直接检测"页面是否已经到达可滚动的最底部 + 页面总高度
    // 是否不再增长 + 本轮是否有新用户被处理"，三者同时满足才计入一次
    // 空闲轮次，判定更直接、更贴近"真的到底了"这个事实。
    BOTTOM_THRESHOLD_PX: 300, // 距离页面底部多少像素以内视为"已到底部"。
    IDLE_ROUNDS_TO_STOP: 4,

    // 隐藏 iframe 探测相关。
    IFRAME_WIDTH_PX: 500,
    IFRAME_HEIGHT_PX: 900,
    PROBE_POLL_INTERVAL_MS: 300,
    PROBE_MAX_WAIT_MS: 9000,
    PROBE_HARD_TIMEOUT_MS: 12000,

    // 批量取消关注相关。要求"每秒最多处理一位"，因此下限不低于 1000ms；
    // 上限再加一点随机浮动，避免间隔过于规律而被识别为自动化脚本。
    UNFOLLOW_INTERVAL_MIN_MS: 1000,
    UNFOLLOW_INTERVAL_MAX_MS: 1800,
    // 点击"取消关注"后，等待二次确认弹窗（若出现）的超时时间。
    UNFOLLOW_CONFIRM_WAIT_MS: 4000,
    // 点击确认后，等待按钮状态变化以核实是否真的取消关注成功的超时时间。
    UNFOLLOW_VERIFY_WAIT_MS: 5000,
    // 取消关注某个用户时，若其卡片当前不在 DOM 中（多数情况下如此——
    // 扫描完成后页面通常停在底部，早先见过的用户卡片已被虚拟列表回收），
    // 需要重新滚动页面去定位该用户；以下控制这次"定位滚动"的节奏与
    // 安全上限（避免因用户已不在列表中而无限滚动下去）。
    UNFOLLOW_SEARCH_SCROLL_WAIT_MIN_MS: 700,
    UNFOLLOW_SEARCH_SCROLL_WAIT_MAX_MS: 1300,
    UNFOLLOW_SEARCH_MAX_ROUNDS: 80,

    // 面板相关。
    PANEL_WIDTH_PX: 340,
    PANEL_DEFAULT_TOP_PX: 70,
    PANEL_EDGE_MARGIN_PX: 16,
    PANEL_MIN_VISIBLE_PX: 60, // 拖拽时至少保留在视口内的可见像素，防止被拖出屏幕。
    DRAG_THRESHOLD_PX: 4, // 超过该移动距离才视为"拖拽"而非"点击"。

    // 行内悬浮资料卡（HoverCard）相关：鼠标悬停在某一行上一小段时间后
    // 才弹出（避免快速划过时频繁闪烁），移出后也留一小段"宽限期"再关闭
    // （让用户可以把鼠标移进卡片本身点击里面的按钮）。
    HOVER_CARD_WIDTH_PX: 280,
    HOVER_CARD_SHOW_DELAY_MS: 350,
    HOVER_CARD_HIDE_DELAY_MS: 200,

    // 导出文件时释放 Blob URL 的延迟（毫秒）。
    BLOB_REVOKE_DELAY_MS: 4000,

    // 缓存版本号，若未来数据结构变化可递增此值使旧缓存自然失效。
    STORAGE_VERSION: 'v2',
  });

  /** 关注列表 / 个人主页 URL 中需要排除的保留路径（非用户名）。 */
  const RESERVED_PATH_SEGMENTS = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search',
    'compose', 'logout', 'tos', 'privacy', 'login', 'signup', 'following',
    'followers', 'lists', 'bookmarks', 'communities', 'premium_sign_up',
    'jobs', 'topics', 'moments', 'account', 'download', 'about',
    'verified_followers', 'connect_people',
  ]);

  /**
   * 本脚本支持自动运行的"列表类"页面类型（形如 /用户名/<类型>）。
   * 目前支持"正在关注"列表与"已验证的关注者"列表，两者的检测方法
   * 完全一致：都是读取每张用户卡片中的 [data-testid="userFollowIndicator"]。
   */
  const SUPPORTED_LIST_PAGE_TYPES = ['following', 'verified_followers'];

  /** 各列表页面类型对应的中文展示名称，用于面板标题与日志。 */
  const LIST_PAGE_TYPE_LABELS = {
    following: '正在关注',
    verified_followers: '已验证的关注者',
  };

  /**
   * 判断"回关"状态不再使用任何文案匹配或 JSON 解析，只通过 X 最新版 DOM
   * 提供的 [data-testid="userFollowIndicator"] 节点是否存在来判定：
   * 存在 = 已回关，不存在 = 未回关。详见 Parser.detectFollowBadgeInProfile()。
   *
   * 下面两组短语仅用于"页面不存在 / 账号被封禁"这两种需要自动跳过的场景，
   * 且只匹配开销极低的 document.title（不再读取 body.innerText 做全文本
   * 扫描），避免不必要的强制回流（reflow）拖慢扫描速度。
   */
  const NOT_FOUND_TITLE_PHRASES = ["doesn't exist", '不存在'];
  const SUSPENDED_TITLE_PHRASES = ['account suspended', '账号已被冻结', '已被暂停'];

  /* ==========================================================================
   * 2. 日志模块（Logger）
   *    统一的彩色 Console 输出，便于调试与追踪扫描过程。
   * ======================================================================== */

  const Logger = {
    /**
     * 生成带有颜色样式的日志前缀文本。
     * @param {string} color CSS 颜色值。
     * @returns {string} 可用于 console.log 的样式字符串。
     */
    _style(color) {
      return `color:${color};font-weight:bold;`;
    },

    /** 输出普通信息日志（蓝色）。 */
    info(message, ...args) {
      console.log(`%c[UFS] ${message}`, this._style('#1d9bf0'), ...args);
    },

    /** 输出成功日志（绿色）。 */
    success(message, ...args) {
      console.log(`%c[UFS] ${message}`, this._style('#00ba7c'), ...args);
    },

    /** 输出警告日志（橙色）。 */
    warn(message, ...args) {
      console.warn(`%c[UFS] ${message}`, this._style('#ffad1f'), ...args);
    },

    /** 输出错误日志（红色）。 */
    error(message, ...args) {
      console.error(`%c[UFS] ${message}`, this._style('#f4212e'), ...args);
    },

    /** 输出调试日志（灰色），用于低优先级的过程信息。 */
    debug(message, ...args) {
      console.debug(`%c[UFS] ${message}`, this._style('#8b98a5'), ...args);
    },
  };

  /* ==========================================================================
   * 3. 工具函数模块（Utils）
   *    与业务无关的通用能力：延时、随机数、格式化、文件导出、DOM 辅助等。
   * ======================================================================== */

  const Utils = {
    /**
     * 异步睡眠指定毫秒数。
     * @param {number} milliseconds 睡眠时长。
     * @returns {Promise<void>}
     */
    sleep(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    },

    /**
     * 返回 [min, max] 闭区间内的随机整数。
     * @param {number} min 最小值。
     * @param {number} max 最大值。
     * @returns {number} 随机整数。
     */
    randomBetween(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },

    /**
     * 随机延时（组合 randomBetween 与 sleep），用于规避风控节流。
     * @param {number} min 最小毫秒数。
     * @param {number} max 最大毫秒数。
     * @returns {Promise<void>}
     */
    randomDelay(min, max) {
      return Utils.sleep(Utils.randomBetween(min, max));
    },

    /**
     * 生成一个足够唯一的短 ID，用于标记探测请求 token。
     * @returns {string} 唯一标识字符串。
     */
    generateId() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    },

    /**
     * 校验字符串是否符合 X 用户名规则（字母/数字/下划线，1~15 位）。
     * @param {string} name 待校验字符串。
     * @returns {boolean} 是否合法。
     */
    isValidUsername(name) {
      return typeof name === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(name);
    },

    /**
     * 从一个 <a href="..."> 链接中提取用户名，排除保留路径与非法格式。
     * @param {string} href 原始 href 属性值（可能是相对路径）。
     * @returns {string|null} 提取到的用户名，若不合法则返回 null。
     */
    extractUsernameFromHref(href) {
      if (!href) return null;
      try {
        const parsedUrl = new URL(href, location.origin);
        const segments = parsedUrl.pathname.split('/').filter(Boolean);
        if (segments.length === 0) return null;
        const candidate = segments[0];
        if (!Utils.isValidUsername(candidate)) return null;
        if (RESERVED_PATH_SEGMENTS.has(candidate.toLowerCase())) return null;
        return candidate;
      } catch (error) {
        return null;
      }
    },

    /**
     * 从形如 "/username/following" 或 "/username/verified_followers" 的路径中
     * 提取所有者用户名。
     * @param {string} pathname 当前页面路径。
     * @returns {string|null} 所有者用户名，若不匹配则返回 null。
     */
    extractOwnerUsernameFromPath(pathname) {
      const pattern = new RegExp(
        `^\\/([A-Za-z0-9_]{1,15})\\/(?:${SUPPORTED_LIST_PAGE_TYPES.join('|')})\\/?$`, 'i'
      );
      const match = pathname.match(pattern);
      return match ? match[1] : null;
    },

    /**
     * 从路径中提取列表页面类型（'following' 或 'verified_followers'）。
     * @param {string} pathname 当前页面路径。
     * @returns {string|null} 页面类型，若不匹配任何受支持类型则返回 null。
     */
    extractListPageTypeFromPath(pathname) {
      const pattern = new RegExp(
        `^\\/[A-Za-z0-9_]{1,15}\\/(${SUPPORTED_LIST_PAGE_TYPES.join('|')})\\/?$`, 'i'
      );
      const match = pathname.match(pattern);
      return match ? match[1].toLowerCase() : null;
    },

    /**
     * 判断给定路径是否为本脚本支持自动运行的"列表类"页面
     * （关注列表 / 已验证的关注者列表）。
     * @param {string} pathname 当前页面路径。
     * @returns {boolean} 是否匹配。
     */
    isSupportedListPagePath(pathname) {
      return Utils.extractOwnerUsernameFromPath(pathname) !== null;
    },

    /**
     * 数组去重。
     * @param {Array<*>} array 原始数组。
     * @returns {Array<*>} 去重后的新数组。
     */
    uniqueArray(array) {
      return Array.from(new Set(array));
    },

    /**
     * 将毫秒数格式化为易读的耗时字符串，例如 "4m12s" 或 "37s"。
     * @param {number} milliseconds 毫秒数。
     * @returns {string} 格式化后的字符串。
     */
    formatDuration(milliseconds) {
      const totalSeconds = Math.floor(milliseconds / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes <= 0) return `${seconds}s`;
      return `${minutes}m${String(seconds).padStart(2, '0')}s`;
    },

    /** 返回当前时间戳（毫秒）。 */
    nowTimestamp() {
      return Date.now();
    },

    /**
     * 轮询等待某个条件函数返回真值，超时后返回 null。
     * @param {Function} conditionFn 条件判断函数，返回真值表示满足。
     * @param {{timeout:number, interval:number}} options 超时与轮询间隔配置。
     * @returns {Promise<*>} 条件函数的返回值，超时则为 null。
     */
    waitFor(conditionFn, options = {}) {
      const timeout = options.timeout ?? 5000;
      const interval = options.interval ?? 200;
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          let result;
          try {
            result = conditionFn();
          } catch (error) {
            result = undefined;
          }
          if (result) {
            clearInterval(timer);
            resolve(result);
          } else if (Date.now() - startedAt >= timeout) {
            clearInterval(timer);
            resolve(null);
          }
        }, interval);
      });
    },

    /**
     * 生成一个防抖函数。
     * @param {Function} fn 原始函数。
     * @param {number} wait 防抖等待时间（毫秒）。
     * @returns {Function} 防抖后的函数。
     */
    debounce(fn, wait) {
      let timerId = null;
      return function debounced(...args) {
        if (timerId) clearTimeout(timerId);
        timerId = setTimeout(() => fn.apply(this, args), wait);
      };
    },

    /**
     * 对单个 CSV 字段进行转义（处理逗号、引号、换行）。
     * @param {*} field 原始字段值。
     * @returns {string} 转义后的字符串。
     */
    escapeCsvField(field) {
      const str = String(field ?? '');
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    },

    /**
     * 将二维数组转换为 CSV 文本。
     * @param {Array<Array<*>>} rows 行数据数组。
     * @returns {string} CSV 文本内容。
     */
    toCsv(rows) {
      return rows.map((row) => row.map(Utils.escapeCsvField).join(',')).join('\r\n');
    },

    /**
     * 触发浏览器下载一个文本文件（无需 GM_download 权限）。
     * @param {string} filename 下载文件名。
     * @param {string} content 文件文本内容。
     * @param {string} mimeType 文件 MIME 类型。
     */
    downloadTextFile(filename, content, mimeType) {
      const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(objectUrl), CONFIG.BLOB_REVOKE_DELAY_MS);
    },

    /**
     * 将数值限制在 [min, max] 区间内。
     * @param {number} value 原始值。
     * @param {number} min 最小值。
     * @param {number} max 最大值。
     * @returns {number} 限制后的值。
     */
    clampNumber(value, min, max) {
      return Math.min(Math.max(value, min), max);
    },

    /**
     * 模拟一次真实的用户点击：依次派发 pointerdown / mousedown / pointerup /
     * mouseup / click 事件序列，而不是只调用 element.click()，以尽量兼容
     * 对事件时序有要求的前端框架。事件会使用目标元素自身所在文档的
     * window（this.ownerDocument.defaultView）来构造，因此在隐藏 iframe
     * 内的元素上调用也能正确工作。
     * @param {Element} element 要点击的目标元素。
     */
    simulateClick(element) {
      if (!element) return;
      const view = (element.ownerDocument && element.ownerDocument.defaultView) || window;
      const eventInit = { bubbles: true, cancelable: true, composed: true, view };
      const dispatch = (eventType, isPointerEvent) => {
        try {
          const EventCtor = isPointerEvent && view.PointerEvent ? view.PointerEvent : view.MouseEvent;
          element.dispatchEvent(new EventCtor(eventType, eventInit));
        } catch (error) {
          // 部分环境可能不支持 PointerEvent 或事件被拦截，忽略即可，
          // 后续的 click 事件通常已经足以触发对应的处理函数。
        }
      };
      dispatch('pointerdown', true);
      dispatch('mousedown', false);
      dispatch('pointerup', true);
      dispatch('mouseup', false);
      dispatch('click', false);
    },
  };

  /* ==========================================================================
   * 3.5 滚动速度模块（ScrollSpeedManager）
   *     滚动等待时间不再是写死的常量，而是可以在面板上用滑块实时调整的
   *     "速度档位"。为了防止用户为了追求速度而把间隔调得过短、触发 X
   *     的风控/反自动化检测，最快的一档也设有安全下限，无法再往下调。
   *     当前档位通过 GM_setValue 持久化，刷新页面 / 下次打开仍然保留。
   * ======================================================================== */

  /**
   * 速度档位表，从"很慢"到"很快"。每一档给出一个随机等待区间（毫秒），
   * 实际等待时间会在区间内随机取值（而不是固定值），进一步降低被识别为
   * 自动化脚本的概率。最后一档（最快）的下限就是本脚本认定的安全阈值，
   * 不会再提供比它更快的选项。
   */
  const SCROLL_SPEED_PRESETS = Object.freeze([
    { label: '很慢', min: 3200, max: 4800 },
    { label: '慢', min: 2400, max: 3600 },
    { label: '标准', min: 1600, max: 2800 },
    { label: '快', min: 1100, max: 1900 },
    { label: '很快（已达安全下限）', min: 900, max: 1500 },
  ]);

  /** 默认速度档位索引（对应"标准"档，即脚本原先的默认节奏）。 */
  const DEFAULT_SPEED_INDEX = 2;

  /** 用于持久化速度档位选择的 GM_setValue 键名（跨账号通用的 UI 偏好）。 */
  const SCROLL_SPEED_STORAGE_KEY = 'ufs_scroll_speed_index_v1';

  const ScrollSpeedManager = {
    presets: SCROLL_SPEED_PRESETS,
    currentIndex: DEFAULT_SPEED_INDEX,

    /** 从 GM_getValue 中恢复上次选择的速度档位（越界或读取失败则回退默认档）。 */
    load() {
      let savedIndex = DEFAULT_SPEED_INDEX;
      try {
        const raw = GM_getValue(SCROLL_SPEED_STORAGE_KEY, DEFAULT_SPEED_INDEX);
        const parsed = Number(raw);
        if (Number.isInteger(parsed)) savedIndex = parsed;
      } catch (error) {
        Logger.warn('读取扫描速度设置失败，使用默认档位', error);
      }
      this.currentIndex = Utils.clampNumber(savedIndex, 0, this.presets.length - 1);
    },

    /**
     * 设置并持久化新的速度档位。
     * @param {number} index 档位索引。
     */
    setIndex(index) {
      const clampedIndex = Utils.clampNumber(Math.round(index), 0, this.presets.length - 1);
      this.currentIndex = clampedIndex;
      try {
        GM_setValue(SCROLL_SPEED_STORAGE_KEY, clampedIndex);
      } catch (error) {
        Logger.warn('保存扫描速度设置失败', error);
      }
    },

    /** 获取当前档位的完整信息（label/min/max）。 */
    getCurrent() {
      return this.presets[this.currentIndex];
    },

    /** 获取档位数量，供面板滑块设置 max 属性使用。 */
    getPresetCount() {
      return this.presets.length;
    },
  };

  /* ==========================================================================
   * 4. 缓存模块（Storage 类）
   *    基于 GM_setValue / GM_getValue 实现的命名空间化持久化存储。
   *    命名空间按"所有者用户名"隔离，避免不同账号数据互相污染。
   * ======================================================================== */

  class Storage {
    /**
     * @param {string} ownerUsername 列表页面所属的用户名（即"我"）。
     * @param {string} pageType 列表页面类型（'following' 或 'verified_followers'），
     *   不同类型的数据分开缓存，避免互相覆盖。
     */
    constructor(ownerUsername, pageType = 'following') {
      this.ownerUsername = ownerUsername;
      this.pageType = pageType;
      this.namespace = `ufs_${CONFIG.STORAGE_VERSION}_${ownerUsername.toLowerCase()}_${pageType}`;
    }

    /**
     * 拼接带命名空间的存储键名。
     * @param {string} name 键名后缀。
     * @returns {string} 完整键名。
     */
    _key(name) {
      return `${this.namespace}_${name}`;
    }

    /**
     * 读取并解析 JSON 格式的缓存值，异常时返回默认值。
     * @param {string} name 键名后缀。
     * @param {*} fallback 默认值。
     * @returns {*} 解析后的值。
     */
    _readJson(name, fallback) {
      try {
        const raw = GM_getValue(this._key(name), null);
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw);
      } catch (error) {
        Logger.warn(`读取缓存失败: ${name}`, error);
        return fallback;
      }
    }

    /**
     * 将值序列化为 JSON 后写入缓存。
     * @param {string} name 键名后缀。
     * @param {*} value 待写入的值。
     */
    _writeJson(name, value) {
      try {
        GM_setValue(this._key(name), JSON.stringify(value));
      } catch (error) {
        Logger.error(`写入缓存失败: ${name}`, error);
      }
    }

    /** 获取已缓存的关注列表用户名数组。 */
    getFollowingList() {
      return this._readJson('following_list', []);
    }

    /** 保存关注列表用户名数组（自动去重）。 */
    saveFollowingList(list) {
      this._writeJson('following_list', Utils.uniqueArray(list));
    }

    /** 获取已缓存的全部扫描结果映射表（username -> 结果对象）。 */
    getScanResults() {
      return this._readJson('scan_results', {});
    }

    /** 覆盖保存整个扫描结果映射表。 */
    saveScanResults(resultsMap) {
      this._writeJson('scan_results', resultsMap);
    }

    /**
     * 保存单个用户的扫描结果（读取-合并-写回）。
     * @param {string} username 用户名。
     * @param {object} resultEntry 结果对象 { status, reason, checkedAt, retries }。
     */
    saveScanResult(username, resultEntry) {
      const all = this.getScanResults();
      all[username] = resultEntry;
      this.saveScanResults(all);
    }

    /** 获取扫描元信息（开始时间、耗时、总数等）。 */
    getMeta() {
      return this._readJson('meta', {
        startedAt: null, updatedAt: null, scannedCount: 0, totalCount: 0, elapsedMs: 0,
      });
    }

    /** 保存扫描元信息。 */
    saveMeta(meta) {
      this._writeJson('meta', meta);
    }

    /**
     * 获取尚未处理完的"待取消关注"队列（用户名数组）。这份队列在批量
     * 取消关注过程中每处理完一人就会更新一次，因此刷新页面 / 重新打开
     * 后仍能从断点继续，实现"缓存到后台慢慢取消"的效果。
     */
    getPendingUnfollowQueue() {
      return this._readJson('pending_unfollow_queue', []);
    }

    /** 保存"待取消关注"队列。 */
    savePendingUnfollowQueue(usernames) {
      this._writeJson('pending_unfollow_queue', usernames);
    }

    /** 清空当前所有者名下的全部缓存数据（关注列表、扫描结果、元信息、待取消关注队列）。 */
    clearAll() {
      this._writeJson('following_list', []);
      this._writeJson('scan_results', {});
      this._writeJson('meta', { startedAt: null, updatedAt: null, scannedCount: 0, totalCount: 0, elapsedMs: 0 });
      this._writeJson('pending_unfollow_queue', []);
    }
  }

  /* ==========================================================================
   * 5. DOM 解析模块（Parser 类）
   *    负责识别页面类型、提取用户名、判断回关状态。所有选择器均采用
   *    "多重候选 + 兜底"策略以适配 X 前端结构的变化。
   * ======================================================================== */

  class Parser {
    /** 判断当前页面是否为本脚本支持的"列表类"页面（关注列表 / 已验证的关注者）。 */
    static isSupportedListPage() {
      return Utils.isSupportedListPagePath(location.pathname);
    }

    /** 从当前 URL 中提取列表所属的用户名（即"我"）。 */
    static getOwnerUsernameFromCurrentUrl() {
      return Utils.extractOwnerUsernameFromPath(location.pathname);
    }

    /** 从当前 URL 中提取列表页面类型（'following' 或 'verified_followers'）。 */
    static getListPageTypeFromCurrentUrl() {
      return Utils.extractListPageTypeFromPath(location.pathname);
    }

    /**
     * 查找关注列表时间线中的每一个用户卡片元素，采用多重候选选择器兼容
     * X 不同版本的 DOM 结构。
     * @param {Document} doc 目标文档对象。
     * @returns {Array<Element>} 用户卡片元素数组。
     */
    static findUserCells(doc = document) {
      const candidateSelectors = [
        '[data-testid="cellInnerDiv"]',
        '[data-testid="UserCell"]',
        'div[role="listitem"]',
      ];
      for (const selector of candidateSelectors) {
        const nodes = doc.querySelectorAll(selector);
        if (nodes && nodes.length > 0) return Array.from(nodes);
      }
      return [];
    }

    /**
     * 从单个用户卡片元素中提取其主用户名（排除所有者本人与保留路径）。
     * 这是"边滚动边探测"架构的核心基础方法：滚动时每发现一个卡片，
     * 立即调用本方法取得用户名，再配合 cellHasFollowBackBadge() 同步
     * 判断回关状态，无需再单独访问对方主页。
     * @param {Element} cellElement 用户卡片元素。
     * @returns {string|null} 用户名，若无法识别则返回 null。
     */
    static extractUsernameFromCell(cellElement) {
      const owner = Parser.getOwnerUsernameFromCurrentUrl();
      const anchors = cellElement.querySelectorAll('a[role="link"][href^="/"]');
      for (const anchor of anchors) {
        const candidate = Utils.extractUsernameFromHref(anchor.getAttribute('href') || '');
        if (candidate && (!owner || candidate.toLowerCase() !== owner.toLowerCase())) {
          return candidate;
        }
      }
      return null;
    }

    /**
     * 从单个用户卡片中提取一份"资料摘要"（用户名、头像、昵称、认证徽章、
     * 简介），供面板的悬浮资料卡使用，效果类似 X 原生头像悬浮卡
     * （HoverCard），但数据来源是列表卡片本身、在扫描过程中顺手采集，
     * 不需要额外触发悬浮交互或访问对方主页，因此没有额外的网络等待。
     *
     * 注意：这里的头像/昵称/简介提取采用的是通用 DOM 启发式规则（找卡片
     * 内第一个 <img> 作为头像、卡片内第一个"像昵称"的短文本 span 作为
     * 昵称、卡片内最长的一段 dir="auto" 文本作为简介），而不是依赖某个
     * 具体的 data-testid——因为目前还没有拿到"普通列表卡片"完整 DOM
     * 结构的截图来核实精确选择器。如果实际展示效果不理想（例如误把
     * 某段其它文字当成了简介/昵称），把某一张卡片在 DevTools 里完整
     * 展开的截图发过来，可以据此把选择器改得更精确。
     * @param {Element} cellElement 用户卡片元素。
     * @returns {{username:string|null, avatarUrl:string|null, displayName:string, isVerified:boolean, bio:string}} 资料摘要。
     */
    static extractProfileSummaryFromCell(cellElement) {
      const avatarImg = cellElement.querySelector('img[src]');
      const avatarUrl = avatarImg ? avatarImg.getAttribute('src') : null;

      const verifiedBadge = cellElement.querySelector(
        'svg[aria-label*="Verified" i], svg[aria-label*="验证"], [aria-label*="Verified account" i]'
      );
      const isVerified = Boolean(verifiedBadge);

      const owner = Parser.getOwnerUsernameFromCurrentUrl();
      let usernameAnchor = null;
      let username = null;
      const anchors = cellElement.querySelectorAll('a[role="link"][href^="/"]');
      for (const anchor of anchors) {
        const candidate = Utils.extractUsernameFromHref(anchor.getAttribute('href') || '');
        if (candidate && (!owner || candidate.toLowerCase() !== owner.toLowerCase())) {
          usernameAnchor = anchor;
          username = candidate;
          break;
        }
      }

      // 显示昵称：在整张卡片范围内（而不是只局限在用户名锚点内部——
      // 昵称和 @handle 在实际 DOM 里未必是同一个祖先节点）按文档顺序
      // 查找第一个"像昵称"的短文本：不是 @handle 本身、长度适中（避免
      // 误抓成大段简介）。找不到时才用用户名本身兜底。
      let displayName = username || '';
      const atHandle = username ? `@${username}` : null;
      const allSpans = cellElement.querySelectorAll('span');
      for (const span of allSpans) {
        const text = (span.textContent || '').trim();
        if (!text) continue;
        if (text.startsWith('@')) continue;
        if (atHandle && text === atHandle) continue;
        if (text.length > 50) continue; // 太长大概率是简介而不是昵称。
        displayName = text;
        break;
      }

      let bio = '';
      let longestLength = 0;
      const bioCandidates = cellElement.querySelectorAll('div[dir="auto"], span[dir="auto"]');
      bioCandidates.forEach((node) => {
        if (usernameAnchor && usernameAnchor.contains(node)) return; // 排除昵称/用户名区域本身。
        const text = (node.textContent || '').trim();
        if (text.length >= 8 && text.length > longestLength) {
          longestLength = text.length;
          bio = text;
        }
      });

      return { username, avatarUrl, displayName, isVerified, bio };
    }

    /**
     * 判断单个用户卡片元素内是否存在 X 官方提供的回关标识节点
     * [data-testid="userFollowIndicator"]。这是唯一的回关判断依据，
     * 纯 DOM 查询，无文本匹配、无多语言判断、无 JSON 解析，开销极低，
     * 可以在滚动过程中同步执行而不产生任何网络请求或额外等待。
     * @param {Element} cellElement 用户卡片元素。
     * @returns {boolean} 是否命中回关标识（true = 已回关）。
     */
    static cellHasFollowBackBadge(cellElement) {
      return Boolean(cellElement.querySelector('[data-testid="userFollowIndicator"]'));
    }

    /**
     * 判断当前页面是否显示"账号被封禁/暂停"提示。仅检查开销极低的
     * document.title，不读取 body.innerText（避免强制触发整页布局回流）。
     * @param {Document} doc 目标文档对象。
     * @returns {boolean} 是否命中。
     */
    static isAccountSuspended(doc = document) {
      const title = (doc.title || '').toLowerCase();
      return SUSPENDED_TITLE_PHRASES.some((phrase) => title.includes(phrase.toLowerCase()));
    }

    /**
     * 判断当前页面是否显示"该账号不存在"提示。同样只检查 document.title。
     * @param {Document} doc 目标文档对象。
     * @returns {boolean} 是否命中。
     */
    static isProfileNotFound(doc = document) {
      const title = (doc.title || '').toLowerCase();
      return NOT_FOUND_TITLE_PHRASES.some((phrase) => title.includes(phrase.toLowerCase()));
    }

    /**
     * 判断对方主页的核心内容（用户名区域 / 关注按钮）是否已经渲染完成。
     * 用于确认"没有回关标识"这一结论是在页面加载完毕之后得出的，而不是
     * 因为页面还没渲染完导致的误判。
     * @param {Document} doc 目标文档对象。
     * @returns {boolean} 是否已渲染完成。
     */
    static isProfileRendered(doc = document) {
      return Boolean(
        doc.querySelector('[data-testid="UserName"]') ||
        doc.querySelector('[data-testid$="-follow"]') ||
        doc.querySelector('[data-testid$="-unfollow"]') ||
        doc.querySelector('[data-testid="UserProfileHeader_Items"]')
      );
    }

    /**
     * 唯一的回关判断依据：对方主页 DOM 中是否存在
     * [data-testid="userFollowIndicator"] 节点。
     * 存在 = 对方已回关，不存在 = 未回关。
     * 纯 querySelector 实现，不做任何文本匹配、多语言判断或 JSON 解析，
     * 以降低 CPU 占用、减少 GC、提升扫描速度。
     * @param {Document} doc 目标文档对象。
     * @returns {boolean} 是否命中回关标识。
     */
    static detectFollowBadgeInProfile(doc = document) {
      return Boolean(doc.querySelector('[data-testid="userFollowIndicator"]'));
    }

    /**
     * 综合检测方法：在隐藏 iframe 中轮询等待对方主页渲染完成，依次判断
     * "是否被封禁/不存在（自动跳过） -> 是否存在 userFollowIndicator 节点
     * （已回关） -> 主页是否已渲染完成但未命中标识（未回关）"。
     * 此方法在探测响应端（iframe 内）被调用，全程仅使用 querySelector，
     * 不读取 innerText、不解析 JSON。
     * @param {Document} doc 目标文档对象。
     * @returns {Promise<{status:string, reason:string}>} 检测结果。
     */
    static async waitAndDetectFollowState(doc = document) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < CONFIG.PROBE_MAX_WAIT_MS) {
        if (Parser.isAccountSuspended(doc)) {
          return { status: SCAN_STATUS.FAILED, reason: 'suspended' };
        }
        if (Parser.isProfileNotFound(doc)) {
          return { status: SCAN_STATUS.FAILED, reason: 'not_found' };
        }
        if (Parser.detectFollowBadgeInProfile(doc)) {
          return { status: SCAN_STATUS.MUTUAL, reason: 'dom_badge' };
        }
        if (Parser.isProfileRendered(doc)) {
          // 页面主体已渲染完成，但未命中 userFollowIndicator 节点，
          // 判定为"未回关"。
          return { status: SCAN_STATUS.NOT_BACK, reason: 'dom_rendered_no_badge' };
        }
        await Utils.sleep(CONFIG.PROBE_POLL_INTERVAL_MS);
      }
      return { status: SCAN_STATUS.FAILED, reason: 'timeout' };
    }

    /**
     * 在给定容器（用户卡片或整个文档）内查找"取消关注"按钮，即
     * data-testid 以 "-unfollow" 结尾的按钮节点。
     * @param {Element|Document} container 查找范围。
     * @returns {Element|null} 找到的按钮，未找到则为 null。
     */
    static findUnfollowButton(container) {
      return container.querySelector('[data-testid$="-unfollow"]');
    }

    /**
     * 判断一个 follow/unfollow 按钮当前是否已经变为"未关注（可回关）"状态，
     * 用于核实一次取消关注操作是否真正生效。注意 "-unfollow" 本身也以
     * "follow" 结尾，因此必须排除它，只认严格的 "-follow" 后缀。
     * @param {Element} button 按钮元素。
     * @returns {boolean} 是否为"回关/关注"按钮（即已不再关注对方）。
     */
    static isFollowButton(button) {
      const testId = (button && button.getAttribute('data-testid')) || '';
      return testId.endsWith('-follow') && !testId.endsWith('-unfollow');
    }

    /**
     * 在弹出的二次确认对话框中查找"确认取消关注"按钮。
     *
     * 经实际 DOM 结构核实（用户提供的 DevTools 截图）：
     *   - 弹窗容器：data-testid="confirmationSheetDialog"
     *   - 确认按钮：data-testid="confirmationSheetConfirm"（标题为
     *     "取消关注 @xxx?" 的 <h1 role="heading"> 也在这个容器内）
     *   - 取消按钮：data-testid="confirmationSheetCancel"
     * 因此优先精确锁定到弹窗容器范围内查找确认按钮，既保证唯一命中
     * （不会误触发页面上其它位置可能存在的同名按钮），又在容器一时
     * 找不到时自动退化为全文档查找同一个 testid。若未来 X 改版导致这个
     * testid 也失效，再兜底为"在任意看起来像对话框的容器内，按钮文案
     * 精确匹配'Unfollow'或包含'取消关注'"。
     * @param {Document} doc 目标文档对象。
     * @returns {Element|null} 找到的确认按钮，未找到则为 null。
     */
    static findUnfollowConfirmButton(doc) {
      const dialog = doc.querySelector('[data-testid="confirmationSheetDialog"]');
      const scopedButton = dialog && dialog.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (scopedButton) return scopedButton;

      const documentWideButton = doc.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (documentWideButton) return documentWideButton;

      const dialogSelectors = ['[role="alertdialog"]', '[role="dialog"]', '[data-testid*="sheetDialog"]'];
      const dialogRegions = [];
      dialogSelectors.forEach((selector) => {
        doc.querySelectorAll(selector).forEach((region) => dialogRegions.push(region));
      });

      for (const region of dialogRegions) {
        const candidates = region.querySelectorAll('button, div[role="button"]');
        for (const candidate of candidates) {
          const text = (candidate.textContent || '').trim().toLowerCase();
          if (text === 'unfollow' || text.includes('取消关注')) {
            return candidate;
          }
        }
      }
      return null;
    }

    /**
     * 点击一个"取消关注"按钮，并完整处理 X 常见的二次确认弹窗，最后核实
     * 按钮状态是否已经从"取消关注"变为"关注/回关"，以此判断操作是否
     * 真正成功。全程通过 Utils.simulateClick 模拟真实的用户点击事件序列，
     * 并输出详细的诊断日志，便于在浏览器控制台定位具体在哪一步失败。
     * @param {Element} button 取消关注按钮元素。
     * @returns {Promise<boolean>} 是否确认取消关注成功。
     */
    static async clickUnfollowButtonAndVerify(button) {
      const ownerDoc = button.ownerDocument || document;
      const usernameHint = button.getAttribute('aria-label') || button.getAttribute('data-testid') || '';
      Logger.debug(`点击取消关注按钮: ${usernameHint}`);
      Utils.simulateClick(button);

      // X 对取消关注这类破坏性操作通常会弹出二次确认框，等待其出现
      // 并点击确认；如果这次操作没有弹出确认框（不同入口/版本可能不同），
      // 也不视为错误，继续往下核实结果即可。
      const confirmButton = await Utils.waitFor(
        () => Parser.findUnfollowConfirmButton(ownerDoc),
        { timeout: CONFIG.UNFOLLOW_CONFIRM_WAIT_MS, interval: 150 }
      );
      if (confirmButton) {
        Logger.debug('检测到二次确认弹窗，点击确认');
        Utils.simulateClick(confirmButton);
      } else {
        Logger.debug('未检测到二次确认弹窗（可能本来就不需要），直接核实结果');
      }

      const succeeded = await Utils.waitFor(() => {
        // 若按钮元素已经不在文档中（例如该行被移除/替换），视为已成功。
        if (!ownerDoc.contains(button)) return true;
        return Parser.isFollowButton(button);
      }, { timeout: CONFIG.UNFOLLOW_VERIFY_WAIT_MS, interval: 200 });

      if (!succeeded) {
        Logger.warn(`核实取消关注结果超时，按钮当前 data-testid: ${button.getAttribute('data-testid')}`);
      }

      return Boolean(succeeded);
    }
  }

  /* ==========================================================================
   * 6. 异步任务队列模块（TaskQueue 类）
   *    通用的并发受限任务队列，支持暂停 / 继续 / 取消，以及进度回调。
   * ======================================================================== */

  class TaskQueue {
    /**
     * @param {{concurrency:number, onProgress:Function}} options 队列配置。
     */
    constructor(options = {}) {
      this.concurrency = Utils.clampNumber(
        options.concurrency ?? CONFIG.DEFAULT_CONCURRENCY, 1, CONFIG.MAX_CONCURRENCY
      );
      this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      this.tasks = [];
      this.activeCount = 0;
      this.isPaused = false;
      this.isCancelled = false;
      this.completedCount = 0;
      this.totalCount = 0;
      this._resolveIdle = null;
      this._idlePromise = null;
    }

    /**
     * 向队列尾部追加一个任务函数（返回 Promise 的无参函数）。
     * @param {Function} taskFn 任务函数。
     */
    addTask(taskFn) {
      this.tasks.push(taskFn);
      this.totalCount += 1;
    }

    /**
     * 批量追加多个任务函数。
     * @param {Array<Function>} taskFns 任务函数数组。
     */
    addTasks(taskFns) {
      taskFns.forEach((fn) => this.addTask(fn));
    }

    /** 暂停队列：当前正在执行的任务会继续完成，但不会再拉取新任务。 */
    pause() {
      this.isPaused = true;
      Logger.warn('扫描已暂停');
    }

    /** 继续队列：恢复拉取新任务执行。 */
    resume() {
      if (!this.isPaused) return;
      this.isPaused = false;
      this._pump();
    }

    /** 取消队列：清空尚未执行的任务（正在执行的任务不受影响）。 */
    cancel() {
      this.isCancelled = true;
      this.tasks = [];
    }

    /**
     * 启动队列并等待其执行至"空闲"状态（所有任务完成、队列为空）。
     * @returns {Promise<void>}
     */
    async run() {
      this._idlePromise = new Promise((resolve) => {
        this._resolveIdle = resolve;
      });
      this._pump();
      await this._idlePromise;
    }

    /**
     * 队列调度核心：在并发数允许范围内持续拉取新任务执行。
     */
    _pump() {
      if (this.isCancelled) {
        this._checkIdle();
        return;
      }
      while (!this.isPaused && this.activeCount < this.concurrency && this.tasks.length > 0) {
        const taskFn = this.tasks.shift();
        this.activeCount += 1;
        this._runOne(taskFn);
      }
      this._checkIdle();
    }

    /**
     * 执行单个任务，并在结束后更新计数、触发进度回调、尝试继续调度。
     * @param {Function} taskFn 任务函数。
     */
    async _runOne(taskFn) {
      try {
        await taskFn();
      } catch (error) {
        Logger.error('任务执行异常', error);
      } finally {
        this.activeCount -= 1;
        this.completedCount += 1;
        if (this.onProgress) {
          this.onProgress(this.completedCount, this.totalCount);
        }
        if (!this.isPaused) {
          this._pump();
        } else {
          this._checkIdle();
        }
      }
    }

    /**
     * 检查队列是否已经完全空闲（无排队任务且无执行中任务），
     * 若是则 resolve 掉 run() 返回的 Promise。
     */
    _checkIdle() {
      if (this.tasks.length === 0 && this.activeCount === 0 && this._resolveIdle) {
        const resolveFn = this._resolveIdle;
        this._resolveIdle = null;
        resolveFn();
      }
    }
  }

  /* ==========================================================================
   * 7. 隐藏 iframe 探测模块（Prober 类）
   *    通过在页面中插入一个不可见的同源 iframe 来"访问"对方主页，
   *    等待该 iframe 内的脚本实例完成 DOM 检测后，通过 postMessage
   *    将结果回传给主页面。全程不发起任何官方 API 请求。
   * ======================================================================== */

  class Prober {
    constructor() {
      /** token -> { resolve, iframe, timeoutId } 的映射，用于匹配异步结果。 */
      this.pending = new Map();
      window.addEventListener('message', this._onMessage.bind(this));
    }

    /**
     * 创建一个指向目标用户主页的隐藏 iframe，并返回一个会在收到对应
     * postMessage 结果（或超时）后 resolve 的 Promise。probeUser 与
     * requestUnfollow 共用这套基础设施，仅在 URL 上附加不同的动作参数、
     * 在等待的消息 type 上加以区分。
     * @param {string} username 目标用户名。
     * @param {string} actionParam 附加在 URL 上的动作标记，如 'ufs_probe' 或 'ufs_unfollow'。
     * @returns {Promise<object>} 对应动作的结果对象。
     */
    _openHiddenIframeAndWait(username, actionParam) {
      return new Promise((resolve) => {
        const token = Utils.generateId();
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.left = '-9999px';
        iframe.style.top = '0';
        iframe.style.width = `${CONFIG.IFRAME_WIDTH_PX}px`;
        iframe.style.height = `${CONFIG.IFRAME_HEIGHT_PX}px`;
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        iframe.style.border = '0';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.setAttribute('tabindex', '-1');

        const targetUrl =
          `${location.origin}/${encodeURIComponent(username)}` +
          `?${actionParam}=1&ufs_token=${token}`;

        const timeoutId = setTimeout(() => {
          this._finish(token, { status: SCAN_STATUS.FAILED, reason: 'hard_timeout', success: false });
        }, CONFIG.PROBE_HARD_TIMEOUT_MS);

        this.pending.set(token, { resolve, iframe, timeoutId });
        iframe.src = targetUrl;
        document.body.appendChild(iframe);
      });
    }

    /**
     * 探测指定用户名是否回关了当前登录账号。
     * @param {string} username 待探测的用户名。
     * @returns {Promise<{status:string, reason:string}>} 探测结果。
     */
    probeUser(username) {
      return this._openHiddenIframeAndWait(username, 'ufs_probe');
    }

    /**
     * 通过隐藏 iframe 访问对方主页并执行取消关注操作（兜底方案，仅在该
     * 用户的卡片不在当前关注列表页面 DOM 中时使用）。
     * @param {string} username 待取消关注的用户名。
     * @returns {Promise<{success:boolean, reason:string}>} 操作结果。
     */
    requestUnfollow(username) {
      return this._openHiddenIframeAndWait(username, 'ufs_unfollow');
    }

    /**
     * 监听来自子 iframe 的 postMessage 消息，匹配 token 后完成对应的 Promise。
     * @param {MessageEvent} event 消息事件对象。
     */
    _onMessage(event) {
      const data = event.data;
      if (!data || data.__ufs !== true) return;
      if (data.type !== 'PROBE_RESULT' && data.type !== 'UNFOLLOW_RESULT') return;
      this._finish(data.token, data.result);
    }

    /**
     * 结束一次探测：清理定时器、移除 iframe、resolve 对应的 Promise。
     * @param {string} token 探测请求标识。
     * @param {object} result 探测或取消关注的结果对象。
     */
    _finish(token, result) {
      const entry = this.pending.get(token);
      if (!entry) return;
      clearTimeout(entry.timeoutId);
      this.pending.delete(token);
      try {
        entry.iframe.remove();
      } catch (error) {
        // 忽略移除失败（例如 iframe 已被浏览器提前卸载）。
      }
      entry.resolve(result);
    }
  }

  /**
   * 在隐藏 iframe 内执行"点击取消关注并核实结果"的完整流程：等待取消
   * 关注按钮出现（若页面本身就不存在/已被封禁/账号已经不再关注，也能
   * 明确识别），点击、处理二次确认弹窗、核实按钮状态是否已经翻转。
   * @returns {Promise<{success:boolean, reason:string}>} 操作结果。
   */
  async function performUnfollowInCurrentDocument() {
    if (Parser.isAccountSuspended(document)) {
      return { success: false, reason: 'suspended' };
    }
    if (Parser.isProfileNotFound(document)) {
      return { success: false, reason: 'not_found' };
    }
    const button = await Utils.waitFor(
      () => Parser.findUnfollowButton(document),
      { timeout: CONFIG.PROBE_MAX_WAIT_MS, interval: CONFIG.PROBE_POLL_INTERVAL_MS }
    );
    if (!button) {
      // 找不到"取消关注"按钮：可能本来就已经没有关注对方了，视为已完成。
      return { success: true, reason: 'already_not_following' };
    }
    const succeeded = await Parser.clickUnfollowButtonAndVerify(button);
    return { success: succeeded, reason: succeeded ? 'ok' : 'verify_timeout' };
  }

  /**
   * 探测/取消关注的响应端逻辑：当脚本被加载在一个带有 ufs_probe 或
   * ufs_unfollow 标记参数的隐藏 iframe 中时，分别执行对应的检测或点击
   * 操作，并将结果通过 postMessage 回传给父页面。若当前不处于这两种
   * 场景之一，直接返回 false。
   * @returns {Promise<boolean>} 是否处理了本次请求。
   */
  async function respondToProbeIfNeeded() {
    if (window.self === window.top) return false; // 仅在被嵌入的 iframe 中响应。
    const searchParams = new URLSearchParams(location.search);
    const token = searchParams.get('ufs_token') || '';

    if (searchParams.get('ufs_probe') === '1') {
      Logger.debug(`探测响应模式启动: ${location.pathname}`);
      const result = await Parser.waitAndDetectFollowState(document);
      try {
        window.parent.postMessage({ __ufs: true, type: 'PROBE_RESULT', token, result }, '*');
      } catch (error) {
        Logger.error('回传探测结果失败', error);
      }
      return true;
    }

    if (searchParams.get('ufs_unfollow') === '1') {
      Logger.debug(`取消关注响应模式启动: ${location.pathname}`);
      const result = await performUnfollowInCurrentDocument();
      try {
        window.parent.postMessage({ __ufs: true, type: 'UNFOLLOW_RESULT', token, result }, '*');
      } catch (error) {
        Logger.error('回传取消关注结果失败', error);
      }
      return true;
    }

    return false;
  }

  /* ==========================================================================
   * 8. 扫描调度模块（Scanner 类）
   *    串联"收集关注列表 -> 构建探测队列 -> 并发执行 -> 结果持久化"
   *    整个业务流程，并向 Panel 汇报进度。
   * ======================================================================== */

  class Scanner {
    /**
     * @param {{ownerUsername:string, pageType:string, storage:Storage, panel:Panel}} deps 依赖项。
     */
    constructor(deps) {
      this.ownerUsername = deps.ownerUsername;
      this.pageType = deps.pageType || 'following';
      this.storage = deps.storage;
      this.panel = deps.panel;
      // Prober 用于两类"兜底"场景：1）重新扫描单个用户但其卡片已不在
      // 当前 DOM 中；2）批量取消关注时目标用户的卡片已不在当前 DOM 中。
      // 两者都不参与批量扫描本身（扫描现在是边滚动边读取列表 DOM）。
      this.prober = new Prober();
      // 手动重扫队列：并发受限（2~3），避免用户连续点击多个"重新扫描"
      // 按钮时一次性打开过多隐藏 iframe。
      this.manualRescanQueue = new TaskQueue({ concurrency: CONFIG.DEFAULT_CONCURRENCY });
      this.followingList = [];
      /** username -> { status, reason, checkedAt, retries } */
      this.scanResults = {};
      this.startTime = null;
      // 只有用户主动点击"开始扫描"按钮（或"重新扫描"）之后，hasStarted
      // 才会变为 true；在此之前脚本只会展示缓存中的既有结果，不会自动
      // 滚动页面或进行任何检测。
      this.hasStarted = false;
      this.isScanning = false;
      this.isPaused = false;
      this._resumeResolve = null;
      // 扫描代次：每次调用 scrollAndDetect() 都会递增，正在运行的旧一轮
      // 循环会在检测到代次变化后自然退出，用于安全地"重新开始"扫描。
      this._scanGeneration = 0;

      // ---- 批量取消关注相关状态 ----
      /** 待处理的取消关注队列（用户名数组），会持久化到 Storage。 */
      this.unfollowQueue = [];
      /** 是否正在处理取消关注队列。 */
      this.isUnfollowing = false;
      /** 取消关注代次：递增后，正在运行的旧一轮处理循环会自然停止。 */
      this._unfollowGeneration = 0;
    }

    /** 从缓存中加载既有的关注列表、扫描结果、待取消关注队列到内存。 */
    loadFromCache() {
      this.followingList = this.storage.getFollowingList();
      this.scanResults = this.storage.getScanResults();
      this.unfollowQueue = this.storage.getPendingUnfollowQueue();
    }

    /**
     * 主入口：启动"边滚动边探测"流程。只有在用户主动点击面板上的
     * "开始扫描"按钮时才会被调用，不会随页面匹配自动触发。
     * @returns {Promise<void>}
     */
    async start() {
      this.hasStarted = true;
      this.startTime = Utils.nowTimestamp();
      this.isScanning = true;
      this.panel.setStatus('scanning');
      // 等待时间线首批用户卡片渲染完成后再开始自动滚动，避免在 DOM
      // 尚未就绪时误判为"已到底部/无新内容"。
      await Utils.waitFor(() => Parser.findUserCells(document).length > 0, {
        timeout: 8000, interval: 300,
      });
      await this.scrollAndDetect();
      this.isScanning = false;
      this._finishScan();
    }

    /**
     * 核心流程：自动无限滚动关注列表，每当发现一个用户卡片就立即在该
     * 卡片的 DOM 内查询 [data-testid="userFollowIndicator"] 来判断对方
     * 是否回关，结果同步写入内存与缓存——不需要访问对方主页，不需要
     * 隐藏 iframe，也不需要任何网络请求。
     *
     * 判定"已经滚动到底、可以结束"的依据是：页面是否已经滚动到可视区域
     * 底部、页面总高度是否连续保持不变、以及本轮是否还有新用户被处理，
     * 三者同时满足才计入一次空闲轮次——不再依赖全局 MutationObserver，
     * 避免页面上与列表无关的其它变动（通知红点、动画等）持续刷新计时器
     * 导致永远无法判定为空闲、滚动停不下来的问题。
     * @returns {Promise<void>}
     */
    async scrollAndDetect() {
      const myGeneration = ++this._scanGeneration;
      const collectedUsernames = new Set(this.followingList);

      let idleRounds = 0;
      let lastProcessedCount = Object.keys(this.scanResults).length;
      let lastScrollHeight = document.documentElement.scrollHeight;

      while (idleRounds < CONFIG.IDLE_ROUNDS_TO_STOP && myGeneration === this._scanGeneration) {
        // 若面板处于"暂停"状态，则在此处挂起，等待用户点击"继续"。
        await this._waitWhilePaused();
        if (myGeneration !== this._scanGeneration) break;

        const cells = Parser.findUserCells(document);
        for (const cell of cells) {
          const username = Parser.extractUsernameFromCell(cell);
          if (!username) continue;
          collectedUsernames.add(username);

          const existingEntry = this.scanResults[username];
          const alreadyConfirmedMutual = Boolean(existingEntry && existingEntry.status === SCAN_STATUS.MUTUAL);
          const needsProfileCapture = !existingEntry || !existingEntry.profile;

          // 已经确认"已回关"的结果非常可靠（标识节点是明确的正向证据），
          // 无需重复判断回关状态；但如果这份缓存还没有采集过资料摘要
          // （例如来自升级前的旧版本缓存），这里顺手补采一次头像/昵称/
          // 简介，供悬浮资料卡使用，然后就可以跳过了。
          if (alreadyConfirmedMutual) {
            if (needsProfileCapture) {
              this.scanResults[username] = {
                ...existingEntry,
                profile: Parser.extractProfileSummaryFromCell(cell),
              };
            }
            continue;
          }

          // "未回关"的结果允许在后续轮次中重新核对——如果该用户的卡片
          // 因为渲染时机较晚、这一轮才刚显示出回关标识，就把结果从
          // "未回关"升级为"已回关"，避免因首次读取过早而误判。
          const hasFollowBackBadge = Parser.cellHasFollowBackBadge(cell);
          const profile = needsProfileCapture
            ? Parser.extractProfileSummaryFromCell(cell)
            : existingEntry.profile;
          this.scanResults[username] = {
            status: hasFollowBackBadge ? SCAN_STATUS.MUTUAL : SCAN_STATUS.NOT_BACK,
            reason: hasFollowBackBadge ? 'list_badge' : 'list_no_badge',
            checkedAt: Utils.nowTimestamp(),
            retries: 0,
            profile,
          };
        }

        this.followingList = Array.from(collectedUsernames);
        this.storage.saveFollowingList(this.followingList);
        this.storage.saveScanResults(this.scanResults);

        const processedCount = Object.keys(this.scanResults).length;
        this.panel.setScanProgress(processedCount);
        this.panel.renderList(this.getAllRows());

        const currentScrollHeight = document.documentElement.scrollHeight;
        const heightUnchanged = currentScrollHeight === lastScrollHeight;
        const atBottom = this._isPageScrolledToBottom();
        const noNewProgress = processedCount === lastProcessedCount;

        if (heightUnchanged && atBottom && noNewProgress) {
          idleRounds += 1;
        } else {
          idleRounds = 0;
        }
        lastProcessedCount = processedCount;
        lastScrollHeight = currentScrollHeight;

        if (idleRounds >= CONFIG.IDLE_ROUNDS_TO_STOP || myGeneration !== this._scanGeneration) {
          break; // 已确认到底，直接结束，不再多滚动一次。
        }

        // 小步增量滚动（而非直接跳到页面最底部），给虚拟列表充分的时间
        // 渲染每一批新出现的用户卡片及其回关标识，降低漏判/误判概率。
        // 若已经处于页面底部，则不再继续下滚，只是等待观察是否有懒加载
        // 的新内容出现（对应上面的 heightUnchanged/atBottom 判定）。
        if (!atBottom) {
          const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
          const scrollStepPx = Math.max(
            CONFIG.MIN_SCROLL_STEP_PX,
            Math.floor(viewportHeight * CONFIG.SCROLL_STEP_RATIO)
          );
          window.scrollBy(0, scrollStepPx);
        }
        // 等待时间实时读取当前的速度档位（用户可以在面板上随时拖动
        // 滑块调整，下一轮循环立刻生效），而不是固定写死的常量。
        const currentSpeed = ScrollSpeedManager.getCurrent();
        await Utils.randomDelay(currentSpeed.min, currentSpeed.max);
      }
    }

    /**
     * 判断页面当前是否已经滚动到（接近）可滚动区域的底部。
     * @returns {boolean} 是否已到底部。
     */
    _isPageScrolledToBottom() {
      const scrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const fullHeight = document.documentElement.scrollHeight;
      return scrollY + viewportHeight >= fullHeight - CONFIG.BOTTOM_THRESHOLD_PX;
    }

    /** 收尾工作：保存元信息、更新面板为"完成"状态、输出汇总日志。 */
    _finishScan() {
      this.storage.saveScanResults(this.scanResults);

      const elapsedMs = Utils.nowTimestamp() - this.startTime;
      this.storage.saveMeta({
        startedAt: this.startTime,
        updatedAt: Utils.nowTimestamp(),
        scannedCount: this.followingList.length,
        totalCount: this.followingList.length,
        elapsedMs,
      });

      this.panel.setStatus('done', { elapsedMs });
      this.panel.renderList(this.getAllRows());

      const stats = this.getStats();
      Logger.success(
        `扫描完成，共 ${stats.total} 人，未回关 ${stats.notBack} 人，耗时 ${Utils.formatDuration(elapsedMs)}`
      );
    }

    /**
     * 重新扫描单个用户名（由面板中的单行"重新扫描"按钮触发）。
     * 优先在当前 DOM 中查找该用户名对应的卡片并直接读取
     * userFollowIndicator（与主流程完全一致、零网络开销）；
     * 若该卡片已经因虚拟列表滚动被回收、不在当前 DOM 中，则退回到
     * 隐藏 iframe 访问对方主页的兜底方案（仅此一次性单点探测使用）。
     * @param {string} username 用户名。
     * @returns {Promise<void>}
     */
    async rescanUser(username) {

      const cell = this._findCellForUsername(username);
      if (cell) {
        const hasFollowBackBadge = Parser.cellHasFollowBackBadge(cell);
        this.scanResults[username] = {
          status: hasFollowBackBadge ? SCAN_STATUS.MUTUAL : SCAN_STATUS.NOT_BACK,
          reason: hasFollowBackBadge ? 'list_badge_rescan' : 'list_no_badge_rescan',
          checkedAt: Utils.nowTimestamp(),
          retries: 0,
          profile: Parser.extractProfileSummaryFromCell(cell),
        };
        this.storage.saveScanResult(username, this.scanResults[username]);
        this.panel.renderList(this.getAllRows());
        return;
      }

      // 兜底方案：该用户当前不在页面 DOM 中，通过隐藏 iframe 单独探测一次。
      // 网络类失败（超时/异常）在此按 MAX_RETRIES 自动重试；账号不存在/
      // 被封禁等确定性失败立即跳过，不再重试。
      await new Promise((resolve) => {
        this.manualRescanQueue.addTask(async () => {
          let retryCount = 0;
          let result;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            await Utils.randomDelay(CONFIG.MIN_TASK_DELAY_MS, CONFIG.MAX_TASK_DELAY_MS);
            try {
              result = await this.prober.probeUser(username);
            } catch (error) {
              result = { status: SCAN_STATUS.FAILED, reason: 'exception' };
            }
            if (result.status === SCAN_STATUS.FAILED) {
              const transientReasons = new Set(['timeout', 'hard_timeout', 'exception']);
              if (transientReasons.has(result.reason) && retryCount < CONFIG.MAX_RETRIES) {
                retryCount += 1;
                Logger.warn(`重新扫描探测失败，准备重试 @${username}（第 ${retryCount} 次）`);
                await Utils.sleep(CONFIG.RETRY_BACKOFF_BASE_MS * retryCount);
                continue;
              }
            }
            break;
          }
          this.scanResults[username] = {
            status: result.status,
            reason: result.reason || '',
            checkedAt: Utils.nowTimestamp(),
            retries: retryCount,
          };
          this.storage.saveScanResult(username, this.scanResults[username]);
          this.panel.renderList(this.getAllRows());
          resolve();
        });
        this.manualRescanQueue.run();
      });
    }

    /**
     * 在当前 DOM 中查找指定用户名对应的用户卡片元素。
     * @param {string} username 用户名。
     * @returns {Element|null} 匹配的卡片元素，找不到则返回 null。
     */
    _findCellForUsername(username) {
      const cells = Parser.findUserCells(document);
      for (const cell of cells) {
        const candidate = Parser.extractUsernameFromCell(cell);
        if (candidate && candidate.toLowerCase() === username.toLowerCase()) {
          return cell;
        }
      }
      return null;
    }

    /**
     * 将一批用户名加入"待取消关注"队列并持久化，若当前尚未在处理则
     * 立即开始处理。重复加入已在队列中的用户名会被自动去重。
     * 若扫描正在进行中，会先自动暂停扫描（避免两者同时操作/滚动页面
     * 造成冲突），用户可以在取消关注完成后手动点击"继续"恢复扫描。
     * @param {Array<string>} usernames 待取消关注的用户名数组。
     */
    enqueueUnfollow(usernames) {
      if (!usernames || usernames.length === 0) return;
      if (this.isScanning && !this.isPaused) {
        this.pause();
        Logger.warn('检测到扫描仍在进行，已自动暂停以避免与取消关注操作冲突');
      }
      const merged = Utils.uniqueArray([...this.unfollowQueue, ...usernames]);
      this.unfollowQueue = merged;
      this.storage.savePendingUnfollowQueue(this.unfollowQueue);
      this.panel.setUnfollowProgress(this.unfollowQueue.length, null);
      if (!this.isUnfollowing) {
        this._processUnfollowQueue().catch((error) => Logger.error('批量取消关注流程异常', error));
      }
    }

    /**
     * 停止处理待取消关注队列。已经执行完成的取消关注不会被撤销，只是
     * 不再继续处理队列中剩余的用户名（剩余部分会被清空，不再持久化）。
     */
    stopUnfollowQueue() {
      this._unfollowGeneration += 1; // 让正在运行的处理循环在下一次检查时自然退出。
      this.isUnfollowing = false;
      this.unfollowQueue = [];
      this.storage.savePendingUnfollowQueue([]);
      this.panel.hideUnfollowProgress();
      Logger.warn('已停止剩余的取消关注任务');
    }

    /**
     * 后台处理"待取消关注"队列的核心循环：每处理完一人就立刻把剩余队列
     * 写回缓存（实现"缓存到后台、断点续传"），处理间隔遵循
     * UNFOLLOW_INTERVAL_MIN_MS ~ UNFOLLOW_INTERVAL_MAX_MS 的随机等待，
     * 确保"每秒最多处理一位"且不完全规律。
     * @returns {Promise<void>}
     */
    async _processUnfollowQueue() {
      if (this.isUnfollowing) return;
      this.isUnfollowing = true;
      const myGeneration = ++this._unfollowGeneration;

      while (this.unfollowQueue.length > 0 && myGeneration === this._unfollowGeneration) {
        const username = this.unfollowQueue[0];
        this.panel.setUnfollowProgress(this.unfollowQueue.length, username);

        const success = await this._performUnfollow(username, myGeneration);
        if (myGeneration !== this._unfollowGeneration) break; // 中途被停止。

        // 无论成功与否都从队列中移除，避免对一个持续失败的用户反复重试
        // 占用整个队列；失败的会在日志中明确提示，用户可以自行重新选择。
        this.unfollowQueue.shift();
        this.storage.savePendingUnfollowQueue(this.unfollowQueue);

        if (success) {
          delete this.scanResults[username];
          this.followingList = this.followingList.filter((name) => name !== username);
          this.storage.saveFollowingList(this.followingList);
          this.storage.saveScanResults(this.scanResults);
          this.panel.renderList(this.getAllRows());
          Logger.success(`已取消关注 @${username}`);
        } else {
          Logger.warn(`取消关注失败，已跳过 @${username}`);
        }

        if (this.unfollowQueue.length === 0 || myGeneration !== this._unfollowGeneration) break;
        await Utils.randomDelay(CONFIG.UNFOLLOW_INTERVAL_MIN_MS, CONFIG.UNFOLLOW_INTERVAL_MAX_MS);
      }

      this.isUnfollowing = false;
      if (myGeneration === this._unfollowGeneration) {
        this.panel.hideUnfollowProgress();
        Logger.success('批量取消关注已完成');
      }
    }

    /**
     * 执行对单个用户名的取消关注操作。核心可靠路径是"在当前这个真实
     * 页面里点击"：
     *   1) 先看该用户的卡片是否已经在当前 DOM 中（最快）；
     *   2) 若不在（这是最常见的情况——扫描完成后页面通常停留在底部，
     *      早先扫描到的用户卡片早已被虚拟列表回收），则主动滚动页面
     *      重新定位到该用户的卡片（_scrollToFindCell）；
     *   3) 只有当用户已经离开了这个列表页面（导航去了别处，导致这个
     *      页面的 DOM 里已经不可能再找到目标用户）时，才退回到隐藏
     *      iframe 访问对方主页执行取消关注的兜底方案。
     * 全程通过模拟真实点击事件、并处理可能出现的二次确认弹窗来完成。
     * @param {string} username 用户名。
     * @returns {Promise<boolean>} 是否确认取消关注成功。
     */
    async _performUnfollow(username, expectedGeneration) {
      const isStillOnMatchingPage =
        Parser.getOwnerUsernameFromCurrentUrl()?.toLowerCase() === this.ownerUsername.toLowerCase() &&
        Parser.getListPageTypeFromCurrentUrl() === this.pageType;

      if (isStillOnMatchingPage) {
        let cell = this._findCellForUsername(username);
        if (cell) {
          Logger.debug(`@${username} 的卡片已在当前页面中，直接点击`);
        } else {
          Logger.debug(`@${username} 的卡片不在当前 DOM 中，尝试滚动定位...`);
          this.panel.setUnfollowProgress(this.unfollowQueue.length, `${username}（滚动定位中...）`);
          cell = await this._scrollToFindCell(username, expectedGeneration);
        }

        if (expectedGeneration !== this._unfollowGeneration) return false; // 中途被停止。

        if (cell) {
          const button = Parser.findUnfollowButton(cell);
          if (button) {
            this.panel.setUnfollowProgress(this.unfollowQueue.length, `${username}（点击中...）`);
            const success = await Parser.clickUnfollowButtonAndVerify(button);
            if (success) return true;
            Logger.warn(`@${username} 页面内点击未能确认成功，尝试隐藏 iframe 兜底`);
          } else {
            Logger.warn(`@${username} 找到了卡片，但卡片内没有"取消关注"按钮（可能已经未关注对方）`);
          }
        } else {
          Logger.warn(`@${username} 滚动查找超出上限仍未找到对应卡片，尝试隐藏 iframe 兜底`);
        }
      } else {
        Logger.debug(`已离开 @${this.ownerUsername} 的${LIST_PAGE_TYPE_LABELS[this.pageType] || this.pageType}页面，直接使用隐藏 iframe 兜底`);
      }

      if (expectedGeneration !== this._unfollowGeneration) return false; // 中途被停止。

      this.panel.setUnfollowProgress(this.unfollowQueue.length, `${username}（兜底方案处理中...）`);
      try {
        const result = await this.prober.requestUnfollow(username);
        if (!result || !result.success) {
          Logger.warn(`@${username} 隐藏 iframe 兜底也未成功，原因: ${(result && result.reason) || 'unknown'}`);
        }
        return Boolean(result && result.success);
      } catch (error) {
        Logger.error(`@${username} 兜底取消关注异常`, error);
        return false;
      }
    }

    /**
     * 在当前关注列表页面中主动滚动，重新定位到指定用户名对应的卡片。
     * 做法：先回到页面顶部，再像扫描时一样小步向下滚动，每一步都检查
     * 该用户的卡片是否已经出现在 DOM 中；若滚动到底部且连续两轮都没有
     * 新内容加载仍未找到，则判定该用户可能已不在列表中，放弃查找。
     * 每一轮都会检查取消关注代次是否仍然匹配，一旦用户点击"停止"就能
     * 及时退出，而不必等到滚动搜索的整个上限跑完。
     * @param {string} username 目标用户名。
     * @param {number} expectedGeneration 发起本次取消关注时的代次快照。
     * @returns {Promise<Element|null>} 找到的卡片元素，找不到（或被中途停止）则为 null。
     */
    async _scrollToFindCell(username, expectedGeneration) {
      window.scrollTo(0, 0);
      await Utils.sleep(CONFIG.UNFOLLOW_SEARCH_SCROLL_WAIT_MIN_MS);

      let lastScrollHeight = -1;
      let stableRounds = 0;

      for (let round = 0; round < CONFIG.UNFOLLOW_SEARCH_MAX_ROUNDS; round += 1) {
        if (expectedGeneration !== this._unfollowGeneration) return null; // 中途被停止。

        const cell = this._findCellForUsername(username);
        if (cell) return cell;

        const currentScrollHeight = document.documentElement.scrollHeight;
        const atBottom = this._isPageScrolledToBottom();
        if (currentScrollHeight === lastScrollHeight && atBottom) {
          stableRounds += 1;
          if (stableRounds >= 2) return null; // 已到底且没有新内容，用户大概率已不在列表中。
        } else {
          stableRounds = 0;
        }
        lastScrollHeight = currentScrollHeight;

        if (!atBottom) {
          const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
          const scrollStepPx = Math.max(
            CONFIG.MIN_SCROLL_STEP_PX,
            Math.floor(viewportHeight * CONFIG.SCROLL_STEP_RATIO)
          );
          window.scrollBy(0, scrollStepPx);
        }
        await Utils.randomDelay(
          CONFIG.UNFOLLOW_SEARCH_SCROLL_WAIT_MIN_MS,
          CONFIG.UNFOLLOW_SEARCH_SCROLL_WAIT_MAX_MS
        );
      }
      return null;
    }

    /** 暂停当前的滚动探测循环（不打开新的隐藏 iframe，也不再继续滚动）。 */
    pause() {
      this.isPaused = true;
      this.panel.setStatus('paused');
      Logger.warn('扫描已暂停');
    }

    /** 继续之前被暂停的滚动探测循环。 */
    resume() {
      if (!this.isPaused) return;
      this.isPaused = false;
      this.panel.setStatus('scanning');
      if (this._resumeResolve) {
        const resolveFn = this._resumeResolve;
        this._resumeResolve = null;
        resolveFn();
      }
    }

    /** 在暂停状态下挂起，直到 resume() 被调用才返回。 */
    async _waitWhilePaused() {
      while (this.isPaused) {
        await new Promise((resolve) => {
          this._resumeResolve = resolve;
        });
      }
    }

    /**
     * 清空全部既有结果并重新执行整体扫描：先回到页面顶部，再清空缓存与
     * 内存中的关注列表/扫描结果，最后重新触发一轮"边滚动边探测"。
     * 递增的 _scanGeneration 会让任何仍在运行的旧一轮循环安全退出，
     * 不会与新一轮扫描的数据相互混杂。
     * @returns {Promise<void>}
     */
    async rescanAll() {
      this.hasStarted = true;
      this.isPaused = false;
      this.isScanning = false;
      this.scanResults = {};
      this.followingList = [];
      this.storage.saveScanResults({});
      this.storage.saveFollowingList([]);
      this.panel.renderList(this.getAllRows());

      window.scrollTo(0, 0);
      await Utils.sleep(ScrollSpeedManager.getCurrent().min);

      this.startTime = Utils.nowTimestamp();
      this.isScanning = true;
      this.panel.setStatus('scanning');
      await this.scrollAndDetect();
      this.isScanning = false;
      this._finishScan();
    }

    /**
     * 汇总当前所有用户名与其扫描状态，供面板渲染使用。
     * @returns {Array<{username:string, status:string, reason:string, profile:object|null}>}
     */
    getAllRows() {
      return this.followingList.map((username) => {
        const entry = this.scanResults[username] || { status: SCAN_STATUS.PENDING, reason: '' };
        return { username, status: entry.status, reason: entry.reason || '', profile: entry.profile || null };
      });
    }

    /**
     * 计算当前统计数据：总数、已互关数、未回关数、失败数、待扫描数。
     * @returns {{total:number, mutual:number, notBack:number, failed:number, pending:number}}
     */
    getStats() {
      const rows = this.getAllRows();
      const stats = { total: rows.length, mutual: 0, notBack: 0, failed: 0, pending: 0 };
      rows.forEach((row) => {
        if (row.status === SCAN_STATUS.MUTUAL) stats.mutual += 1;
        else if (row.status === SCAN_STATUS.NOT_BACK) stats.notBack += 1;
        else if (row.status === SCAN_STATUS.FAILED) stats.failed += 1;
        else stats.pending += 1;
      });
      return stats;
    }
  }

  /* ==========================================================================
   * 9. 右侧固定面板模块（Panel 类）
   *    深色风格、圆角、阴影的悬浮 UI，支持折叠/关闭/暂停继续/重新扫描/
   *    搜索/排序/分类标签/导出 CSV 与 TXT/复制用户名等交互。
   * ======================================================================== */

  class Panel {
    constructor() {
      this.scanner = null;
      this.isCollapsed = false;
      this.searchKeyword = '';
      this.sortAscending = true;
      this.activeTab = 'not_back'; // 默认聚焦展示"未回关"分类。
      this.rows = [];
      /** 当前被勾选、待批量取消关注的用户名集合。 */
      this.selectedUsernames = new Set();
      this._dragState = null;
      this._lastDragWasMove = false;
      /** 悬浮资料卡的显示/隐藏延迟计时器。 */
      this._hoverShowTimer = null;
      this._hoverHideTimer = null;
      this._injectStyles();
      this._buildSkeleton();
      this._buildHoverCard();
      this._bindStaticEvents();
      this._bindDragEvents();
      this._applyInitialPosition();
      this._initSpeedControl();
      this._onWindowResize = Utils.debounce(() => this._reclampToViewport(), 200);
      window.addEventListener('resize', this._onWindowResize);
    }

    /**
     * 绑定对应的 Scanner 实例，使面板上的按钮可以驱动扫描流程。
     * @param {Scanner} scanner Scanner 实例。
     */
    bindScanner(scanner) {
      this.scanner = scanner;
    }

    /** 注入面板所需的全部 CSS 样式（深色主题、圆角、阴影等）。 */
    _injectStyles() {
      GM_addStyle(`
        #ufs-panel {
          position: fixed;
          width: ${CONFIG.PANEL_WIDTH_PX}px; max-height: calc(100vh - 100px);
          background: #15181c; color: #e7e9ea; border-radius: 16px;
          box-shadow: 0 8px 28px rgba(0,0,0,0.55);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px; z-index: 999999; display: flex; flex-direction: column;
          overflow: hidden; border: 1px solid #2f3336;
        }
        #ufs-panel.ufs-collapsed .ufs-body { display: none; }
        #ufs-panel .ufs-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 12px; background: #1d2226; cursor: grab; user-select: none;
          touch-action: none;
        }
        #ufs-panel .ufs-header.ufs-dragging { cursor: grabbing; }
        #ufs-panel .ufs-title { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 6px; }
        #ufs-panel .ufs-title span { font-weight: 400; font-size: 10px; color: #8b98a5; }
        #ufs-panel .ufs-header-actions { display: flex; gap: 6px; }
        #ufs-panel .ufs-icon-btn {
          background: transparent; border: none; color: #8b98a5; cursor: pointer;
          font-size: 14px; padding: 2px 6px; border-radius: 6px;
        }
        #ufs-panel .ufs-icon-btn:hover { background: #2f3336; color: #e7e9ea; }
        #ufs-panel .ufs-body { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
        #ufs-panel .ufs-progress-wrap { padding: 8px 12px 0; }
        #ufs-panel .ufs-progress-text { font-size: 12px; color: #8b98a5; margin-bottom: 6px; }
        #ufs-panel .ufs-progress-bar-track { height: 5px; background: #2f3336; border-radius: 3px; overflow: hidden; }
        #ufs-panel .ufs-progress-bar-fill {
          height: 100%; background: linear-gradient(90deg,#1d9bf0,#00ba7c);
          width: 0%; transition: width .25s ease;
        }
        #ufs-panel .ufs-controls { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; }
        #ufs-panel .ufs-btn {
          background: #2f3336; color: #e7e9ea; border: none; border-radius: 999px;
          padding: 6px 10px; font-size: 12px; cursor: pointer;
        }
        #ufs-panel .ufs-btn:hover { background: #3a3f42; }
        #ufs-panel .ufs-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        #ufs-panel .ufs-btn.ufs-btn-primary { background: #1d9bf0; color: #fff; }
        #ufs-panel .ufs-btn.ufs-btn-primary:hover { background: #1a8cd8; }
        #ufs-panel .ufs-speed-row { padding: 0 12px 10px; }
        #ufs-panel .ufs-speed-label-row {
          display: flex; justify-content: space-between; align-items: center;
          font-size: 12px; color: #8b98a5; margin-bottom: 4px;
        }
        #ufs-panel .ufs-speed-label-row span:last-child { color: #e7e9ea; font-weight: 600; }
        #ufs-panel .ufs-speed-slider {
          width: 100%; accent-color: #1d9bf0; cursor: pointer; display: block;
        }
        #ufs-panel .ufs-speed-hint { font-size: 11px; color: #71767b; margin-top: 4px; }
        #ufs-panel .ufs-search-row { display: flex; gap: 6px; padding: 0 12px 8px; }
        #ufs-panel .ufs-search-input {
          flex: 1; background: #0f1317; border: 1px solid #2f3336; border-radius: 8px;
          color: #e7e9ea; padding: 6px 8px; font-size: 12px;
        }
        #ufs-panel .ufs-search-input:focus { outline: 1px solid #1d9bf0; }
        #ufs-panel .ufs-sort-btn {
          background: #0f1317; border: 1px solid #2f3336; color: #8b98a5;
          border-radius: 8px; padding: 6px 8px; font-size: 12px; cursor: pointer;
        }
        #ufs-panel .ufs-tabs { display: flex; padding: 0 12px 8px; gap: 4px; }
        #ufs-panel .ufs-tab {
          flex: 1; text-align: center; padding: 6px 4px; border-radius: 8px;
          font-size: 11px; color: #8b98a5; cursor: pointer; background: #0f1317;
        }
        #ufs-panel .ufs-tab.ufs-tab-active { background: #1d9bf0; color: #fff; }
        #ufs-panel .ufs-batch-row {
          display: flex; align-items: center; gap: 8px; padding: 0 12px 8px;
          font-size: 12px; color: #8b98a5;
        }
        #ufs-panel .ufs-select-all-label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
        #ufs-panel .ufs-select-all-label input { accent-color: #1d9bf0; cursor: pointer; }
        #ufs-panel .ufs-selected-count { flex: 1; }
        #ufs-panel .ufs-btn.ufs-btn-danger { background: #f4212e; color: #fff; }
        #ufs-panel .ufs-btn.ufs-btn-danger:hover { background: #d81b25; }
        #ufs-panel .ufs-btn.ufs-btn-danger:disabled { background: #4a2226; color: #a98488; opacity: 1; }
        #ufs-panel .ufs-unfollow-progress {
          display: flex; align-items: center; gap: 8px; padding: 6px 12px; margin: 0 12px 8px;
          background: #2a1416; border: 1px solid #5a2a2e; border-radius: 8px;
          font-size: 11px; color: #ff8a8a;
        }
        #ufs-panel .ufs-unfollow-progress-text { flex: 1; }
        #ufs-panel .ufs-list { flex: 1; overflow-y: auto; padding: 0 8px 8px; min-height: 120px; }
        #ufs-panel .ufs-list::-webkit-scrollbar { width: 6px; }
        #ufs-panel .ufs-list::-webkit-scrollbar-thumb { background: #3a3f42; border-radius: 3px; }
        #ufs-panel .ufs-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 8px; border-radius: 8px; margin-bottom: 4px; background: #1a1e22;
        }
        #ufs-panel .ufs-row-user { display: flex; align-items: center; gap: 6px; overflow: hidden; }
        #ufs-panel .ufs-row-checkbox { accent-color: #f4212e; cursor: pointer; flex-shrink: 0; }
        #ufs-panel .ufs-row-checkbox-spacer { display: inline-block; width: 13px; flex-shrink: 0; }
        #ufs-panel .ufs-row-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        #ufs-panel .ufs-dot-mutual { background: #00ba7c; }
        #ufs-panel .ufs-dot-not_back { background: #f4212e; }
        #ufs-panel .ufs-dot-failed { background: #71767b; }
        #ufs-panel .ufs-dot-pending { background: #ffad1f; }
        #ufs-panel .ufs-row-name {
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;
        }
        #ufs-panel .ufs-row-actions { display: flex; gap: 2px; }
        #ufs-panel .ufs-row-actions button {
          background: transparent; border: none; color: #8b98a5; cursor: pointer;
          font-size: 12px; padding: 2px 4px; border-radius: 4px;
        }
        #ufs-panel .ufs-row-actions button:hover { color: #e7e9ea; background: #2f3336; }
        #ufs-panel .ufs-footer {
          padding: 8px 12px; border-top: 1px solid #2f3336; font-size: 11px; color: #8b98a5;
        }
        #ufs-panel .ufs-empty { text-align: center; color: #71767b; padding: 24px 8px; font-size: 12px; }

        /* 行内悬浮资料卡：独立于 #ufs-panel，用 position:fixed 挂在 body 上，
           这样才能不受面板自身 overflow-y 滚动裁切的影响，随意定位到
           视口内的任意位置。 */
        #ufs-hovercard {
          position: fixed; width: ${CONFIG.HOVER_CARD_WIDTH_PX}px; z-index: 1000000;
          background: #15181c; color: #e7e9ea; border-radius: 14px; border: 1px solid #38444d;
          box-shadow: 0 12px 32px rgba(0,0,0,0.6); padding: 14px; display: none;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        #ufs-hovercard .ufs-hc-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        #ufs-hovercard .ufs-hc-avatar {
          width: 48px; height: 48px; border-radius: 50%; background: #2f3336; object-fit: cover;
          border: 2px solid #15181c;
        }
        #ufs-hovercard .ufs-hc-status {
          font-size: 11px; padding: 3px 8px; border-radius: 999px; font-weight: 600;
        }
        #ufs-hovercard .ufs-hc-status.ufs-dot-mutual { background: rgba(0,186,124,0.15); color: #00ba7c; }
        #ufs-hovercard .ufs-hc-status.ufs-dot-not_back { background: rgba(244,33,46,0.15); color: #f4212e; }
        #ufs-hovercard .ufs-hc-status.ufs-dot-failed { background: rgba(113,118,123,0.2); color: #a7acb0; }
        #ufs-hovercard .ufs-hc-status.ufs-dot-pending { background: rgba(255,173,31,0.15); color: #ffad1f; }
        #ufs-hovercard .ufs-hc-name { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 4px; }
        #ufs-hovercard .ufs-hc-name .ufs-hc-verified { color: #1d9bf0; font-size: 13px; }
        #ufs-hovercard .ufs-hc-username { font-size: 13px; color: #8b98a5; margin-bottom: 8px; }
        #ufs-hovercard .ufs-hc-bio {
          font-size: 12px; color: #d8dcdf; line-height: 1.5; margin-bottom: 10px;
          max-height: 96px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
        }
        #ufs-hovercard .ufs-hc-actions { display: flex; gap: 6px; }
        #ufs-hovercard .ufs-hc-actions button {
          flex: 1; background: #2f3336; color: #e7e9ea; border: none; border-radius: 999px;
          padding: 6px 4px; font-size: 12px; cursor: pointer; text-align: center;
          display: flex; align-items: center; justify-content: center; white-space: nowrap;
        }
        #ufs-hovercard .ufs-hc-actions button:hover { background: #3a3f42; }
        #ufs-hovercard .ufs-hc-actions button.ufs-hc-unfollow-btn { background: #f4212e; color: #fff; }
        #ufs-hovercard .ufs-hc-actions button.ufs-hc-unfollow-btn:hover { background: #d81b25; }
      `);
    }

    /** 构建面板的静态骨架 DOM 结构（只创建一次）。 */
    _buildSkeleton() {
      const root = document.createElement('div');
      root.id = 'ufs-panel';
      root.innerHTML = `
        <div class="ufs-header" id="ufs-header">
          <div class="ufs-title">🔍 互关检测助手 <span>v${SCRIPT_VERSION}</span></div>
          <div class="ufs-header-actions">
            <button class="ufs-icon-btn" id="ufs-collapse-btn" title="折叠/展开">▾</button>
            <button class="ufs-icon-btn" id="ufs-close-btn" title="关闭">✕</button>
          </div>
        </div>
        <div class="ufs-body">
          <div class="ufs-progress-wrap">
            <div class="ufs-progress-text" id="ufs-progress-text">等待开始...</div>
            <div class="ufs-progress-bar-track"><div class="ufs-progress-bar-fill" id="ufs-progress-fill"></div></div>
          </div>
          <div class="ufs-controls">
            <button class="ufs-btn ufs-btn-primary" id="ufs-toggle-btn">开始扫描</button>
            <button class="ufs-btn" id="ufs-rescan-btn">重新扫描</button>
            <button class="ufs-btn" id="ufs-export-csv-btn">导出CSV</button>
            <button class="ufs-btn" id="ufs-export-txt-btn">导出TXT</button>
            <button class="ufs-btn" id="ufs-copy-all-btn">复制列表</button>
          </div>
          <div class="ufs-speed-row">
            <div class="ufs-speed-label-row">
              <span>扫描速度</span>
              <span id="ufs-speed-value">标准</span>
            </div>
            <input type="range" class="ufs-speed-slider" id="ufs-speed-slider" min="0" max="4" step="1"
              title="为防止触发平台风控，最快档位已设有安全下限，无法调得更快" />
            <div class="ufs-speed-hint" id="ufs-speed-hint">滚动间隔 1.6s ~ 2.8s</div>
          </div>
          <div class="ufs-search-row">
            <input class="ufs-search-input" id="ufs-search-input" placeholder="搜索用户名..." />
            <button class="ufs-sort-btn" id="ufs-sort-btn">A-Z</button>
          </div>
          <div class="ufs-tabs">
            <div class="ufs-tab" data-tab="all" id="ufs-tab-all">全部(0)</div>
            <div class="ufs-tab" data-tab="mutual" id="ufs-tab-mutual">已互关(0)</div>
            <div class="ufs-tab" data-tab="not_back" id="ufs-tab-not_back">未回关(0)</div>
            <div class="ufs-tab" data-tab="failed" id="ufs-tab-failed">失败(0)</div>
          </div>
          <div class="ufs-batch-row">
            <label class="ufs-select-all-label">
              <input type="checkbox" id="ufs-select-all-checkbox" /> 全选未回关
            </label>
            <span class="ufs-selected-count" id="ufs-selected-count">已选 0</span>
            <button class="ufs-btn ufs-btn-danger" id="ufs-unfollow-selected-btn" disabled>取消关注选中</button>
          </div>
          <div class="ufs-unfollow-progress" id="ufs-unfollow-progress" style="display:none;">
            <div class="ufs-unfollow-progress-text" id="ufs-unfollow-progress-text"></div>
            <button class="ufs-btn" id="ufs-unfollow-stop-btn">停止</button>
          </div>
          <div class="ufs-list" id="ufs-list"></div>
          <div class="ufs-footer" id="ufs-footer">尚未扫描</div>
        </div>
      `;
      document.documentElement.appendChild(root);
      this.root = root;
      this._cacheElements();
      this._setActiveTabUi();
    }

    /**
     * 构建行内悬浮资料卡的 DOM 结构。这个卡片独立挂载在
     * document.documentElement 下（而不是 #ufs-panel 内部），这样才能
     * 用 position:fixed 自由定位到视口内任意位置，不受面板自身列表区域
     * overflow-y 滚动裁切的影响。默认隐藏，鼠标悬停到某一行上时才显示。
     */
    _buildHoverCard() {
      const hoverCard = document.createElement('div');
      hoverCard.id = 'ufs-hovercard';
      hoverCard.innerHTML = `
        <div class="ufs-hc-header">
          <img class="ufs-hc-avatar" id="ufs-hc-avatar" alt="" />
          <span class="ufs-hc-status" id="ufs-hc-status"></span>
        </div>
        <div class="ufs-hc-name" id="ufs-hc-name"></div>
        <div class="ufs-hc-username" id="ufs-hc-username"></div>
        <div class="ufs-hc-bio" id="ufs-hc-bio"></div>
        <div class="ufs-hc-actions">
          <button id="ufs-hc-open-btn">打开主页</button>
          <button id="ufs-hc-copy-btn">复制</button>
          <button id="ufs-hc-unfollow-btn" class="ufs-hc-unfollow-btn">取消关注</button>
        </div>
      `;
      document.documentElement.appendChild(hoverCard);
      this.hoverCardRoot = hoverCard;
      this.hoverCardElements = {
        avatar: hoverCard.querySelector('#ufs-hc-avatar'),
        status: hoverCard.querySelector('#ufs-hc-status'),
        name: hoverCard.querySelector('#ufs-hc-name'),
        username: hoverCard.querySelector('#ufs-hc-username'),
        bio: hoverCard.querySelector('#ufs-hc-bio'),
        openBtn: hoverCard.querySelector('#ufs-hc-open-btn'),
        copyBtn: hoverCard.querySelector('#ufs-hc-copy-btn'),
        unfollowBtn: hoverCard.querySelector('#ufs-hc-unfollow-btn'),
      };
      // 鼠标移入卡片本身时取消隐藏计时，允许用户点击卡片内的按钮；
      // 移出卡片时和移出行一样，走同样的延迟隐藏逻辑。
      hoverCard.addEventListener('mouseenter', () => {
        if (this._hoverHideTimer) clearTimeout(this._hoverHideTimer);
      });
      hoverCard.addEventListener('mouseleave', () => this._scheduleHideHoverCard());
    }

    /** 缓存常用 DOM 元素引用，避免重复查询。 */
    _cacheElements() {
      this.elements = {
        header: this.root.querySelector('#ufs-header'),
        collapseBtn: this.root.querySelector('#ufs-collapse-btn'),
        closeBtn: this.root.querySelector('#ufs-close-btn'),
        progressText: this.root.querySelector('#ufs-progress-text'),
        progressFill: this.root.querySelector('#ufs-progress-fill'),
        toggleBtn: this.root.querySelector('#ufs-toggle-btn'),
        rescanBtn: this.root.querySelector('#ufs-rescan-btn'),
        exportCsvBtn: this.root.querySelector('#ufs-export-csv-btn'),
        exportTxtBtn: this.root.querySelector('#ufs-export-txt-btn'),
        copyAllBtn: this.root.querySelector('#ufs-copy-all-btn'),
        searchInput: this.root.querySelector('#ufs-search-input'),
        sortBtn: this.root.querySelector('#ufs-sort-btn'),
        speedSlider: this.root.querySelector('#ufs-speed-slider'),
        speedValue: this.root.querySelector('#ufs-speed-value'),
        speedHint: this.root.querySelector('#ufs-speed-hint'),
        selectAllCheckbox: this.root.querySelector('#ufs-select-all-checkbox'),
        selectedCount: this.root.querySelector('#ufs-selected-count'),
        unfollowSelectedBtn: this.root.querySelector('#ufs-unfollow-selected-btn'),
        unfollowProgress: this.root.querySelector('#ufs-unfollow-progress'),
        unfollowProgressText: this.root.querySelector('#ufs-unfollow-progress-text'),
        unfollowStopBtn: this.root.querySelector('#ufs-unfollow-stop-btn'),
        list: this.root.querySelector('#ufs-list'),
        footer: this.root.querySelector('#ufs-footer'),
        tabs: {
          all: this.root.querySelector('#ufs-tab-all'),
          mutual: this.root.querySelector('#ufs-tab-mutual'),
          not_back: this.root.querySelector('#ufs-tab-not_back'),
          failed: this.root.querySelector('#ufs-tab-failed'),
        },
      };
    }

    /** 绑定所有静态交互事件（折叠、关闭、暂停/继续、导出、搜索、排序、分类等）。 */
    _bindStaticEvents() {
      this.elements.header.addEventListener('click', (event) => {
        if (event.target.closest('.ufs-icon-btn')) return;
        if (this._lastDragWasMove) {
          // 本次是一次拖拽（而非点击），不触发折叠/展开。
          this._lastDragWasMove = false;
          return;
        }
        this.toggleCollapse();
      });
      this.elements.collapseBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleCollapse();
      });
      this.elements.closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.close();
      });
      this.elements.toggleBtn.addEventListener('click', () => this._onPrimaryButtonClick());
      this.elements.rescanBtn.addEventListener('click', () => this._onRescanAll());
      this.elements.exportCsvBtn.addEventListener('click', () => this._onExportCsv());
      this.elements.exportTxtBtn.addEventListener('click', () => this._onExportTxt());
      this.elements.copyAllBtn.addEventListener('click', () => this._onCopyAll());
      this.elements.sortBtn.addEventListener('click', () => this._onToggleSort());
      this.elements.speedSlider.addEventListener('input', (event) => this._onSpeedChange(event.target.value));
      this.elements.selectAllCheckbox.addEventListener('change', (event) => this._onSelectAllChange(event.target.checked));
      this.elements.unfollowSelectedBtn.addEventListener('click', () => this._onUnfollowSelectedClick());
      this.elements.unfollowStopBtn.addEventListener('click', () => this._onStopUnfollowClick());

      const debouncedSearch = Utils.debounce((value) => {
        this.searchKeyword = value.trim().toLowerCase();
        this.renderList(this.rows);
      }, 250);
      this.elements.searchInput.addEventListener('input', (event) => debouncedSearch(event.target.value));

      Object.entries(this.elements.tabs).forEach(([tabKey, tabEl]) => {
        tabEl.addEventListener('click', () => {
          this.activeTab = tabKey;
          this._setActiveTabUi();
          this.renderList(this.rows);
        });
      });
    }

    /** 根据当前 activeTab 更新分类标签的高亮样式。 */
    _setActiveTabUi() {
      Object.entries(this.elements.tabs).forEach(([tabKey, tabEl]) => {
        tabEl.classList.toggle('ufs-tab-active', tabKey === this.activeTab);
      });
    }

    /**
     * 绑定面板头部的拖拽事件（基于 Pointer Events，同时支持鼠标与触摸）。
     * 通过移动距离阈值（DRAG_THRESHOLD_PX）区分"点击折叠"与"拖拽移动"：
     * 移动超过阈值才视为拖拽，松手后会把新位置持久化到 GM_setValue，
     * 下次打开面板时自动恢复到用户上次拖动到的位置。
     */
    _bindDragEvents() {
      const header = this.elements.header;

      header.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.ufs-icon-btn')) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return; // 仅响应鼠标左键。
        const rect = this.root.getBoundingClientRect();
        this._dragState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originLeft: rect.left,
          originTop: rect.top,
          moved: false,
        };
        header.classList.add('ufs-dragging');
        try {
          header.setPointerCapture(event.pointerId);
        } catch (error) {
          // 部分环境可能不支持 Pointer Capture，忽略即可，不影响基本拖拽。
        }
      });

      header.addEventListener('pointermove', (event) => {
        const dragState = this._dragState;
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        if (!dragState.moved) {
          const exceededThreshold =
            Math.abs(deltaX) > CONFIG.DRAG_THRESHOLD_PX || Math.abs(deltaY) > CONFIG.DRAG_THRESHOLD_PX;
          if (exceededThreshold) dragState.moved = true;
        }
        if (dragState.moved) {
          const clamped = this._clampPosition(dragState.originLeft + deltaX, dragState.originTop + deltaY);
          this.root.style.left = `${clamped.left}px`;
          this.root.style.top = `${clamped.top}px`;
        }
      });

      const finishDrag = (event) => {
        const dragState = this._dragState;
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        header.classList.remove('ufs-dragging');
        this._lastDragWasMove = dragState.moved;
        if (dragState.moved) {
          const rect = this.root.getBoundingClientRect();
          this._savePanelPosition(rect.left, rect.top);
        }
        try {
          header.releasePointerCapture(event.pointerId);
        } catch (error) {
          // 忽略。
        }
        this._dragState = null;
      };

      header.addEventListener('pointerup', finishDrag);
      header.addEventListener('pointercancel', finishDrag);
    }

    /**
     * 计算面板初始位置：优先使用用户上次拖动后保存的位置，若没有保存过
     * 或保存的位置已经不在当前视口范围内，则回退到默认的右上角位置。
     */
    _applyInitialPosition() {
      const saved = this._loadPanelPosition();
      let left;
      let top;
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        left = saved.left;
        top = saved.top;
      } else {
        left = window.innerWidth - CONFIG.PANEL_WIDTH_PX - CONFIG.PANEL_EDGE_MARGIN_PX;
        top = CONFIG.PANEL_DEFAULT_TOP_PX;
      }
      const clamped = this._clampPosition(left, top);
      this.root.style.left = `${clamped.left}px`;
      this.root.style.top = `${clamped.top}px`;
    }

    /**
     * 将坐标限制在视口范围内，保证拖拽时面板至少保留
     * PANEL_MIN_VISIBLE_PX 像素可见，不会被完全拖出屏幕、无法再次抓取。
     * @param {number} left 期望的 left 值。
     * @param {number} top 期望的 top 值。
     * @returns {{left:number, top:number}} 限制后的坐标。
     */
    _clampPosition(left, top) {
      const panelWidth = this.root.offsetWidth || CONFIG.PANEL_WIDTH_PX;
      const minVisible = CONFIG.PANEL_MIN_VISIBLE_PX;
      const maxLeft = window.innerWidth - minVisible;
      const minLeft = minVisible - panelWidth;
      const maxTop = window.innerHeight - minVisible;
      const minTop = 0;
      return {
        left: Utils.clampNumber(left, minLeft, maxLeft),
        top: Utils.clampNumber(top, minTop, maxTop),
      };
    }

    /** 窗口尺寸发生变化时，重新校正面板位置，避免其停留在视口之外。 */
    _reclampToViewport() {
      const rect = this.root.getBoundingClientRect();
      const clamped = this._clampPosition(rect.left, rect.top);
      this.root.style.left = `${clamped.left}px`;
      this.root.style.top = `${clamped.top}px`;
    }

    /**
     * 从 GM_getValue 中读取上次保存的面板位置（跨账号通用的 UI 偏好，
     * 不经过按所有者命名空间隔离的 Storage 类）。
     * @returns {{left:number, top:number}|null} 保存的位置，读取失败则为 null。
     */
    _loadPanelPosition() {
      try {
        const raw = GM_getValue('ufs_panel_position_v1', null);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (error) {
        Logger.warn('读取面板位置缓存失败', error);
        return null;
      }
    }

    /**
     * 将当前面板位置保存到 GM_setValue，供下次打开页面时恢复。
     * @param {number} left 左侧坐标。
     * @param {number} top 顶部坐标。
     */
    _savePanelPosition(left, top) {
      try {
        GM_setValue('ufs_panel_position_v1', JSON.stringify({ left, top }));
      } catch (error) {
        Logger.warn('保存面板位置失败', error);
      }
    }

    /** 折叠/展开面板主体。 */
    toggleCollapse() {
      this.isCollapsed = !this.isCollapsed;
      this.root.classList.toggle('ufs-collapsed', this.isCollapsed);
      this.elements.collapseBtn.textContent = this.isCollapsed ? '▸' : '▾';
    }

    /** 关闭并移除面板；同时暂停底层扫描队列。 */
    close() {
      this.root.remove();
      if (this.hoverCardRoot) this.hoverCardRoot.remove();
      window.removeEventListener('resize', this._onWindowResize);
      if (this.scanner) this.scanner.pause();
    }

    /**
     * 处理面板主按钮点击：
     *   - 尚未开始扫描时，按钮显示"开始扫描"，点击后调用 scanner.start()，
     *     此时才会真正开始自动滚动与检测（而不是页面一匹配就自动执行）。
     *   - 已经开始之后，按钮在"暂停"/"继续"之间切换，行为与之前一致。
     */
    _onPrimaryButtonClick() {
      if (!this.scanner) return;
      if (!this.scanner.hasStarted) {
        this.elements.toggleBtn.textContent = '暂停';
        this.scanner.start().catch((error) => Logger.error('扫描流程异常', error));
        return;
      }
      if (this.elements.toggleBtn.textContent === '暂停') {
        this.scanner.pause();
        this.elements.toggleBtn.textContent = '继续';
      } else {
        this.scanner.resume();
        this.elements.toggleBtn.textContent = '暂停';
      }
    }

    /** 处理"重新扫描"（整体）按钮点击。 */
    async _onRescanAll() {
      if (!this.scanner) return;
      this.elements.toggleBtn.disabled = false;
      this.elements.toggleBtn.textContent = '暂停';
      await this.scanner.rescanAll();
    }

    /** 导出全部结果为 CSV 文件（包含全部状态分类）。 */
    _onExportCsv() {
      const header = ['username', 'status'];
      const dataRows = this.rows.map((row) => [row.username, row.status]);
      const csvText = Utils.toCsv([header, ...dataRows]);
      Utils.downloadTextFile(`ufs-report-${Date.now()}.csv`, csvText, 'text/csv');
      Logger.success('CSV 导出完成');
    }

    /** 导出"未回关"用户名列表为 TXT 文件。 */
    _onExportTxt() {
      const notBackLines = this.rows
        .filter((row) => row.status === SCAN_STATUS.NOT_BACK)
        .map((row) => `@${row.username}`);
      Utils.downloadTextFile(`ufs-not-back-${Date.now()}.txt`, notBackLines.join('\n'), 'text/plain');
      Logger.success('TXT 导出完成');
    }

    /** 复制当前筛选/排序后可见的全部用户名到剪贴板。 */
    _onCopyAll() {
      const filteredRows = this._getFilteredSortedRows();
      const text = filteredRows.map((row) => `@${row.username}`).join('\n');
      try {
        GM_setClipboard(text);
        Logger.success('已复制到剪贴板');
      } catch (error) {
        Logger.error('复制失败', error);
      }
    }

    /** 切换排序方向（A-Z / Z-A）并重新渲染列表。 */
    _onToggleSort() {
      this.sortAscending = !this.sortAscending;
      this.elements.sortBtn.textContent = this.sortAscending ? 'A-Z' : 'Z-A';
      this.renderList(this.rows);
    }

    /**
     * 初始化速度滑块：设置滑块的最大值（对应档位数量）与当前值
     * （读取 ScrollSpeedManager 中已持久化的用户偏好），并同步显示文案。
     * 在面板构造时调用一次即可，之后由 _onSpeedChange 负责保持同步。
     */
    _initSpeedControl() {
      this.elements.speedSlider.max = String(ScrollSpeedManager.getPresetCount() - 1);
      this.elements.speedSlider.value = String(ScrollSpeedManager.currentIndex);
      this._refreshSpeedDisplay();
    }

    /**
     * 处理速度滑块的拖动：立即持久化新档位（下一轮滚动等待会实时读取
     * 新的速度，无需重新开始扫描），并刷新面板上的档位文案显示。
     * @param {string|number} rawIndex 滑块的原始 value。
     */
    _onSpeedChange(rawIndex) {
      ScrollSpeedManager.setIndex(Number(rawIndex));
      this._refreshSpeedDisplay();
    }

    /** 根据当前速度档位刷新面板上的文案展示（档位名 + 实际等待区间）。 */
    _refreshSpeedDisplay() {
      const current = ScrollSpeedManager.getCurrent();
      this.elements.speedValue.textContent = current.label;
      this.elements.speedHint.textContent =
        `滚动间隔 ${(current.min / 1000).toFixed(1)}s ~ ${(current.max / 1000).toFixed(1)}s`;
    }

    /**
     * 处理"全选未回关"复选框的勾选/取消勾选：批量将当前"未回关"分类下
     * 的全部用户名加入或移出选中集合，然后重新渲染列表以同步各行的
     * 复选框状态。
     * @param {boolean} checked 是否勾选。
     */
    _onSelectAllChange(checked) {
      const notBackUsernames = this.rows
        .filter((row) => row.status === SCAN_STATUS.NOT_BACK)
        .map((row) => row.username);
      if (checked) {
        notBackUsernames.forEach((username) => this.selectedUsernames.add(username));
      } else {
        notBackUsernames.forEach((username) => this.selectedUsernames.delete(username));
      }
      this.renderList(this.rows);
    }

    /**
     * 处理"取消关注选中"按钮点击：二次确认后，把选中的用户名交给
     * Scanner 加入批量取消关注队列，随后清空当前选择。
     */
    _onUnfollowSelectedClick() {
      if (!this.scanner) return;
      const usernames = Array.from(this.selectedUsernames);
      if (usernames.length === 0) return;
      const confirmed = window.confirm(
        `确定要取消关注选中的 ${usernames.length} 个账号吗？\n` +
        '将按每人约 1~2 秒的随机间隔逐个执行，可随时点击"停止"中断。\n' +
        '此操作会实际取消关注对方，无法撤销，请谨慎确认。'
      );
      if (!confirmed) return;
      this.selectedUsernames.clear();
      this.scanner.enqueueUnfollow(usernames);
      this.renderList(this.rows);
    }

    /** 处理"停止"按钮点击：中断尚未处理的取消关注队列。 */
    _onStopUnfollowClick() {
      if (!this.scanner) return;
      this.scanner.stopUnfollowQueue();
    }

    /**
     * 刷新批量操作工具栏：选中数量文案、"取消关注选中"按钮的可用状态、
     * 以及"全选未回关"复选框自身的勾选状态（是否已经全选/部分选中）。
     */
    _refreshBatchBar() {
      const count = this.selectedUsernames.size;
      this.elements.selectedCount.textContent = `已选 ${count}`;
      this.elements.unfollowSelectedBtn.disabled = count === 0;

      const notBackRows = this.rows.filter((row) => row.status === SCAN_STATUS.NOT_BACK);
      const allSelected =
        notBackRows.length > 0 && notBackRows.every((row) => this.selectedUsernames.has(row.username));
      this.elements.selectAllCheckbox.checked = allSelected;
      this.elements.selectAllCheckbox.disabled = notBackRows.length === 0;
    }

    /**
     * 展示批量取消关注的进行中状态：剩余人数与当前正在处理的用户名。
     * 出于同样"避免虚假分数进度"的考虑（参见扫描进度的设计），这里只
     * 展示"剩余 N 个"而不是"X / Y"，因为队列可能在处理过程中被继续追加。
     * @param {number} remainingCount 队列中剩余（含正在处理的这一个）的人数。
     * @param {string|null} currentUsername 当前正在处理的用户名，可能为 null。
     */
    setUnfollowProgress(remainingCount, currentUsername) {
      this.elements.unfollowProgress.style.display = 'flex';
      const currentText = currentUsername ? `当前：@${currentUsername}` : '';
      this.elements.unfollowProgressText.textContent =
        `正在取消关注...剩余 ${remainingCount} 个 ${currentText}`.trim();
    }

    /** 隐藏批量取消关注的进度条（处理完成或被用户停止后调用）。 */
    hideUnfollowProgress() {
      this.elements.unfollowProgress.style.display = 'none';
    }

    /**
     * 更新"滚动扫描中"阶段的进度文案。由于结果是在滚动过程中实时产生的，
     * 扫描结束前无法预知最终总人数，因此这里只展示"已处理"的累计人数，
     * 进度条以脉冲式动画表示"正在进行中"，而非精确百分比。
     * @param {number} processedCount 当前已处理（已判定回关状态）的人数。
     */
    setScanProgress(processedCount) {
      this.elements.progressText.textContent = `正在滚动扫描... 已处理 ${processedCount} 人`;
      this.elements.progressFill.style.width = '100%';
    }

    /**
     * 更新整体状态展示（待开始 / 扫描中 / 已暂停 / 已完成）。
     * @param {string} statusName 状态名称：'idle' | 'scanning' | 'paused' | 'done'。
     * @param {object} extra 附加数据（例如完成时的耗时）。
     */
    setStatus(statusName, extra = {}) {
      if (statusName === 'idle') {
        this.elements.toggleBtn.textContent = '开始扫描';
        this.elements.toggleBtn.disabled = false;
        this.elements.progressText.textContent = '已加载缓存数据，点击"开始扫描"以检测/更新回关状态';
        this.elements.progressFill.style.width = '0%';
      } else if (statusName === 'scanning') {
        this.elements.toggleBtn.textContent = '暂停';
        this.elements.toggleBtn.disabled = false;
      } else if (statusName === 'paused') {
        this.elements.toggleBtn.textContent = '继续';
      } else if (statusName === 'done') {
        const elapsedText = extra.elapsedMs ? Utils.formatDuration(extra.elapsedMs) : '0s';
        this.elements.progressText.textContent =
          `完成，共扫描 ${this.rows.length} 人，耗时 ${elapsedText}`;
        this.elements.progressFill.style.width = '100%';
        this.elements.toggleBtn.textContent = '暂停';
        this.elements.toggleBtn.disabled = true;
      }
    }

    /**
     * 根据当前的分类标签、搜索关键词、排序方向，计算最终需要展示的行数据。
     * @returns {Array<{username:string, status:string, reason:string}>}
     */
    _getFilteredSortedRows() {
      let filtered = this.rows;
      if (this.activeTab !== 'all') {
        filtered = filtered.filter((row) => row.status === this.activeTab);
      }
      if (this.searchKeyword) {
        filtered = filtered.filter((row) => row.username.toLowerCase().includes(this.searchKeyword));
      }
      filtered = [...filtered].sort((a, b) => {
        const comparison = a.username.toLowerCase().localeCompare(b.username.toLowerCase());
        return this.sortAscending ? comparison : -comparison;
      });
      return filtered;
    }

    /**
     * 重新渲染分类标签计数、底部统计文案与用户名列表。
     * 出于安全考虑，用户名一律使用 textContent 写入，杜绝任何 HTML 注入风险。
     * @param {Array<{username:string, status:string, reason:string}>} rows 全量行数据。
     */
    renderList(rows) {
      this.rows = rows;

      // 清理"过期"的选中项：例如已经成功取消关注而从列表中消失、或者
      // 重新扫描后状态不再是"未回关"的用户名，避免选中集合越滚越大。
      const notBackUsernameSet = new Set(
        rows.filter((row) => row.status === SCAN_STATUS.NOT_BACK).map((row) => row.username)
      );
      Array.from(this.selectedUsernames).forEach((username) => {
        if (!notBackUsernameSet.has(username)) this.selectedUsernames.delete(username);
      });

      const tabCounters = { all: rows.length, mutual: 0, not_back: 0, failed: 0 };
      rows.forEach((row) => {
        if (row.status === SCAN_STATUS.MUTUAL) tabCounters.mutual += 1;
        else if (row.status === SCAN_STATUS.NOT_BACK) tabCounters.not_back += 1;
        else if (row.status === SCAN_STATUS.FAILED) tabCounters.failed += 1;
      });
      this.elements.tabs.all.textContent = `全部(${tabCounters.all})`;
      this.elements.tabs.mutual.textContent = `已互关(${tabCounters.mutual})`;
      this.elements.tabs.not_back.textContent = `未回关(${tabCounters.not_back})`;
      this.elements.tabs.failed.textContent = `失败(${tabCounters.failed})`;
      this.elements.footer.textContent = `共 ${tabCounters.all} 人 · 未回关 ${tabCounters.not_back} 人`;

      this._refreshBatchBar();

      const filteredRows = this._getFilteredSortedRows();
      this.elements.list.innerHTML = '';

      if (filteredRows.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'ufs-empty';
        emptyEl.textContent = '暂无数据';
        this.elements.list.appendChild(emptyEl);
        return;
      }

      const statusLabels = { mutual: '已互关', not_back: '未回关', failed: '失败', pending: '待扫描' };
      filteredRows.forEach((row) => this.elements.list.appendChild(this._buildRowElement(row, statusLabels)));
    }

    /**
     * 构建单行用户名展示元素：仅"未回关"分类的行会带一个复选框（用于
     * 批量选择取消关注），其它分类展示等宽的占位符以保持对齐；随后是
     * 状态圆点、用户名、复制/打开/重新扫描按钮。
     * @param {{username:string, status:string, reason:string}} row 行数据。
     * @param {object} statusLabels 状态 -> 中文标签的映射表。
     * @returns {Element} 行 DOM 元素。
     */
    _buildRowElement(row, statusLabels) {
      const rowEl = document.createElement('div');
      rowEl.className = 'ufs-row';

      const userWrap = document.createElement('div');
      userWrap.className = 'ufs-row-user';

      if (row.status === SCAN_STATUS.NOT_BACK) {
        const checkboxEl = document.createElement('input');
        checkboxEl.type = 'checkbox';
        checkboxEl.className = 'ufs-row-checkbox';
        checkboxEl.title = '勾选以加入批量取消关注';
        checkboxEl.checked = this.selectedUsernames.has(row.username);
        checkboxEl.addEventListener('change', (event) => {
          if (event.target.checked) {
            this.selectedUsernames.add(row.username);
          } else {
            this.selectedUsernames.delete(row.username);
          }
          this._refreshBatchBar();
        });
        userWrap.appendChild(checkboxEl);
      } else {
        const spacerEl = document.createElement('span');
        spacerEl.className = 'ufs-row-checkbox-spacer';
        userWrap.appendChild(spacerEl);
      }

      const dotEl = document.createElement('span');
      dotEl.className = `ufs-row-dot ufs-dot-${row.status}`;
      dotEl.title = statusLabels[row.status] || row.status;

      const nameEl = document.createElement('span');
      nameEl.className = 'ufs-row-name';
      nameEl.textContent = `@${row.username}`;
      nameEl.title = `@${row.username}（${statusLabels[row.status] || row.status}）`;

      userWrap.appendChild(dotEl);
      userWrap.appendChild(nameEl);

      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'ufs-row-actions';

      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋';
      copyBtn.title = '复制用户名';
      copyBtn.addEventListener('click', () => {
        try {
          GM_setClipboard(`@${row.username}`);
          Logger.success(`已复制 @${row.username}`);
        } catch (error) {
          Logger.error('复制失败', error);
        }
      });

      const openBtn = document.createElement('button');
      openBtn.textContent = '🔗';
      openBtn.title = '打开主页';
      openBtn.addEventListener('click', () => {
        window.open(`${location.origin}/${row.username}`, '_blank', 'noopener');
      });

      const rescanBtn = document.createElement('button');
      rescanBtn.textContent = '⟳';
      rescanBtn.title = '重新扫描该用户';
      rescanBtn.addEventListener('click', async () => {
        rescanBtn.disabled = true;
        if (this.scanner) await this.scanner.rescanUser(row.username);
        rescanBtn.disabled = false;
      });

      actionsWrap.appendChild(copyBtn);
      actionsWrap.appendChild(openBtn);
      actionsWrap.appendChild(rescanBtn);

      if (row.status === SCAN_STATUS.NOT_BACK) {
        const unfollowBtn = document.createElement('button');
        unfollowBtn.textContent = '🚫';
        unfollowBtn.title = '取消关注该用户';
        unfollowBtn.addEventListener('click', () => {
          if (!this.scanner) return;
          const confirmed = window.confirm(`确定要取消关注 @${row.username} 吗？此操作无法撤销。`);
          if (!confirmed) return;
          this.scanner.enqueueUnfollow([row.username]);
        });
        actionsWrap.appendChild(unfollowBtn);
      }

      rowEl.appendChild(userWrap);
      rowEl.appendChild(actionsWrap);

      rowEl.addEventListener('mouseenter', () => this._scheduleShowHoverCard(row, rowEl));
      rowEl.addEventListener('mouseleave', () => this._scheduleHideHoverCard());

      return rowEl;
    }

    /**
     * 安排在 HOVER_CARD_SHOW_DELAY_MS 之后显示悬浮资料卡（若鼠标在此期间
     * 移开则会被 _scheduleHideHoverCard 取消，不会真正显示），避免鼠标
     * 快速划过多行时卡片不停闪烁。
     * @param {{username:string, status:string, reason:string, profile:object|null}} row 行数据。
     * @param {Element} anchorElement 触发悬停的行元素，用于定位卡片位置。
     */
    _scheduleShowHoverCard(row, anchorElement) {
      if (this._hoverHideTimer) clearTimeout(this._hoverHideTimer);
      if (this._hoverShowTimer) clearTimeout(this._hoverShowTimer);
      this._hoverShowTimer = setTimeout(() => {
        this._showHoverCard(row, anchorElement);
      }, CONFIG.HOVER_CARD_SHOW_DELAY_MS);
    }

    /**
     * 安排在 HOVER_CARD_HIDE_DELAY_MS 之后隐藏悬浮资料卡。留一小段宽限期
     * 是为了让用户可以把鼠标从行移动到卡片本身，点击卡片内的按钮
     * （打开主页 / 复制 / 取消关注），而不会因为鼠标短暂离开而提前关闭。
     */
    _scheduleHideHoverCard() {
      if (this._hoverShowTimer) clearTimeout(this._hoverShowTimer);
      if (this._hoverHideTimer) clearTimeout(this._hoverHideTimer);
      this._hoverHideTimer = setTimeout(() => this._hideHoverCard(), CONFIG.HOVER_CARD_HIDE_DELAY_MS);
    }

    /**
     * 实际渲染并展示悬浮资料卡：填充头像/昵称/认证标记/回关状态/简介，
     * 绑定"打开主页/复制/取消关注"三个快捷操作按钮，并将卡片定位到
     * 触发行的旁边（优先显示在面板左侧，空间不足时自动切换到右侧，
     * 垂直方向也会做视口边界钳制，避免卡片超出屏幕）。
     * @param {{username:string, status:string, reason:string, profile:object|null}} row 行数据。
     * @param {Element} anchorElement 触发悬停的行元素。
     */
    _showHoverCard(row, anchorElement) {
      const profile = row.profile || {};
      const elements = this.hoverCardElements;
      const statusLabels = { mutual: '已互关', not_back: '未回关', failed: '失败', pending: '待扫描' };

      if (profile.avatarUrl) {
        elements.avatar.src = profile.avatarUrl;
        elements.avatar.style.visibility = 'visible';
      } else {
        elements.avatar.removeAttribute('src');
        elements.avatar.style.visibility = 'hidden';
      }

      elements.status.textContent = statusLabels[row.status] || row.status;
      elements.status.className = `ufs-hc-status ufs-dot-${row.status}`;

      elements.name.innerHTML = '';
      const nameTextNode = document.createTextNode(profile.displayName || row.username);
      elements.name.appendChild(nameTextNode);
      if (profile.isVerified) {
        const verifiedMark = document.createElement('span');
        verifiedMark.className = 'ufs-hc-verified';
        verifiedMark.textContent = '✓';
        verifiedMark.title = '已认证账号';
        elements.name.appendChild(verifiedMark);
      }

      elements.username.textContent = `@${row.username}`;
      elements.bio.textContent = profile.bio || '（未采集到简介信息，可尝试"重新扫描该用户"）';

      elements.openBtn.onclick = () => window.open(`${location.origin}/${row.username}`, '_blank', 'noopener');
      elements.copyBtn.onclick = () => {
        try {
          GM_setClipboard(`@${row.username}`);
          Logger.success(`已复制 @${row.username}`);
        } catch (error) {
          Logger.error('复制失败', error);
        }
      };
      elements.unfollowBtn.style.display = row.status === SCAN_STATUS.NOT_BACK ? 'block' : 'none';
      elements.unfollowBtn.onclick = () => {
        if (!this.scanner) return;
        const confirmed = window.confirm(`确定要取消关注 @${row.username} 吗？此操作无法撤销。`);
        if (!confirmed) return;
        this.scanner.enqueueUnfollow([row.username]);
        this._hideHoverCard();
      };

      const rect = anchorElement.getBoundingClientRect();
      const cardWidth = CONFIG.HOVER_CARD_WIDTH_PX;
      let left = rect.left - cardWidth - 12; // 默认显示在触发行的左侧。
      if (left < 8) left = rect.right + 12; // 左侧放不下则改到右侧。
      left = Utils.clampNumber(left, 8, window.innerWidth - cardWidth - 8);

      this.hoverCardRoot.style.left = `${left}px`;
      this.hoverCardRoot.style.top = `${rect.top}px`;
      this.hoverCardRoot.style.display = 'block';

      // 卡片实际高度要渲染出来才知道，下一帧再根据真实高度做垂直方向的
      // 视口边界钳制，避免卡片下半部分超出屏幕看不到。
      requestAnimationFrame(() => {
        const cardRect = this.hoverCardRoot.getBoundingClientRect();
        let top = rect.top;
        if (top + cardRect.height > window.innerHeight - 8) {
          top = window.innerHeight - cardRect.height - 8;
        }
        if (top < 8) top = 8;
        this.hoverCardRoot.style.top = `${top}px`;
      });
    }

    /** 隐藏悬浮资料卡。 */
    _hideHoverCard() {
      if (this.hoverCardRoot) this.hoverCardRoot.style.display = 'none';
    }
  }

  /* ==========================================================================
   * 10. 启动引导（main）
   *     负责识别页面类型、监听 X 的 SPA 路由变化（pushState/replaceState/
   *     popstate），并在合适的时机组装 Storage / Parser / Scanner / Panel
   *     四大模块，驱动整个检测流程运行。
   * ======================================================================== */

  (async function main() {
    try {

      // 若当前处于"隐藏 iframe 探测响应"场景，处理完毕后直接结束，
      // 不再执行下面的面板/扫描初始化逻辑，避免在探测 iframe 内产生
      // 多余的浮动面板或递归探测。
      const handledAsProbe = await respondToProbeIfNeeded();
      if (handledAsProbe) return;

      // 恢复用户上次选择的扫描速度档位（若从未设置过则使用默认"标准"档）。
      ScrollSpeedManager.load();

      /** 当前已初始化面板对应的所有者用户名，用于避免重复初始化。 */
      let currentOwnerUsername = null;
      /** 当前已初始化面板对应的列表页面类型（'following' / 'verified_followers'）。 */
      let currentPageType = null;
      /** 当前面板实例引用。 */
      let currentPanel = null;
      /** 当前扫描器实例引用。 */
      let currentScanner = null;
      /**
       * 标记"当前的暂停状态是否由离开页面自动触发"——只有这种情况下，
       * 重新回到同一个列表页面时才会自动恢复扫描；如果是用户自己手动
       * 点击了"暂停"按钮，则不会被这里的逻辑覆盖，尊重用户的主动选择。
       */
      let pausedByNavigation = false;

      /**
       * 为当前页面（新的所有者 + 新的列表类型）创建一整套 Storage / Scanner /
       * Panel，替换掉旧的实例。只负责展示面板、加载缓存数据，不会自动开始
       * 扫描——扫描必须由用户主动点击面板上的"开始扫描"按钮触发。
       * @param {string} ownerUsername 列表所有者用户名。
       * @param {string} pageType 列表页面类型。
       * @returns {Promise<void>}
       */
      async function initForNewTarget(ownerUsername, pageType) {
        currentOwnerUsername = ownerUsername;
        currentPageType = pageType;
        pausedByNavigation = false;

        const pageTypeLabel = LIST_PAGE_TYPE_LABELS[pageType] || pageType;

        if (currentPanel) {
          try {
            currentPanel.close();
          } catch (error) {
            // 忽略旧面板关闭异常。
          }
        }

        const storage = new Storage(ownerUsername, pageType);
        const panel = new Panel();
        const scanner = new Scanner({ ownerUsername, pageType, storage, panel });
        panel.bindScanner(scanner);

        scanner.loadFromCache();
        panel.renderList(scanner.getAllRows());
        panel.setStatus('idle');

        currentPanel = panel;
        currentScanner = scanner;

        // 若上次还有未处理完的批量取消关注任务（例如页面被刷新/关闭中断），
        // 自动恢复继续处理，并立即在面板上展示剩余进度。
        if (scanner.unfollowQueue.length > 0) {
          panel.setUnfollowProgress(scanner.unfollowQueue.length, null);
          scanner._processUnfollowQueue().catch((error) => Logger.error('恢复取消关注流程异常', error));
        }
      }

      /**
       * 处理一次可能的路由变化：
       *   - 若离开了当前正在使用的目标（不同所有者或不同页面类型，或者
       *     新页面根本不是受支持的列表页面），且旧的 Scanner 仍在扫描中，
       *     则自动暂停它，避免脚本在无关页面上继续滚动和读取 DOM。
       *   - 若新页面不是受支持的列表页面，到此为止，保留旧的面板/扫描器
       *     原样挂起，不做任何销毁，方便用户随时切回。
       *   - 若重新回到了同一个目标页面，且之前是因为"离开页面"而被自动
       *     暂停的，则自动恢复扫描；否则（例如用户手动暂停过）不做处理。
       *   - 若目标确实发生了变化（不同所有者或不同页面类型），则视为全新
       *     页面，重新初始化一整套 Storage / Scanner / Panel。
       * @returns {Promise<void>}
       */
      async function handlePossibleRouteChange() {
        const newOwnerUsername = Parser.getOwnerUsernameFromCurrentUrl();
        const newPageType = Parser.getListPageTypeFromCurrentUrl();

        const isSameTarget = Boolean(
          newOwnerUsername && newPageType &&
          currentOwnerUsername && currentPageType &&
          newOwnerUsername.toLowerCase() === currentOwnerUsername.toLowerCase() &&
          newPageType === currentPageType
        );

        if (!isSameTarget && currentScanner && currentScanner.isScanning && !currentScanner.isPaused) {
          // 离开了正在扫描的目标（无论新页面是否受支持），先自动暂停，
          // 避免继续在无关页面上滚动、读取 DOM。
          currentScanner.pause();
          pausedByNavigation = true;
          Logger.warn('已离开当前列表页面，扫描已自动暂停');
        }

        if (!newOwnerUsername || !newPageType) {
          // 新页面不是受支持的列表页面，保留现有面板/扫描器，什么都不做。
          return;
        }

        if (isSameTarget) {
          if (pausedByNavigation && currentScanner && currentScanner.isPaused) {
            currentScanner.resume();
            pausedByNavigation = false;
          }
          return;
        }

        // 所有者或页面类型发生了变化：视为全新目标，重新初始化。
        await initForNewTarget(newOwnerUsername, newPageType);
      }

      /**
       * 监听 X 的 SPA 路由切换（history.pushState / replaceState / popstate），
       * 每当路径可能发生变化时调用 handlePossibleRouteChange 进行处理。
       */
      function watchUrlChanges() {
        let lastPathname = location.pathname;

        const handlePossibleChange = Utils.debounce(() => {
          if (location.pathname !== lastPathname) {
            lastPathname = location.pathname;
            handlePossibleRouteChange();
          }
        }, 400);

        const originalPushState = history.pushState.bind(history);
        history.pushState = function patchedPushState(...args) {
          const resultValue = originalPushState(...args);
          handlePossibleChange();
          return resultValue;
        };

        const originalReplaceState = history.replaceState.bind(history);
        history.replaceState = function patchedReplaceState(...args) {
          const resultValue = originalReplaceState(...args);
          handlePossibleChange();
          return resultValue;
        };

        window.addEventListener('popstate', handlePossibleChange);

        // 额外用 MutationObserver 监听 <body> 的直接子节点变化作为兜底信号，
        // 进一步提升对 X 客户端路由变化的感知灵敏度。
        const bodyObserver = new MutationObserver(handlePossibleChange);
        bodyObserver.observe(document.body, { childList: true, subtree: false });
      }

      // 首次加载：若当前页面本身就是受支持的列表页面，直接初始化面板
      // （但不会自动开始扫描，需等待用户点击"开始扫描"）。
      const initialOwnerUsername = Parser.getOwnerUsernameFromCurrentUrl();
      const initialPageType = Parser.getListPageTypeFromCurrentUrl();
      if (initialOwnerUsername && initialPageType) {
        await initForNewTarget(initialOwnerUsername, initialPageType);
      }
      watchUrlChanges();
    } catch (error) {
      Logger.error('脚本初始化过程中发生未捕获异常', error);
    }
  })();
})();