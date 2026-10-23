import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultCatPath = path.join(__dirname, 'assets', 'monthly_salary_cat.gif');

let logger = null;
let pluginConfigPath = '';

// 默认配置
let currentConfig = {
  target_qq: "",
  forward_private: true,
  forward_group: false,
  forward_group_at_only: true,
  send_confirmation: true,
  show_sender_info: true,
  show_original_nickname: false,   // 备注名后是否显示用户实际QQ昵称（默认关，仅显示备注名）
  enable_quote_reply: true,         // 回复对方时是否使用引用回复（引用对方的原消息）
  forward_file: true,              // 是否自动转发接收到的文件
  ignore_dnd: true,                // 自动检测并跳过QQ客户端设置了“消息免打扰”或“屏蔽”的会话
  dnd_list: [],                    // 手动免打扰/黑名单列表 (QQ号或群号字符串数组)
  dnd_list_str: "",                // 供 WebUI 展示的免打扰名单文本
  forward_friend_request: true,    // 转发好友申请给管理员
  auto_approve_friend: false,      // 是否自动同意好友申请
  auto_approve_keyword: "",        // 附言包含关键字时自动同意（留空不启用）
  notify_on_at: true,              // 群聊有人@机器人时是否通知管理员
  auto_protect_group_card: true,   // 是否开启群名片防篡改自动恢复
  protect_card_delay_minutes: 10,  // 检测到群名片被改后，延迟多少分钟改回（防抢拉扯）
  default_group_card: "", // 默认期望群名片
  // 定时群发月薪喵表情包配置
  enable_schedule: true,           // 是否开启定时群发
  schedule_groups: "",             // 目标群聊列表（支持逗号/空格/换行分隔，如：123456, 7891011）
  schedule_times: "12:30",         // 每天定时发送时间点（改为中午12:30）
  schedule_random_minutes: 0,      // 定时时间前后随机浮动时长 (分钟，0为固定时间准点发送)
  schedule_text: "",               // 发送表情包时的附加文本
  schedule_send_image: true,       // 关闭后只发送 schedule_text
  schedule_custom_image: "",       // 自定义表情图片路径或 URL（留空使用内置月薪喵）
  enable_schedule_activity_check: true, // 是否开启群活跃度防刷屏检测（防止死群刷屏被踢）
  schedule_min_other_msgs: 5,      // 群内其他成员消息数必须严格大于 n 才能再次发送
};
const configDefaults = structuredClone(currentConfig);

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置必须是对象');
  for (const [key, value] of Object.entries(config)) {
    if (!(key in configDefaults)) continue;
    if (Array.isArray(configDefaults[key])) {
      if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) {
        throw new Error(`${key} 必须是 QQ/群号字符串数组`);
      }
    } else if (typeof value !== typeof configDefaults[key]) throw new Error(`${key} 类型不正确`);
  }
  for (const [key, min, max] of [
    ['schedule_random_minutes', 0, 1440], ['schedule_min_other_msgs', 0, 1000000],
    ['protect_card_delay_minutes', 1, 1440]
  ]) {
    if (key in config && (!Number.isFinite(config[key]) || config[key] < min || config[key] > max)) {
      throw new Error(`${key} 必须在 ${min} 到 ${max} 之间`);
    }
  }
  if (config.target_qq && !/^\d+$/.test(config.target_qq)) throw new Error('管理员 QQ 必须为数字');
  if (config.schedule_times && config.schedule_times.split(/[,，\s]+/).filter(Boolean)
      .some(t => !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error('时间必须为有效的 HH:mm');
  if (config.schedule_groups && config.schedule_groups.split(/[,，\s]+/).filter(Boolean)
      .some(g => !/^\d+$/.test(g))) throw new Error('目标群号必须为数字');
}

// 内存中的消息映射: sent_msg_id -> target info
// key: String(sent_message_id)
// value: { sender_id, sender_name, chat_type, group_id, group_name, original_msg_id, time, is_friend_request, flag }
const messageMap = new Map();
const MAX_MAP_SIZE = 5000;
let saveTimer = null;
let dataDir = '';

// 群定时活跃度追踪: groupId -> { lastSentDate, lastSentTime, otherMsgCount, waitingForActivity }
const groupActivityMap = new Map();
let groupActivitySaveTimer = null;

// 受保护群的期望名片映射: groupId -> expectedCard
const protectedGroupCards = new Map();

// 待执行的名片改回任务: groupId -> { timer, expectedCard, oldCard, newCard, detectedAt, scheduledAt, groupName }
const pendingCardRestores = new Map();
let cardPollCounter = 0;

// 待处理的好友申请缓存: key -> { user_id, nickname, flag, comment, time }
// 这里的 key 可以是 message_id (发给管理员的消息ID)、user_id (申请人QQ)、flag
const pendingFriendRequests = new Map();
const friendNotificationsInFlight = new Set();
const friendApprovalsInFlight = new Set();
const groupSendsInFlight = new Set();
const activityMessageIds = new Map();
const activityHistoryChecks = new Map();
const ACTIVITY_HISTORY_TTL = 60000;
let pluginActive = true;
const shanghaiClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function localClock(date = new Date()) {
  return Object.fromEntries(shanghaiClock.formatToParts(date)
    .filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(file + '.tmp', file);
}

function activityThreshold() {
  const n = Number(currentConfig.schedule_min_other_msgs);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 5;
}

function configuredGroupIds() {
  return [...new Set(String(currentConfig.schedule_groups || '')
    .split(/[,，\s]+/).filter(g => /^\d+$/.test(g)))];
}

// 群消息 Mask 缓存，避免对 QQ NT 核心接口的高频重复轮询
let groupMaskCache = null;
let groupMaskCacheTime = 0;
let groupMaskRefresh = null;
const contactDndCache = new Map();
const GROUP_MASK_CACHE_TTL = 15000; // 15秒缓存

// 好友备注与昵称缓存: uin -> { nickname, remark, lastUpdated }
const friendCache = new Map();
let lastFriendRefresh = 0;
const FRIEND_CACHE_TTL = 300000; // 5分钟自动刷新缓存

/**
 * 安全调用 OneBot Action
 * 彻底解决 NapCat 4.18+ 在调用 set_group_card、set_friend_remark 等无返回数据的 Action 时
 * 因内部 `if (!result.data)` 误判抛出 "Action xxx failed: No data returned" 的内核 Bug
 */
async function callAction(ctx, actionName, params = {}) {
  if (!ctx?.actions) throw new Error('ctx.actions 不可用');
  const handler = ctx.actions.get?.(actionName);
  if (handler && typeof handler.handle === 'function') {
    const result = await handler.handle(params, ctx.adapterName, ctx.pluginManager?.config);
    if (result?.status !== 'ok' || (result.retcode !== undefined && result.retcode !== 0)) {
      throw new Error(result?.message || result?.wording || `Action ${actionName} failed`);
    }
    return result.data ?? null;
  }
  // Older NapCat releases expose only call(); only known void actions may return no data.
  try {
    return await ctx.actions.call(actionName, params, ctx.adapterName, ctx.pluginManager?.config);
  } catch (err) {
    if (['set_group_card', 'set_friend_remark', 'set_friend_add_request'].includes(actionName)
        && String(err?.message).includes('No data returned')) return null;
    throw err;
  }
}

/**
 * 刷新好友列表缓存（获取所有好友的最新备注与原始昵称）
 */
async function refreshFriendCache(ctx, force = false) {
  const now = Date.now();
  if (!force && friendCache.size > 0 && now - lastFriendRefresh < FRIEND_CACHE_TTL) {
    return;
  }
  try {
    const rawRes = await callAction(ctx, 'get_friend_list', {});
    const res = Array.isArray(rawRes) ? rawRes : (Array.isArray(rawRes?.data) ? rawRes.data : []);
    if (Array.isArray(res)) {
      for (const item of res) {
        if (item && item.user_id) {
          friendCache.set(String(item.user_id), {
            nickname: (item.nickname || '').trim(),
            remark: (item.remark || '').trim(),
            lastUpdated: now
          });
        }
      }
      lastFriendRefresh = now;
      logger?.debug?.(`[Relay] 成功刷新好友信息缓存，共 ${friendCache.size} 位好友`);
    }
  } catch (e) {
    logger?.debug?.('[Relay] 获取好友列表异常:', e);
  }
}

/**
 * 获取并格式化用户的显示名称（严格保证备注名最高优先级）
 * @param {object} ctx NapCat 上下文
 * @param {string|number} userId 用户QQ号
 * @param {string} fallbackNickname 备用昵称
 * @returns {Promise<string>}
 */
async function getUserDisplayName(ctx, userId, fallbackNickname = '') {
  const uin = String(userId || '').trim();
  if (!uin) return '';

  let cached = friendCache.get(uin);
  if (!cached) {
    await refreshFriendCache(ctx);
    cached = friendCache.get(uin);
  }

  let remark = (cached?.remark || '').trim();
  let nickname = (cached?.nickname || fallbackNickname || '').trim();

  // 如果缓存无记录且无昵称，尝试获取陌生人信息
  if (!remark && !nickname) {
    try {
      const info = await callAction(ctx, 'get_stranger_info', { user_id: Number(uin) });
      if (info && info.nickname) {
        nickname = String(info.nickname).trim();
      }
    } catch (e) {}
  }

  if (!nickname) {
    nickname = uin;
  }

  // 核心规则：备注名优先级最高
  if (remark) {
    if (currentConfig.show_original_nickname && nickname && nickname !== remark) {
      return `${remark} (${nickname})`;
    }
    return remark;
  }

  return nickname;
}

/**
 * 格式化文件大小可读字符串
 */
function formatFileSize(bytes) {
  const b = Number(bytes);
  if (isNaN(b) || b <= 0) return '未知大小';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export let plugin_config_ui = [];

/**
 * 将配置持久化保存到磁盘
 */
function saveConfigToFile(filePath) {
  const p = filePath || pluginConfigPath;
  if (!p) return;
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // 确保 dnd_list_str 与 dnd_list 保持同步
    currentConfig.dnd_list_str = (currentConfig.dnd_list || []).join(', ');
    fs.writeFileSync(p, JSON.stringify(currentConfig, null, 2), 'utf-8');
    logger?.info('[Relay] 配置已成功持久化至磁盘:', p);
  } catch (err) {
    logger?.error('[Relay] 保存配置文件失败:', err);
  }
}

/**
 * 从磁盘加载历史映射表
 */
function loadMessageMap() {
  try {
    if (!dataDir) return;
    const mapFile = path.join(dataDir, 'message_map.json');
    if (fs.existsSync(mapFile)) {
      const data = JSON.parse(fs.readFileSync(mapFile, 'utf-8'));
      if (Array.isArray(data)) {
        messageMap.clear();
        for (const item of data) {
          if (item && item.id && item.info) {
            messageMap.set(String(item.id), item.info);
          }
        }
        logger?.info(`[Relay] 成功从磁盘加载 ${messageMap.size} 条历史消息映射`);
      }
    }
  } catch (err) {
    logger?.warn('[Relay] 加载消息映射文件失败:', err);
  }
}

/**
 * 保存消息映射表到磁盘 (防抖保存)
 */
function saveMessageMapNow() {
  if (!dataDir) return;
  writeJsonAtomic(path.join(dataDir, 'message_map.json'),
    [...messageMap].map(([id, info]) => ({ id, info })));
}

function scheduleSaveMessageMap() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { saveMessageMapNow(); }
    catch (err) { logger?.warn('[Relay] 保存消息映射文件失败:', err); }
  }, 2000);
}

/**
 * 记录一条发送出的消息映射
 */
function recordMessageMapping(sentId, info) {
  if (!sentId) return;
  const key = String(sentId);
  if (messageMap.size >= MAX_MAP_SIZE) {
    const oldestKey = messageMap.keys().next().value;
    if (oldestKey) messageMap.delete(oldestKey);
  }
  messageMap.set(key, { ...info, target_qq: String(currentConfig.target_qq || "") });
  scheduleSaveMessageMap();
}

/**
 * 获取机器人自身的 QQ 号
 */
async function getSelfUin(ctx) {
  if (ctx.core?.selfInfo?.uin) return String(ctx.core.selfInfo.uin).trim();
  try {
    const loginInfo = await callAction(ctx, 'get_login_info', {});
    if (loginInfo?.user_id) return String(loginInfo.user_id).trim();
  } catch (e) {}
  return '';
}

/**
 * 已加入群列表缓存
 */
let joinedGroupCache = {
  time: 0,
  ids: new Set()
};

/**
 * 获取机器人当前实际已加入的群号列表（带5分钟缓存）
 */
async function getJoinedGroupIds(ctx, forceRefresh = false) {
  if (!ctx?.actions) return joinedGroupCache.ids;
  const now = Date.now();
  if (!forceRefresh && joinedGroupCache.time > 0 && (now - joinedGroupCache.time < 300000)) {
    return joinedGroupCache.ids;
  }
  try {
    const rawList = await callAction(ctx, 'get_group_list', { no_cache: forceRefresh });
    const list = Array.isArray(rawList) ? rawList : (Array.isArray(rawList?.data) ? rawList.data : []);
    if (Array.isArray(rawList) || Array.isArray(rawList?.data)) {
      const set = new Set();
      for (const g of list) {
        if (g && (g.group_id !== undefined && g.group_id !== null)) {
          set.add(String(g.group_id).trim());
        }
      }
      joinedGroupCache = { time: now, ids: set };
      return set;
    }
  } catch (err) {
    logger?.debug?.('[Relay] 获取机器人已加入群列表失败:', err);
  }
  return joinedGroupCache.ids;
}

/**
 * 获取所有未过滤的受保护群号列表（去重）
 */
function getRawProtectedGroupIds() {
  const set = new Set();
  const raw = currentConfig.schedule_groups || '';
  for (const part of raw.split(/[,，\s\n]+/)) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) {
      set.add(trimmed);
    }
  }
  for (const gid of protectedGroupCards.keys()) {
    if (/^\d+$/.test(gid)) {
      set.add(gid);
    }
  }
  return Array.from(set);
}

/**
 * 同步获取受保护群号（若有缓存则自动过滤不在的群）
 */
function getProtectedGroupIdsSync() {
  const allIds = getRawProtectedGroupIds();
  if (joinedGroupCache.time > 0) {
    return allIds.filter(id => joinedGroupCache.ids.has(id));
  }
  return allIds;
}

/**
 * 获取所有受保护的群号列表（自动过滤机器人未加入或已退出的群）
 */
async function getProtectedGroupIds(ctx) {
  const allIds = getRawProtectedGroupIds();
  if (!ctx) return getProtectedGroupIdsSync();
  try {
    const joined = await getJoinedGroupIds(ctx);
    if (joinedGroupCache.time > 0) {
      return allIds.filter(id => joined.has(id));
    }
  } catch (e) {}
  return allIds;
}

/**
 * 从磁盘加载受保护群名片配置
 */
