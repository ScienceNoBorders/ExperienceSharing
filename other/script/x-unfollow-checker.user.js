// ==UserScript==
// @name         X 互关检测助手 (X Unfollowers Checker)
// @namespace    https://github.com/ScienceNoBorders/ExperienceSharing/blob/master/other/script/x-unfollow-checker.user
// @version      2.1.0
// @description  自动滚动你在 X (Twitter) 上的关注列表，滚动过程中实时检测每个用户是否回关了你（读取列表卡片 data-testid="userFollowIndicator" 节点），并在页面右侧固定面板中展示"未互关"名单。全程基于网页 DOM 解析实现，不调用官方 API，不需要开发者 Token 或 Bearer Token。
// @author       traderNathan(@nathan_9795)
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

/*
 * ============================================================================
 * X 互关检测助手
 * ----------------------------------------------------------------------------
 * 功能概述：
 *   1. 当用户访问 https://x.com/<用户名>/following 页面时自动启动。
 *   2. 自动无限滚动关注列表；每当有新的用户卡片进入 DOM，立即在该卡片内
 *      查询 [data-testid="userFollowIndicator"] 节点：存在则判定"已回关"，
 *      不存在则判定"未回关"——检测与滚动同步进行，滚动到底的那一刻，
 *      全部人的回关状态也已经确定，不需要再额外访问任何用户主页。
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
  const SCRIPT_VERSION = '1.0.0';

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
    // 随机等待 + 更多轮连续无变化才判定到底"的保守策略，而不是直接跳到
    // 页面最底部——一次性跳到底部可能导致虚拟列表来不及渲染中间的用户
    // 卡片（以及其中的 userFollowIndicator 回关标识），造成漏判/误判。
    SCROLL_STEP_RATIO: 0.7, // 每次滚动视口高度的比例。
    MIN_SCROLL_STEP_PX: 260, // 每次滚动的最小像素数（应对极小视口）。
    SCROLL_WAIT_MIN_MS: 1600,
    SCROLL_WAIT_MAX_MS: 2800,
    IDLE_ROUNDS_TO_STOP: 6,
    MUTATION_IDLE_MS: 3500,

    // 隐藏 iframe 探测相关。
    IFRAME_WIDTH_PX: 500,
    IFRAME_HEIGHT_PX: 900,
    PROBE_POLL_INTERVAL_MS: 300,
    PROBE_MAX_WAIT_MS: 9000,
    PROBE_HARD_TIMEOUT_MS: 12000,

    // 面板相关。
    PANEL_WIDTH_PX: 340,
    PANEL_DEFAULT_TOP_PX: 70,
    PANEL_EDGE_MARGIN_PX: 16,
    PANEL_MIN_VISIBLE_PX: 60, // 拖拽时至少保留在视口内的可见像素，防止被拖出屏幕。
    DRAG_THRESHOLD_PX: 4, // 超过该移动距离才视为"拖拽"而非"点击"。

    // 导出文件时释放 Blob URL 的延迟（毫秒）。
    BLOB_REVOKE_DELAY_MS: 4000,

    // 缓存版本号，若未来数据结构变化可递增此值使旧缓存自然失效。
    STORAGE_VERSION: 'v1',
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
     * 从形如 "/username/following" 的路径中提取所有者用户名。
     * @param {string} pathname 当前页面路径。
     * @returns {string|null} 所有者用户名，若不匹配则返回 null。
     */
    extractOwnerUsernameFromPath(pathname) {
      const match = pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/i);
      return match ? match[1] : null;
    },

    /**
     * 判断给定路径是否为"关注列表"页面。
     * @param {string} pathname 当前页面路径。
     * @returns {boolean} 是否匹配。
     */
    isFollowingPagePath(pathname) {
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
  };

  /* ==========================================================================
   * 4. 缓存模块（Storage 类）
   *    基于 GM_setValue / GM_getValue 实现的命名空间化持久化存储。
   *    命名空间按"所有者用户名"隔离，避免不同账号数据互相污染。
   * ======================================================================== */

  class Storage {
    /**
     * @param {string} ownerUsername 关注列表页面所属的用户名（即"我"）。
     */
    constructor(ownerUsername) {
      this.ownerUsername = ownerUsername;
      this.namespace = `ufs_${CONFIG.STORAGE_VERSION}_${ownerUsername.toLowerCase()}`;
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

    /** 清空当前所有者名下的全部缓存数据（关注列表、扫描结果、元信息）。 */
    clearAll() {
      this._writeJson('following_list', []);
      this._writeJson('scan_results', {});
      this._writeJson('meta', { startedAt: null, updatedAt: null, scannedCount: 0, totalCount: 0, elapsedMs: 0 });
    }
  }

  /* ==========================================================================
   * 5. DOM 解析模块（Parser 类）
   *    负责识别页面类型、提取用户名、判断回关状态。所有选择器均采用
   *    "多重候选 + 兜底"策略以适配 X 前端结构的变化。
   * ======================================================================== */

  class Parser {
    /** 判断当前页面是否为"关注列表"页面。 */
    static isFollowingPage() {
      return Utils.isFollowingPagePath(location.pathname);
    }

    /** 从当前 URL 中提取关注列表所属的用户名（即"我"）。 */
    static getOwnerUsernameFromCurrentUrl() {
      return Utils.extractOwnerUsernameFromPath(location.pathname);
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
      Logger.info('扫描已继续');
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
     * 探测指定用户名是否回关了当前登录账号。
     * @param {string} username 待探测的用户名。
     * @returns {Promise<{status:string, reason:string}>} 探测结果。
     */
    probeUser(username) {
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
          `?ufs_probe=1&ufs_token=${token}`;

        const timeoutId = setTimeout(() => {
          this._finish(token, { status: SCAN_STATUS.FAILED, reason: 'hard_timeout' });
        }, CONFIG.PROBE_HARD_TIMEOUT_MS);

        this.pending.set(token, { resolve, iframe, timeoutId });
        iframe.src = targetUrl;
        document.body.appendChild(iframe);
      });
    }

    /**
     * 监听来自子 iframe 的 postMessage 消息，匹配 token 后完成对应的 Promise。
     * @param {MessageEvent} event 消息事件对象。
     */
    _onMessage(event) {
      const data = event.data;
      if (!data || data.__ufs !== true || data.type !== 'PROBE_RESULT') return;
      this._finish(data.token, data.result);
    }

    /**
     * 结束一次探测：清理定时器、移除 iframe、resolve 对应的 Promise。
     * @param {string} token 探测请求标识。
     * @param {{status:string, reason:string}} result 探测结果。
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
   * 探测响应端逻辑：当脚本被加载在一个带有 ufs_probe 标记参数的隐藏
   * iframe 中时，负责等待目标主页渲染完成、判断回关状态，并将结果通过
   * postMessage 回传给父页面。若当前不处于探测场景，直接返回 false。
   * @returns {Promise<boolean>} 是否处理了本次探测请求。
   */
  async function respondToProbeIfNeeded() {
    const searchParams = new URLSearchParams(location.search);
    if (searchParams.get('ufs_probe') !== '1') return false;
    if (window.self === window.top) return false; // 仅在被嵌入的 iframe 中响应。

    const token = searchParams.get('ufs_token') || '';
    Logger.debug(`探测响应模式启动: ${location.pathname}`);
    const result = await Parser.waitAndDetectFollowState(document);
    try {
      window.parent.postMessage({ __ufs: true, type: 'PROBE_RESULT', token, result }, '*');
    } catch (error) {
      Logger.error('回传探测结果失败', error);
    }
    return true;
  }

  /* ==========================================================================
   * 8. 扫描调度模块（Scanner 类）
   *    串联"收集关注列表 -> 构建探测队列 -> 并发执行 -> 结果持久化"
   *    整个业务流程，并向 Panel 汇报进度。
   * ======================================================================== */

  class Scanner {
    /**
     * @param {{ownerUsername:string, storage:Storage, panel:Panel}} deps 依赖项。
     */
    constructor(deps) {
      this.ownerUsername = deps.ownerUsername;
      this.storage = deps.storage;
      this.panel = deps.panel;
      // Prober 现在只用于"重新扫描单个用户"时、且该用户的卡片已经不在
      // 当前 DOM 中（被虚拟列表回收）的兜底场景，不再用于批量扫描。
      this.prober = new Prober();
      // 手动重扫队列：并发受限（2~3），避免用户连续点击多个"重新扫描"
      // 按钮时一次性打开过多隐藏 iframe。
      this.manualRescanQueue = new TaskQueue({ concurrency: CONFIG.DEFAULT_CONCURRENCY });
      this.followingList = [];
      /** username -> { status, reason, checkedAt, retries } */
      this.scanResults = {};
      this.startTime = null;
      this.isScanning = false;
      this.isPaused = false;
      this._resumeResolve = null;
      this._mutationObserver = null;
      this._lastMutationAt = 0;
      // 扫描代次：每次调用 scrollAndDetect() 都会递增，正在运行的旧一轮
      // 循环会在检测到代次变化后自然退出，用于安全地"重新开始"扫描。
      this._scanGeneration = 0;
    }

    /** 从缓存中加载既有的关注列表与扫描结果到内存。 */
    loadFromCache() {
      this.followingList = this.storage.getFollowingList();
      this.scanResults = this.storage.getScanResults();
    }

    /**
     * 主入口：启动"边滚动边探测"流程。
     * @returns {Promise<void>}
     */
    async start() {
      this.startTime = Utils.nowTimestamp();
      this.isScanning = true;
      this.panel.setStatus('scanning');
      await this.scrollAndDetect();
      this.isScanning = false;
      this._finishScan();
    }

    /**
     * 核心流程：自动无限滚动关注列表，每当发现一个用户卡片就立即在该
     * 卡片的 DOM 内查询 [data-testid="userFollowIndicator"] 来判断对方
     * 是否回关，结果同步写入内存与缓存——不需要访问对方主页，不需要
     * 隐藏 iframe，也不需要任何网络请求。滚动结束（自动检测到无限滚动
     * 到底）的那一刻，全部结果已经就绪。
     * @returns {Promise<void>}
     */
    async scrollAndDetect() {
      const myGeneration = ++this._scanGeneration;
      const collectedUsernames = new Set(this.followingList);
      this._attachMutationObserver();

      let idleRounds = 0;
      let lastProcessedCount = Object.keys(this.scanResults).length;

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
          // 已经确认"已回关"的结果非常可靠（标识节点是明确的正向证据），
          // 无需重复判断；但"未回关"的结果允许在后续轮次中重新核对——
          // 如果该用户的卡片因为渲染时机较晚、这一轮才刚显示出回关标识，
          // 就把结果从"未回关"升级为"已回关"，避免因首次读取过早而误判。
          if (existingEntry && existingEntry.status === SCAN_STATUS.MUTUAL) continue;

          const hasFollowBackBadge = Parser.cellHasFollowBackBadge(cell);
          this.scanResults[username] = {
            status: hasFollowBackBadge ? SCAN_STATUS.MUTUAL : SCAN_STATUS.NOT_BACK,
            reason: hasFollowBackBadge ? 'list_badge' : 'list_no_badge',
            checkedAt: Utils.nowTimestamp(),
            retries: 0,
          };
        }

        this.followingList = Array.from(collectedUsernames);
        this.storage.saveFollowingList(this.followingList);
        this.storage.saveScanResults(this.scanResults);

        const processedCount = Object.keys(this.scanResults).length;
        this.panel.setScanProgress(processedCount);
        this.panel.renderList(this.getAllRows());

        const noNewProgress = processedCount === lastProcessedCount;
        const noRecentMutation = Date.now() - this._lastMutationAt > CONFIG.MUTATION_IDLE_MS;
        if (noNewProgress && noRecentMutation) {
          idleRounds += 1;
        } else {
          idleRounds = 0;
        }
        lastProcessedCount = processedCount;

        // 小步增量滚动（而非直接跳到页面最底部），给虚拟列表充分的时间
        // 渲染每一批新出现的用户卡片及其回关标识，降低漏判/误判概率。
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
        const scrollStepPx = Math.max(
          CONFIG.MIN_SCROLL_STEP_PX,
          Math.floor(viewportHeight * CONFIG.SCROLL_STEP_RATIO)
        );
        window.scrollBy(0, scrollStepPx);
        await Utils.randomDelay(CONFIG.SCROLL_WAIT_MIN_MS, CONFIG.SCROLL_WAIT_MAX_MS);
      }

      this._detachMutationObserver();
    }

    /** 挂载 MutationObserver，用于感知时间线是否仍在持续加载新内容。 */
    _attachMutationObserver() {
      this._lastMutationAt = Date.now();
      this._mutationObserver = new MutationObserver(() => {
        this._lastMutationAt = Date.now();
      });
      this._mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    /** 卸载 MutationObserver。 */
    _detachMutationObserver() {
      if (this._mutationObserver) {
        this._mutationObserver.disconnect();
        this._mutationObserver = null;
      }
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
      Logger.info(`重新扫描 @${username}`);

      const cell = this._findCellForUsername(username);
      if (cell) {
        const hasFollowBackBadge = Parser.cellHasFollowBackBadge(cell);
        this.scanResults[username] = {
          status: hasFollowBackBadge ? SCAN_STATUS.MUTUAL : SCAN_STATUS.NOT_BACK,
          reason: hasFollowBackBadge ? 'list_badge_rescan' : 'list_no_badge_rescan',
          checkedAt: Utils.nowTimestamp(),
          retries: 0,
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
      Logger.info('扫描已继续');
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
      this.isPaused = false;
      this.isScanning = false;
      this.scanResults = {};
      this.followingList = [];
      this.storage.saveScanResults({});
      this.storage.saveFollowingList([]);
      this.panel.renderList(this.getAllRows());

      window.scrollTo(0, 0);
      await Utils.sleep(CONFIG.SCROLL_WAIT_MIN_MS);

      this.startTime = Utils.nowTimestamp();
      this.isScanning = true;
      this.panel.setStatus('scanning');
      await this.scrollAndDetect();
      this.isScanning = false;
      this._finishScan();
    }

    /**
     * 汇总当前所有用户名与其扫描状态，供面板渲染使用。
     * @returns {Array<{username:string, status:string, reason:string}>}
     */
    getAllRows() {
      return this.followingList.map((username) => {
        const entry = this.scanResults[username] || { status: SCAN_STATUS.PENDING, reason: '' };
        return { username, status: entry.status, reason: entry.reason || '' };
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
      this._dragState = null;
      this._lastDragWasMove = false;
      this._injectStyles();
      this._buildSkeleton();
      this._bindStaticEvents();
      this._bindDragEvents();
      this._applyInitialPosition();
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
        #ufs-panel .ufs-list { flex: 1; overflow-y: auto; padding: 0 8px 8px; min-height: 120px; }
        #ufs-panel .ufs-list::-webkit-scrollbar { width: 6px; }
        #ufs-panel .ufs-list::-webkit-scrollbar-thumb { background: #3a3f42; border-radius: 3px; }
        #ufs-panel .ufs-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 8px; border-radius: 8px; margin-bottom: 4px; background: #1a1e22;
        }
        #ufs-panel .ufs-row-user { display: flex; align-items: center; gap: 6px; overflow: hidden; }
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
      `);
    }

    /** 构建面板的静态骨架 DOM 结构（只创建一次）。 */
    _buildSkeleton() {
      const root = document.createElement('div');
      root.id = 'ufs-panel';
      root.innerHTML = `
        <div class="ufs-header" id="ufs-header">
          <div class="ufs-title">🔍 未回关检测 <span>v${SCRIPT_VERSION}</span></div>
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
            <button class="ufs-btn ufs-btn-primary" id="ufs-toggle-btn">暂停</button>
            <button class="ufs-btn" id="ufs-rescan-btn">重新扫描</button>
            <button class="ufs-btn" id="ufs-export-csv-btn">导出CSV</button>
            <button class="ufs-btn" id="ufs-export-txt-btn">导出TXT</button>
            <button class="ufs-btn" id="ufs-copy-all-btn">复制列表</button>
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
          <div class="ufs-list" id="ufs-list"></div>
          <div class="ufs-footer" id="ufs-footer">尚未扫描</div>
        </div>
      `;
      document.documentElement.appendChild(root);
      this.root = root;
      this._cacheElements();
      this._setActiveTabUi();
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
      this.elements.toggleBtn.addEventListener('click', () => this._onTogglePauseResume());
      this.elements.rescanBtn.addEventListener('click', () => this._onRescanAll());
      this.elements.exportCsvBtn.addEventListener('click', () => this._onExportCsv());
      this.elements.exportTxtBtn.addEventListener('click', () => this._onExportTxt());
      this.elements.copyAllBtn.addEventListener('click', () => this._onCopyAll());
      this.elements.sortBtn.addEventListener('click', () => this._onToggleSort());

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
      window.removeEventListener('resize', this._onWindowResize);
      if (this.scanner) this.scanner.pause();
    }

    /** 处理"暂停/继续"按钮点击。 */
    _onTogglePauseResume() {
      if (!this.scanner) return;
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
     * 更新整体状态展示（扫描中 / 已暂停 / 已完成）。
     * @param {string} statusName 状态名称。
     * @param {object} extra 附加数据（例如完成时的耗时）。
     */
    setStatus(statusName, extra = {}) {
      if (statusName === 'scanning') {
        this.elements.toggleBtn.textContent = '暂停';
        this.elements.toggleBtn.disabled = false;
      } else if (statusName === 'paused') {
        this.elements.toggleBtn.textContent = '继续';
      } else if (statusName === 'done') {
        const elapsedText = extra.elapsedMs ? Utils.formatDuration(extra.elapsedMs) : '0s';
        this.elements.progressText.textContent =
          `完成，共扫描 ${this.rows.length} 人，耗时 ${elapsedText}`;
        this.elements.progressFill.style.width = '100%';
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
     * 构建单行用户名展示元素，包含状态圆点、用户名、复制/打开/重新扫描按钮。
     * @param {{username:string, status:string, reason:string}} row 行数据。
     * @param {object} statusLabels 状态 -> 中文标签的映射表。
     * @returns {Element} 行 DOM 元素。
     */
    _buildRowElement(row, statusLabels) {
      const rowEl = document.createElement('div');
      rowEl.className = 'ufs-row';

      const userWrap = document.createElement('div');
      userWrap.className = 'ufs-row-user';

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

      rowEl.appendChild(userWrap);
      rowEl.appendChild(actionsWrap);
      return rowEl;
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
      Logger.info(`脚本已加载 v${SCRIPT_VERSION}`);

      // 若当前处于"隐藏 iframe 探测响应"场景，处理完毕后直接结束，
      // 不再执行下面的面板/扫描初始化逻辑，避免在探测 iframe 内产生
      // 多余的浮动面板或递归探测。
      const handledAsProbe = await respondToProbeIfNeeded();
      if (handledAsProbe) return;

      /** 当前已初始化面板对应的所有者用户名，用于避免重复初始化。 */
      let currentOwnerUsername = null;
      /** 当前面板实例引用。 */
      let currentPanel = null;
      /** 当前扫描器实例引用。 */
      let currentScanner = null;

      /**
       * 检查当前页面是否为"关注列表"页面，若是且尚未针对该所有者初始化过，
       * 则创建 Storage / Panel / Scanner 三件套并启动扫描流程。
       * @returns {Promise<void>}
       */
      async function bootForCurrentPage() {
        if (!Parser.isFollowingPage()) return;
        const ownerUsername = Parser.getOwnerUsernameFromCurrentUrl();
        if (!ownerUsername) return;
        if (ownerUsername === currentOwnerUsername && currentScanner) return;

        currentOwnerUsername = ownerUsername;
        Logger.info(`检测到关注列表页面，所有者: @${ownerUsername}`);

        if (currentPanel) {
          try {
            currentPanel.close();
          } catch (error) {
            // 忽略旧面板关闭异常。
          }
        }

        const storage = new Storage(ownerUsername);
        const panel = new Panel();
        const scanner = new Scanner({ ownerUsername, storage, panel });
        panel.bindScanner(scanner);

        scanner.loadFromCache();
        panel.renderList(scanner.getAllRows());

        currentPanel = panel;
        currentScanner = scanner;

        // 等待时间线首批用户卡片渲染完成后再开始自动滚动收集，
        // 避免在页面刚切换、DOM 尚未就绪时读取到空列表。
        await Utils.waitFor(() => Parser.findUserCells(document).length > 0, {
          timeout: 8000, interval: 300,
        });

        scanner.start().catch((error) => Logger.error('扫描流程异常', error));
      }

      /**
       * 监听 X 的 SPA 路由切换（history.pushState / replaceState / popstate），
       * 当路径变化且新路径也是关注列表页面时，重新执行 bootForCurrentPage。
       */
      function watchUrlChanges() {
        let lastPathname = location.pathname;

        const handlePossibleChange = Utils.debounce(() => {
          if (location.pathname !== lastPathname) {
            lastPathname = location.pathname;
            bootForCurrentPage();
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

      await bootForCurrentPage();
      watchUrlChanges();
    } catch (error) {
      Logger.error('脚本初始化过程中发生未捕获异常', error);
    }
  })();
})();