// ==UserScript==
// @name         X 用户检测助手 (X Users Checker Local Test)
// @namespace    https://github.com/ScienceNoBorders/ExperienceSharing/blob/master/other/script/x-unfollow-checker.user.js
// @version      3.2.0
// @description  支持在"正在关注"与"已验证的关注者"两种列表页面使用。自动检测回关状态、最新发帖日期，以及提取 followers/following 比例并进行阈值筛选批量取关。
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

(function () {
  'use strict';

  if (window.__ufsScriptLoaded) {
    return;
  }
  window.__ufsScriptLoaded = true;

  /* ==========================================================================
   * 1. 常量与配置区（CONFIG）
   * ======================================================================== */

  const SCRIPT_VERSION = '3.2.0';

  const SCAN_STATUS = Object.freeze({
    PENDING: 'pending',
    MUTUAL: 'mutual',
    NOT_BACK: 'not_back',
    FAILED: 'failed',
  });

  const CONFIG = Object.freeze({
    DEFAULT_CONCURRENCY: 2,
    MAX_CONCURRENCY: 3,

    MIN_TASK_DELAY_MS: 500,
    MAX_TASK_DELAY_MS: 1500,

    MAX_RETRIES: 3,
    RETRY_BACKOFF_BASE_MS: 1500,

    SCROLL_STEP_RATIO: 0.7,
    MIN_SCROLL_STEP_PX: 260,
    BOTTOM_THRESHOLD_PX: 300,
    IDLE_ROUNDS_TO_STOP: 4,

    PROBE_WINDOW_NAME: 'ufs_profile_probe',
    PROBE_WINDOW_FEATURES: 'width=420,height=640,left=50,top=50,menubar=no,toolbar=no,location=yes,status=no',
    PROBE_POLL_INTERVAL_MS: 300,
    PROBE_MAX_WAIT_MS: 12000,
    PROBE_HARD_TIMEOUT_MS: 22000,

    UNFOLLOW_INTERVAL_MIN_MS: 1000,
    UNFOLLOW_INTERVAL_MAX_MS: 1800,
    UNFOLLOW_CONFIRM_WAIT_MS: 4000,
    UNFOLLOW_VERIFY_WAIT_MS: 5000,
    UNFOLLOW_SEARCH_SCROLL_WAIT_MIN_MS: 700,
    UNFOLLOW_SEARCH_SCROLL_WAIT_MAX_MS: 1300,
    UNFOLLOW_SEARCH_MAX_ROUNDS: 80,

    POST_DATE_INTERVAL_MIN_MS: 1200,
    POST_DATE_INTERVAL_MAX_MS: 2200,
    POST_DATE_PROBE_MAX_WAIT_MS: 16000,
    POST_DATE_EMPTY_GRACE_MS: 4500,
    POST_DATE_HARD_TIMEOUT_MS: 28000,
    DEFAULT_INACTIVE_THRESHOLD_DAYS: 365,
    DEFAULT_RATIO_THRESHOLD: 0.5,

    PANEL_WIDTH_PX: 360,
    PANEL_DEFAULT_TOP_PX: 70,
    PANEL_EDGE_MARGIN_PX: 16,
    PANEL_MIN_VISIBLE_PX: 60,
    DRAG_THRESHOLD_PX: 4,

    HOVER_CARD_WIDTH_PX: 280,
    HOVER_CARD_SHOW_DELAY_MS: 350,
    HOVER_CARD_HIDE_DELAY_MS: 200,

    BLOB_REVOKE_DELAY_MS: 4000,
    STORAGE_VERSION: 'v2',
  });

  const RESERVED_PATH_SEGMENTS = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search',
    'compose', 'logout', 'tos', 'privacy', 'login', 'signup', 'following',
    'followers', 'lists', 'bookmarks', 'communities', 'premium_sign_up',
    'jobs', 'topics', 'moments', 'account', 'download', 'about',
    'verified_followers', 'connect_people',
  ]);

  const SUPPORTED_LIST_PAGE_TYPES = ['following'];

  const LIST_PAGE_TYPE_LABELS = {
    following: '正在关注',
    verified_followers: '已验证的关注者',
  };

  const NOT_FOUND_TITLE_PHRASES = ["doesn't exist", '不存在'];
  const SUSPENDED_TITLE_PHRASES = ['account suspended', '账号已被冻结', '已被暂停'];

  /* ==========================================================================
   * 2. 日志模块（Logger）
   * ======================================================================== */

  const Logger = {
    _style(color) {
      return `color:${color};font-weight:bold;`;
    },
    info(message, ...args) {console.log(`%c[UFS] ${message}`, this._style('#1d9bf0'), ...args);},
    success(message, ...args) {},
    warn(message, ...args) {},
    error(message, ...args) {},
    debug(message, ...args) {},
  };

  /* ==========================================================================
   * 3. 工具函数模块（Utils）
   * ======================================================================== */

  const Utils = {
    sleep(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    },

    randomBetween(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },

    randomDelay(min, max) {
      return Utils.sleep(Utils.randomBetween(min, max));
    },

    generateId() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    },

    isValidUsername(name) {
      return typeof name === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(name);
    },

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

    extractOwnerUsernameFromPath(pathname) {
      const pattern = new RegExp(
        `^\\/([A-Za-z0-9_]{1,15})\\/(?:${SUPPORTED_LIST_PAGE_TYPES.join('|')})\\/?$`, 'i'
      );
      const match = pathname.match(pattern);
      return match ? match[1] : null;
    },

    extractListPageTypeFromPath(pathname) {
      const pattern = new RegExp(
        `^\\/[A-Za-z0-9_]{1,15}\\/(${SUPPORTED_LIST_PAGE_TYPES.join('|')})\\/?$`, 'i'
      );
      const match = pathname.match(pattern);
      return match ? match[1].toLowerCase() : null;
    },

    isSupportedListPagePath(pathname) {
      return Utils.extractOwnerUsernameFromPath(pathname) !== null;
    },

    uniqueArray(array) {
      return Array.from(new Set(array));
    },

    formatDuration(milliseconds) {
      const totalSeconds = Math.floor(milliseconds / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes <= 0) return `${seconds}s`;
      return `${minutes}m${String(seconds).padStart(2, '0')}s`;
    },

    nowTimestamp() {
      return Date.now();
    },

    /**
     * 将包含千分位逗号（如 "1,502"）或 K/M/B 缩写的数量文本转换为数字
     */
    parseNumberText(text) {
      if (!text || typeof text !== 'string') return 0;

      // 1. 去除首尾空白，按空格拆分，优先取第一部分（即包含数字与单位的部分）
      const firstChunk = text.trim().split(/\s+/)[0];
      if (!firstChunk) return 0;

      // 2. 移除千分位逗号并统一转大写
      let clean = firstChunk.replace(/,/g, '').toUpperCase();
      let multiplier = 1;

      // 3. 判断并提取单位 multiplier（支持千、K、万、W、百万、M、亿、B）
      if (clean.endsWith('千') || clean.endsWith('K')) {
        multiplier = 1000;
        clean = clean.slice(0, -1);
      } else if (clean.endsWith('万') || clean.endsWith('W')) {
        multiplier = 10000;
        clean = clean.slice(0, -1);
      } else if (clean.endsWith('百万') || clean.endsWith('M')) {
        multiplier = 1000000;
        clean = clean.endsWith('百万') ? clean.slice(0, -2) : clean.slice(0, -1);
      } else if (clean.endsWith('亿') || clean.endsWith('B')) {
        multiplier = 100000000;
        clean = clean.slice(0, -1);
      }

      // 4. 正则匹配提取纯数字（支持整数与浮点数）
      const match = clean.match(/-?\d+(?:\.\d+)?/);
      if (!match) return 0;

      const num = parseFloat(match[0]);
      return isNaN(num) ? 0 : Math.round(num * multiplier);
    },

    extractDateFromDatetimeAttr(datetimeAttr) {
      if (!datetimeAttr || typeof datetimeAttr !== 'string') return null;
      const match = datetimeAttr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (
        !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
        month < 1 || month > 12 || day < 1 || day > 31
      ) {
        return null;
      }
      return `${match[1]}-${match[2]}-${match[3]}`;
    },

    normalizePostDatetimeAttr(datetimeAttr) {
      if (!datetimeAttr || typeof datetimeAttr !== 'string') return null;
      const trimmed = datetimeAttr.trim();
      if (!Utils.extractDateFromDatetimeAttr(trimmed)) return null;
      if (!/^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(trimmed) && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return null;
      }
      return trimmed;
    },

    daysSince(isoDateString) {
      const datePart = Utils.extractDateFromDatetimeAttr(isoDateString);
      if (!datePart) return null;
      const [year, month, day] = datePart.split('-').map(Number);
      const postUtcMidnight = Date.UTC(year, month - 1, day);
      const now = new Date();
      const todayUtcMidnight = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
      );
      return Math.floor((todayUtcMidnight - postUtcMidnight) / (24 * 60 * 60 * 1000));
    },

    formatRelativeDays(isoDateString) {
      if (!isoDateString) return '无发帖记录';
      const days = Utils.daysSince(isoDateString);
      if (days === null) return '无发帖记录';
      if (days <= 0) return '今天';
      if (days < 30) return `${days}天前`;
      if (days < 365) return `${Math.floor(days / 30)}个月前`;
      return `${(days / 365).toFixed(1)}年前`;
    },

    formatShortDate(isoDateString) {
      return Utils.extractDateFromDatetimeAttr(isoDateString) || '';
    },

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

    debounce(fn, wait) {
      let timerId = null;
      return function debounced(...args) {
        if (timerId) clearTimeout(timerId);
        timerId = setTimeout(() => fn.apply(this, args), wait);
      };
    },

    escapeCsvField(field) {
      const str = String(field ?? '');
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    },

    toCsv(rows) {
      return rows.map((row) => row.map(Utils.escapeCsvField).join(',')).join('\r\n');
    },

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

    clampNumber(value, min, max) {
      return Math.min(Math.max(value, min), max);
    },

    simulateClick(element) {
      if (!element) return;
      const view = (element.ownerDocument && element.ownerDocument.defaultView) || window;
      const eventInit = { bubbles: true, cancelable: true, composed: true, view };
      const dispatch = (eventType, isPointerEvent) => {
        try {
          const EventCtor = isPointerEvent && view.PointerEvent ? view.PointerEvent : view.MouseEvent;
          element.dispatchEvent(new EventCtor(eventType, eventInit));
        } catch (error) {}
      };
      dispatch('pointerdown', true);
      dispatch('mousedown', false);
      dispatch('pointerup', true);
      dispatch('mouseup', false);
      dispatch('click', false);
    },
  };

  /* ==========================================================================
   * 3.5 滚动速度与配置管理器
   * ======================================================================== */

  const SCROLL_SPEED_PRESETS = Object.freeze([
    { label: '很慢', min: 3200, max: 4800 },
    { label: '慢', min: 2400, max: 3600 },
    { label: '标准', min: 1600, max: 2800 },
    { label: '快', min: 1100, max: 1900 },
    { label: '很快（已达安全下限）', min: 900, max: 1500 },
  ]);

  const DEFAULT_SPEED_INDEX = 2;
  const SCROLL_SPEED_STORAGE_KEY = 'ufs_scroll_speed_index_v1';

  const ScrollSpeedManager = {
    presets: SCROLL_SPEED_PRESETS,
    currentIndex: DEFAULT_SPEED_INDEX,

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

    setIndex(index) {
      const clampedIndex = Utils.clampNumber(Math.round(index), 0, this.presets.length - 1);
      this.currentIndex = clampedIndex;
      try {
        GM_setValue(SCROLL_SPEED_STORAGE_KEY, clampedIndex);
      } catch (error) {
        Logger.warn('保存扫描速度设置失败', error);
      }
    },

    getCurrent() {
      return this.presets[this.currentIndex];
    },

    getPresetCount() {
      return this.presets.length;
    },
  };

  const INACTIVE_THRESHOLD_STORAGE_KEY = 'ufs_inactive_threshold_days_v1';

  const InactivityThresholdManager = {
    days: CONFIG.DEFAULT_INACTIVE_THRESHOLD_DAYS,

    load() {
      let savedDays = CONFIG.DEFAULT_INACTIVE_THRESHOLD_DAYS;
      try {
        const raw = GM_getValue(INACTIVE_THRESHOLD_STORAGE_KEY, CONFIG.DEFAULT_INACTIVE_THRESHOLD_DAYS);
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) savedDays = parsed;
      } catch (error) {
        Logger.warn('读取不活跃阈值设置失败，使用默认值', error);
      }
      this.days = savedDays;
    },

    setDays(days) {
      const parsed = Number(days);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      this.days = Math.round(parsed);
      try {
        GM_setValue(INACTIVE_THRESHOLD_STORAGE_KEY, this.days);
      } catch (error) {
        Logger.warn('保存不活跃阈值设置失败', error);
      }
    },

    isInactive(lastPostDate) {
      if (lastPostDate === undefined) return false;
      if (lastPostDate === null) return true;
      const days = Utils.daysSince(lastPostDate);
      return days !== null && days > this.days;
    },
  };

  const WHITELIST_STORAGE_KEY = 'ufs_whitelist_usernames_v1';

  const WhitelistManager = {
    usernames: new Set(),

    load() {
      let saved = [];
      try {
        const raw = GM_getValue(WHITELIST_STORAGE_KEY, '[]');
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) saved = parsed;
      } catch (error) {
        Logger.warn('读取白名单设置失败，使用空白名单', error);
      }
      this.usernames = new Set(saved.map((name) => this.normalize(name)).filter(Boolean));
    },

    save() {
      try {
        GM_setValue(WHITELIST_STORAGE_KEY, JSON.stringify(Array.from(this.usernames)));
      } catch (error) {
        Logger.warn('保存白名单设置失败', error);
      }
    },

    normalize(raw) {
      if (!raw) return '';
      return String(raw).trim().replace(/^@+/, '').toLowerCase();
    },

    setFromText(text) {
      const list = String(text || '')
        .split(/[\r\n]+/)
        .map((line) => this.normalize(line))
        .filter(Boolean);
      this.usernames = new Set(list);
      this.save();
    },

    toText() {
      return Array.from(this.usernames)
        .map((name) => `@${name}`)
        .join('\n');
    },

    has(username) {
      return this.usernames.has(this.normalize(username));
    },

    get size() {
      return this.usernames.size;
    },
  };

  /* ==========================================================================
   * 4. 缓存模块（Storage 类）
   * ======================================================================== */

  class Storage {
    constructor(ownerUsername, pageType = 'following') {
      this.ownerUsername = ownerUsername;
      this.pageType = pageType;
      this.namespace = `ufs_${CONFIG.STORAGE_VERSION}_${ownerUsername.toLowerCase()}_${pageType}`;
    }

    _key(name) {
      return `${this.namespace}_${name}`;
    }

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

    _writeJson(name, value) {
      try {
        GM_setValue(this._key(name), JSON.stringify(value));
      } catch (error) {
        Logger.error(`写入缓存失败: ${name}`, error);
      }
    }

    getFollowingList() {
      return this._readJson('following_list', []);
    }

    saveFollowingList(list) {
      this._writeJson('following_list', Utils.uniqueArray(list));
    }

    getScanResults() {
      return this._readJson('scan_results', {});
    }

    saveScanResults(resultsMap) {
      this._writeJson('scan_results', resultsMap);
    }

    saveScanResult(username, resultEntry) {
      const all = this.getScanResults();
      all[username] = resultEntry;
      this.saveScanResults(all);
    }

    getMeta() {
      return this._readJson('meta', {
        startedAt: null, updatedAt: null, scannedCount: 0, totalCount: 0, elapsedMs: 0,
      });
    }

    saveMeta(meta) {
      this._writeJson('meta', meta);
    }

    getPendingUnfollowQueue() {
      return this._readJson('pending_unfollow_queue', []);
    }

    savePendingUnfollowQueue(usernames) {
      this._writeJson('pending_unfollow_queue', usernames);
    }

    getPendingPostDateQueue() {
      return this._readJson('pending_postdate_queue', []);
    }

    savePendingPostDateQueue(usernames) {
      this._writeJson('pending_postdate_queue', usernames);
    }

    clearAll() {
      this._writeJson('following_list', []);
      this._writeJson('scan_results', {});
      this._writeJson('meta', { startedAt: null, updatedAt: null, scannedCount: 0, totalCount: 0, elapsedMs: 0 });
      this._writeJson('pending_unfollow_queue', []);
      this._writeJson('pending_postdate_queue', []);
    }
  }

  /* ==========================================================================
   * 5. DOM 解析模块（Parser 类）
   * ======================================================================== */

  class Parser {
    static isSupportedListPage() {
      return Utils.isSupportedListPagePath(location.pathname);
    }

    static getOwnerUsernameFromCurrentUrl() {
      return Utils.extractOwnerUsernameFromPath(location.pathname);
    }

    static getListPageTypeFromCurrentUrl() {
      return Utils.extractListPageTypeFromPath(location.pathname);
    }

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

    static extractProfileSummaryFromCell(cellElement) {
      const avatarImg = cellElement.querySelector('img[src]');
      const avatarUrl = avatarImg ? avatarImg.getAttribute('src') : null;

      const verifiedBadge = cellElement.querySelector(
        '[data-testid="icon-verified"], svg[aria-label*="认证"], svg[aria-label*="Verified" i]'
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

      let displayName = username || '';
      let foundNameViaStructure = false;
      if (usernameAnchor) {
        const nameContainer = usernameAnchor.querySelector('div[dir="ltr"]');
        if (nameContainer) {
          const text = (nameContainer.textContent || '').trim();
          if (text) {
            displayName = text;
            foundNameViaStructure = true;
          }
        }
      }
      if (!foundNameViaStructure) {
        const atHandle = username ? `@${username}` : null;
        const allSpans = cellElement.querySelectorAll('span');
        for (const span of allSpans) {
          const text = (span.textContent || '').trim();
          if (!text) continue;
          if (text.startsWith('@')) continue;
          if (atHandle && text === atHandle) continue;
          if (text.length > 50) continue;
          displayName = text;
          break;
        }
      }

      let bio = '';
      let longestLength = 0;
      const bioCandidates = cellElement.querySelectorAll('div[dir="auto"], span[dir="auto"]');
      bioCandidates.forEach((node) => {
        if (usernameAnchor && usernameAnchor.contains(node)) return;
        const text = (node.textContent || '').trim();
        if (text.length >= 8 && text.length > longestLength) {
          longestLength = text.length;
          bio = text;
        }
      });

      return { username, avatarUrl, displayName, isVerified, bio };
    }

    static cellHasFollowBackBadge(cellElement) {
      return Boolean(cellElement.querySelector('[data-testid="userFollowIndicator"]'));
    }

    static isAccountSuspended(doc = document) {
      const title = (doc.title || '').toLowerCase();
      return SUSPENDED_TITLE_PHRASES.some((phrase) => title.includes(phrase.toLowerCase()));
    }

    static isProfileNotFound(doc = document) {
      const title = (doc.title || '').toLowerCase();
      return NOT_FOUND_TITLE_PHRASES.some((phrase) => title.includes(phrase.toLowerCase()));
    }

    static isProfileRendered(doc = document) {
      return Boolean(
        doc.querySelector('[data-testid="UserName"]') ||
        doc.querySelector('[data-testid$="-follow"]') ||
        doc.querySelector('[data-testid$="-unfollow"]') ||
        doc.querySelector('[data-testid="UserProfileHeader_Items"]')
      );
    }

    static detectFollowBadgeInProfile(doc = document) {
      return Boolean(doc.querySelector('[data-testid="userFollowIndicator"]'));
    }

    /**
     * 从目标主页 DOM 提取 Followers 与 Following 并计算比例
     */
    static extractFollowerStats(doc = document) {
      let following = 0;
      let followers = 0;

      const followingAnchor = doc.querySelector('a[href$="/following"]');
      if (followingAnchor) {
        following = Utils.parseNumberText(followingAnchor.textContent || '');
      }

      const followerAnchor = doc.querySelector('a[href$="/verified_followers"], a[href$="/followers"]');
      if (followerAnchor) {
        followers = Utils.parseNumberText(followerAnchor.textContent || '');
      }

      const ratio = following > 0 ? (followers / following) : 0;
      return { followers, following, ratio };
    }

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
          return { status: SCAN_STATUS.NOT_BACK, reason: 'dom_rendered_no_badge' };
        }
        await Utils.sleep(CONFIG.PROBE_POLL_INTERVAL_MS);
      }
      return { status: SCAN_STATUS.FAILED, reason: 'timeout' };
    }

    static readTimeDatetimeAttr(timeEl) {
      if (!timeEl || !timeEl.getAttribute) return null;
      return Utils.normalizePostDatetimeAttr(timeEl.getAttribute('datetime'));
    }

    static isPinnedTweet(article) {
      if (!article) return false;

      const socialContexts = article.querySelectorAll('[data-testid="socialContext"]');
      for (const ctx of socialContexts) {
        const text = (ctx.textContent || '').trim();
        if (!text) continue;
        if (/pinned|置顶|ピン留め|ピン止め/i.test(text)) {
          return true;
        }
      }

      const pinIcon = article.querySelector(
        'svg[aria-label*="置顶" i], svg[aria-label*="Pinned" i], svg[aria-label*="ピン" i]'
      );
      if (pinIcon) return true;

      return false;
    }

    static findLatestPostTimeElement(doc = document) {
      const articles = doc.querySelectorAll(
        'article[data-testid="tweet"], article[role="article"]'
      );
      for (const article of articles) {
        if (Parser.isPinnedTweet(article)) continue;

        const userNameBlock = article.querySelector('[data-testid="User-Name"]');
        if (userNameBlock) {
          const statusTime = userNameBlock.querySelector(
            'a[href*="/status/"] time[datetime]'
          );
          if (Parser.readTimeDatetimeAttr(statusTime)) return statusTime;
          const anyTimeInName = userNameBlock.querySelector('time[datetime]');
          if (Parser.readTimeDatetimeAttr(anyTimeInName)) return anyTimeInName;
        }

        const statusTime = article.querySelector('a[href*="/status/"] time[datetime]');
        if (Parser.readTimeDatetimeAttr(statusTime)) return statusTime;

        const anyTime = article.querySelector('time[datetime]');
        if (Parser.readTimeDatetimeAttr(anyTime)) return anyTime;
      }

      const statusTimes = doc.querySelectorAll('a[href*="/status/"] time[datetime]');
      for (const timeEl of statusTimes) {
        if (!Parser.readTimeDatetimeAttr(timeEl)) continue;
        const parentArticle = timeEl.closest('article');
        if (parentArticle && Parser.isPinnedTweet(parentArticle)) continue;
        return timeEl;
      }
      return null;
    }

    static isEmptyTimeline(doc = document) {
      if (doc.querySelector('article[data-testid="tweet"], article[role="article"]')) {
        return false;
      }
      if (doc.querySelector('a[href*="/status/"] time[datetime]')) {
        return false;
      }

      const emptyPhrases = [
        "hasn't posted", "doesn't have any posts", 'no posts yet', "hasn't Tweeted",
        '还没有发过', '尚未发布', '还没有帖子', '这些帖子受到保护',
        'these posts are protected', 'posts are protected', 'trying to view posts that are protected',
      ];

      const candidates = doc.querySelectorAll(
        '[data-testid="emptyState"], [data-testid="primaryColumn"] [role="heading"], [data-testid="primaryColumn"] span'
      );
      for (const node of candidates) {
        const text = (node.textContent || '').trim().toLowerCase();
        if (!text || text.length > 200) continue;
        if (emptyPhrases.some((phrase) => text.includes(phrase.toLowerCase()))) {
          return true;
        }
      }
      return false;
    }

    /**
     * 轮询等待对方主页时间线渲染，同时提取最新推文日期与粉丝/关注比列 stats
     */
    static async waitAndDetectLatestPostDate(doc = document) {
      const startedAt = Date.now();
      let profileReadySince = null;

      while (Date.now() - startedAt < CONFIG.POST_DATE_PROBE_MAX_WAIT_MS) {
        if (Parser.isAccountSuspended(doc)) {
          return { success: false, reason: 'suspended' };
        }
        if (Parser.isProfileNotFound(doc)) {
          return { success: false, reason: 'not_found' };
        }

        const stats = Parser.extractFollowerStats(doc);
        const timeEl = Parser.findLatestPostTimeElement(doc);
        const datetime = Parser.readTimeDatetimeAttr(timeEl);

        if (datetime) {
          return { success: true, lastPostDate: datetime, ...stats };
        }

        if (Parser.isEmptyTimeline(doc)) {
          return { success: true, lastPostDate: null, ...stats };
        }

        if (Parser.isProfileRendered(doc)) {
          if (profileReadySince === null) profileReadySince = Date.now();
          if (Date.now() - profileReadySince >= CONFIG.POST_DATE_EMPTY_GRACE_MS) {
            return { success: true, lastPostDate: null, ...stats };
          }
        }

        await Utils.sleep(CONFIG.PROBE_POLL_INTERVAL_MS);
      }
      return { success: false, reason: 'timeout' };
    }

    static findUnfollowButton(container) {
      return container.querySelector('[data-testid$="-unfollow"]');
    }

    static isFollowButton(button) {
      const testId = (button && button.getAttribute('data-testid')) || '';
      return testId.endsWith('-follow') && !testId.endsWith('-unfollow');
    }

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

    static async clickUnfollowButtonAndVerify(button) {
      const ownerDoc = button.ownerDocument || document;
      const usernameHint = button.getAttribute('aria-label') || button.getAttribute('data-testid') || '';
      Logger.debug(`点击取消关注按钮: ${usernameHint}`);
      Utils.simulateClick(button);

      const confirmButton = await Utils.waitFor(
        () => Parser.findUnfollowConfirmButton(ownerDoc),
        { timeout: CONFIG.UNFOLLOW_CONFIRM_WAIT_MS, interval: 150 }
      );
      if (confirmButton) {
        Logger.debug('检测到二次确认弹窗，点击确认');
        Utils.simulateClick(confirmButton);
      }

      const succeeded = await Utils.waitFor(() => {
        if (!ownerDoc.contains(button)) return true;
        return Parser.isFollowButton(button);
      }, { timeout: CONFIG.UNFOLLOW_VERIFY_WAIT_MS, interval: 200 });

      return Boolean(succeeded);
    }
  }

  /* ==========================================================================
   * 6. 任务队列模块（TaskQueue 类）
   * ======================================================================== */

  class TaskQueue {
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

    addTask(taskFn) {
      this.tasks.push(taskFn);
      this.totalCount += 1;
    }

    addTasks(taskFns) {
      taskFns.forEach((fn) => this.addTask(fn));
    }

    pause() {
      this.isPaused = true;
    }

    resume() {
      if (!this.isPaused) return;
      this.isPaused = false;
      this._pump();
    }

    cancel() {
      this.isCancelled = true;
      this.tasks = [];
    }

    async run() {
      this._idlePromise = new Promise((resolve) => {
        this._resolveIdle = resolve;
      });
      this._pump();
      await this._idlePromise;
    }

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

    _checkIdle() {
      if (this.tasks.length === 0 && this.activeCount === 0 && this._resolveIdle) {
        const resolveFn = this._resolveIdle;
        this._resolveIdle = null;
        resolveFn();
      }
    }
  }

  /* ==========================================================================
   * 7. 主页探测模块（Prober 类）
   * ======================================================================== */

  class Prober {
    constructor() {
      this._probeWindow = null;
      this._popupBlockedWarned = false;
    }

    hasOpenProbeWindow() {
      try {
        return Boolean(this._probeWindow && !this._probeWindow.closed);
      } catch (error) {
        this._probeWindow = null;
        return false;
      }
    }

    _ensureProbeWindow(initialUrl = null) {
      try {
        if (this._probeWindow && !this._probeWindow.closed) {
          return this._probeWindow;
        }
      } catch (error) {
        this._probeWindow = null;
      }

      const openUrl = initialUrl || 'about:blank';
      let win = null;
      try {
        win = window.open(
          openUrl,
          CONFIG.PROBE_WINDOW_NAME,
          CONFIG.PROBE_WINDOW_FEATURES
        );
      } catch (error) {
        win = null;
      }

      if (!win) {
        if (!this._popupBlockedWarned) {
          this._popupBlockedWarned = true;
          Logger.error('探测弹窗被浏览器拦截。请允许 x.com 弹窗。');
        }
        this._probeWindow = null;
        return null;
      }

      this._probeWindow = win;
      try {
        win.resizeTo(420, 640);
        win.moveTo(0, 0);
        win.blur();
        window.focus();
      } catch (error) {}
      return win;
    }

    prepareProbeWindow(username = null) {
      const initialUrl = username
        ? `${location.origin}/${encodeURIComponent(username)}`
        : null;
      return this._ensureProbeWindow(initialUrl);
    }

    closeProbeWindow() {
      try {
        if (this._probeWindow && !this._probeWindow.closed) {
          this._probeWindow.close();
        }
      } catch (error) {}
      this._probeWindow = null;
    }

    _diagnoseProbeWindow(win) {
      try {
        if (!win || win.closed) return 'popup_closed';
        const doc = win.document;
        if (!doc) return 'popup_inaccessible';
        const href = (win.location && win.location.href) || '';
        if (!href || href === 'about:blank') return 'popup_about_blank';
        if (!doc.body) return 'popup_no_body';
        const textLen = (doc.body.textContent || '').trim().length;
        if (textLen < 20) return 'popup_empty';
        return 'hard_timeout';
      } catch (error) {
        return 'popup_inaccessible';
      }
    }

    _isOnUserProfile(win, username) {
      try {
        const href = win.location.href || '';
        if (!href || href === 'about:blank') return false;
        const path = (win.location.pathname || '').toLowerCase();
        const target = `/${String(username).toLowerCase()}`;
        return path === target || path.startsWith(`${target}/`);
      } catch (error) {
        return false;
      }
    }

    _withProfileDocument(username, detectFn, hardTimeoutMs = CONFIG.PROBE_HARD_TIMEOUT_MS) {
      return new Promise((resolve) => {
        const win = this._ensureProbeWindow();
        if (!win) {
          resolve({
            success: false,
            status: SCAN_STATUS.FAILED,
            reason: 'popup_blocked',
          });
          return;
        }

        const targetUrl = `${location.origin}/${encodeURIComponent(username)}`;
        let settled = false;
        let detectStarted = false;
        let hardTimerId = null;
        let accessPollId = null;
        let navGeneration = 0;

        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (hardTimerId) clearTimeout(hardTimerId);
          if (accessPollId) clearInterval(accessPollId);
          resolve(result);
        };

        hardTimerId = setTimeout(() => {
          const reason = this._diagnoseProbeWindow(win);
          finish({
            success: false,
            status: SCAN_STATUS.FAILED,
            reason,
          });
        }, hardTimeoutMs);

        const tryStartDetect = () => {
          if (settled || detectStarted) return;
          try {
            if (!win || win.closed) {
              finish({ success: false, status: SCAN_STATUS.FAILED, reason: 'popup_closed' });
              return;
            }
          } catch (error) {
            finish({ success: false, status: SCAN_STATUS.FAILED, reason: 'popup_closed' });
            return;
          }

          let doc;
          try {
            doc = win.document;
          } catch (error) {
            return;
          }
          if (!doc || !doc.documentElement) return;
          if (!this._isOnUserProfile(win, username)) return;

          detectStarted = true;
          if (accessPollId) {
            clearInterval(accessPollId);
            accessPollId = null;
          }

          try {
            win.blur();
            window.focus();
          } catch (error) {}

          const myGen = navGeneration;
          Promise.resolve()
            .then(() => detectFn(doc))
            .then((result) => {
              if (settled || myGen !== navGeneration) return;
              if (!result || typeof result !== 'object') {
                finish({ success: false, reason: 'empty_result' });
                return;
              }
              finish(result);
            })
            .catch((error) => {
              if (settled || myGen !== navGeneration) return;
              finish({ success: false, status: SCAN_STATUS.FAILED, reason: 'exception' });
            });
        };

        accessPollId = setInterval(tryStartDetect, CONFIG.PROBE_POLL_INTERVAL_MS);

        try {
          navGeneration += 1;
          detectStarted = false;
          win.location.href = targetUrl;
        } catch (error) {
          finish({ success: false, status: SCAN_STATUS.FAILED, reason: 'popup_navigate_failed' });
          return;
        }

        tryStartDetect();
      });
    }

    probeUser(username) {
      return this._withProfileDocument(
        username,
        (doc) => Parser.waitAndDetectFollowState(doc),
        CONFIG.PROBE_HARD_TIMEOUT_MS
      );
    }

    requestUnfollow(username) {
      return this._withProfileDocument(
        username,
        (doc) => performUnfollowInDocument(doc),
        CONFIG.PROBE_HARD_TIMEOUT_MS
      );
    }

    requestLastPostDate(username) {
      return this._withProfileDocument(
        username,
        (doc) => Parser.waitAndDetectLatestPostDate(doc),
        CONFIG.POST_DATE_HARD_TIMEOUT_MS
      );
    }
  }

  async function performUnfollowInDocument(doc = document) {
    if (Parser.isAccountSuspended(doc)) {
      return { success: false, reason: 'suspended' };
    }
    if (Parser.isProfileNotFound(doc)) {
      return { success: false, reason: 'not_found' };
    }
    const button = await Utils.waitFor(
      () => Parser.findUnfollowButton(doc),
      { timeout: CONFIG.PROBE_MAX_WAIT_MS, interval: CONFIG.PROBE_POLL_INTERVAL_MS }
    );
    if (!button) {
      return { success: true, reason: 'already_not_following' };
    }
    const succeeded = await Parser.clickUnfollowButtonAndVerify(button);
    return { success: succeeded, reason: succeeded ? 'ok' : 'verify_timeout' };
  }

  async function respondToProbeIfNeeded() {
    if (window.self !== window.top) {
      return true;
    }
    return false;
  }

  /* ==========================================================================
   * 8. 扫描调度模块（Scanner 类）
   * ======================================================================== */

  class Scanner {
    constructor(deps) {
      this.ownerUsername = deps.ownerUsername;
      this.pageType = deps.pageType || 'following';
      this.storage = deps.storage;
      this.panel = deps.panel;
      this.prober = new Prober();
      this.manualRescanQueue = new TaskQueue({ concurrency: CONFIG.DEFAULT_CONCURRENCY });
      this.followingList = [];
      this.scanResults = {};
      this.startTime = null;
      this.hasStarted = false;
      this.isScanning = false;
      this.isPaused = false;
      this._resumeResolve = null;
      this._scanGeneration = 0;

      this.unfollowQueue = [];
      this.isUnfollowing = false;
      this._unfollowGeneration = 0;
      this._unfollowProbePrepared = false;
      this._unfollowRescanAlertShown = false;

      this.postDateQueue = [];
      this.isCollectingPostDates = false;
      this._postDateGeneration = 0;
      this._postDateOnComplete = null;
    }

    loadFromCache() {
      this.followingList = this.storage.getFollowingList();
      this.scanResults = this.storage.getScanResults();
      this.unfollowQueue = this.storage.getPendingUnfollowQueue();
      this.postDateQueue = this.storage.getPendingPostDateQueue();
    }

    async start() {
      this.hasStarted = true;
      this.startTime = Utils.nowTimestamp();
      this.isScanning = true;
      this.panel.setStatus('scanning');
      await Utils.waitFor(() => Parser.findUserCells(document).length > 0, {
        timeout: 8000, interval: 300,
      });
      await this.scrollAndDetect();
      this.isScanning = false;
      this._finishScan();
    }

    async scrollAndDetect() {
      const myGeneration = ++this._scanGeneration;
      const collectedUsernames = new Set(this.followingList);

      let idleRounds = 0;
      let lastProcessedCount = Object.keys(this.scanResults).length;
      let lastScrollHeight = document.documentElement.scrollHeight;

      while (idleRounds < CONFIG.IDLE_ROUNDS_TO_STOP && myGeneration === this._scanGeneration) {
        await this._waitWhilePaused();
        if (myGeneration !== this._scanGeneration) break;

        const cells = Parser.findUserCells(document);
        for (const cell of cells) {
          const username = Parser.extractUsernameFromCell(cell);
          if (!username) continue;
          if (WhitelistManager.has(username)) continue;
          collectedUsernames.add(username);

          const existingEntry = this.scanResults[username];
          const alreadyConfirmedMutual = Boolean(existingEntry && existingEntry.status === SCAN_STATUS.MUTUAL);
          const needsProfileCapture = !existingEntry || !existingEntry.profile;

          if (alreadyConfirmedMutual) {
            if (needsProfileCapture) {
              this.scanResults[username] = {
                ...existingEntry,
                profile: Parser.extractProfileSummaryFromCell(cell),
              };
            }
            continue;
          }

          const hasFollowBackBadge = Parser.cellHasFollowBackBadge(cell);
          const profile = needsProfileCapture
            ? Parser.extractProfileSummaryFromCell(cell)
            : existingEntry.profile;
          this.scanResults[username] = {
            ...existingEntry,
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
          break;
        }

        if (!atBottom) {
          const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
          const scrollStepPx = Math.max(
            CONFIG.MIN_SCROLL_STEP_PX,
            Math.floor(viewportHeight * CONFIG.SCROLL_STEP_RATIO)
          );
          window.scrollBy(0, scrollStepPx);
        }
        const currentSpeed = ScrollSpeedManager.getCurrent();
        await Utils.randomDelay(currentSpeed.min, currentSpeed.max);
      }
    }

    _isPageScrolledToBottom() {
      const scrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const fullHeight = document.documentElement.scrollHeight;
      return scrollY + viewportHeight >= fullHeight - CONFIG.BOTTOM_THRESHOLD_PX;
    }

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
    }

    async rescanUser(username) {
      if (WhitelistManager.has(username)) return;

      const cell = this._findCellForUsername(username);
      if (cell) {
        const hasFollowBackBadge = Parser.cellHasFollowBackBadge(cell);
        const existingEntry = this.scanResults[username] || {};
        this.scanResults[username] = {
          ...existingEntry,
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

      await new Promise((resolve) => {
        this.manualRescanQueue.addTask(async () => {
          let retryCount = 0;
          let result;
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
                await Utils.sleep(CONFIG.RETRY_BACKOFF_BASE_MS * retryCount);
                continue;
              }
            }
            break;
          }
          const existingEntry = this.scanResults[username] || {};
          this.scanResults[username] = {
            ...existingEntry,
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

    isOnMatchingListPage() {
      return (
        Parser.getOwnerUsernameFromCurrentUrl()?.toLowerCase() === this.ownerUsername.toLowerCase() &&
        Parser.getListPageTypeFromCurrentUrl() === this.pageType
      );
    }

    enqueueUnfollow(usernames, options = {}) {
      if (!usernames || usernames.length === 0) return;

      if (!this.hasStarted) {
        window.alert('请先点击「开始扫描」完整加载关注列表后，再执行取消关注。');
        return;
      }

      if (!this.isOnMatchingListPage() && !this.prober.hasOpenProbeWindow()) {
        window.alert('无法直接取消关注：当前不在对应的关注列表页面。');
        return;
      }

      if (this.isScanning && !this.isPaused) {
        this.pause();
      }
      if (options.preparedByUserGesture) {
        this._unfollowProbePrepared = true;
      }
      const merged = Utils.uniqueArray([...this.unfollowQueue, ...usernames]);
      this.unfollowQueue = merged;
      this.storage.savePendingUnfollowQueue(this.unfollowQueue);
      this.panel.setUnfollowProgress(this.unfollowQueue.length, null);
      if (!this.isUnfollowing) {
        this._processUnfollowQueue().catch((error) => Logger.error('批量取消关注流程异常', error));
      }
    }

    stopUnfollowQueue() {
      this._unfollowGeneration += 1;
      this.isUnfollowing = false;
      this.unfollowQueue = [];
      this.storage.savePendingUnfollowQueue([]);
      this._unfollowProbePrepared = false;
      this.prober.closeProbeWindow();
      this.panel.hideUnfollowProgress();
    }

    _alertUnfollowNeedsListOrRescan(username, reason) {
      if (this._unfollowRescanAlertShown) return;
      this._unfollowRescanAlertShown = true;
      window.alert(`取消关注 @${username} 未成功。`);
    }

    async _processUnfollowQueue() {
      if (this.isUnfollowing) return;
      this.isUnfollowing = true;
      const myGeneration = ++this._unfollowGeneration;
      this._unfollowRescanAlertShown = false;

      while (this.unfollowQueue.length > 0 && myGeneration === this._unfollowGeneration) {
        const username = this.unfollowQueue[0];
        this.panel.setUnfollowProgress(this.unfollowQueue.length, username);

        const success = await this._performUnfollow(username, myGeneration);
        if (myGeneration !== this._unfollowGeneration) break;

        this.unfollowQueue.shift();
        this.storage.savePendingUnfollowQueue(this.unfollowQueue);

        if (success) {
          delete this.scanResults[username];
          this.followingList = this.followingList.filter((name) => name !== username);
          this.storage.saveFollowingList(this.followingList);
          this.storage.saveScanResults(this.scanResults);
          this.panel.renderList(this.getAllRows());
        }

        if (this.unfollowQueue.length === 0 || myGeneration !== this._unfollowGeneration) break;
        await Utils.randomDelay(CONFIG.UNFOLLOW_INTERVAL_MIN_MS, CONFIG.UNFOLLOW_INTERVAL_MAX_MS);
      }

      this.isUnfollowing = false;
      if (myGeneration === this._unfollowGeneration) {
        this._unfollowProbePrepared = false;
        this.prober.closeProbeWindow();
        this.panel.hideUnfollowProgress();
      }
    }

    enqueuePostDateCollection(usernames, options = {}) {
      if (!usernames || usernames.length === 0) {
        if (typeof options.onComplete === 'function') {
          try { options.onComplete(); } catch (error) {}
        }
        return;
      }
      if (typeof options.onComplete === 'function') {
        this._postDateOnComplete = options.onComplete;
      }
      const alreadyCollected = new Set(
        Object.keys(this.scanResults).filter((name) => this.scanResults[name].lastPostDate !== undefined)
      );
      const targets = usernames.filter((name) => !alreadyCollected.has(name));
      if (targets.length === 0) {
        this._invokePostDateOnComplete();
        return;
      }
      const merged = Utils.uniqueArray([...this.postDateQueue, ...targets]);
      this.postDateQueue = merged;
      this.storage.savePendingPostDateQueue(this.postDateQueue);
      this.panel.setPostDateProgress(this.postDateQueue.length, null);
      if (!this.isCollectingPostDates) {
        this._processPostDateQueue().catch((error) => Logger.error('批量获取发帖日期流程异常', error));
      }
    }

    _invokePostDateOnComplete() {
      const callback = this._postDateOnComplete;
      this._postDateOnComplete = null;
      if (typeof callback !== 'function') return;
      try {
        callback();
      } catch (error) {}
    }

    clearPostDateOnComplete() {
      this._postDateOnComplete = null;
    }

    stopPostDateQueue() {
      this._postDateGeneration += 1;
      this.isCollectingPostDates = false;
      this.postDateQueue = [];
      this.storage.savePendingPostDateQueue([]);
      this._postDateOnComplete = null;
      if (this.panel) this.panel.cancelAwaitingInactiveSelect();
      this.panel.hidePostDateProgress();
      this.prober.closeProbeWindow();
    }

    resumePostDateCollection() {
      if (!this.postDateQueue || this.postDateQueue.length === 0) return false;
      this.panel.setPostDateProgress(this.postDateQueue.length, null);
      if (!this.isCollectingPostDates) {
        this._processPostDateQueue().catch((error) => Logger.error('批量获取发帖日期流程异常', error));
      }
      return true;
    }

    /**
     * 批量获取发帖日期与 followers/following 比例
     */
    async _processPostDateQueue() {
      if (this.isCollectingPostDates) return;
      this.isCollectingPostDates = true;
      const myGeneration = ++this._postDateGeneration;
      let consecutivePopupBlocks = 0;

      try {
        while (this.postDateQueue.length > 0 && myGeneration === this._postDateGeneration) {
          const username = this.postDateQueue[0];
          this.panel.setPostDateProgress(this.postDateQueue.length, username);

          await Utils.randomDelay(CONFIG.POST_DATE_INTERVAL_MIN_MS, CONFIG.POST_DATE_INTERVAL_MAX_MS);
          if (myGeneration !== this._postDateGeneration) break;

          let result;
          try {
            result = await this.prober.requestLastPostDate(username);
          } catch (error) {
            result = { success: false, reason: 'exception' };
          }
          if (myGeneration !== this._postDateGeneration) break;

          if (result && result.reason === 'popup_blocked') {
            consecutivePopupBlocks += 1;
            break;
          }
          consecutivePopupBlocks = 0;

          this.postDateQueue.shift();
          this.storage.savePendingPostDateQueue(this.postDateQueue);

          if (result && result.success) {
            const existingEntry = this.scanResults[username] || { status: SCAN_STATUS.PENDING, reason: '' };
            const normalized = result.lastPostDate
              ? Utils.normalizePostDatetimeAttr(result.lastPostDate)
              : null;

            // 绑定提取到的粉丝数、关注数和比例
            this.scanResults[username] = {
              ...existingEntry,
              lastPostDate: normalized,
              followers: result.followers ?? existingEntry.followers,
              following: result.following ?? existingEntry.following,
              ratio: result.ratio ?? existingEntry.ratio,
            };
            this.storage.saveScanResult(username, this.scanResults[username]);
            this.panel.renderList(this.getAllRows());
          }

          if (this.postDateQueue.length === 0 || myGeneration !== this._postDateGeneration) break;
        }
      } finally {
        this.isCollectingPostDates = false;
      }

      if (myGeneration === this._postDateGeneration) {
        this.panel.hidePostDateProgress();
        this.prober.closeProbeWindow();
        if (this.postDateQueue.length === 0) {
          this._invokePostDateOnComplete();
        } else if (consecutivePopupBlocks > 0) {
          this._postDateOnComplete = null;
          if (this.panel) this.panel.cancelAwaitingInactiveSelect();
        }
      }
    }

    async _performUnfollow(username, expectedGeneration) {
      const isStillOnMatchingPage = this.isOnMatchingListPage();
      let listPathFailedReason = null;

      if (isStillOnMatchingPage) {
        let cell = this._findCellForUsername(username);
        if (!cell) {
          this.panel.setUnfollowProgress(this.unfollowQueue.length, `${username}（滚动定位中...）`);
          cell = await this._scrollToFindCell(username, expectedGeneration);
        }

        if (expectedGeneration !== this._unfollowGeneration) return false;

        if (cell) {
          const button = Parser.findUnfollowButton(cell);
          if (button) {
            this.panel.setUnfollowProgress(this.unfollowQueue.length, `${username}（点击中...）`);
            const success = await Parser.clickUnfollowButtonAndVerify(button);
            if (success) return true;
            listPathFailedReason = 'list_click_verify_failed';
          } else {
            listPathFailedReason = 'list_no_unfollow_button';
          }
        } else {
          listPathFailedReason = 'list_cell_not_found';
        }
      } else {
        listPathFailedReason = 'not_on_list_page';
      }

      if (expectedGeneration !== this._unfollowGeneration) return false;

      const canUseProbeFallback =
        this._unfollowProbePrepared || this.prober.hasOpenProbeWindow();

      if (!canUseProbeFallback) {
        this._alertUnfollowNeedsListOrRescan(username, listPathFailedReason || 'no_probe_window');
        return false;
      }

      this.panel.setUnfollowProgress(this.unfollowQueue.length, `${username}（弹窗兜底处理中...）`);
      try {
        const result = await this.prober.requestUnfollow(username);
        if (result && result.success) return true;

        const reason = (result && result.reason) || listPathFailedReason || 'unknown';
        const blankLikeReasons = new Set([
          'popup_about_blank', 'popup_blocked', 'popup_closed',
          'popup_navigate_failed', 'popup_inaccessible', 'popup_empty', 'hard_timeout',
        ]);
        if (blankLikeReasons.has(reason) || reason === 'list_cell_not_found' || reason === 'not_on_list_page') {
          this.prober.closeProbeWindow();
          this._unfollowProbePrepared = false;
          this._alertUnfollowNeedsListOrRescan(username, reason);
        }
        return false;
      } catch (error) {
        this.prober.closeProbeWindow();
        this._unfollowProbePrepared = false;
        this._alertUnfollowNeedsListOrRescan(username, 'exception');
        return false;
      }
    }

    async _scrollToFindCell(username, expectedGeneration) {
      window.scrollTo(0, 0);
      await Utils.sleep(CONFIG.UNFOLLOW_SEARCH_SCROLL_WAIT_MIN_MS);

      let lastScrollHeight = -1;
      let stableRounds = 0;

      for (let round = 0; round < CONFIG.UNFOLLOW_SEARCH_MAX_ROUNDS; round += 1) {
        if (expectedGeneration !== this._unfollowGeneration) return null;

        const cell = this._findCellForUsername(username);
        if (cell) return cell;

        const currentScrollHeight = document.documentElement.scrollHeight;
        const atBottom = this._isPageScrolledToBottom();
        if (currentScrollHeight === lastScrollHeight && atBottom) {
          stableRounds += 1;
          if (stableRounds >= 2) return null;
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

    pause() {
      this.isPaused = true;
      this.panel.setStatus('paused');
    }

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

    async _waitWhilePaused() {
      while (this.isPaused) {
        await new Promise((resolve) => {
          this._resumeResolve = resolve;
        });
      }
    }

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

    getAllRows() {
      return this.followingList
        .filter((username) => !WhitelistManager.has(username))
        .map((username) => {
          const entry = this.scanResults[username] || { status: SCAN_STATUS.PENDING, reason: '' };
          return {
            username,
            status: entry.status,
            reason: entry.reason || '',
            profile: entry.profile || null,
            lastPostDate: entry.lastPostDate,
            followers: entry.followers,
            following: entry.following,
            ratio: entry.ratio,
          };
        });
    }

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
   * 9. 面板模块（Panel 类）
   * ======================================================================== */

  class Panel {
    constructor() {
      this.scanner = null;
      this.isCollapsed = false;
      this.searchKeyword = '';
      this.sortAscending = true;
      this.activeTab = 'not_back';
      this.rows = [];
      this.selectedUsernames = new Set();
      this._awaitingInactiveSelect = false;
      this._dragState = null;
      this._lastDragWasMove = false;
      this._hoverShowTimer = null;
      this._hoverHideTimer = null;

      this._injectStyles();
      this._buildSkeleton();
      this._buildHoverCard();
      this._buildWhitelistModal();
      this._bindStaticEvents();
      this._bindDragEvents();
      this._applyInitialPosition();
      this._initSpeedControl();

      this.elements.inactiveThresholdInput.value = String(InactivityThresholdManager.days);
      this._updateWhitelistBtnLabel();
      this._onWindowResize = Utils.debounce(() => this._reclampToViewport(), 200);
      window.addEventListener('resize', this._onWindowResize);
    }

    bindScanner(scanner) {
      this.scanner = scanner;
    }

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
        #ufs-panel .ufs-icon-btn:hover { background: #2f3336; color: #000; }
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
          display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 0 10px 8px;
          font-size: 11px; color: #8b98a5; flex-wrap: nowrap;
        }
        #ufs-panel .ufs-select-all-label {
          display: flex; align-items: center; gap: 2px; cursor: pointer;
          white-space: nowrap; flex-shrink: 0; font-size: 11px;
        }
        #ufs-panel .ufs-select-all-label input { accent-color: #1d9bf0; cursor: pointer; margin: 0 2px 0 0; }
        #ufs-panel .ufs-select-all-label input:disabled { cursor: not-allowed; opacity: 0.5; }
        #ufs-panel .ufs-batch-row .ufs-btn.ufs-btn-danger {
          flex-shrink: 0; white-space: nowrap; padding: 4px 8px; font-size: 11px; margin-left: auto;
        }
        #ufs-panel .ufs-btn.ufs-btn-danger { background: #f4212e; color: #fff; }
        #ufs-panel .ufs-btn.ufs-btn-danger:hover { background: #d81b25; }
        #ufs-panel .ufs-btn.ufs-btn-danger:disabled { background: #4a2226; color: #a98488; opacity: 1; }
        #ufs-panel .ufs-unfollow-progress {
          display: flex; align-items: center; gap: 8px; padding: 6px 12px; margin: 0 12px 8px;
          background: #2a1416; border: 1px solid #5a2a2e; border-radius: 8px;
          font-size: 11px; color: #ff8a8a;
        }
        #ufs-panel .ufs-unfollow-progress-text { flex: 1; }
        #ufs-panel .ufs-postdate-row {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 0 12px 8px; font-size: 11px; color: #8b98a5; flex-wrap: nowrap;
        }
        #ufs-panel .ufs-postdate-row #ufs-collect-postdate-btn { flex-shrink: 0; }
        #ufs-panel .ufs-postdate-row-group {
          display: flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap;
        }
        #ufs-panel .ufs-inactive-threshold-label { white-space: nowrap; }
        #ufs-panel .ufs-inactive-threshold-input {
          width: 60px; background: #0f1317; border: 1px solid #2f3336; border-radius: 8px;
          color: #e7e9ea; padding: 4px 6px; font-size: 11px; text-align: center;
        }
        #ufs-panel .ufs-postdate-progress {
          display: flex; align-items: center; gap: 8px; padding: 6px 12px; margin: 0 12px 8px;
          background: #241f14; border: 1px solid #5a4a2a; border-radius: 8px;
          font-size: 11px; color: #ffcf8a;
        }
        #ufs-panel .ufs-postdate-progress-text { flex: 1; }
        #ufs-panel .ufs-row-inactive {
          color: #ffad1f; font-size: 11px; flex-shrink: 0; cursor: default;
        }
        #ufs-panel .ufs-row-ratio {
          color: #1d9bf0; font-size: 11px; flex-shrink: 0; margin-left: 2px;
        }
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
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;
        }
        #ufs-panel .ufs-row-verified {
          color: #1d9bf0; font-size: 12px; flex-shrink: 0; font-weight: 700;
        }
        #ufs-panel .ufs-row-actions { display: flex; gap: 2px; }
        #ufs-panel .ufs-row-actions button {
          background: transparent; border: none; color: #8b98a5; cursor: pointer;
          font-size: 12px; padding: 2px 4px; border-radius: 4px;
        }
        #ufs-panel .ufs-row-actions button:hover:not(:disabled) { color: #e7e9ea; background: #2f3336; }
        #ufs-panel .ufs-row-actions button:disabled {
          opacity: 0.35; cursor: not-allowed; color: #71767b;
        }
        #ufs-panel .ufs-footer {
          padding: 8px 12px; border-top: 1px solid #2f3336; font-size: 11px; color: #8b98a5;
        }
        #ufs-panel .ufs-empty { text-align: center; color: #71767b; padding: 24px 8px; font-size: 12px; }

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
        #ufs-hovercard .ufs-hc-postdate {
          font-size: 11px; color: #8b98a5; margin-bottom: 10px; display: flex; align-items: center; gap: 4px;
        }
        #ufs-hovercard .ufs-hc-postdate.ufs-hc-postdate-inactive { color: #ffad1f; font-weight: 600; }
        #ufs-hovercard .ufs-hc-actions { display: flex; gap: 6px; }
        #ufs-hovercard .ufs-hc-actions button {
          flex: 1; background: #2f3336; color: #e7e9ea; border: none; border-radius: 999px;
          padding: 6px 4px; font-size: 12px; cursor: pointer; text-align: center;
          display: flex; align-items: center; justify-content: center; white-space: nowrap;
        }
        #ufs-hovercard .ufs-hc-actions button:hover:not(:disabled) { background: #3a3f42; }
        #ufs-hovercard .ufs-hc-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
        #ufs-hovercard .ufs-hc-actions button.ufs-hc-unfollow-btn { background: #f4212e; color: #fff; }
        #ufs-hovercard .ufs-hc-actions button.ufs-hc-unfollow-btn:hover:not(:disabled) { background: #d81b25; }
        #ufs-hovercard .ufs-hc-actions button.ufs-hc-unfollow-btn:disabled {
          background: #4a2226; color: #a98488;
        }

        #ufs-whitelist-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000001;
          display: none; align-items: center; justify-content: center;
        }
        #ufs-whitelist-overlay .ufs-whitelist-modal {
          width: 320px; max-width: calc(100vw - 32px); max-height: calc(100vh - 80px);
          background: #15181c; color: #8b98a5; border-radius: 16px; border: 1px solid #2f3336;
          box-shadow: 0 12px 32px rgba(0,0,0,0.6); display: flex; flex-direction: column;
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        #ufs-whitelist-overlay .ufs-whitelist-modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px; background: #1d2226; font-weight: 700; font-size: 14px;
        }
        #ufs-whitelist-overlay .ufs-whitelist-modal-hint {
          padding: 10px 14px 0; font-size: 11px; color: #8b98a5; line-height: 1.5;
        }
        #ufs-whitelist-overlay .ufs-whitelist-textarea {
          margin: 10px 14px; flex: 1; min-height: 160px; resize: vertical;
          background: #0f1317; border: 1px solid #2f3336; border-radius: 8px;
          color: #e7e9ea; padding: 8px; font-size: 12px; line-height: 1.6; font-family: inherit;
        }
        #ufs-whitelist-overlay .ufs-whitelist-textarea:focus { outline: 1px solid #1d9bf0; }
        #ufs-whitelist-overlay .ufs-whitelist-modal-footer {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 14px 14px; font-size: 11px; color: #8b98a5;
        }
        #ufs-whitelist-overlay .ufs-whitelist-modal-actions { display: flex; gap: 8px; }
      `);
    }

    _buildSkeleton() {
      const root = document.createElement('div');
      root.id = 'ufs-panel';
      root.innerHTML = `
        <div class="ufs-header" id="ufs-header">
          <div class="ufs-title">🔍 X 用户检测助手 <span>v${SCRIPT_VERSION}</span></div>
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
            <button class="ufs-btn" id="ufs-copy-all-btn">复制日报</button>
            <button class="ufs-btn" id="ufs-whitelist-btn" title="白名单内的用户不参与扫描">⭐ 白名单</button>
          </div>
          <div class="ufs-speed-row">
            <div class="ufs-speed-label-row">
              <span>扫描速度</span>
              <span id="ufs-speed-value">标准</span>
            </div>
            <input type="range" class="ufs-speed-slider" id="ufs-speed-slider" min="0" max="4" step="1" />
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
            <label class="ufs-select-all-label" title="勾选/取消勾选当前列表中的全部账号">
              <input type="checkbox" id="ufs-select-all-checkbox" /> 全选
            </label>
            <label class="ufs-select-all-label" title="勾选全部「未回关 + 非认证」账号，再点击右侧「取消关注选中」批量取消关注">
              <input type="checkbox" id="ufs-select-unverified-checkbox" /> 全选非认证
            </label>
            <label class="ufs-select-all-label" title="勾选全部超过「不活跃阈值」未发帖的账号">
              <input type="checkbox" id="ufs-select-inactive-checkbox" /> 全选超阈值
            </label>
            <button class="ufs-btn ufs-btn-danger" id="ufs-unfollow-selected-btn" disabled>取消关注选中(0)</button>
          </div>
          <div class="ufs-unfollow-progress" id="ufs-unfollow-progress" style="display:none;">
            <div class="ufs-unfollow-progress-text" id="ufs-unfollow-progress-text"></div>
            <button class="ufs-btn" id="ufs-unfollow-stop-btn">停止</button>
          </div>
          <div class="ufs-postdate-row">
            <button class="ufs-btn" id="ufs-collect-postdate-btn" title="仅扫描当前分类标签下尚未采集的账号">🕐 获取未回关详情</button>
            <div class="ufs-postdate-row-group">
              <span class="ufs-inactive-threshold-label">不活跃</span>
              <input type="number" class="ufs-inactive-threshold-input" id="ufs-inactive-threshold-input" min="1" step="1" />
              <span class="ufs-inactive-threshold-label">天</span>
            </div>
          </div>
          <div class="ufs-postdate-row">
            <button class="ufs-btn" id="ufs-select-by-ratio-btn">📊 勾选低于比例账号</button>
            <div class="ufs-postdate-row-group">
              <span class="ufs-inactive-threshold-label">比例阈值 (&lt;)</span>
              <input type="number" class="ufs-inactive-threshold-input" id="ufs-ratio-threshold-input" step="0.1" value="1" />
            </div>
          </div>
          <div class="ufs-postdate-progress" id="ufs-postdate-progress" style="display:none;">
            <div class="ufs-postdate-progress-text" id="ufs-postdate-progress-text"></div>
            <button class="ufs-btn" id="ufs-postdate-stop-btn">停止</button>
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
        <div class="ufs-hc-postdate" id="ufs-hc-postdate"></div>
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
        postdate: hoverCard.querySelector('#ufs-hc-postdate'),
        bio: hoverCard.querySelector('#ufs-hc-bio'),
        openBtn: hoverCard.querySelector('#ufs-hc-open-btn'),
        copyBtn: hoverCard.querySelector('#ufs-hc-copy-btn'),
        unfollowBtn: hoverCard.querySelector('#ufs-hc-unfollow-btn'),
      };
      hoverCard.addEventListener('mouseenter', () => {
        if (this._hoverHideTimer) clearTimeout(this._hoverHideTimer);
      });
      hoverCard.addEventListener('mouseleave', () => this._scheduleHideHoverCard());
    }

    _buildWhitelistModal() {
      const overlay = document.createElement('div');
      overlay.id = 'ufs-whitelist-overlay';
      overlay.innerHTML = `
        <div class="ufs-whitelist-modal">
          <div class="ufs-whitelist-modal-header">
            <span>⭐ 白名单管理</span>
            <button class="ufs-icon-btn" id="ufs-whitelist-close-btn" title="关闭">✕</button>
          </div>
          <div class="ufs-whitelist-modal-hint">
            白名单内的用户不会被扫描。每行填写一个用户名（支持 @username 或 username），按回车换行。
          </div>
          <textarea class="ufs-whitelist-textarea" id="ufs-whitelist-textarea" placeholder="@xinzhizhu9795&#10;@elonmusk&#10;..."></textarea>
          <div class="ufs-whitelist-modal-footer">
            <span class="ufs-whitelist-modal-count" id="ufs-whitelist-modal-count">共 0 人</span>
            <div class="ufs-whitelist-modal-actions">
              <button class="ufs-btn" id="ufs-whitelist-cancel-btn">取消</button>
              <button class="ufs-btn ufs-btn-primary" id="ufs-whitelist-save-btn">保存</button>
            </div>
          </div>
        </div>
      `;
      document.documentElement.appendChild(overlay);
      this.whitelistModalElements = {
        overlay,
        textarea: overlay.querySelector('#ufs-whitelist-textarea'),
        countLabel: overlay.querySelector('#ufs-whitelist-modal-count'),
        closeBtn: overlay.querySelector('#ufs-whitelist-close-btn'),
        cancelBtn: overlay.querySelector('#ufs-whitelist-cancel-btn'),
        saveBtn: overlay.querySelector('#ufs-whitelist-save-btn'),
      };

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) this._closeWhitelistModal();
      });
      this.whitelistModalElements.closeBtn.addEventListener('click', () => this._closeWhitelistModal());
      this.whitelistModalElements.cancelBtn.addEventListener('click', () => this._closeWhitelistModal());
      this.whitelistModalElements.saveBtn.addEventListener('click', () => this._onSaveWhitelist());
      this.whitelistModalElements.textarea.addEventListener('input', () => this._updateWhitelistModalCount());
    }

    _openWhitelistModal() {
      this.whitelistModalElements.textarea.value = WhitelistManager.toText();
      this._updateWhitelistModalCount();
      this.whitelistModalElements.overlay.style.display = 'flex';
      this.whitelistModalElements.textarea.focus();
    }

    _closeWhitelistModal() {
      this.whitelistModalElements.overlay.style.display = 'none';
    }

    _updateWhitelistModalCount() {
      const names = this.whitelistModalElements.textarea.value
        .split(/[\r\n]+/)
        .map((line) => WhitelistManager.normalize(line))
        .filter(Boolean);
      const uniqueCount = new Set(names).size;
      this.whitelistModalElements.countLabel.textContent = `共 ${uniqueCount} 人`;
    }

    _onSaveWhitelist() {
      WhitelistManager.setFromText(this.whitelistModalElements.textarea.value);
      this._closeWhitelistModal();
      this._updateWhitelistBtnLabel();
      if (this.scanner) this.renderList(this.scanner.getAllRows());
    }

    _updateWhitelistBtnLabel() {
      if (this.elements && this.elements.whitelistBtn) {
        this.elements.whitelistBtn.textContent = `⭐ 白名单(${WhitelistManager.size})`;
      }
    }

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
        whitelistBtn: this.root.querySelector('#ufs-whitelist-btn'),
        searchInput: this.root.querySelector('#ufs-search-input'),
        sortBtn: this.root.querySelector('#ufs-sort-btn'),
        speedSlider: this.root.querySelector('#ufs-speed-slider'),
        speedValue: this.root.querySelector('#ufs-speed-value'),
        speedHint: this.root.querySelector('#ufs-speed-hint'),
        selectAllCheckbox: this.root.querySelector('#ufs-select-all-checkbox'),
        selectInactiveCheckbox: this.root.querySelector('#ufs-select-inactive-checkbox'),
        selectUnverifiedCheckbox: this.root.querySelector('#ufs-select-unverified-checkbox'),
        unfollowSelectedBtn: this.root.querySelector('#ufs-unfollow-selected-btn'),
        unfollowProgress: this.root.querySelector('#ufs-unfollow-progress'),
        unfollowProgressText: this.root.querySelector('#ufs-unfollow-progress-text'),
        unfollowStopBtn: this.root.querySelector('#ufs-unfollow-stop-btn'),
        collectPostDateBtn: this.root.querySelector('#ufs-collect-postdate-btn'),
        inactiveThresholdInput: this.root.querySelector('#ufs-inactive-threshold-input'),
        ratioThresholdInput: this.root.querySelector('#ufs-ratio-threshold-input'),
        selectByRatioBtn: this.root.querySelector('#ufs-select-by-ratio-btn'),
        postDateProgress: this.root.querySelector('#ufs-postdate-progress'),
        postDateProgressText: this.root.querySelector('#ufs-postdate-progress-text'),
        postDateStopBtn: this.root.querySelector('#ufs-postdate-stop-btn'),
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

    _bindStaticEvents() {
      this.elements.header.addEventListener('click', (event) => {
        if (event.target.closest('.ufs-icon-btn')) return;
        if (this._lastDragWasMove) {
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
      this.elements.whitelistBtn.addEventListener('click', () => this._openWhitelistModal());
      this.elements.sortBtn.addEventListener('click', () => this._onToggleSort());
      this.elements.speedSlider.addEventListener('input', (event) => this._onSpeedChange(event.target.value));
      this.elements.selectAllCheckbox.addEventListener('change', (event) => this._onSelectAllChange(event.target.checked));
      this.elements.selectInactiveCheckbox.addEventListener('change', (event) => this._onSelectInactiveChange(event.target.checked));
      this.elements.selectUnverifiedCheckbox.addEventListener('change', (event) => this._onSelectUnverifiedChange(event.target.checked));
      this.elements.unfollowSelectedBtn.addEventListener('click', () => this._onUnfollowSelectedClick());
      this.elements.unfollowStopBtn.addEventListener('click', () => this._onStopUnfollowClick());
      this.elements.collectPostDateBtn.addEventListener('click', () => this._onCollectPostDateClick());
      this.elements.inactiveThresholdInput.addEventListener('change', (event) => this._onThresholdChange(event.target.value));
      this.elements.postDateStopBtn.addEventListener('click', () => this._onStopPostDateClick());

      // 绑定通过比例筛选账号按钮逻辑
      this.elements.selectByRatioBtn.addEventListener('click', () => this._onSelectByRatioClick());

      const debouncedSearch = Utils.debounce((value) => {
        this.searchKeyword = value.trim().toLowerCase();
        this.renderList(this.rows);
      }, 250);
      this.elements.searchInput.addEventListener('input', (event) => debouncedSearch(event.target.value));

      Object.entries(this.elements.tabs).forEach(([tabKey, tabEl]) => {
        tabEl.addEventListener('click', () => {
          this.activeTab = tabKey;
          this._setActiveTabUi();
          this._updateCollectPostDateBtnLabel();
          this.renderList(this.rows);
        });
      });
      this._updateCollectPostDateBtnLabel();
    }

    /**
     * 根据设置的比例阈值筛选并勾选符合条件的账号
     */
    _onSelectByRatioClick() {
      const threshold = parseFloat(this.elements.ratioThresholdInput.value) || CONFIG.DEFAULT_RATIO_THRESHOLD;
      let count = 0;

      this.rows.forEach((row) => {
        if (row.ratio !== undefined && row.ratio < threshold) {
          this.selectedUsernames.add(row.username);
          count++;
        }
      });

      this.renderList(this.rows);
      Logger.success(`已勾选 ${count} 个粉丝/关注比例低于 ${threshold} 的账号`);
    }

    _setActiveTabUi() {
      Object.entries(this.elements.tabs).forEach(([tabKey, tabEl]) => {
        tabEl.classList.toggle('ufs-tab-active', tabKey === this.activeTab);
      });
    }

    _getTabLabel(tabKey = this.activeTab) {
      const labels = {
        all: '全部',
        mutual: '已互关',
        not_back: '未回关',
        failed: '失败',
      };
      return labels[tabKey] || '当前列表';
    }

    _updateCollectPostDateBtnLabel() {
      if (!this.elements.collectPostDateBtn) return;
      const label = this._getTabLabel();
      const selectedCount = this.selectedUsernames.size;
      if (selectedCount > 0) {
        this.elements.collectPostDateBtn.textContent = `📊 获取勾选列表详情(${selectedCount})`;
      } else {
        this.elements.collectPostDateBtn.textContent = `📊 获取${label}列表详情`;
      }
    }

    _getPostDateTargetsForActiveTab() {
      const selectedCount = this.selectedUsernames.size;
      let candidates = this.rows;
      let mode = 'tab';

      if (selectedCount > 0) {
        mode = 'selected';
        const selectedLower = new Set(
          Array.from(this.selectedUsernames).map((name) => String(name).toLowerCase())
        );
        candidates = candidates.filter(
          (row) => row && row.username && selectedLower.has(String(row.username).toLowerCase())
        );
      } else if (this.activeTab !== 'all') {
        candidates = candidates.filter((row) => row.status === this.activeTab);
      }

      const targets = candidates.filter((row) => row.lastPostDate === undefined);
      return { targets, selectedCount, mode };
    }

    _bindDragEvents() {
      const header = this.elements.header;

      header.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.ufs-icon-btn')) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
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
        } catch (error) {}
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
        } catch (error) {}
        this._dragState = null;
      };

      header.addEventListener('pointerup', finishDrag);
      header.addEventListener('pointercancel', finishDrag);
    }

    _applyInitialPosition() {
      const saved = this._loadPanelPosition();
      let left, top;
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

    _reclampToViewport() {
      const rect = this.root.getBoundingClientRect();
      const clamped = this._clampPosition(rect.left, rect.top);
      this.root.style.left = `${clamped.left}px`;
      this.root.style.top = `${clamped.top}px`;
    }

    _loadPanelPosition() {
      try {
        const raw = GM_getValue('ufs_panel_position_v1', null);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    }

    _savePanelPosition(left, top) {
      try {
        GM_setValue('ufs_panel_position_v1', JSON.stringify({ left, top }));
      } catch (error) {}
    }

    toggleCollapse() {
      this.isCollapsed = !this.isCollapsed;
      this.root.classList.toggle('ufs-collapsed', this.isCollapsed);
      this.elements.collapseBtn.textContent = this.isCollapsed ? '▸' : '▾';
    }

    close() {
      this.root.remove();
      if (this.hoverCardRoot) this.hoverCardRoot.remove();
      window.removeEventListener('resize', this._onWindowResize);
      if (this.scanner) this.scanner.pause();
    }

    _onPrimaryButtonClick() {
      if (!this.scanner) return;
      if (!this.scanner.hasStarted) {
        this.elements.toggleBtn.textContent = '暂停';
        this.scanner.start().catch((error) => Logger.error('扫描流程异常', error));
        this.renderList(this.rows);
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

    async _onRescanAll() {
      if (!this.scanner) return;
      this.elements.toggleBtn.disabled = false;
      this.elements.toggleBtn.textContent = '暂停';
      this.scanner.hasStarted = true;
      this.renderList(this.rows);
      await this.scanner.rescanAll();
    }

    _onExportCsv() {
      const header = ['username', 'status', 'followers', 'following', 'ratio', 'lastPostDate'];
      const dataRows = this.rows.map((row) => [
        row.username, row.status, row.followers ?? '', row.following ?? '', row.ratio !== undefined ? row.ratio.toFixed(2) : '', row.lastPostDate ?? ''
      ]);
      const csvText = Utils.toCsv([header, ...dataRows]);
      Utils.downloadTextFile(`ufs-report-${Date.now()}.csv`, csvText, 'text/csv');
    }

    _onExportTxt() {
      const notBackLines = this.rows
        .filter((row) => row.status === SCAN_STATUS.NOT_BACK)
        .map((row) => `@${row.username}`);
      Utils.downloadTextFile(`ufs-not-back-${Date.now()}.txt`, notBackLines.join('\n'), 'text/plain');
    }

    _buildDailyReportText() {
      const now = new Date();
      const dateLabel = `${now.getMonth() + 1}.${now.getDate()}`;

      const stats = { total: this.rows.length, mutual: 0, notBack: 0, failed: 0, pending: 0 };
      let verifiedTotal = 0;
      let unverifiedTotal = 0;
      let notBackVerified = 0;
      let notBackUnverified = 0;

      this.rows.forEach((row) => {
        const isVerified = Boolean(row.profile && row.profile.isVerified);
        if (isVerified) verifiedTotal += 1;
        else unverifiedTotal += 1;

        if (row.status === SCAN_STATUS.MUTUAL) {
          stats.mutual += 1;
        } else if (row.status === SCAN_STATUS.NOT_BACK) {
          stats.notBack += 1;
          if (isVerified) notBackVerified += 1;
          else notBackUnverified += 1;
        } else if (row.status === SCAN_STATUS.FAILED) {
          stats.failed += 1;
        } else {
          stats.pending += 1;
        }
      });

      const lines = [
        `📢 每日一统（${dateLabel}日数据统计）：`,
        '',
        `🔍 完成回关检测 ${stats.total} 人，其中：`,
        '',
        `✅ 已互关：${stats.mutual} 人`,
        `❌ 未回关：${stats.notBack} 人`,
        `⚠️ 扫描失败：${stats.failed} 人`,
        '',
        `🔵 认证账号：${verifiedTotal} 人`,
        `⚪ 非认证账号：${unverifiedTotal} 人`,
        '',
        `📌 未回关名单中：认证 ${notBackVerified} 人 / 非认证 ${notBackUnverified} 人`,
        '',
        `⭐ 白名单：${WhitelistManager.size} 人（不参与以上统计）`,
      ];

      return lines.join('\n');
    }

    _onCopyAll() {
      const text = this._buildDailyReportText();
      try {
        GM_setClipboard(text);
      } catch (error) {}
    }

    _onToggleSort() {
      this.sortAscending = !this.sortAscending;
      this.elements.sortBtn.textContent = this.sortAscending ? 'A-Z' : 'Z-A';
      this.renderList(this.rows);
    }

    _initSpeedControl() {
      this.elements.speedSlider.max = String(ScrollSpeedManager.getPresetCount() - 1);
      this.elements.speedSlider.value = String(ScrollSpeedManager.currentIndex);
      this._refreshSpeedDisplay();
    }

    _onSpeedChange(rawIndex) {
      ScrollSpeedManager.setIndex(Number(rawIndex));
      this._refreshSpeedDisplay();
    }

    _refreshSpeedDisplay() {
      const current = ScrollSpeedManager.getCurrent();
      this.elements.speedValue.textContent = current.label;
      this.elements.speedHint.textContent =
        `滚动间隔 ${(current.min / 1000).toFixed(1)}s ~ ${(current.max / 1000).toFixed(1)}s`;
    }

    _onSelectAllChange(checked) {
      const visibleRows = this._getFilteredSortedRows();
      const selectableRows = visibleRows.filter((row) => this._isRowSelectableForUnfollow(row));
      if (checked) {
        selectableRows.forEach((row) => this.selectedUsernames.add(row.username));
      } else {
        selectableRows.forEach((row) => this.selectedUsernames.delete(row.username));
      }
      this.renderList(this.rows);
    }

    _isRowSelectableForUnfollow(row) {
      if (!row) return false;
      if (row.status === SCAN_STATUS.NOT_BACK) return true;
      if (
        row.status === SCAN_STATUS.MUTUAL &&
        InactivityThresholdManager.isInactive(row.lastPostDate)
      ) {
        return true;
      }
      return false;
    }

    _isUnfollowActionEnabled() {
      return Boolean(this.scanner && this.scanner.hasStarted);
    }

    _getUnfollowDisabledTitle() {
      return '请先点击「开始扫描」（或「重新扫描」）后再取消关注';
    }

    _guardUnfollowRequiresScan() {
      if (this._isUnfollowActionEnabled()) return false;
      window.alert('请先点击「开始扫描」完整加载关注列表后，再执行取消关注。');
      return true;
    }

    _getInactiveSelectCandidateRows(rows = this.rows) {
      return rows.filter(
        (row) => row.status === SCAN_STATUS.NOT_BACK || row.status === SCAN_STATUS.MUTUAL
      );
    }

    _getInactiveSelectableUsernames(rows = this.rows) {
      return rows
        .filter((row) => this._isRowSelectableForUnfollow(row) &&
          InactivityThresholdManager.isInactive(row.lastPostDate))
        .map((row) => row.username);
    }

    _selectInactiveSelectableUsers(rows = this.rows) {
      const inactiveUsernames = this._getInactiveSelectableUsernames(rows);
      inactiveUsernames.forEach((username) => this.selectedUsernames.add(username));
      this.renderList(rows);
      return inactiveUsernames.length;
    }

    _onSelectInactiveChange(checked) {
      if (!checked) {
        this._awaitingInactiveSelect = false;
        if (this.scanner) this.scanner.clearPostDateOnComplete();
        this._getInactiveSelectableUsernames().forEach((username) => {
          this.selectedUsernames.delete(username);
        });
        this.renderList(this.rows);
        return;
      }

      const candidateRows = this._getInactiveSelectCandidateRows();
      if (candidateRows.length === 0) {
        this._awaitingInactiveSelect = false;
        this.elements.selectInactiveCheckbox.checked = false;
        window.alert('当前没有未回关或已互关账号可检测。');
        return;
      }

      const notBackCount = candidateRows.filter((row) => row.status === SCAN_STATUS.NOT_BACK).length;
      const mutualCount = candidateRows.filter((row) => row.status === SCAN_STATUS.MUTUAL).length;
      const needCollect = candidateRows.filter((row) => row.lastPostDate === undefined);

      if (needCollect.length === 0) {
        this._awaitingInactiveSelect = false;
        const count = this._selectInactiveSelectableUsers();
        if (count === 0) {
          this.elements.selectInactiveCheckbox.checked = false;
          window.alert(`当前未回关/已互关中没有超过「${InactivityThresholdManager.days} 天」不活跃阈值的账号。`);
        }
        return;
      }

      if (!this.scanner) {
        this._awaitingInactiveSelect = false;
        this.elements.selectInactiveCheckbox.checked = false;
        return;
      }

      const alreadyKnownInactive = this._getInactiveSelectableUsernames().length;
      const avgIntervalMs =
        (CONFIG.POST_DATE_INTERVAL_MIN_MS + CONFIG.POST_DATE_INTERVAL_MAX_MS) / 2;
      const estimatedText = Utils.formatDuration(needCollect.length * avgIntervalMs);
      const confirmed = window.confirm(
        `「全选超阈值」需要先获取发帖日期才能判断。\n\n` +
        `未回关：${notBackCount} 人 · 已互关：${mutualCount} 人\n` +
        `尚未采集发帖日期：${needCollect.length} 人（需先扫描）\n` +
        `已确认超阈值：${alreadyKnownInactive} 人\n` +
        `当前不活跃阈值：${InactivityThresholdManager.days} 天\n\n` +
        `预计约 ${estimatedText}，是否继续？`
      );
      if (!confirmed) {
        this._awaitingInactiveSelect = false;
        this.elements.selectInactiveCheckbox.checked = false;
        return;
      }

      const usernamesToCollect = needCollect.map((row) => row.username);
      const probeWin = this.scanner.prober.prepareProbeWindow(usernamesToCollect[0]);
      if (!probeWin) {
        this._awaitingInactiveSelect = false;
        this.elements.selectInactiveCheckbox.checked = false;
        window.alert('无法打开探测窗口。请在地址栏允许本站弹窗后重试。');
        return;
      }

      this._awaitingInactiveSelect = true;

      this.scanner.enqueuePostDateCollection(usernamesToCollect, {
        onComplete: () => {
          this._awaitingInactiveSelect = false;
          const updatedRows = this.scanner ? this.scanner.getAllRows() : this.rows;
          this.rows = updatedRows;
          const count = this._selectInactiveSelectableUsers(updatedRows);
          if (count === 0 && this.elements.selectInactiveCheckbox) {
            this.elements.selectInactiveCheckbox.checked = false;
          }
          this.renderList(this.rows);
        },
      });
    }

    _prepareUnfollowProbeWindow(firstUsername) {
      if (!this.scanner) return { ok: false, preparedByUserGesture: false };

      if (this.scanner.isOnMatchingListPage()) {
        return { ok: true, preparedByUserGesture: false };
      }

      const probeWin = this.scanner.prober.prepareProbeWindow(firstUsername);
      if (!probeWin) {
        window.alert('当前不在「正在关注」列表页面，且无法打开探测窗口。');
        return { ok: false, preparedByUserGesture: false };
      }
      return { ok: true, preparedByUserGesture: true };
    }

    _onUnfollowSelectedClick() {
      if (!this.scanner) return;
      if (this._guardUnfollowRequiresScan()) return;
      const usernames = Array.from(this.selectedUsernames);
      if (usernames.length === 0) return;
      const confirmed = window.confirm(`确定要取消关注选中的 ${usernames.length} 个账号吗？`);
      if (!confirmed) return;
      const prep = this._prepareUnfollowProbeWindow(usernames[0]);
      if (!prep.ok) return;
      this.selectedUsernames.clear();
      this.scanner.enqueueUnfollow(usernames, { preparedByUserGesture: prep.preparedByUserGesture });
      this.renderList(this.rows);
    }

    _getUnverifiedSelectableUsernames(rows = this.rows) {
      return rows
        .filter((row) => row.status === SCAN_STATUS.NOT_BACK && !(row.profile && row.profile.isVerified))
        .map((row) => row.username);
    }

    _onSelectUnverifiedChange(checked) {
      const usernames = this._getUnverifiedSelectableUsernames();
      if (checked) {
        if (usernames.length === 0) {
          window.alert('当前"未回关"名单中没有找到非认证账号。');
        }
        usernames.forEach((username) => this.selectedUsernames.add(username));
      } else {
        usernames.forEach((username) => this.selectedUsernames.delete(username));
      }
      this.renderList(this.rows);
    }

    _onStopUnfollowClick() {
      if (!this.scanner) return;
      this.scanner.stopUnfollowQueue();
    }

    _refreshBatchBar() {
      const count = this.selectedUsernames.size;
      const unfollowEnabled = this._isUnfollowActionEnabled();
      const disabledTitle = this._getUnfollowDisabledTitle();

      this.elements.unfollowSelectedBtn.disabled = !unfollowEnabled || count === 0;
      this.elements.unfollowSelectedBtn.textContent = `取消关注选中(${count})`;
      this.elements.unfollowSelectedBtn.title = unfollowEnabled
        ? (count === 0 ? '请先勾选要取消关注的账号' : '取消关注选中的账号')
        : disabledTitle;

      const visibleRows = this._getFilteredSortedRows();
      const selectableRows = visibleRows.filter((row) => this._isRowSelectableForUnfollow(row));
      const allSelected =
        selectableRows.length > 0 && selectableRows.every((row) => this.selectedUsernames.has(row.username));
      this.elements.selectAllCheckbox.checked = allSelected;
      this.elements.selectAllCheckbox.disabled = selectableRows.length === 0;

      const inactiveSelectable = this._getInactiveSelectableUsernames();
      const allInactiveSelected =
        inactiveSelectable.length > 0 &&
        inactiveSelectable.every((username) => this.selectedUsernames.has(username));
      this.elements.selectInactiveCheckbox.checked =
        this._awaitingInactiveSelect || allInactiveSelected;
      this.elements.selectInactiveCheckbox.disabled =
        this._getInactiveSelectCandidateRows().length === 0;

      const unverifiedSelectable = this._getUnverifiedSelectableUsernames();
      const allUnverifiedSelected =
        unverifiedSelectable.length > 0 &&
        unverifiedSelectable.every((username) => this.selectedUsernames.has(username));
      this.elements.selectUnverifiedCheckbox.checked = allUnverifiedSelected;
      this.elements.selectUnverifiedCheckbox.disabled = unverifiedSelectable.length === 0;

      this._updateCollectPostDateBtnLabel();
    }

    setUnfollowProgress(remainingCount, currentUsername) {
      this.elements.unfollowProgress.style.display = 'flex';
      const currentText = currentUsername ? `当前：@${currentUsername}` : '';
      this.elements.unfollowProgressText.textContent =
        `正在取消关注...剩余 ${remainingCount} 个 ${currentText}`.trim();
    }

    hideUnfollowProgress() {
      this.elements.unfollowProgress.style.display = 'none';
    }

    _onCollectPostDateClick() {
      if (!this.scanner) return;
      const tabLabel = this._getTabLabel();
      const { targets, selectedCount, mode } = this._getPostDateTargetsForActiveTab();
      const pendingQueueCount = (this.scanner.postDateQueue && this.scanner.postDateQueue.length) || 0;
      const usernames = targets.map((row) => row.username);
      const newTargetCount = usernames.length;

      if (newTargetCount === 0 && pendingQueueCount === 0) {
        window.alert('没有需要获取发帖日期的账号。');
        return;
      }

      const scanCount = newTargetCount > 0 ? newTargetCount : pendingQueueCount;
      const avgIntervalMs =
        (CONFIG.POST_DATE_INTERVAL_MIN_MS + CONFIG.POST_DATE_INTERVAL_MAX_MS) / 2;
      const estimatedText = Utils.formatDuration(scanCount * avgIntervalMs);

      const confirmed = window.confirm(
        `确定要获取 ${scanCount} 个账号的最新详情与比例数据吗？ \n\n` +
        `说明：X 禁止 iframe，确认后会打开探测小窗口逐个加载主页（请勿手动关闭）。\n` +
        `预计约 ${estimatedText}，可随时点「停止」；已采集数据会实时保存。\n\n是否继续？`
      );

      if (!confirmed) return;

      const probeWin = this.scanner.prober._ensureProbeWindow();
      if (!probeWin) {
        window.alert('无法打开探测窗口，请允许本站弹窗后重试。');
        return;
      }

      if (newTargetCount > 0) {
        this.scanner.enqueuePostDateCollection(usernames);
      } else {
        this.scanner.resumePostDateCollection();
      }
    }

    _onThresholdChange(rawValue) {
      InactivityThresholdManager.setDays(rawValue);
      this.elements.inactiveThresholdInput.value = String(InactivityThresholdManager.days);
      this.renderList(this.rows);
    }

    _onStopPostDateClick() {
      if (!this.scanner) return;
      this.cancelAwaitingInactiveSelect();
      this.scanner.stopPostDateQueue();
    }

    cancelAwaitingInactiveSelect() {
      this._awaitingInactiveSelect = false;
      this._refreshBatchBar();
    }

    setPostDateProgress(remainingCount, currentUsername) {
      this.elements.postDateProgress.style.display = 'flex';
      const currentText = currentUsername ? `当前：@${currentUsername}` : '';
      this.elements.postDateProgressText.textContent =
        `正在获取详情...剩余 ${remainingCount} 个 ${currentText}`.trim();
    }

    hidePostDateProgress() {
      this.elements.postDateProgress.style.display = 'none';
    }

    setScanProgress(processedCount) {
      this.elements.progressText.textContent = `正在滚动扫描... 已处理 ${processedCount} 人`;
      this.elements.progressFill.style.width = '100%';
    }

    setStatus(statusName, extra = {}) {
      if (statusName === 'idle') {
        this.elements.toggleBtn.textContent = '开始扫描';
        this.elements.toggleBtn.disabled = false;
        this.elements.progressText.textContent = '已加载缓存数据，点击"开始扫描"以检测回关状态';
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
      this._refreshBatchBar();
    }

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

    renderList(rows) {
      this.rows = rows;

      const selectableUsernameSet = new Set(
        rows.filter((row) => this._isRowSelectableForUnfollow(row)).map((row) => row.username)
      );
      Array.from(this.selectedUsernames).forEach((username) => {
        if (!selectableUsernameSet.has(username)) this.selectedUsernames.delete(username);
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
      this.elements.footer.textContent =
        `共 ${tabCounters.all} 人 · 未回关 ${tabCounters.not_back} 人 · 白名单 ${WhitelistManager.size} 人`;

      this._updateCollectPostDateBtnLabel();
      this._updateWhitelistBtnLabel();
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

    _buildRowElement(row, statusLabels) {
      const rowEl = document.createElement('div');
      rowEl.className = 'ufs-row';

      const userWrap = document.createElement('div');
      userWrap.className = 'ufs-row-user';

      const canSelectForUnfollow = this._isRowSelectableForUnfollow(row);
      if (canSelectForUnfollow) {
        const checkboxEl = document.createElement('input');
        checkboxEl.type = 'checkbox';
        checkboxEl.className = 'ufs-row-checkbox';
        checkboxEl.checked = this.selectedUsernames.has(row.username);
        checkboxEl.addEventListener('change', (event) => {
          if (event.target.checked) {
            this.selectedUsernames.add(row.username);
          } else {
            this.selectedUsernames.delete(row.username);
          }
          this._refreshBatchBar();
          this._updateCollectPostDateBtnLabel();
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

      if (row.profile && row.profile.isVerified) {
        const verifiedEl = document.createElement('span');
        verifiedEl.className = 'ufs-row-verified';
        verifiedEl.textContent = '✓';
        verifiedEl.title = '已认证账号';
        userWrap.appendChild(verifiedEl);
      }

      if (InactivityThresholdManager.isInactive(row.lastPostDate)) {
        const inactiveEl = document.createElement('span');
        inactiveEl.className = 'ufs-row-inactive';
        inactiveEl.textContent = '⏰';
        userWrap.appendChild(inactiveEl);
      }

      // 渲染计算出的比例数据
      if (row.ratio !== undefined) {
        const ratioEl = document.createElement('span');
        ratioEl.className = 'ufs-row-ratio';
        ratioEl.textContent = `[${row.ratio.toFixed(2)}]`;
        ratioEl.title = `粉丝: ${row.followers ?? 0} | 关注: ${row.following ?? 0} (粉丝/关注 比例: ${row.ratio.toFixed(2)})`;
        userWrap.appendChild(ratioEl);
      }

      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'ufs-row-actions';

      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋';
      copyBtn.title = '复制用户名';
      copyBtn.addEventListener('click', () => {
        try {
          GM_setClipboard(`@${row.username}`);
        } catch (error) {}
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

      if (canSelectForUnfollow) {
        const unfollowBtn = document.createElement('button');
        unfollowBtn.textContent = '🚫';
        const unfollowEnabled = this._isUnfollowActionEnabled();
        unfollowBtn.disabled = !unfollowEnabled;
        unfollowBtn.title = unfollowEnabled
          ? '取消关注该用户'
          : this._getUnfollowDisabledTitle();
        unfollowBtn.addEventListener('click', () => {
          if (!this.scanner) return;
          if (this._guardUnfollowRequiresScan()) return;
          const confirmed = window.confirm(`确定要取消关注 @${row.username} 吗？`);
          if (!confirmed) return;
          const prep = this._prepareUnfollowProbeWindow(row.username);
          if (!prep.ok) return;
          this.scanner.enqueueUnfollow([row.username], {
            preparedByUserGesture: prep.preparedByUserGesture,
          });
        });
        actionsWrap.appendChild(unfollowBtn);
      }

      rowEl.appendChild(userWrap);
      rowEl.appendChild(actionsWrap);

      rowEl.addEventListener('mouseenter', () => this._scheduleShowHoverCard(row, rowEl));
      rowEl.addEventListener('mouseleave', () => this._scheduleHideHoverCard());

      return rowEl;
    }

    _scheduleShowHoverCard(row, anchorElement) {
      if (this._hoverHideTimer) clearTimeout(this._hoverHideTimer);
      if (this._hoverShowTimer) clearTimeout(this._hoverShowTimer);
      this._hoverShowTimer = setTimeout(() => {
        this._showHoverCard(row, anchorElement);
      }, CONFIG.HOVER_CARD_SHOW_DELAY_MS);
    }

    _scheduleHideHoverCard() {
      if (this._hoverShowTimer) clearTimeout(this._hoverShowTimer);
      if (this._hoverHideTimer) clearTimeout(this._hoverHideTimer);
      this._hoverHideTimer = setTimeout(() => this._hideHoverCard(), CONFIG.HOVER_CARD_HIDE_DELAY_MS);
    }

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

      let postDateText = '';
      if (row.lastPostDate === undefined) {
        postDateText = '🕐 最近发帖：尚未获取';
      } else {
        const isInactive = InactivityThresholdManager.isInactive(row.lastPostDate);
        const relativeText = Utils.formatRelativeDays(row.lastPostDate);
        const shortDate = Utils.formatShortDate(row.lastPostDate);
        const dateSuffix = shortDate ? `（${shortDate}）` : '';
        postDateText = `🕐 最近发帖：${relativeText}${dateSuffix}`;
        if (isInactive) {
          postDateText += ` ⚠️ 超过 ${InactivityThresholdManager.days} 天未发帖`;
        }
      }

      if (row.ratio !== undefined) {
        postDateText += `\n📊 粉丝: ${row.followers ?? 0} | 关注: ${row.following ?? 0} | 比例: ${row.ratio.toFixed(2)}`;
      }

      elements.postdate.textContent = postDateText;
      elements.bio.textContent = profile.bio || '（未采集到简介信息）';

      elements.openBtn.onclick = () => window.open(`${location.origin}/${row.username}`, '_blank', 'noopener');
      elements.copyBtn.onclick = () => {
        try {
          GM_setClipboard(`@${row.username}`);
        } catch (error) {}
      };

      const canUnfollowRow = this._isRowSelectableForUnfollow(row);
      const unfollowEnabled = this._isUnfollowActionEnabled();
      elements.unfollowBtn.style.display = canUnfollowRow ? 'block' : 'none';
      elements.unfollowBtn.disabled = !canUnfollowRow || !unfollowEnabled;
      elements.unfollowBtn.onclick = () => {
        if (!this.scanner) return;
        if (this._guardUnfollowRequiresScan()) return;
        const confirmed = window.confirm(`确定要取消关注 @${row.username} 吗？`);
        if (!confirmed) return;
        const prep = this._prepareUnfollowProbeWindow(row.username);
        if (!prep.ok) return;
        this.scanner.enqueueUnfollow([row.username], {
          preparedByUserGesture: prep.preparedByUserGesture,
        });
        this._hideHoverCard();
      };

      const rect = anchorElement.getBoundingClientRect();
      const cardWidth = CONFIG.HOVER_CARD_WIDTH_PX;
      let left = rect.left - cardWidth - 24;
      if (left < 8) left = rect.right + 12;
      left = Utils.clampNumber(left, 8, window.innerWidth - cardWidth - 8);

      this.hoverCardRoot.style.left = `${left}px`;
      this.hoverCardRoot.style.top = `${rect.top}px`;
      this.hoverCardRoot.style.display = 'block';

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

    _hideHoverCard() {
      if (this.hoverCardRoot) this.hoverCardRoot.style.display = 'none';
    }
  }

  /* ==========================================================================
   * 10. 启动引导（main）
   * ======================================================================== */

  (async function main() {
    try {
      const handledAsProbe = await respondToProbeIfNeeded();
      if (handledAsProbe) return;

      ScrollSpeedManager.load();
      InactivityThresholdManager.load();
      WhitelistManager.load();

      let currentOwnerUsername = null;
      let currentPageType = null;
      let currentPanel = null;
      let currentScanner = null;
      let pausedByNavigation = false;

      async function initForNewTarget(ownerUsername, pageType) {
        currentOwnerUsername = ownerUsername;
        currentPageType = pageType;
        pausedByNavigation = false;

        if (currentPanel) {
          try {
            currentPanel.close();
          } catch (error) {}
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

        if (scanner.unfollowQueue.length > 0) {
          panel.setUnfollowProgress(scanner.unfollowQueue.length, '等待再次点击以继续…');
        }

        if (scanner.postDateQueue.length > 0) {
          panel.setPostDateProgress(scanner.postDateQueue.length, null);
        }
      }

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
          currentScanner.pause();
          pausedByNavigation = true;
        }

        if (!newOwnerUsername || !newPageType) {
          return;
        }

        if (isSameTarget) {
          if (pausedByNavigation && currentScanner && currentScanner.isPaused) {
            currentScanner.resume();
            pausedByNavigation = false;
          }
          return;
        }

        await initForNewTarget(newOwnerUsername, newPageType);
      }

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

        const bodyObserver = new MutationObserver(handlePossibleChange);
        bodyObserver.observe(document.body, { childList: true, subtree: false });
      }

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