function loadProtectedCards() {
  try {
    if (!dataDir) return;
    const cardsFile = path.join(dataDir, 'protected_group_cards.json');
    if (fs.existsSync(cardsFile)) {
      const data = JSON.parse(fs.readFileSync(cardsFile, 'utf-8'));
      if (typeof data === 'object' && data !== null) {
        protectedGroupCards.clear();
        for (const [gid, card] of Object.entries(data)) {
          if (gid && typeof card === 'string') {
            protectedGroupCards.set(String(gid).trim(), card.trim());
          }
        }
        logger?.info(`[Relay Card] 成功从磁盘加载 ${protectedGroupCards.size} 个群的名片保护配置`);
      }
    }
  } catch (err) {
    logger?.warn('[Relay Card] 读取群名片保护文件失败:', err);
  }
}

/**
 * 保存受保护群名片配置到磁盘
 */
function saveProtectedCards() {
  try {
    if (!dataDir) return;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const cardsFile = path.join(dataDir, 'protected_group_cards.json');
    const obj = {};
    for (const [gid, card] of protectedGroupCards.entries()) {
      obj[gid] = card;
    }
    fs.writeFileSync(cardsFile, JSON.stringify(obj, null, 2), 'utf-8');
    logger?.debug?.(`[Relay Card] 群名片保护配置已保存: ${protectedGroupCards.size} 个群`);
  } catch (err) {
    logger?.warn('[Relay Card] 保存群名片保护配置失败:', err);
  }
}

/**
 * 执行群名片恢复改回
 */
async function executeCardRestore(ctx, groupId, isManual = false) {
  const gId = String(groupId || '').trim();
  if (!isManual && (!pluginActive || !currentConfig.auto_protect_group_card)) return { success: false, message: '群名片保护已关闭' };
  const pending = pendingCardRestores.get(gId);
  if (pending?.timer) {
    clearTimeout(pending.timer);
  }
  pendingCardRestores.delete(gId);

  // 实时强制刷新群列表，检查机器人是否仍在群中
  const joined = await getJoinedGroupIds(ctx, true);
  if (joinedGroupCache.time > 0 && !joined.has(gId)) {
    logger?.warn(`[Relay Card] 机器人已不在群 [${gId}]，跳过名片改回并自动移除保护`);
    if (protectedGroupCards.has(gId)) {
      protectedGroupCards.delete(gId);
      saveProtectedCards();
    }
    const targetQq = String(currentConfig.target_qq || '').trim();
    if (isManual && targetQq) {
      try {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `⚠️ 【群名片改回跳过】\n━━━━━━━━━━━━━━━\n👥 目标群聊: ${pending?.groupName || gId} (${gId})\n⚠️ 机器人当前已不在该群中，已自动移除该群的名片保护。`
        });
      } catch (e) {}
    }
    return { success: false, message: `机器人已不在群 [${gId}]` };
  }

  const expectedCard = (protectedGroupCards.get(gId) || currentConfig.default_group_card || '').trim();
  if (!expectedCard) return { success: false, message: '未找到期望名片配置' };

  const targetQq = String(currentConfig.target_qq || '').trim();
  const selfUin = await getSelfUin(ctx);
  if (!selfUin) return { success: false, message: '无法获取机器人自身QQ号' };

  try {
    await callAction(ctx, 'set_group_card', {
      group_id: Number(gId),
      user_id: Number(selfUin),
      card: expectedCard
    });

    logger?.info(`[Relay Card] ✅ 成功将群 [${gId}] 的群名片改回: "${expectedCard}" (${isManual ? '手动执行' : '自动恢复'})`);

    if (targetQq) {
      const tip = isManual
        ? `✅ 【群名片手动改回成功】\n━━━━━━━━━━━━━━━\n👥 目标群聊: ${pending?.groupName || gId} (${gId})\n🏷️ 名片已立即恢复为: ${expectedCard}`
        : `✅ 【群名片自动恢复成功】\n━━━━━━━━━━━━━━━\n👥 目标群聊: ${pending?.groupName || gId} (${gId})\n🏷️ 已度过防抢保护期，名片已自动恢复为: ${expectedCard}`;

      try {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: tip
        });
      } catch (e) {}
    }
    return { success: true, message: '成功' };
  } catch (err) {
    const errMsg = err?.message || String(err);
    // 若提示成员不存在或未加入群，从受保护列表中移除
    if (errMsg.includes('不存在') || errMsg.includes('未加入') || errMsg.includes('不在群')) {
      if (protectedGroupCards.has(gId)) {
        protectedGroupCards.delete(gId);
        saveProtectedCards();
      }
    }
    logger?.error(`[Relay Card] ❌ 改回群 [${gId}] 群名片失败:`, err);
    if (targetQq) {
      try {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `❌ 【群名片改回失败】\n━━━━━━━━━━━━━━━\n👥 目标群聊: ${pending?.groupName || gId} (${gId})\n⚠️ 尝试改回「${expectedCard}」失败: ${errMsg}`
        });
      } catch (e) {}
    }
    return { success: false, message: errMsg };
  }
}

/**
 * 检查名片并调度延迟改回任务
 */
async function checkAndScheduleCardRestore(ctx, groupId, currentCard, groupName = '') {
  if (!currentConfig.auto_protect_group_card) return;
  const gId = String(groupId || '').trim();
  if (!gId) return;

  const protectedIds = await getProtectedGroupIds(ctx);
  if (!protectedIds.includes(gId)) return;

  const expectedCard = (protectedGroupCards.get(gId) || currentConfig.default_group_card || '').trim();
  if (!expectedCard) return;

  const cleanCurrentCard = (currentCard || '').trim();

  // 若当前名片已与期望名片一致，若有待执行任务则取消
  if (cleanCurrentCard === expectedCard) {
    if (pendingCardRestores.has(gId)) {
      const pending = pendingCardRestores.get(gId);
      if (pending?.timer) clearTimeout(pending.timer);
      pendingCardRestores.delete(gId);
      logger?.info(`[Relay Card] 群 [${gId}] 名片已恢复为期望名片 "${expectedCard}"，已自动取消待执行改回任务`);
    }
    return;
  }

  // 检测到不一致，排队延迟改回
  const delayMinutes = Math.max(1, Number(currentConfig.protect_card_delay_minutes) || 10);
  const now = Date.now();
  const scheduledAt = now + delayMinutes * 60 * 1000;
  const targetQq = String(currentConfig.target_qq || '').trim();

  // 若该群已有排队任务，仅更新其被修改的名片记录，保持既有倒计时不重复发通知
  if (pendingCardRestores.has(gId)) {
    const existing = pendingCardRestores.get(gId);
    existing.newCard = cleanCurrentCard;
    if (groupName && !existing.groupName) existing.groupName = groupName;
    return;
  }

  const dateObj = new Date(scheduledAt);
  const targetTimeStr = `${String(dateObj.getHours()).padStart(2, '0')}:${String(dateObj.getMinutes()).padStart(2, '0')}:${String(dateObj.getSeconds()).padStart(2, '0')}`;

  const restoreTask = {
    expectedCard,
    oldCard: expectedCard,
    newCard: cleanCurrentCard,
    detectedAt: now,
    scheduledAt,
    groupName: groupName || gId,
    timer: null
  };

  restoreTask.timer = setTimeout(async () => {
    await executeCardRestore(ctx, gId, false);
  }, delayMinutes * 60 * 1000);

  pendingCardRestores.set(gId, restoreTask);

  logger?.warn(`[Relay Card] ⚠️ 检测到群 [${gId}] 名片被修改为: "${cleanCurrentCard}" (期望: "${expectedCard}")。已排队将在 ${delayMinutes} 分钟后 (${targetTimeStr}) 自动改回`);

  if (targetQq) {
    const alertMsg =
      `⚠️ 【群名片被修改警告】\n` +
      `━━━━━━━━━━━━━━━\n` +
      `👥 目标群聊: ${groupName || gId} (${gId})\n` +
      `🏷️ 原设定名片: ${expectedCard}\n` +
      `❌ 被修改为: ${cleanCurrentCard ? cleanCurrentCard : '【被清空/默认昵称】'}\n` +
      `⏳ 防抢冲突保护已启动：将在 ${delayMinutes} 分钟后（预计 ${targetTimeStr}）自动改回。\n` +
      `━━━━━━━━━━━━━━━\n` +
      `💡 快捷指令：\n` +
      `• 发送「#立即改名片 ${gId}」立即改回\n` +
      `• 发送「#取消改名片 ${gId}」取消本次自动改回\n` +
      `• 发送「#设置群名片 ${gId} <新名片>」修改期望名片`;

    try {
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: alertMsg
      });
    } catch (e) {
      logger?.error('[Relay Card] 发送群名片被篡改警告失败:', e);
    }
  }
}

/**
 * 轮询检查所有受保护群名片（安全兜底）
 */
async function pollCheckProtectedGroupCards(ctx) {
  if (!currentConfig.auto_protect_group_card) return;
  const selfUin = await getSelfUin(ctx);
  if (!selfUin) return;

  const groupIds = await getProtectedGroupIds(ctx);
  for (const gId of groupIds) {
    if (pendingCardRestores.has(gId)) continue;
    try {
      const info = await callAction(ctx, 'get_group_member_info', {
        group_id: Number(gId),
        user_id: Number(selfUin),
        no_cache: true
      });
      if (info && (info.card !== undefined || info.nickname !== undefined)) {
        const currentCard = (info.card || '').trim();
        const expectedCard = (protectedGroupCards.get(gId) || currentConfig.default_group_card || '').trim();
        if (expectedCard && currentCard !== expectedCard) {
          await checkAndScheduleCardRestore(ctx, gId, currentCard);
        }
      }
    } catch (e) {
      const errMsg = e?.message || String(e);
      // 若明确提示成员不存在或未加入群，从受保护列表中移除
      if (errMsg.includes('不存在') || errMsg.includes('未加入') || errMsg.includes('不在群')) {
        logger?.info?.(`[Relay Card] 机器人已不在群 [${gId}]，自动清理名片保护基线`);
        if (protectedGroupCards.has(gId)) {
          protectedGroupCards.delete(gId);
          saveProtectedCards();
        }
      }
    }
  }
}

/**
 * 初始化群名片保护基线
 */
async function initProtectedGroupCards(ctx) {
  loadProtectedCards();
  // 等待 8 秒以便 QQ NT 核心完成群列表与成员初始化同步
  await new Promise(resolve => setTimeout(resolve, 8000));
  if (!pluginActive) return;

  const selfUin = await getSelfUin(ctx);
  if (!selfUin) return;

  const groupIds = await getProtectedGroupIds(ctx);
  let updated = false;
  for (const gid of groupIds) {
    if (!protectedGroupCards.has(gid)) {
      try {
        const info = await callAction(ctx, 'get_group_member_info', {
          group_id: Number(gid),
          user_id: Number(selfUin),
          no_cache: true
        });
        const card = (info?.card || '').trim();
        if (card) {
          protectedGroupCards.set(gid, card);
          updated = true;
          logger?.info(`[Relay Card] 自动识别并建立群 [${gid}] 名片防篡改基线: "${card}"`);
        } else if (currentConfig.default_group_card) {
          protectedGroupCards.set(gid, currentConfig.default_group_card.trim());
          updated = true;
          logger?.info(`[Relay Card] 群 [${gid}] 当前名片为空，设定为默认名片: "${currentConfig.default_group_card.trim()}"`);
        }
      } catch (e) {
        logger?.debug?.(`[Relay Card] 检查群 [${gid}] 成员名片失败:`, e?.message || e);
      }
    }
  }
  if (updated) {
    saveProtectedCards();
  }

  // 初始检查一次所有受保护群名片
  await pollCheckProtectedGroupCards(ctx);
}

/**
 * 查找待处理的好友申请 (优先从内存查询，找不到再尝试 NT 内核)
 */
async function findPendingFriendRequest(ctx, queryId) {
  if (!queryId) return null;
  const qStr = String(queryId).trim();

  // 1. 从内存映射查询
  if (pendingFriendRequests.has(qStr)) {
    return pendingFriendRequests.get(qStr);
  }

  for (const request of messageMap.values()) {
    if (request.is_friend_request && !request.processed &&
        (String(request.user_id) === qStr || String(request.flag) === qStr) &&
        ![...messageMap.values()].some(m => m.is_friend_request && m.flag === request.flag && m.processed)) return request;
  }

  // 2. 尝试从 NT 内核查询好友申请列表
  try {
    const friendApi = ctx.core?.apis?.FriendApi;
    const userApi = ctx.core?.apis?.UserApi;
    if (friendApi && typeof friendApi.getBuddyReq === 'function') {
      const resp = await friendApi.getBuddyReq();
      if (resp && Array.isArray(resp.buddyReqs)) {
        for (const req of resp.buddyReqs) {
          if (!req || req.isDecide) continue;
          let uin = '';
          if (userApi && typeof userApi.getUinByUidV2 === 'function' && req.friendUid) {
            try { uin = await userApi.getUinByUidV2(req.friendUid); } catch (e) {}
          }
          if (String(req.reqTime) === qStr || String(uin) === qStr || String(req.friendUid) === qStr) {
            return {
              user_id: String(uin || qStr),
              nickname: req.friendNick || String(uin || qStr),
              flag: String(req.reqTime),
              comment: req.extWords || '',
              time: req.reqTime ? Number(req.reqTime) * 1000 : Date.now()
            };
          }
        }
      }
    }
  } catch (e) {
    logger?.debug('[Relay] 查询 Kernel getBuddyReq 异常:', e);
  }

  return null;
}

/**
 * 执行同意或拒绝好友申请
 */
async function executeFriendRequestAction(ctx, reqInfo, approve, remark, targetQq) {
  const flag = String(reqInfo.flag || '');
  const records = [...messageMap.values()].filter(m => m.is_friend_request && m.flag === flag);
  if (reqInfo.processed || records.some(m => m.processed)) {
    await callAction(ctx, 'send_private_msg', { user_id: targetQq, message: '该好友申请已经处理，请勿重复审批。' });
    return;
  }
  if (!flag || friendApprovalsInFlight.has(flag)) return;
  friendApprovalsInFlight.add(flag);
  try {
    try {
      await callAction(ctx, 'set_friend_add_request', { flag, approve, remark: remark || '' });
    } catch (err) {
      // Approval failure is not success: an already-friend fallback needs current evidence.
      if (!approve) throw err;
      const friends = await callAction(ctx, 'get_friend_list', {});
      const list = Array.isArray(friends) ? friends : friends?.data;
      if (!Array.isArray(list) || !list.some(f => String(f.user_id) === String(reqInfo.user_id))) throw err;
      if (remark) await callAction(ctx, 'set_friend_remark', { user_id: Number(reqInfo.user_id), remark });
    }
    reqInfo.processed = true;
    for (const record of records) record.processed = true;
    recordMessageMapping(`friend:${flag}`, { ...reqInfo, is_friend_request: true, processed: true });
    saveMessageMapNow();
    for (const [key, req] of pendingFriendRequests) {
      if (String(req.flag) === flag) pendingFriendRequests.delete(key);
    }
    if (approve && remark) friendCache.set(String(reqInfo.user_id), {
      nickname: reqInfo.nickname || '', remark, lastUpdated: Date.now()
    });
    await callAction(ctx, 'send_private_msg', {
      user_id: targetQq,
      message: `${approve ? '✅ 已同意' : '❌ 已拒绝'}好友申请: ${reqInfo.nickname || ''} (${reqInfo.user_id})${remark ? `\n备注: ${remark}` : ''}`
    });
  } catch (err) {
    logger?.error('[Relay] 好友申请审批失败:', err);
    await callAction(ctx, 'send_private_msg', { user_id: targetQq, message: `❌ 处理好友申请失败: ${err.message || err}` });
  } finally { friendApprovalsInFlight.delete(flag); }
}

/**
 * 统一处理好友申请：自动同意或向管理员推送交互审核卡片
 */
async function processFriendRequestAndNotify(ctx, reqInfo, targetQq) {
  const applicantId = String(reqInfo.user_id || '').trim();
  const displayName = reqInfo.nickname || await getUserDisplayName(ctx, applicantId, applicantId);
  const flag = String(reqInfo.flag || '');
  const comment = reqInfo.comment || '';

  const automatic = currentConfig.auto_approve_friend ||
    (String(currentConfig.auto_approve_keyword || '').trim() && comment.includes(String(currentConfig.auto_approve_keyword).trim()));
  if (!automatic && !currentConfig.forward_friend_request) return;
  if (!flag || friendNotificationsInFlight.has(flag)) return;
  if ([...messageMap.values()].some(m => m.is_friend_request && m.flag === flag)) return;
  friendNotificationsInFlight.add(flag);
  try {
  if (automatic) {
    try {
      await callAction(ctx, 'set_friend_add_request', { flag, approve: true });
      recordMessageMapping(`friend:${flag}`, { ...reqInfo, is_friend_request: true, processed: true });
      saveMessageMapNow();
    } catch (err) { logger?.error('[Relay] 自动同意好友申请失败:', err); }
    // Automatic approval is intentionally silent, including keyword matches.
    return;
  }

  // 2. 构建并向管理员推送审核通知卡片
  const timeStr = new Date(reqInfo.time || Date.now()).toLocaleString('zh-CN', { hour12: false });
  const notifyText =
    `👤 【收到新的好友申请】\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📌 申请人: ${displayName} (${applicantId})\n` +
    `📝 验证消息: ${comment || '(无附言)'}\n` +
    `⏱️ 申请时间: ${timeStr}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `👉 处理方式（二选一）:\n` +
    `1. 直接【引用回复】本消息：\n` +
    `   • 回复「同意」或「同意 备注名」（支持 /同意、#同意）\n` +
    `   • 回复「拒绝」（支持 /拒绝、#拒绝）\n` +
    `2. 发送指令：\n` +
    `   • #同意 ${applicantId} [备注名]\n` +
    `   • #拒绝 ${applicantId}`;

  try {
    const res = await callAction(ctx, 'send_private_msg', {
      user_id: targetQq,
      message: notifyText
    });

    if (res && res.message_id) {
      const sentId = String(res.message_id);
      // 记录到引用回复映射
      recordMessageMapping(sentId, {
        is_friend_request: true,
        user_id: applicantId,
        nickname: displayName,
        flag,
        comment,
        time: Date.now()
      });
      // 记录到待办申请表
      pendingFriendRequests.set(sentId, reqInfo);
    }
    pendingFriendRequests.set(applicantId, reqInfo);
    pendingFriendRequests.set(flag, reqInfo);

    logger?.info(`[Relay] 已将 ${displayName}(${applicantId}) 的好友申请推达管理员 QQ: ${targetQq}`);
  } catch (err) {
    logger?.error('[Relay] 推送好友申请至管理员失败:', err);
  }
  } finally { friendNotificationsInFlight.delete(flag); }
}

/**
 * 处理好友申请事件 (OneBot 11 request.friend)
 */
async function handleFriendRequestEvent(ctx, event) {
  if (!currentConfig.forward_friend_request && !currentConfig.auto_approve_friend && !currentConfig.auto_approve_keyword) return;

  const targetQq = String(currentConfig.target_qq || '').trim();
  if (!targetQq) return;

  const applicantId = String(event.user_id || '').trim();
  const flag = String(event.flag || '');
  const comment = event.comment || '';

  // 获取申请人备注名或昵称 (优先备注名)
  const displayName = await getUserDisplayName(ctx, applicantId, applicantId);

  const reqInfo = {
    user_id: applicantId,
    nickname: displayName,
    flag,
    comment,
    time: event.time ? Number(event.time) * 1000 : Date.now()
  };

  await processFriendRequestAndNotify(ctx, reqInfo, targetQq);
}

/**
 * 检查当前会话框是否处于免打扰状态 (Do Not Disturb)
 * @param {object} ctx NapCat 上下文
 * @param {object} event 接收到的消息事件
 * @returns {Promise<boolean>} 若免打扰则返回 true
 */
async function readGroupMasks(ctx) {
  if (groupMaskCache && Date.now() - groupMaskCacheTime < GROUP_MASK_CACHE_TTL) return groupMaskCache;
  if (!groupMaskRefresh) {
    groupMaskRefresh = (async () => {
      let masks;
      if (typeof ctx.core?.eventWrapper?.callNormalEventV2 === 'function') {
        // QQ returns only an ACK from getGroupMsgMask; actual masks arrive on this listener.
        const [, result] = await ctx.core.eventWrapper.callNormalEventV2(
          'NodeIKernelGroupService/getGroupMsgMask', 'NodeIKernelGroupListener/onGroupsMsgMaskResult',
          [], r => r.result === 0, () => true, 1, 3000
        );
        masks = result;
      } else {
        masks = await ctx.core?.context?.session?.getGroupService?.()?.getGroupMsgMask?.();
      }
      groupMaskCache = masks?.groupMaskMap ?? masks?.groupCodeMap ?? masks?.data ?? masks;
      groupMaskCacheTime = Date.now();
      return groupMaskCache;
    })().finally(() => { groupMaskRefresh = null; });
  }
  return groupMaskRefresh;
}

async function readContactDND(ctx, chatType, peerUid, peerUin) {
  const key = `${chatType}:${peerUid}`;
  const cached = contactDndCache.get(key);
  if (cached && Date.now() - cached.time < GROUP_MASK_CACHE_TTL) return cached.contact;
  const service = ctx.core?.context?.session?.getRecentContactService?.();
  let contacts;
  if (typeof service?.getContacts === 'function') {
    const result = await service.getContacts([{ chatType, peerUid, guildId: '' }]);
    contacts = result?.foundContacts;
  }
  let contact = contacts?.find(c => Number(c.chatType) === chatType &&
    (String(c.peerUid) === peerUid || String(c.peerUin) === peerUin));
  if (!contact && typeof ctx.core?.apis?.UserApi?.getRecentContactListSnapShot === 'function') {
    const snapshot = await ctx.core.apis.UserApi.getRecentContactListSnapShot(100);
    contact = snapshot?.info?.changedList?.find(c => Number(c.chatType) === chatType &&
      (String(c.peerUid) === peerUid || String(c.peerUin) === peerUin));
  }
  // Keep only DND flags, never cache message bodies from native recent contacts.
  const flags = contact ? { isMsgDisturb: contact.isMsgDisturb, isBlock: contact.isBlock } : null;
  if (flags) {
    contactDndCache.set(key, { time: Date.now(), contact: flags });
    if (contactDndCache.size > 5000) contactDndCache.delete(contactDndCache.keys().next().value);
  }
  return flags;
}

async function isChatDND(ctx, event) {
  const senderId = String(event.user_id || '');
  const groupId = String(event.group_id || '');
  const manual = (currentConfig.dnd_list || []).map(String);
  if (manual.includes(senderId) || (groupId && manual.includes(groupId))) return true;
  if (!currentConfig.ignore_dnd) return false;
  const mutedMask = value => [2, 3, 4].includes(Number(value?.msgMask ?? value?.groupMask ?? value?.mask ?? value));
  const raw = event.raw || {};
  if (raw.isMsgDisturb === true || raw.isBlock === true) return true;
  if (event.message_type === 'group' && groupId) {
    if (mutedMask(raw.groupMask) || raw.elements?.some(el => mutedMask(el?.extraInfo?.groupMask))) return true;
    try {
      const masks = await readGroupMasks(ctx);
      let value;
      if (masks instanceof Map) value = masks.get(groupId) ?? masks.get(Number(groupId)) ?? masks.get(BigInt(groupId));
      else if (Array.isArray(masks)) value = masks.find(m => String(m.groupCode ?? m.code ?? m.id) === groupId);
      else value = masks?.[groupId];
      if (mutedMask(value)) return true;
    } catch (err) { logger?.debug('[Relay] 读取群免打扰状态失败:', err); }
    try {
      const contact = await readContactDND(ctx, 2, groupId, groupId);
      if (contact?.isMsgDisturb === true || contact?.isBlock === true) return true;
    } catch (err) { logger?.debug('[Relay] 读取群会话状态失败:', err); }
  }
  if (event.message_type === 'private' && senderId) {
    try {
      const buddy = ctx.core?.context?.session?.getBuddyService?.();
      const uid = event.sender?.uid || raw.senderUid || raw.peerUid ||
        await ctx.core?.apis?.UserApi?.getUidByUinV2?.(senderId);
      if (uid && buddy) {
        const blocked = typeof buddy.isBlocked === 'function' ? await buddy.isBlocked(uid) : false;
        if (blocked === true || blocked === 1 || blocked?.isBlocked === true) return true;
      }
      if (uid) {
        const contact = await readContactDND(ctx, 1, String(uid), senderId);
        if (contact?.isMsgDisturb === true || contact?.isBlock === true) return true;
      }
      if (raw.isMsgNotify === false || raw.isMsgNotify === 0) return true;
    } catch (err) { logger?.debug('[Relay] 读取私聊免打扰状态失败:', err); }
  }
  return false;
}

// ========================================================
// 群定时活跃度追踪与防刷屏持久化模块
// ========================================================

/**
 * 获取今日日期字符串 YYYY-MM-DD
 */
function getTodayDateStr(date = new Date()) {
  const { year, month, day } = localClock(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 获取指定群的活跃度记录
 */
function getGroupActivity(groupId) {
  const gId = String(groupId).trim();
  if (!groupActivityMap.has(gId)) {
    groupActivityMap.set(gId, {
      lastAttemptDate: '',
      lastSentDate: '',
      lastSentTime: 0,
      otherMsgCount: 0,
      waitingForActivity: false
    });
  }
  return groupActivityMap.get(gId);
}

/**
 * 从磁盘加载群定时活跃度记录
 */
function loadGroupActivity() {
  try {
    if (!dataDir) return;
    const file = path.join(dataDir, 'group_schedule_activity.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof data === 'object' && data !== null) {
        groupActivityMap.clear();
        for (const [gid, val] of Object.entries(data)) {
          if (gid && typeof val === 'object' && val !== null) {
            groupActivityMap.set(String(gid).trim(), {
              lastAttemptDate: String(val.lastAttemptDate || ''),
              lastSentDate: String(val.lastSentDate || ''),
              lastSentTime: Number(val.lastSentTime) || 0,
              otherMsgCount: Number(val.otherMsgCount) || 0,
              waitingForActivity: Boolean(val.waitingForActivity)
            });
          }
        }
        logger?.info(`[Relay Schedule] 成功从磁盘加载 ${groupActivityMap.size} 个群的活跃度防刷屏记录`);
      }
    }
  } catch (e) {
    logger?.warn('[Relay Schedule] 读取群活跃度记录失败:', e);
  }
}

/**
 * 保存群定时活跃度记录到磁盘
 */
function saveGroupActivity() {
  try {
    if (!dataDir) throw new Error('未设置插件数据目录');
    writeJsonAtomic(path.join(dataDir, 'group_schedule_activity.json'), Object.fromEntries(groupActivityMap));
    return true;
  } catch (e) {
    logger?.error('[Relay Schedule] 保存群活跃度记录失败，暂停发送以避免重复:', e);
    return false;
  }
}

/**
 * 防抖保存群定时活跃度记录 (5秒防抖)
 */
function saveGroupActivityDebounced() {
  if (groupActivitySaveTimer) return;
  groupActivitySaveTimer = setTimeout(() => {
    groupActivitySaveTimer = null;
    saveGroupActivity();
  }, 5000);
}

function activityHistoryCheckDue(groupId) {
  const previous = activityHistoryChecks.get(String(groupId));
  return !previous || previous.since !== getGroupActivity(groupId).lastSentTime ||
    previous.threshold !== activityThreshold() || Date.now() - previous.time >= ACTIVITY_HISTORY_TTL;
}

async function refreshActivityFromHistory(ctx, groupId) {
  const gid = String(groupId);
  const activity = getGroupActivity(gid);
  const since = activity.lastSentTime;
  if (!since || activity.otherMsgCount > activityThreshold() || !activityHistoryCheckDue(gid)) return;
  activityHistoryChecks.set(gid, { time: Date.now(), since, threshold: activityThreshold() });
  try {
    const self = await getSelfUin(ctx);
    if (!self) return;
    const seen = new Set();
    let cursor;
    let count = 0;
    // shortcut: read up to 20 pages per check; raise this cap if large thresholds need deeper history.
    for (let page = 0; page < 20 && count <= activityThreshold(); page++) {
      const data = await callAction(ctx, 'get_group_msg_history', {
        group_id: Number(gid), count: 100, reverse_order: false,
        disable_get_url: true, parse_mult_msg: false,
        ...(cursor ? { message_seq: cursor } : {})
      });
      const messages = Array.isArray(data) ? data : data?.messages;
      if (!Array.isArray(messages)) throw new Error('群历史记录返回格式异常');
      if (!messages.length) break;
      const valid = messages.filter(m => Number.isFinite(Number(m.time)) && Number(m.time) > 0)
        .sort((a, b) => Number(a.time) - Number(b.time) || Number(a.message_seq || 0) - Number(b.message_seq || 0));
      for (const message of valid) {
        const id = message.message_id;
        const sender = message.user_id ?? message.sender?.user_id;
        if (id === undefined || sender === undefined || seen.has(String(id))) continue;
        seen.add(String(id));
        if (message.group_id !== undefined && String(message.group_id) !== gid) continue;
        // Historical timestamps have second precision; exclude ambiguous messages in the send's own second.
        if (Number(message.time) * 1000 <= since || String(sender) === self) continue;
        count++;
        activityMessageIds.set(`${gid}:${id}`, true);
        if (activityMessageIds.size > 10000) activityMessageIds.delete(activityMessageIds.keys().next().value);
      }
      const oldest = valid[0];
      if (!oldest || Number(oldest.time) * 1000 <= since) break;
      // NapCat resolves this parameter through its short message-id table, despite its sequence name.
      const nextCursor = oldest.message_id === undefined ? '' : String(oldest.message_id);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    if (!pluginActive || activity.lastSentTime !== since) return;
    // History overlaps the live counter: never add the two counts together.
    if (count > activity.otherMsgCount) {
      activity.otherMsgCount = count;
      saveGroupActivity();
      logger?.info(`[Relay Schedule] 群 [${gid}] 已用历史记录修正其他成员发言计数: ${count}`);
    }
  } catch (err) { logger?.warn(`[Relay Schedule] 群 [${gid}] 历史活跃度复核失败，保留现有计数:`, err); }
}

// ========================================================
// 定时群发月薪喵表情包核心调度模块
// ========================================================

let catImageBase64Cache = null;
let scheduleTimer = null;
const schedulerStateKey = Symbol.for('napcat-plugin-relay.scheduler');
// 今日随机调度计划: slot ("09:00") -> { slot, targetTimestamp, targetTimeStr, state, offsetMinutes: string }
const dailySchedulePlan = new Map();
let currentPlanDate = '';

/**
 * 生成或更新当天的定时任务随机执行计划
 * @param {Date} now 当前时间
 * @param {boolean} force 是否强制重新计算未触发任务的随机时间
 */
function generateDailySchedulePlan(now = new Date(), force = false) {
  const date = getTodayDateStr(now);
  const isNewDay = currentPlanDate !== date;
  const signature = JSON.stringify([currentConfig.schedule_times, currentConfig.schedule_random_minutes]);
  if (isNewDay) {
    dailySchedulePlan.clear();
    currentPlanDate = date;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'daily_schedule_plan.json'), 'utf-8'));
      if (saved.date === date && saved.signature === signature) {
        for (const plan of saved.plans) {
          if (typeof plan.slot === 'string' && Number.isFinite(plan.targetTimestamp)) {
            dailySchedulePlan.set(plan.slot, { ...plan, state: plan.state === 'sending' ? 'pending' : plan.state });
          }
        }
      }
    } catch (e) { /* First start or old plan: generate today's plan below. */ }
  }
  const slots = [...new Set(String(currentConfig.schedule_times || '').split(/[,，\s]+/)
    .filter(t => /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(t))
    .map(t => t.padStart(5, '0')))];
  const { year, month, day } = localClock(now);
  const midnight = Date.UTC(year, month - 1, day) - 8 * 3600000;
  const earliest = midnight + 8 * 3600000;
  const latest = midnight + 24 * 3600000 - 1000;
  const randomMs = Math.min(1440, Math.max(0, Number(currentConfig.schedule_random_minutes) || 0)) * 60000;
  for (const slot of slots) {
    const previous = dailySchedulePlan.get(slot);
    if (previous && (!force || previous.state !== 'pending')) continue;
    const [h, m] = slot.split(':').map(Number);
    const base = midnight + (h * 60 + m) * 60000;
    // Intersect the random window with 08:00..23:59:59 of this Shanghai calendar day.
    const low = Math.max(earliest, Math.min(latest, base - randomMs));
    const high = Math.max(low, Math.min(latest, base + randomMs));
    const targetTimestamp = low + Math.floor(Math.random() * (Math.floor((high - low) / 1000) + 1)) * 1000;
    const t = localClock(new Date(targetTimestamp));
    dailySchedulePlan.set(slot, {
      slot, targetTimestamp,
      targetTimeStr: [t.hour, t.minute, t.second].map(v => String(v).padStart(2, '0')).join(':'),
      state: targetTimestamp < now.getTime() - 60000 ? 'skipped' : 'pending',
      offsetMinutes: ((targetTimestamp - base) / 60000).toFixed(1), sentAt: null, result: null
    });
  }
  for (const slot of dailySchedulePlan.keys()) {
    if (!slots.includes(slot)) dailySchedulePlan.delete(slot);
  }
  saveDailySchedulePlan();
}

function saveDailySchedulePlan() {
  if (!dataDir) return;
  try {
    writeJsonAtomic(path.join(dataDir, 'daily_schedule_plan.json'), {
      date: currentPlanDate,
      signature: JSON.stringify([currentConfig.schedule_times, currentConfig.schedule_random_minutes]),
      plans: [...dailySchedulePlan.values()]
    });
  } catch (err) { logger?.warn('[Relay Schedule] 保存随机发送计划失败:', err); }
}

/**
 * 获取内置月薪喵表情包的 Base64 编码
 */
function getCatImageBase64() {
  if (catImageBase64Cache) return catImageBase64Cache;
  try {
    if (fs.existsSync(defaultCatPath)) {
      const buf = fs.readFileSync(defaultCatPath);
      catImageBase64Cache = `base64://${buf.toString('base64')}`;
      logger?.debug?.(`[Relay Schedule] 已成功加载内置月薪喵表情包 Base64 (大小: ${buf.length} 字节)`);
      return catImageBase64Cache;
    } else {
      logger?.warn('[Relay Schedule] 内置表情包文件不存在:', defaultCatPath);
    }
  } catch (err) {
    logger?.error('[Relay Schedule] 读取内置月薪喵表情包失败:', err);
  }
  return null;
}

/**
 * 批量发送月薪喵表情包到配置的目标群聊
 */
async function sendCatToConfiguredGroups(ctx, sourceLabel = '定时任务', targetGroupOverride = null) {
  if (!pluginActive || localClock().hour < 8) {
    return { success: false, message: '北京时间 08:00 前不发送群定时消息' };
  }
  let groups = targetGroupOverride ? [String(targetGroupOverride).trim()] : configuredGroupIds();
  groups = [...new Set(groups.filter(g => /^\d+$/.test(g)))];
  const joined = await getJoinedGroupIds(ctx);
  if (joinedGroupCache.time > 0) groups = groups.filter(g => joined.has(g));
  if (!groups.length) return { success: false, message: '未配置有效且已加入的目标群号' };

  const message = [];
  const text = String(currentConfig.schedule_text || '').trim();
  if (text) message.push({ type: 'text', data: { text } });
  if (currentConfig.schedule_send_image !== false) {
    const image = String(currentConfig.schedule_custom_image || '').trim() || getCatImageBase64();
    if (!image) return { success: false, message: '无法获取表情包资源文件' };
    message.push({ type: 'image', data: { file: image } });
  }
  if (!message.length) return { success: false, message: '请填写定时文本或启用图片' };
  let successCount = 0, deferredCount = 0, failCount = 0, skippedCount = 0;
  for (const gid of groups) {
    if (groupSendsInFlight.has(gid)) { skippedCount++; continue; }
    groupSendsInFlight.add(gid);
    try {
      const date = getTodayDateStr();
      const activity = getGroupActivity(gid);
      if (!pluginActive || localClock().hour < 8 || activity.lastSentDate === date || activity.lastAttemptDate === date) {
        skippedCount++; continue;
      }
      if (currentConfig.enable_schedule_activity_check) await refreshActivityFromHistory(ctx, gid);
      if (!pluginActive || localClock().hour < 8 || getTodayDateStr() !== date) {
        skippedCount++; continue;
      }
      if (currentConfig.enable_schedule_activity_check && activity.lastSentTime > 0
          && activity.otherMsgCount <= activityThreshold()) {
        activity.waitingForActivity = true;
        deferredCount++;
        saveGroupActivity();
        continue;
      }
      // Persist a reservation before any network send. A crash/timeout must never cause a second send today.
      activity.lastAttemptDate = date;
      if (!saveGroupActivity()) { activity.lastAttemptDate = ''; failCount++; continue; }
      const countAtSend = activity.otherMsgCount;
      const sentAt = Date.now();
      const result = await callAction(ctx, 'send_group_msg', { group_id: Number(gid), message });
      if (result?.message_id === undefined) throw new Error('发送结果缺少 message_id，保留当日发送占位以防重发');
      activity.lastSentDate = date;
      activity.lastSentTime = sentAt;
      activity.otherMsgCount = Math.max(0, activity.otherMsgCount - countAtSend);
      activity.waitingForActivity = false;
      saveGroupActivity();
      successCount++;
      logger?.info(`[Relay Schedule] ${sourceLabel}: 群 [${gid}] 今日发送完成`);
    } catch (err) {
      failCount++;
      logger?.error(`[Relay Schedule] 群 [${gid}] 发送失败或结果不确定，当日不自动重试:`, err);
    } finally {
      groupSendsInFlight.delete(gid);
    }
  }
  return {
    success: successCount > 0 || deferredCount > 0, successCount, deferredCount, failCount, skippedCount,
    total: groups.length,
    message: `发送 ${successCount} 群，等待活跃 ${deferredCount} 群，已发送或处理中跳过 ${skippedCount} 群，失败 ${failCount} 群`
  };
}

/**
 * 监听群消息活跃度：累加非机器人消息并在达到防刷门槛时自动触发今日定时补发
 */
async function handleGroupActivityOnMessage(ctx, event) {
  if (event.message_type !== 'group' || String(event.user_id) === await getSelfUin(ctx)) return;
  const gid = String(event.group_id || '');
  if (!configuredGroupIds().includes(gid)) return;
  if (event.message_id !== undefined) {
    const key = `${gid}:${event.message_id}`;
    if (activityMessageIds.has(key)) return;
    activityMessageIds.set(key, true);
    if (activityMessageIds.size > 10000) activityMessageIds.delete(activityMessageIds.keys().next().value);
  }
  const activity = getGroupActivity(gid);
  if (event.time && Number(event.time) * 1000 + 999 < activity.lastSentTime) return;
  activity.otherMsgCount++;
  saveGroupActivityDebounced();
  if (!currentConfig.enable_schedule || !activity.waitingForActivity || localClock().hour < 8) return;
  if (activity.lastSentDate === getTodayDateStr() || activity.otherMsgCount <= activityThreshold()) return;
  generateDailySchedulePlan();
  if (![...dailySchedulePlan.values()].some(p => Date.now() >= p.targetTimestamp)) return;
  await sendCatToConfiguredGroups(ctx, '活跃达标补发', gid);
}

/**
 * 启动定时调度轮询器
 */
function startScheduler(ctx) {
  const previous = globalThis[schedulerStateKey];
  if (previous?.timer) clearInterval(previous.timer);
  if (scheduleTimer) clearInterval(scheduleTimer);
  const state = { timer: null, busy: false };
  globalThis[schedulerStateKey] = state;
  generateDailySchedulePlan();
  scheduleTimer = setInterval(async () => {
    if (state.busy || !pluginActive) return;
    state.busy = true;
    try {
      // Card protection is independent of whether scheduled group messages are enabled.
      cardPollCounter++;
      if (cardPollCounter % 8 === 0) await pollCheckProtectedGroupCards(ctx);
      if (!currentConfig.enable_schedule || localClock().hour < 8) return;
      generateDailySchedulePlan();
      for (const plan of dailySchedulePlan.values()) {
        if (plan.state !== 'pending' || Date.now() < plan.targetTimestamp) continue;
        plan.state = 'sending';
        saveDailySchedulePlan();
        try {
          plan.result = await sendCatToConfiguredGroups(ctx, `定时任务(${plan.slot})`);
          plan.state = plan.result.success ? 'sent' : 'failed';
        } catch (err) {
          plan.state = 'failed';
          logger?.error('[Relay Schedule] 发送任务失败:', err);
        }
        plan.sentAt = new Date().toISOString();
        saveDailySchedulePlan();
      }
      // Also release a persisted deferred task after 08:00 once today's slot is due.
      if ([...dailySchedulePlan.values()].some(p => Date.now() >= p.targetTimestamp)) {
        for (const gid of configuredGroupIds()) {
          const activity = getGroupActivity(gid);
          if (activity.waitingForActivity && activity.lastSentDate !== getTodayDateStr() &&
              activity.lastAttemptDate !== getTodayDateStr() &&
              (activity.otherMsgCount > activityThreshold() || activityHistoryCheckDue(gid))) {
            await sendCatToConfiguredGroups(ctx, '等待活跃后补发', gid);
          }
        }
      }
    } catch (err) { logger?.error('[Relay Schedule] 定时轮询异常:', err); }
    finally { state.busy = false; }
  }, 15000);
  state.timer = scheduleTimer;
}

/**
 * 插件初始化
 */
export const plugin_init = async (ctx) => {
  pluginActive = true;
  logger = ctx.logger;
  logger.info("消息中转与好友申请处理插件正在初始化...");

  dataDir = ctx.dataPath || '';
  pluginConfigPath = ctx.configPath || '';

  // 1. 加载配置
  try {
    if (pluginConfigPath && fs.existsSync(pluginConfigPath)) {
      const savedConfig = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf-8'));
      validateConfig(savedConfig);
      Object.assign(currentConfig, savedConfig);
      if (typeof currentConfig.dnd_list_str === 'string' && currentConfig.dnd_list_str.trim()) {
        currentConfig.dnd_list = currentConfig.dnd_list_str.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean);
      }
      logger.info("[Relay] 配置加载成功");
    }
  } catch (err) {
    logger.warn("[Relay] 读取配置文件失败，使用默认配置:", err);
  }

  // 2. 加载历史消息映射与群活跃度记录
  loadMessageMap();
  loadGroupActivity();

  // 3. 启动定时任务调度器
  startScheduler(ctx);

  // 4. 预加载好友列表与备注缓存
  refreshFriendCache(ctx).catch(err => logger?.debug?.('[Relay] 预加载好友缓存失败:', err));

  // 5. 初始化群名片防篡改保护基线与任务
  initProtectedGroupCards(ctx).catch(err => logger?.error?.('[Relay Card] 初始化群名片保护异常:', err));

  // 6. 构建 WebUI 配置界面
  if (ctx.NapCatConfig) {
    plugin_config_ui = ctx.NapCatConfig.combine(
      ctx.NapCatConfig.html('<div style="padding: 12px; background: rgba(0,0,0,0.04); border-radius: 8px; margin-bottom: 10px;">' +
        '<h3 style="margin: 0 0 6px 0;">📨 消息中转与引用回复插件</h3>' +
        '<p style="margin: 0; color: #666; font-size: 13px;">自动将接收到的私聊/群聊消息转发给指定管理员QQ。管理员直接【引用回复】中转消息可原路送达，对好友申请通知【引用回复】可一键同意/拒绝。</p>' +
        '</div>'),
      ctx.NapCatConfig.text("target_qq", "目标管理员 QQ", "", "接收所有转发消息与好友申请的目标好友QQ号"),
      ctx.NapCatConfig.boolean("forward_private", "转发私聊消息", true, "开启后，所有好友和陌生人发给机器人的私聊消息均会转发给管理员"),
      ctx.NapCatConfig.boolean("notify_on_at", "群聊有人@我时通知", true, "即使未开启全部群聊转发，当群内有人@机器人时也会将消息通知转发给管理员"),
      ctx.NapCatConfig.boolean("forward_group", "转发全部群聊消息", false, "是否转发群聊消息给管理员（建议谨慎开启，避免群消息过多）"),
      ctx.NapCatConfig.boolean("forward_group_at_only", "群聊仅转发@我的消息", true, "当开启群聊转发时，仅转发艾特机器人的群消息"),
      ctx.NapCatConfig.boolean("forward_file", "转发文件消息", true, "收到私聊/群聊文件时，自动向管理员转发 QQ 原生文件卡片并推送文件详情与下载直链"),
      ctx.NapCatConfig.boolean("enable_quote_reply", "回复对方时使用引用回复", true, "管理员引用回复中转消息时，机器人向原好友发送消息是否【引用回复】对方最初发送的那条消息"),
      ctx.NapCatConfig.boolean("show_original_nickname", "备注名后显示原QQ昵称", false, "开启后，若好友设置了备注名，则显示为「备注名 (原昵称)」；关闭则仅显示「备注名」"),
      ctx.NapCatConfig.boolean("forward_friend_request", "转发好友申请通知", true, "收到好友申请时推送到管理员私聊，支持管理员引用回复或发指令一键同意/拒绝"),
      ctx.NapCatConfig.boolean("auto_approve_friend", "自动同意所有好友申请", false, "自动通过且不向管理员发送通知；关闭后才通知并等待引用回复审批"),
      ctx.NapCatConfig.text("auto_approve_keyword", "关键词自动同意好友", "", "匹配关键词时静默自动通过，留空不启用"),
      ctx.NapCatConfig.boolean("ignore_dnd", "自动过滤QQ客户端免打扰会话", true, "自动识别并跳过QQ客户端中设置了【消息免打扰】（接收不提醒）或【屏蔽】的群聊与好友会话"),
      ctx.NapCatConfig.text("dnd_list_str", "手动免打扰名单 (QQ/群号)", "", "额外的免打扰名单，多个QQ号或群号可用逗号、空格或换行分隔，设置后这些会话的消息不会被转发"),
      ctx.NapCatConfig.boolean("show_sender_info", "显示发送者信息前缀", true, "转发消息时附加 [来自私聊: 备注名(QQ)] 标识"),
      ctx.NapCatConfig.boolean("send_confirmation", "发送回复成功回执", true, "管理员引用回复成功转回后，是否向管理员发送成功提示"),
      // 群名片防篡改保护配置
      ctx.NapCatConfig.html(
        '<div style="margin: 15px 0 10px; padding: 12px; background: rgba(103, 194, 58, 0.08); border-left: 4px solid #67c23a; border-radius: 4px;">' +
        '  <h4 style="margin: 0 0 5px; color: #67c23a;">🛡️ 群名片防篡改自动恢复</h4>' +
        '  <span style="font-size: 13px; color: #666;">自动检测发消息群聊的名片是否被管理员修改，若被修改则延迟10分钟自动改回，避免与群管理互相抢改冲突。</span>' +
        '</div>'
      ),
      ctx.NapCatConfig.boolean("auto_protect_group_card", "开启群名片防篡改保护", true, "检测到发消息群聊的群名片被篡改后，自动排队改回"),
      ctx.NapCatConfig.number("protect_card_delay_minutes", "防篡改改回延迟 (分钟)", 10, "检测到群名片被修改后，延迟多少分钟再改回（默认10分钟）"),
      ctx.NapCatConfig.text("default_group_card", "默认期望群名片", "", "受保护群聊的名片基线，未单独设置名片的群将自动使用该名片"),
      // 定时发送月薪喵表情包配置
      ctx.NapCatConfig.html(
        '<div style="margin: 15px 0 10px; padding: 12px; background: rgba(64, 158, 255, 0.08); border-left: 4px solid #409eff; border-radius: 4px;">' +
        '  <h4 style="margin: 0 0 5px; color: #409eff;">⏰ 定时发送月薪喵表情包 (防死群刷屏版)</h4>' +
        '  <span style="font-size: 13px; color: #666;">支持每日固定时间（中午）自动向指定QQ群批量发送最新月薪喵表情包。内置智能防刷屏机制：若自上次发送后群内其他成员发言未达门槛则自动暂缓，直到活跃达标再补发。</span>' +
        '</div>'
      ),
      ctx.NapCatConfig.boolean("enable_schedule", "开启定时发送", true, "是否启用每日固定时间群发月薪喵表情包"),
      ctx.NapCatConfig.text("schedule_groups", "定时发送目标群号", "", "需要定时发送表情包的群号列表，支持多个群号，用逗号、空格或换行分隔（如：123456, 7891011）"),
      ctx.NapCatConfig.text("schedule_times", "每日定时发送时间点", "12:30", "北京时间 HH:mm，支持多个时间点；08:00前不发送，每群每天最多一条"),
      ctx.NapCatConfig.number("schedule_random_minutes", "随机浮动范围 (分钟)", 0, "设置定时发送在设定时间点前后随机浮动的分钟数，例如填 60 则在设定时间前后 ±60 分钟内随机触发；填 0 为固定时间准点发送"),
      ctx.NapCatConfig.boolean("enable_schedule_activity_check", "防死群刷屏活跃度检测", true, "若群内自上次发消息后其他成员发言不足设定条数，则暂缓发送，直到群内其他成员消息数严格大于 n 再自动补发，防止被群管理判定为刷屏"),
      ctx.NapCatConfig.number("schedule_min_other_msgs", "群发言活跃门槛 (条)", 5, "自上次机器人发送后，仅当上次发送后其他成员消息数严格大于 n 才发送；可设为0"),
      ctx.NapCatConfig.text("schedule_text", "附带文本说明 (可选)", "", "发送表情包时随图附带的文字，留空则纯发表情包"),
      ctx.NapCatConfig.boolean("schedule_send_image", "发送图片", true, "关闭后仅发送附带文本，可用于纯文字定时消息"),
      ctx.NapCatConfig.text("schedule_custom_image", "自定义表情图片 (可选)", "", "留空则默认使用内置的最新月薪喵动态表情；可填写本地绝对路径、网络图片URL或 base64://")
    );
  }

  logger.info(`[Relay] 插件初始化完成！目标管理员: ${currentConfig.target_qq || '(未配置)'}，免打扰过滤: ${currentConfig.ignore_dnd ? '开' : '关'}，群名片防篡改: ${currentConfig.auto_protect_group_card ? '开' : '关'}，群聊@通知: ${currentConfig.notify_on_at ? '开' : '关'}`);
};

/**
 * 通用事件监听 (捕获好友申请 request 事件、群名片变动 notice 事件等)
 */
export const plugin_onevent = async (ctx, event) => {
  if (!event) return;

  // 1. 捕获好友申请事件 (OneBot 11 request.friend)
  if (event.post_type === 'request' && event.request_type === 'friend') {
    await handleFriendRequestEvent(ctx, event);
  }

  // 2. 捕获群名片变动通知 (OneBot 11 notice.group_card)
  if (event.post_type === 'notice' && event.notice_type === 'group_card') {
    const selfUin = await getSelfUin(ctx);
    if (selfUin && String(event.user_id) === String(selfUin)) {
      const groupId = String(event.group_id);
      const newCard = (event.card_new || '').trim();
      logger?.info(`[Relay Card Event] 收到群名片变更通知: 群 [${groupId}], 新名片: "${newCard}", 旧名片: "${event.card_old || ''}"`);
      await checkAndScheduleCardRestore(ctx, groupId, newCard);
    }
  }
};

/**
 * 消息事件监听
 */
export const plugin_onmessage = async (ctx, event) => {
  if (!event || event.post_type !== 'message') return;

  const senderId = String(event.user_id || '').trim();
  const targetQq = String(currentConfig.target_qq || '').trim();
  const selfUin = await getSelfUin(ctx);

  // 未配置目标管理员或自身消息时直接忽略
  if (!targetQq || senderId === selfUin) return;

  // ========================================================
  // 分支一：来自管理员的消息 -> 检查指令或引用回复
  // ========================================================
  if (senderId === targetQq && event.message_type === 'private') {
    const rawText = (event.raw_message || '').trim();

    // 1. 管理员调试与状态指令
    if (rawText === '#中转状态' || rawText === '#relay' || rawText === '#relay status') {
      const dndCount = (currentConfig.dnd_list || []).length;
      const dndPreview = dndCount > 0 ? (currentConfig.dnd_list.slice(0, 5).join(', ') + (dndCount > 5 ? ` 等共${dndCount}个` : '')) : '无';
      const randomMins = Number(currentConfig.schedule_random_minutes) || 0;
      const randomDesc = randomMins > 0 ? `前后随机 ±${randomMins} 分钟` : '准点发送 (未开启随机)';
      const planList = Array.from(dailySchedulePlan.entries())
        .map(([slot, p]) => {
          const stateText = p.state === 'sent'
            ? `✅已发送 ${p.sentAt || ''}`.trim()
            : p.state === 'skipped'
              ? '⏭️已跳过（插件启动时该时段已过）'
            : p.state === 'failed'
              ? '❌发送失败'
                : p.state === 'sending'
                  ? '📤发送中'
                  : '⏳待发送';
          return `  • ${slot} 档 ➔ 今日计划 ${p.targetTimeStr} (${stateText})`;
        })
        .join('\n');

      const protectedGroupList = await getProtectedGroupIds(ctx);
      const protectedCount = protectedGroupList.length;
      const pendingRestoreCount = pendingCardRestores.size;

      // 活跃度防刷屏状态
      let activitySummary = '';
      if (currentConfig.enable_schedule_activity_check) {
        const minMsgs = activityThreshold();
        const configuredGroups = (currentConfig.schedule_groups || '')
          .split(/[,，\s\n]+/)
          .map(g => g.trim())
          .filter(g => /^\d+$/.test(g));
        const todayStr = getTodayDateStr();
        const actLines = [];
        for (const gid of configuredGroups) {
          const act = getGroupActivity(gid);
          const isTodaySent = act.lastSentDate === todayStr;
          let label = '';
          if (isTodaySent) {
            label = `✅今日已发 (群内后续发言: ${act.otherMsgCount}条)`;
          } else if (act.waitingForActivity) {
            label = `⏳暂缓中 (发言 ${act.otherMsgCount}/${minMsgs}条，等待群活跃)`;
          } else if (act.lastSentTime === 0) {
            label = `🆕首发待命`;
          } else if (act.otherMsgCount > minMsgs) {
            label = `🟢活跃达标 (${act.otherMsgCount}/${minMsgs}条，待定时发送)`;
          } else {
            label = `⚪活跃不足 (${act.otherMsgCount}/${minMsgs}条)`;
          }
          actLines.push(`  • 群 [${gid}]: ${label}`);
        }
        activitySummary = actLines.length > 0 ? `👥 群活跃度防刷屏 (${minMsgs}条门槛):\n${actLines.join('\n')}\n` : '';
      }

      const statusText =
        `🤖 【消息中转传话插件运行状态】\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 管理员账号: ${targetQq}\n` +
        `📥 私聊转发: ${currentConfig.forward_private ? '✅ 开启' : '❌ 关闭'}\n` +
        `🔔 群聊@提醒: ${currentConfig.notify_on_at ? '✅ 开启 (群内有人@机器人时推送)' : '❌ 关闭'}\n` +
        `👥 群聊转发: ${currentConfig.forward_group ? '✅ 开启' : '❌ 关闭'}\n` +
        `🎯 群聊仅@: ${currentConfig.forward_group_at_only ? '✅ 开启' : '❌ 关闭'}\n` +
        `📁 文件转发: ${currentConfig.forward_file ? '✅ 开启' : '❌ 关闭'}\n` +
        `🛡️ 群名片防篡改: ${currentConfig.auto_protect_group_card ? `✅ 开启 (延迟 ${currentConfig.protect_card_delay_minutes || 10} 分钟改回)` : '❌ 关闭'}\n` +
        `🏷️ 期望群名片: 「${currentConfig.default_group_card || '未设置'}」 (已保护 ${protectedCount} 个群${pendingRestoreCount > 0 ? `，${pendingRestoreCount} 个待改回` : ''})\n` +
        `🏷️ 备注名优先: ✅ 开启 (原昵称追加: ${currentConfig.show_original_nickname ? '开启' : '关闭'})\n` +
        `💬 引用回复原消息: ${currentConfig.enable_quote_reply ? '✅ 开启' : '❌ 关闭'}\n` +
        `🤝 好友申请推送: ${currentConfig.forward_friend_request ? '✅ 开启' : '❌ 关闭'}\n` +
        `🤖 好友自动通过: ${currentConfig.auto_approve_friend ? '✅ 全自动 (静默，不通知管理员)' : (currentConfig.auto_approve_keyword ? '🔑 关键词匹配时静默通过' : '❌ 手动审核')}\n` +
        `🔕 QQ免打扰过滤: ${currentConfig.ignore_dnd ? '✅ 自动过滤' : '❌ 未启用'}\n` +
        `📋 手动免打扰名单: ${dndPreview}\n` +
        `🔔 发送回执: ${currentConfig.send_confirmation ? '✅ 开启' : '❌ 关闭'}\n` +
        `⏰ 定时月薪喵: ${currentConfig.enable_schedule ? '✅ 开启' : '❌ 关闭'}\n` +
        `🕒 设定时间点: ${currentConfig.schedule_times || '未设置'}\n` +
        `🎲 随机时间浮动: ${randomDesc}\n` +
        `🛡️ 防刷屏检测: ${currentConfig.enable_schedule_activity_check ? `✅ 开启 (其他发言 > ${activityThreshold()} 条触发)` : '❌ 关闭'}\n` +
        `📢 定时目标群聊: ${currentConfig.schedule_groups || '未配置'}\n` +
        (activitySummary || '') +
        (planList ? `📅 今日执行计划:\n${planList}\n` : '') +
        `📊 活跃引用映射条数: ${messageMap.size} 条 | 好友缓存: ${friendCache.size} 位\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💡 快捷管理指令:\n` +
        `• 【引用回复】消息：自动原路回复该好友/群聊 (群聊@通知同理)\n` +
        `• 【引用回复】好友申请：回复「同意」或「拒绝」处理申请\n` +
        `• 发送 #开启@通知 / #关闭@通知\n` +
        `• 发送 #群名片 查看防篡改状态与倒计时\n` +
        `• 发送 #设置群名片 [群号] <名片> (设置期望名片)\n` +
        `• 发送 #立即改名片 [群号] (跳过等待立即改回)\n` +
        `• 发送 #取消改名片 [群号] (取消待恢复任务)\n` +
        `• 发送 #设置改名延迟 <分钟数> (如 #设置改名延迟 10)\n` +
        `• 发送 #开启防改名片 / #关闭防改名片\n` +
        `• 发送 #刷新好友 (立即同步最新QQ好友备注)\n` +
        `• 发送 #开启原名 / #关闭原名 (切换是否显示原昵称)\n` +
        `• 发送 #开启引用回复 / #关闭引用回复\n` +
        `• 发送 #测试月薪喵 [群号] / #月薪喵\n` +
        `• 发送 #设置群聊 <群号1,群号2...>\n` +
        `• 发送 #设置时间 <12:30>\n` +
        `• 发送 #设置随机 <分钟数> (设置时间前后随机浮动)\n` +
        `• 发送 #开启月薪喵 / #关闭月薪喵\n` +
        `• 发送 #开启防刷 / #关闭防刷 (防死群刷屏检测)\n` +
        `• 发送 #设置发言门槛 <条数> (如 #设置发言门槛 5)\n` +
        `• 发送 #重置群活跃 <群号> (重置某群活跃发言计数)\n` +
        `• 发送 #同意 <QQ号> [备注名] / #拒绝 <QQ号>\n` +
        `• 发送 #免打扰 查看免打扰设置与指令`;

      try {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: statusText
        });
      } catch (e) {
        logger?.error('[Relay] 发送状态消息失败:', e);
      }
      return;
    }

    // 2. 查看免打扰名单指令
    if (rawText === '#免打扰' || rawText === '#dnd' || rawText === '#dnd list') {
      const list = currentConfig.dnd_list || [];
      const listStr = list.length > 0 ? list.map((id, idx) => `${idx + 1}. ${id}`).join('\n') : '暂无手动设置的免打扰账号/群号';
      const text =
        `🔕 【会话免打扰设置】\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⚡ QQ客户端免打扰过滤: ${currentConfig.ignore_dnd ? '✅ 自动识别过滤 (QQ中设置了免打扰的会话不转发)' : '❌ 已关闭'}\n\n` +
        `📋 手动免打扰名单 (共 ${list.length} 个):\n${listStr}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `➕ 添加免打扰: 发送 #添加免打扰 <QQ号或群号>\n` +
        `➖ 删除免打扰: 发送 #删除免打扰 <QQ号或群号>`;

      try {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: text
        });
      } catch (e) {
        logger?.error('[Relay] 发送免打扰列表失败:', e);
      }
      return;
    }

    // 3. 添加免打扰指令
    const addMatch = rawText.match(/^#(?:添加免打扰|屏蔽)\s*(\d+)$/);
    if (addMatch) {
      const targetId = addMatch[1].trim();
      if (!currentConfig.dnd_list) currentConfig.dnd_list = [];
      if (!currentConfig.dnd_list.includes(targetId)) {
        currentConfig.dnd_list.push(targetId);
        saveConfigToFile();
      }
      try {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `✅ 已成功将 [${targetId}] 加入免打扰名单！来自该好友/群聊的消息将不再转发给你。`
        });
      } catch (e) {
        logger?.error('[Relay] 发送添加免打扰回执失败:', e);
      }
      return;
    }

    // 4. 删除免打扰指令
    const delMatch = rawText.match(/^#(?:删除免打扰|解除免打扰|解封)\s*(\d+)$/);
    if (delMatch) {
      const targetId = delMatch[1].trim();
      if (currentConfig.dnd_list && currentConfig.dnd_list.includes(targetId)) {
        currentConfig.dnd_list = currentConfig.dnd_list.filter(id => id !== targetId);
        saveConfigToFile();
        try {
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `✅ 已将 [${targetId}] 从免打扰名单移除，后续消息将恢复转发。`
          });
        } catch (e) {
          logger?.error('[Relay] 发送移除免打扰回执失败:', e);
        }
      } else {
        try {
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `⚠️ 免打扰名单中未找到 [${targetId}]。`
          });
        } catch (e) {
          logger?.error('[Relay] 发送提示失败:', e);
        }
      }
      return;
    }

    // 5. 显式指令：同意好友申请 (#同意 <QQ号/flag> [备注名])
    const approveMatch = rawText.match(/^#(?:同意|通过|同意好友|通过好友)\s+(\d+)(?:\s+(.+))?$/);
    if (approveMatch) {
      const targetId = approveMatch[1].trim();
      const remark = (approveMatch[2] || '').trim();
      const reqInfo = await findPendingFriendRequest(ctx, targetId);
      if (reqInfo) {
        await executeFriendRequestAction(ctx, reqInfo, true, remark, targetQq);
      } else {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `⚠️ 未找到账号/标识为 [${targetId}] 的待处理好友申请，可能已处理或已过期。`
        });
      }
      return;
    }

    // 6. 显式指令：拒绝好友申请 (#拒绝 <QQ号/flag>)
    const rejectMatch = rawText.match(/^#(?:拒绝|拒绝好友|忽略好友)\s+(\d+)$/);
    if (rejectMatch) {
      const targetId = rejectMatch[1].trim();
      const reqInfo = await findPendingFriendRequest(ctx, targetId);
      if (reqInfo) {
        await executeFriendRequestAction(ctx, reqInfo, false, '', targetQq);
      } else {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `⚠️ 未找到账号/标识为 [${targetId}] 的待处理好友申请，可能已处理或已过期。`
        });
      }
      return;
    }

    // 7. 定时月薪喵表情包测试与触发指令
    if (rawText.startsWith('#测试月薪喵') || rawText.startsWith('#发送月薪喵') || rawText === '#月薪喵') {
      const parts = rawText.split(/\s+/);
      const targetGroup = parts[1] ? parts[1].trim() : null;

      try {
        if (targetGroup && /^\d+$/.test(targetGroup)) {
          const res = await sendCatToConfiguredGroups(ctx, '管理员手动指令', targetGroup);
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `📋 群 [${targetGroup}]: ${res.message}`
          });
        } else {
          const configuredGroups = (currentConfig.schedule_groups || '')
            .split(/[,，\s\n]+/)
            .map(g => g.trim())
            .filter(g => /^\d+$/.test(g));

          if (configuredGroups.length > 0) {
            const res = await sendCatToConfiguredGroups(ctx, '管理员手动指令');
            await callAction(ctx, 'send_private_msg', {
              user_id: targetQq,
              message: `✅ 已执行向所有配置群聊发送月薪喵表情包，结果: ${res.message}`
            });
          } else {
            const imgFile = currentConfig.schedule_custom_image?.trim() || getCatImageBase64();
            await callAction(ctx, 'send_private_msg', {
              user_id: targetQq,
              message: [
                { type: 'text', data: { text: '🐱 【月薪喵表情包预览】\n（当前尚未配置定时发送目标群聊，可在 WebUI 或私聊发送 #设置群聊 <群号> 进行配置）：\n' } },
                { type: 'image', data: { file: imgFile } }
              ]
            });
          }
        }
      } catch (err) {
        logger?.error('[Relay] 执行月薪喵测试指令异常:', err);
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `❌ 测试发送月薪喵失败: ${err.message || err}`
        });
      }
      return;
    }

    // 8. 快捷指令：设置定时群聊 (#设置群聊 <群号1,群号2...>)
    const setGroupsMatch = rawText.match(/^#(?:设置群聊|配置群聊|定时群聊)\s+(.+)$/);
    if (setGroupsMatch) {
      const input = setGroupsMatch[1].trim();
      currentConfig.schedule_groups = input;
      saveConfigToFile();
      const groups = input.split(/[,，\s\n]+/).map(g => g.trim()).filter(g => /^\d+$/.test(g));
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已成功更新定时发送群聊列表 (共 ${groups.length} 个有效群)：\n${groups.join(', ')}\n\n💡 发送 #测试月薪喵 可立即进行测试。`
      });
      return;
    }

    // 9. 快捷指令：设置定时时间 (#设置时间 <09:00,12:00,18:00>)
    const setTimesMatch = rawText.match(/^#(?:设置时间|配置时间|定时时间)\s+(.+)$/);
    if (setTimesMatch) {
      const input = setTimesMatch[1].trim();
      try { validateConfig({ schedule_times: input }); }
      catch (err) {
        await callAction(ctx, 'send_private_msg', { user_id: targetQq, message: err.message });
        return;
      }
      currentConfig.schedule_times = input;
      saveConfigToFile();
      generateDailySchedulePlan(new Date(), true);
      const planDesc = Array.from(dailySchedulePlan.entries())
        .map(([slot, p]) => `• ${slot} 时段 ➔ 今日预计 ${p.targetTimeStr} (${p.state === 'sent' ? '✅已发送' : p.state === 'skipped' ? '⏭️已跳过' : '⏳待发送'})`)
        .join('\n');
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已成功更新每日定时发送时间点：\n${input}\n\n📅 今日更新后的执行计划：\n${planDesc || '(未设置发送时间点)'}`
      });
      return;
    }

    // 9.1 快捷指令：设置定时前后随机浮动时长 (#设置随机 <分钟数> / #设置随机时间 <分钟数>)
    const setRandomMatch = rawText.match(/^#(?:设置随机时间|设置随机|配置随机|随机时间|随机时长)(?:\s+(\d+))?$/);
    if (setRandomMatch) {
      const param = setRandomMatch[1]?.trim();
      if (param === undefined) {
        const currentMins = Number(currentConfig.schedule_random_minutes) || 0;
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `🕒 当前定时发送随机浮动范围: ${currentMins > 0 ? `前后 ±${currentMins} 分钟` : '准点发送 (0 分钟)'}\n\n💡 指令用法:\n• 发送 #设置随机 10 (设置为时间点前后 ±10 分钟随机触发)\n• 发送 #设置随机 0 (关闭随机浮动，准点发送)`
        });
        return;
      }
      const minutes = Math.min(1440, parseInt(param, 10));
      currentConfig.schedule_random_minutes = minutes;
      saveConfigToFile();
      generateDailySchedulePlan(new Date(), true);
      const planDesc = Array.from(dailySchedulePlan.entries())
        .map(([slot, p]) => `• ${slot} 时段 ➔ 今日预计 ${p.targetTimeStr} (${p.state === 'sent' ? '✅已发送' : p.state === 'skipped' ? '⏭️已跳过' : '⏳待发送'})`)
        .join('\n');
      const tip = minutes > 0
        ? `✅ 已设置定时发送前后随机浮动时长为: ±${minutes} 分钟！\n每次发送将在设定时间点的前后 ${minutes} 分钟内随机触发。\n\n📅 今日更新后的执行计划：\n${planDesc || '(未设置发送时间点)'}`
        : `✅ 已关闭定时发送随机浮动，后续将按设定时间点准点发送。\n\n📅 今日更新后的执行计划：\n${planDesc || '(未设置发送时间点)'}`;
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: tip
      });
      return;
    }

    // 10. 快捷指令：开启/关闭月薪喵定时
    if (rawText === '#开启月薪喵' || rawText === '#启用月薪喵') {
      currentConfig.enable_schedule = true;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启定时群发月薪喵表情包。`
      });
      return;
    }
    if (rawText === '#关闭月薪喵' || rawText === '#停用月薪喵' || rawText === '#禁用月薪喵') {
      currentConfig.enable_schedule = false;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已暂停定时群发月薪喵表情包。`
      });
      return;
    }

    // 10.1 快捷指令：开启/关闭防刷屏活跃度检测
    if (rawText === '#开启防刷' || rawText === '#开启防刷屏' || rawText === '#启用防刷') {
      currentConfig.enable_schedule_activity_check = true;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启防死群刷屏活跃度检测！自上次发消息后，群内其他成员发言需 > ${activityThreshold()} 条才会在中午发送定时消息，若未达标将暂缓直至活跃达标后再补发。`
      });
      return;
    }
    if (rawText === '#关闭防刷' || rawText === '#关闭防刷屏' || rawText === '#停用防刷') {
      currentConfig.enable_schedule_activity_check = false;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已关闭防死群刷屏活跃度检测，定时时间到达后将对所有目标群直接发送。`
      });
      return;
    }

    // 10.2 快捷指令：设置发言门槛 (#设置发言门槛 <条数> / #设置防刷条数 <条数>)
    const setThresholdMatch = rawText.match(/^#(?:设置发言门槛|设置防刷门槛|设置防刷条数|发言门槛|防刷门槛)\s+(\d+)$/);
    if (setThresholdMatch) {
      const count = Math.max(0, parseInt(setThresholdMatch[1], 10));
      currentConfig.schedule_min_other_msgs = count;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已将群发言活跃门槛设置为: ${count} 条！自上次机器人发消息后，群内其他成员发言 > ${count} 条才会触发下一次定时发送。`
      });
      return;
    }

    // 10.3 快捷指令：重置群活跃度计数 (#重置群活跃 [群号])
    const resetActMatch = rawText.match(/^#(?:重置群活跃|重置活跃|清理活跃)(?:\s+(\d+))?$/);
    if (resetActMatch) {
      const specifiedGid = resetActMatch[1]?.trim();
      if (specifiedGid) {
        const act = getGroupActivity(specifiedGid);
        act.otherMsgCount = 0;
        act.waitingForActivity = false;
        saveGroupActivity();
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `✅ 已重置群 [${specifiedGid}] 的其他成员发言计数为 0 条。`
        });
      } else {
        for (const act of groupActivityMap.values()) {
          act.otherMsgCount = 0;
          act.waitingForActivity = false;
        }
        saveGroupActivity();
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `✅ 已重置所有群的其他成员发言计数为 0 条。`
        });
      }
      return;
    }

    // 11. 快捷指令：开启/关闭引用回复
    if (rawText === '#开启引用回复' || rawText === '#启用引用回复') {
      currentConfig.enable_quote_reply = true;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启引用回复功能！管理员回复消息时，机器人将【引用回复】原好友/群聊的原始提问消息。`
      });
      return;
    }
    if (rawText === '#关闭引用回复' || rawText === '#停用引用回复' || rawText === '#禁用引用回复') {
      currentConfig.enable_quote_reply = false;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已关闭引用回复功能，机器人回复时将直接发送普通消息。`
      });
      return;
    }

    // 12. 快捷指令：开启/关闭在备注后显示原昵称
    if (rawText === '#开启原名' || rawText === '#显示原名' || rawText === '#开启原昵称') {
      currentConfig.show_original_nickname = true;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启原昵称显示！好友展示格式为：「备注名 (原昵称) (QQ号)」。`
      });
      return;
    }
    if (rawText === '#关闭原名' || rawText === '#隐藏原名' || rawText === '#关闭原昵称') {
      currentConfig.show_original_nickname = false;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已关闭原昵称显示！好友展示格式将默认仅保留「备注名 (QQ号)」。`
      });
      return;
    }

    // 13. 快捷指令：开启/关闭文件转发
    if (rawText === '#开启文件转发' || rawText === '#启用文件转发') {
      currentConfig.forward_file = true;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启文件转发功能！收到好友或群聊发送的文件时将自动向你推送。`
      });
      return;
    }
    if (rawText === '#关闭文件转发' || rawText === '#停用文件转发') {
      currentConfig.forward_file = false;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已关闭文件转发功能。`
      });
      return;
    }

    // 14. 快捷指令：强制刷新好友备注列表缓存 (#刷新好友 / #更新好友)
    if (rawText === '#刷新好友' || rawText === '#更新好友' || rawText === '#同步好友') {
      await refreshFriendCache(ctx, true);
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 好友备注信息已同步刷新！当前已缓存 ${friendCache.size} 位好友的备注与昵称。`
      });
      return;
    }

    // 15. 快捷指令：开启/关闭群聊@提醒 (#开启@通知 / #关闭@通知 / #开启艾特通知 / #关闭艾特通知)
    if (rawText === '#开启@通知' || rawText === '#开启艾特通知' || rawText === '#开启at通知') {
      currentConfig.notify_on_at = true;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启群聊 @ 提醒功能！当群聊有人艾特机器人时，系统将自动向你转发通知，你可以直接引用回复传话。`
      });
      return;
    }
    if (rawText === '#关闭@通知' || rawText === '#关闭艾特通知' || rawText === '#关闭at通知') {
      currentConfig.notify_on_at = false;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已关闭群聊 @ 提醒功能。`
      });
      return;
    }

    // 16. 快捷指令：查看群名片保护状态 (#群名片 / #名片状态 / #查看群名片)
    if (rawText === '#群名片' || rawText === '#名片状态' || rawText === '#查看群名片') {
      const protectedIds = await getProtectedGroupIds(ctx);
      const delayMinutes = Math.max(1, Number(currentConfig.protect_card_delay_minutes) || 10);
      let descList = [];
      const now = Date.now();

      for (const gid of protectedIds) {
        const expected = protectedGroupCards.get(gid) || currentConfig.default_group_card || '未设置';
        let pendingText = '✅ 正常 (名片未被修改)';
        if (pendingCardRestores.has(gid)) {
          const p = pendingCardRestores.get(gid);
          const remainSec = Math.max(0, Math.round((p.scheduledAt - now) / 1000));
          const remainMin = Math.floor(remainSec / 60);
          const remainSecMod = remainSec % 60;
          pendingText = `⏳ 待改回 (剩余 ${remainMin}分${remainSecMod}秒，当前被改为「${p.newCard || '空'}」)`;
        }
        descList.push(`• 群 [${gid}]:\n   期望名片: 「${expected}」\n   当前状态: ${pendingText}`);
      }

      const statusMsg =
        `🛡️ 【群名片防篡改保护状态】\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 功能状态: ${currentConfig.auto_protect_group_card ? '✅ 开启中' : '❌ 已关闭'}\n` +
        `⏱️ 延迟改回时长: ${delayMinutes} 分钟 (防抢拉扯保护期)\n` +
        `🏷️ 全局默认名片: 「${currentConfig.default_group_card || '未设置'}」\n` +
        `👥 受保护群聊数: ${protectedIds.length} 个\n` +
        `━━━━━━━━━━━━━━━\n` +
        (descList.length > 0 ? descList.join('\n\n') + '\n━━━━━━━━━━━━━━━\n' : '') +
        `💡 常用指令：\n` +
        `• #设置群名片 <名片> (设置全局默认期望名片)\n` +
        `• #设置群名片 <群号> <名片> (设置指定群期望名片)\n` +
        `• #立即改名片 [群号] (跳过等待，立即恢复名片)\n` +
        `• #取消改名片 [群号] (取消当前等待中的恢复任务)\n` +
        `• #设置改名延迟 <分钟数> (如 #设置改名延迟 10)\n` +
        `• #开启防改名片 / #关闭防改名片`;

      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: statusMsg
      });
      return;
    }

    // 17. 快捷指令：设置群名片 (#设置群名片 [群号] <名片>)
    const setCardMatch = rawText.match(/^#(?:设置群名片|配置群名片|修改期望名片)(?:\s+(\d+))?\s+(.+)$/);
    if (setCardMatch) {
      const specifiedGid = setCardMatch[1]?.trim();
      const cardContent = setCardMatch[2]?.trim();
      if (!cardContent) {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `⚠️ 名片内容不能为空。用法：\n• #设置群名片 <期望名片> (设置全局默认名片)\n• #设置群名片 <群号> <期望名片> (设置指定群名片)`
        });
        return;
      }
      if (specifiedGid) {
        protectedGroupCards.set(specifiedGid, cardContent);
        saveProtectedCards();
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `✅ 已成功为群 [${specifiedGid}] 设置期望群名片为：「${cardContent}」！`
        });
      } else {
        currentConfig.default_group_card = cardContent;
        const allProtected = await getProtectedGroupIds(ctx);
        for (const gid of allProtected) {
          protectedGroupCards.set(gid, cardContent);
        }
        saveConfigToFile();
        saveProtectedCards();
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `✅ 已将所有受保护群的期望群名片统一设置为：「${cardContent}」！`
        });
      }
      return;
    }

    // 18. 快捷指令：立即改名片 (#立即改名片 [群号])
    const restoreCardMatch = rawText.match(/^#(?:立即改名片|立即恢复名片|改回名片)(?:\s+(\d+))?$/);
    if (restoreCardMatch) {
      const specifiedGid = restoreCardMatch[1]?.trim();
      if (specifiedGid) {
        const res = await executeCardRestore(ctx, specifiedGid, true);
        if (!res.success) {
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `❌ 执行立即恢复群 [${specifiedGid}] 名片失败: ${res.message}`
          });
        }
      } else {
        const pendingKeys = Array.from(pendingCardRestores.keys());
        if (pendingKeys.length === 0) {
          const allGids = await getProtectedGroupIds(ctx);
          let count = 0;
          for (const gid of allGids) {
            const res = await executeCardRestore(ctx, gid, true);
            if (res.success) count++;
          }
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `✅ 已执行全量群名片校准恢复 (共处理 ${count}/${allGids.length} 个群聊)。`
          });
        } else {
          for (const gid of pendingKeys) {
            await executeCardRestore(ctx, gid, true);
          }
        }
      }
      return;
    }

    // 19. 快捷指令：取消改名片 (#取消改名片 [群号])
    const cancelCardMatch = rawText.match(/^#(?:取消改名片|取消恢复名片)(?:\s+(\d+))?$/);
    if (cancelCardMatch) {
      const specifiedGid = cancelCardMatch[1]?.trim();
      if (specifiedGid) {
        if (pendingCardRestores.has(specifiedGid)) {
          const pending = pendingCardRestores.get(specifiedGid);
          if (pending?.timer) clearTimeout(pending.timer);
          pendingCardRestores.delete(specifiedGid);
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `✅ 已成功取消群 [${specifiedGid}] 的自动改回名片任务。`
          });
        } else {
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `⚠️ 群 [${specifiedGid}] 当前没有正在等待中的改回任务。`
          });
        }
      } else {
        const count = pendingCardRestores.size;
        for (const [gid, p] of pendingCardRestores.entries()) {
          if (p?.timer) clearTimeout(p.timer);
        }
        pendingCardRestores.clear();
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `✅ 已取消所有等待中的改名片任务 (共 ${count} 个)。`
        });
      }
      return;
    }

    // 20. 快捷指令：设置改名延迟 (#设置改名延迟 <分钟数>)
    const setDelayMatch = rawText.match(/^#(?:设置改名延迟|改名延迟|设置保护延迟)(?:\s+(\d+))?$/);
    if (setDelayMatch) {
      const param = setDelayMatch[1]?.trim();
      if (param === undefined) {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `⏱️ 当前群名片修改后延迟改回时长为: ${currentConfig.protect_card_delay_minutes || 10} 分钟。\n\n💡 指令用法: #设置改名延迟 10 (设置为延迟 10 分钟后改回)`
        });
        return;
      }
      const minutes = parseInt(param, 10);
      if (minutes < 1 || minutes > 1440) {
        await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: `⚠️ 延迟分钟数必须在 1 到 1440 分钟之间。`
        });
        return;
      }
      currentConfig.protect_card_delay_minutes = minutes;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已成功设置群名片修改后延迟 ${minutes} 分钟再改回！有效避免与管理员反复互抢冲突。`
      });
      return;
    }

    // 21. 快捷指令：开启/关闭防改名片 (#开启防改名片 / #关闭防改名片)
    if (rawText === '#开启防改名片' || rawText === '#开启群名片保护') {
      currentConfig.auto_protect_group_card = true;
      saveConfigToFile();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启群名片防篡改保护！当管理员修改群名片后，系统将在 ${currentConfig.protect_card_delay_minutes || 10} 分钟后自动改回。`
      });
      return;
    }
    if (rawText === '#关闭防改名片' || rawText === '#关闭群名片保护') {
      currentConfig.auto_protect_group_card = false;
      saveConfigToFile();
      for (const [gid, p] of pendingCardRestores.entries()) {
        if (p?.timer) clearTimeout(p.timer);
      }
      pendingCardRestores.clear();
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已关闭群名片防篡改保护功能。`
      });
      return;
    }

    // 22. 检测引用回复
    let repliedMsgId = null;

    if (Array.isArray(event.message)) {
      const replySeg = event.message.find(seg => seg.type === 'reply');
      if (replySeg?.data?.id) {
        repliedMsgId = String(replySeg.data.id);
      } else if (replySeg?.data?.message_id) {
        repliedMsgId = String(replySeg.data.message_id);
      }
    }

    if (!repliedMsgId && event.raw_message) {
      const match = event.raw_message.match(/\[CQ:reply,id=(-?\d+)\]/);
      if (match) {
        repliedMsgId = match[1];
      }
    }

    // 如果不是引用回复，放行
    if (!repliedMsgId) return;

    // 提取管理员实际回复文本内容（过滤掉 reply 节点）
    let replyPayload = null;
    let cleanText = '';
    if (Array.isArray(event.message)) {
      replyPayload = event.message.filter(seg => seg.type !== 'reply');
      cleanText = replyPayload.map(seg => seg.type === 'text' ? seg.data.text : '').join('').trim();
      if (replyPayload.length > 0 && replyPayload[0].type === 'text') {
        const textVal = replyPayload[0].data.text || '';
        const trimmed = textVal.replace(/^\s+/, '');
        if (trimmed.length > 0) {
          replyPayload[0] = { ...replyPayload[0], data: { ...replyPayload[0].data, text: trimmed } };
        } else {
          replyPayload.shift();
        }
      }
    } else {
      const rawClean = (event.raw_message || '').replace(/\[CQ:reply,id=-?\d+\]\s*/, '').trim();
      if (rawClean) {
        replyPayload = rawClean;
        cleanText = rawClean;
      }
    }

    // A. 检查是否是对「好友申请通知」的引用回复！
    let friendReq = pendingFriendRequests.get(repliedMsgId);
    if (!friendReq) {
      const mapped = messageMap.get(repliedMsgId);
      if (mapped && mapped.is_friend_request && (!mapped.target_qq || mapped.target_qq === targetQq)) {
        friendReq = mapped;
      }
    }

    if (friendReq) {
      // 检查管理员输入是否为同意或拒绝 (支持 /同意, #同意, 同意 等)
      const isApprove = /^[/#]?(?:同意|通过|接收|接受|ok|yes)(?:\s+(.+))?$/i.exec(cleanText);
      if (isApprove) {
        const remark = (isApprove[1] || '').trim();
        await executeFriendRequestAction(ctx, friendReq, true, remark, targetQq);
        return;
      }

      const isReject = /^[/#]?(?:拒绝|不通过|忽略|no)$/i.test(cleanText);
      if (isReject) {
        await executeFriendRequestAction(ctx, friendReq, false, '', targetQq);
        return;
      }

      // 如果既不是同意也不是拒绝，向管理员友好提示操作格式
      await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: `💡 【好友申请处理提示】\n检测到你正在引用回复好友申请通知：\n• 发送「同意」或「同意 备注名」（支持 /同意）通过申请\n• 发送「拒绝」（支持 /拒绝）拒绝申请`
      });
      return;
    }

    // B. 对普通中转消息的引用回复 -> 原路转回发送者
    const targetInfo = messageMap.get(repliedMsgId);
    if (!targetInfo || (targetInfo.target_qq && targetInfo.target_qq !== targetQq)) {
      logger?.debug(`[Relay] 管理员引用的消息ID (${repliedMsgId}) 不在转发映射表中，可能已过期或并非转发消息`);
      return;
    }

    // 智能兜底：如果管理员引用了普通消息却发送了 /同意、同意、/拒绝
    const smartApprove = /^[/#]?(?:同意|通过|接收|接受|ok|yes)(?:\s+(.+))?$/i.exec(cleanText);
    const smartReject = /^[/#]?(?:拒绝|不通过|忽略|no)$/i.test(cleanText);
    if (targetInfo.chat_type === 'private' && (smartApprove || smartReject)) {
      const senderUin = String(targetInfo.sender_id);
      const pendingReq = await findPendingFriendRequest(ctx, senderUin) || pendingFriendRequests.get(senderUin);
      if (pendingReq) {
        logger?.info(`[Relay] 管理员引用了普通消息并回复同意/拒绝，智能转为处理该用户好友申请: ${senderUin}`);
        await executeFriendRequestAction(ctx, pendingReq, Boolean(smartApprove), smartApprove?.[1]?.trim(), targetQq);
        return;
      }
      // 如果已在好友列表中，且管理员回复 /同意 备注名，智能更新备注
      if (friendCache.has(senderUin)) {
        if (smartApprove) {
          const remark = smartApprove[1]?.trim();
          if (remark) {
            try {
              await callAction(ctx, 'set_friend_remark', { user_id: Number(senderUin), remark });
              friendCache.set(senderUin, { nickname: targetInfo.sender_name || '', remark, lastUpdated: Date.now() });
              await callAction(ctx, 'send_private_msg', { user_id: targetQq, message: `✅ 该用户已在好友列表中，已为你成功更新其备注名: ${remark} (${senderUin})` });
            } catch (e) {
              await callAction(ctx, 'send_private_msg', { user_id: targetQq, message: `✅ 该用户已在好友列表中。更新备注失败: ${e.message || e}` });
            }
          } else {
            await callAction(ctx, 'send_private_msg', { user_id: targetQq, message: `✅ 该用户已在好友列表中，无需重复通过申请。若需设置备注名可回复「/同意 备注名」` });
          }
          return;
        } else if (smartReject) {
          await callAction(ctx, 'send_private_msg', { user_id: targetQq, message: `⚠️ 该用户已是好友。如需屏蔽该会话请发送 #添加免打扰 ${senderUin}` });
          return;
        }
      }
    }

    if (!replyPayload || (Array.isArray(replyPayload) && replyPayload.length === 0)) {
      logger?.warn('[Relay] 管理员回复的内容为空，不予转发');
      return;
    }

    // 执行回传原私聊发送者
    if (targetInfo.chat_type === 'private') {
      try {
        let finalPayload = replyPayload;
        if (currentConfig.enable_quote_reply && targetInfo.original_msg_id) {
          if (Array.isArray(finalPayload)) {
            finalPayload = [{ type: 'reply', data: { id: String(targetInfo.original_msg_id) } }, ...finalPayload];
          } else {
            finalPayload = `[CQ:reply,id=${targetInfo.original_msg_id}]` + finalPayload;
          }
        }

        await callAction(ctx, 'send_private_msg', {
          user_id: targetInfo.sender_id,
          message: finalPayload
        });

        // 获取最新格式化备注名
        const currentDisplayName = await getUserDisplayName(ctx, targetInfo.sender_id, targetInfo.sender_name);

        logger?.info(`[Relay] ✅ 成功将管理员回复转发给私聊好友 ${currentDisplayName}(${targetInfo.sender_id})`);

        if (currentConfig.send_confirmation) {
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `✅ 已成功回复给私聊好友: ${currentDisplayName} (${targetInfo.sender_id})`
          });
        }
      } catch (err) {
        logger?.error(`[Relay] 转发回复给私聊好友失败:`, err);
        const currentDisplayName = await getUserDisplayName(ctx, targetInfo.sender_id, targetInfo.sender_name);
        if (currentConfig.send_confirmation) {
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `❌ 回复给 ${currentDisplayName}(${targetInfo.sender_id}) 失败: ${err.message || err}`
          });
        }
      }
    } else if (targetInfo.chat_type === 'group') {
      // 执行回传原群聊
      try {
        let groupMsg = [];
        if (currentConfig.enable_quote_reply && targetInfo.original_msg_id) {
          groupMsg.push({ type: 'reply', data: { id: String(targetInfo.original_msg_id) } });
        } else {
          groupMsg.push({ type: 'at', data: { qq: targetInfo.sender_id } });
          groupMsg.push({ type: 'text', data: { text: ' ' } });
        }
        if (Array.isArray(replyPayload)) {
          groupMsg.push(...replyPayload);
        } else {
          groupMsg.push({ type: 'text', data: { text: replyPayload } });
        }

        await callAction(ctx, 'send_group_msg', {
          group_id: targetInfo.group_id,
          message: groupMsg
        });

        const currentDisplayName = await getUserDisplayName(ctx, targetInfo.sender_id, targetInfo.sender_name);
        logger?.info(`[Relay] ✅ 成功将管理员回复转发到群聊 ${targetInfo.group_id} 并回复 ${currentDisplayName}(${targetInfo.sender_id})`);

        if (currentConfig.send_confirmation) {
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `✅ 已成功回复到群聊: ${targetInfo.group_name || targetInfo.group_id} (@${currentDisplayName})`
          });
        }
      } catch (err) {
        logger?.error(`[Relay] 转发回复到群聊失败:`, err);
        if (currentConfig.send_confirmation) {
          await callAction(ctx, 'send_private_msg', {
            user_id: targetQq,
            message: `❌ 回复到群聊 ${targetInfo.group_id} 失败: ${err.message || err}`
          });
        }
      }
    }

    return;
  }

  // ========================================================
  // 分支二：来自其他人的消息 -> 检查免打扰并转发给管理员
  // ========================================================

  // 处理私聊转发
  if (event.message_type === 'private') {
    if (!currentConfig.forward_private) return;

    // 免打扰检查：设置了免打扰的会话框不予转发
    if (await isChatDND(ctx, event)) {
      return;
    }

    // 获取发送者格式化名称（优先使用备注名）
    const senderName = await getUserDisplayName(ctx, senderId, event.sender?.nickname);

    // 检查是否为 QQ 好友申请提示 (如 QQ 私聊发送的 "请求添加你为好友")
    const rawCleanText = (event.raw_message || '').trim();
    const isFriendReqText = /^(?:请求添加(?:你|对方)为好友|请求加为好友|加为好友|申请添加你为好友)/i.test(rawCleanText);
    let detectedPendingReq = null;
    if (isFriendReqText) {
      detectedPendingReq = await findPendingFriendRequest(ctx, senderId);
    }
    if (isFriendReqText || detectedPendingReq) {
      logger?.info(`[Relay] 拦截到私聊好友申请通知: "${rawCleanText}" (来自: ${senderId})`);
      const flag = detectedPendingReq?.flag || String(event.time || Date.now());
      const comment = detectedPendingReq?.comment || (isFriendReqText ? rawCleanText : '');
      const reqTime = detectedPendingReq?.time || (event.time ? Number(event.time) * 1000 : Date.now());

      const reqInfo = {
        user_id: senderId,
        nickname: senderName,
        flag,
        comment,
        time: reqTime
      };

      await processFriendRequestAndNotify(ctx, reqInfo, targetQq);
      return;
    }

    // 检查是否为文件消息
    const fileSeg = Array.isArray(event.message)
      ? event.message.find(seg => seg.type === 'file' || seg.type === 'onlinefile')
      : null;
    const isFileMsg = Boolean(fileSeg || (event.raw_message && /\[CQ:file/i.test(event.raw_message)));

    if (isFileMsg && currentConfig.forward_file) {
      const fileName = fileSeg?.data?.file || fileSeg?.data?.fileName || '未知文件';
      const fileSize = fileSeg?.data?.file_size || fileSeg?.data?.fileSize || 0;
      const fileUrl = fileSeg?.data?.url || '';
      const sizeText = formatFileSize(fileSize);

      const fileNotice =
        `📁 【收到私聊文件】\n` +
        `━━━━━━━━━━━━━━━\n` +
        `👤 发送人: ${senderName} (${senderId})\n` +
        `📄 文件名: ${fileName}\n` +
        `📦 大小: ${sizeText}\n` +
        (fileUrl ? `🔗 下载直链: ${fileUrl}\n` : '') +
        `━━━━━━━━━━━━━━━\n` +
        `💡 提示: 已向你转发 QQ 原生文件卡片。直接【引用回复】此消息即可回复对方。`;

      try {
        const res = await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: fileNotice
        });

        if (res && res.message_id) {
          recordMessageMapping(res.message_id, {
            sender_id: senderId,
            sender_name: senderName,
            chat_type: 'private',
            original_msg_id: String(event.message_id),
            time: Date.now()
          });
        }

        // 调用 forward_friend_single_msg 进行 QQ 原生单条消息/文件卡片转发
        try {
          const forwarded = await callAction(ctx, 'forward_friend_single_msg', {
            message_id: event.message_id,
            user_id: Number(targetQq)
          });
          if (forwarded?.message_id) recordMessageMapping(forwarded.message_id, {
            sender_id: senderId, sender_name: senderName, chat_type: 'private',
            original_msg_id: String(event.message_id), time: Date.now()
          });
          logger?.info(`[Relay] 已成功将 ${senderName}(${senderId}) 的文件卡片转发至管理员`);
        } catch (fwdErr) {
          logger?.warn(`[Relay] forward_friend_single_msg 原生转发文件失败，尝试 upload_private_file:`, fwdErr);
          if (fileUrl) {
            try {
              await callAction(ctx, 'upload_private_file', {
                user_id: targetQq,
                file: fileUrl,
                name: fileName
              });
              logger?.info(`[Relay] 通过 upload_private_file 成功将文件推达管理员`);
            } catch (upErr) {
              logger?.warn(`[Relay] upload_private_file 失败:`, upErr);
            }
          }
        }
      } catch (err) {
        logger?.error(`[Relay] 转发文件通知失败:`, err);
      }
      return;
    }

    const prefix = currentConfig.show_sender_info ? `[来自私聊: ${senderName}(${senderId})]:\n` : '';

    let forwardMsg = null;
    if (Array.isArray(event.message)) {
      forwardMsg = prefix ? [{ type: 'text', data: { text: prefix } }, ...event.message] : [...event.message];
    } else {
      forwardMsg = prefix + (event.raw_message || '');
    }

    try {
      const res = await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: forwardMsg
      });

      if (res && res.message_id) {
        recordMessageMapping(res.message_id, {
          sender_id: senderId,
          sender_name: senderName,
          chat_type: 'private',
          original_msg_id: String(event.message_id),
          time: Date.now()
        });
        logger?.info(`[Relay] 已将 ${senderName}(${senderId}) 的私聊消息转发至管理员，映射ID: ${res.message_id}`);
      }
    } catch (err) {
      logger?.error(`[Relay] 转发私聊消息至管理员失败:`, err);
    }
    return;
  }

  // 处理群聊转发与 @ 提醒
  if (event.message_type === 'group') {
    // 0. 群活跃度统计与防刷屏自动补发检测（排除机器人自身消息）
    if (senderId !== selfUin) {
      await handleGroupActivityOnMessage(ctx, event);
    }

    // 检查是否有人 @ 机器人
    const isAtMe = (Array.isArray(event.message) && event.message.some(
      seg => seg.type === 'at' && String(seg.data?.qq) === selfUin
    )) || (event.raw_message && event.raw_message.includes(`[CQ:at,qq=${selfUin}]`));

    // 路由判断：
    // 1. 如果命中 @我：需要开启 notify_on_at 或者是开启了 forward_group
    // 2. 如果未命中 @我：需要开启 forward_group 且未开启 forward_group_at_only
    if (isAtMe) {
      if (!currentConfig.notify_on_at && !currentConfig.forward_group) {
        return;
      }
    } else {
      if (!currentConfig.forward_group) return;
      if (currentConfig.forward_group_at_only) return;
    }

    // 免打扰检查：设置了免打扰/接收不提醒/屏蔽的群聊会话框不予转发
    if (await isChatDND(ctx, event)) {
      return;
    }

    // 群内优先使用群名片，若无群名片则获取备注名/昵称
    const senderName = event.sender?.card || await getUserDisplayName(ctx, senderId, event.sender?.nickname);
    const groupId = String(event.group_id);
    const groupName = event.group_name || groupId;

    // 检查是否为群文件
    const fileSeg = Array.isArray(event.message)
      ? event.message.find(seg => seg.type === 'file' || seg.type === 'onlinefile')
      : null;
    const isFileMsg = Boolean(fileSeg || (event.raw_message && /\[CQ:file/i.test(event.raw_message)));

    if (isFileMsg && currentConfig.forward_file) {
      const fileName = fileSeg?.data?.file || fileSeg?.data?.fileName || '未知文件';
      const fileSize = fileSeg?.data?.file_size || fileSeg?.data?.fileSize || 0;
      const fileUrl = fileSeg?.data?.url || '';
      const sizeText = formatFileSize(fileSize);

      const fileNotice =
        `📁 【收到群聊文件${isAtMe ? ' (@提醒)' : ''}】\n` +
        `━━━━━━━━━━━━━━━\n` +
        `👥 来自群聊: ${groupName} (${groupId})\n` +
        `👤 发送人: ${senderName} (${senderId})\n` +
        `📄 文件名: ${fileName}\n` +
        `📦 大小: ${sizeText}\n` +
        (fileUrl ? `🔗 下载直链: ${fileUrl}\n` : '') +
        `━━━━━━━━━━━━━━━\n` +
        `💡 提示: 已向你转发文件卡片。直接【引用回复】此消息即可回复该群聊。`;

      try {
        const res = await callAction(ctx, 'send_private_msg', {
          user_id: targetQq,
          message: fileNotice
        });

        if (res && res.message_id) {
          recordMessageMapping(res.message_id, {
            sender_id: senderId,
            sender_name: senderName,
            chat_type: 'group',
            group_id: groupId,
            group_name: groupName,
            original_msg_id: String(event.message_id),
            time: Date.now()
          });
        }

        try {
          const forwarded = await callAction(ctx, 'forward_friend_single_msg', {
            message_id: event.message_id,
            user_id: Number(targetQq)
          });
          if (forwarded?.message_id) recordMessageMapping(forwarded.message_id, {
            sender_id: senderId, sender_name: senderName, chat_type: 'group', group_id: groupId,
            group_name: groupName, original_msg_id: String(event.message_id), time: Date.now()
          });
          logger?.info(`[Relay] 已成功将群聊 [${groupName}] 内 ${senderName} 的文件卡片转发给管理员`);
        } catch (fwdErr) {
          logger?.warn(`[Relay] forward_friend_single_msg 转发群文件卡片失败:`, fwdErr);
        }
      } catch (err) {
        logger?.error(`[Relay] 转发群文件通知失败:`, err);
      }
      return;
    }

    const prefix = currentConfig.show_sender_info
      ? (isAtMe
          ? `[来自群聊@提醒: ${groupName}(${groupId}) - ${senderName}(${senderId})]:\n`
          : `[来自群聊: ${groupName}(${groupId}) - ${senderName}(${senderId})]:\n`)
      : '';

    let filteredMsg = Array.isArray(event.message)
      ? event.message.filter(seg => !(seg.type === 'at' && String(seg.data?.qq) === selfUin))
      : (event.raw_message || '').replace(new RegExp(`\\[CQ:at,qq=${selfUin}\\]\\s*`, 'g'), '');

    let forwardMsg = null;
    if (Array.isArray(filteredMsg)) {
      forwardMsg = prefix ? [{ type: 'text', data: { text: prefix } }, ...filteredMsg] : filteredMsg;
    } else {
      forwardMsg = prefix + filteredMsg;
    }

    try {
      const res = await callAction(ctx, 'send_private_msg', {
        user_id: targetQq,
        message: forwardMsg
      });

      if (res && res.message_id) {
        recordMessageMapping(res.message_id, {
          sender_id: senderId,
          sender_name: senderName,
          chat_type: 'group',
          group_id: groupId,
          group_name: groupName,
          original_msg_id: String(event.message_id),
          time: Date.now()
        });
        logger?.info(`[Relay] 已将群聊 [${groupName}] 内 ${senderName}(${senderId}) 的${isAtMe ? ' @提醒' : ''}消息转发至管理员，映射ID: ${res.message_id}`);
      }
    } catch (err) {
      logger?.error(`[Relay] 转发群聊消息至管理员失败:`, err);
    }
    return;
  }
};

/**
 * WebUI 获取配置
 */
export const plugin_get_config = async () => {
  currentConfig.dnd_list_str = (currentConfig.dnd_list || []).join(', ');
  return currentConfig;
};

/**
 * WebUI 更新配置
 */
export const plugin_set_config = async (ctx, config) => {
  if (!config) return;
  validateConfig(config);
  const previousScheduleTimes = currentConfig.schedule_times;
  const previousRandomMinutes = Number(currentConfig.schedule_random_minutes) || 0;
  Object.assign(currentConfig, config);

  if (typeof currentConfig.dnd_list_str === 'string') {
    currentConfig.dnd_list = currentConfig.dnd_list_str.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean);
  }

  if (!currentConfig.auto_protect_group_card) {
    for (const pending of pendingCardRestores.values()) clearTimeout(pending.timer);
    pendingCardRestores.clear();
  }
  saveConfigToFile(ctx?.configPath);

  const scheduleChanged =
    previousScheduleTimes !== currentConfig.schedule_times ||
    previousRandomMinutes !== (Number(currentConfig.schedule_random_minutes) || 0);
  if (scheduleChanged) {
    generateDailySchedulePlan(new Date(), true);
  }
};

/**
 * 插件卸载/清理资源
 */
export const plugin_cleanup = async () => {
  pluginActive = false;
  if (scheduleTimer) {
    const timer = scheduleTimer;
    clearInterval(timer);
    scheduleTimer = null;
    logger?.info('[Relay Schedule] 定时调度器已停止');
    if (globalThis[schedulerStateKey]?.timer === timer) {
      delete globalThis[schedulerStateKey];
    }
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
    try { saveMessageMapNow(); } catch (err) { logger?.warn("[Relay] 保存消息映射失败:", err); }
    saveTimer = null;
  }
  if (groupActivitySaveTimer) {
    clearTimeout(groupActivitySaveTimer);
    groupActivitySaveTimer = null;
    saveGroupActivity();
  }
  for (const [gid, pending] of pendingCardRestores.entries()) {
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
  }
  pendingCardRestores.clear();
  saveDailySchedulePlan();
};
