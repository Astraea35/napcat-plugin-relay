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
  // 定时群发月薪喵表情包配置
  enable_schedule: true,           // 是否开启定时群发
  schedule_groups: "",             // 目标群聊列表（支持逗号/空格/换行分隔，如：123456, 7891011）
  schedule_times: "09:00, 12:00, 18:00", // 每天定时发送时间点（24小时制 HH:mm，支持逗号分隔）
  schedule_text: "",               // 发送表情包时的附加文本
  schedule_custom_image: "",       // 自定义表情图片路径或 URL（留空使用内置月薪喵）
};

// 内存中的消息映射: sent_msg_id -> target info
// key: String(sent_message_id)
// value: { sender_id, sender_name, chat_type, group_id, group_name, original_msg_id, time, is_friend_request, flag }
const messageMap = new Map();
const MAX_MAP_SIZE = 5000;
let saveTimer = null;
let dataDir = '';

// 待处理的好友申请缓存: key -> { user_id, nickname, flag, comment, time }
// 这里的 key 可以是 message_id (发给管理员的消息ID)、user_id (申请人QQ)、flag
const pendingFriendRequests = new Map();

// 群消息 Mask 缓存，避免对 QQ NT 核心接口的高频重复轮询
let groupMaskCache = null;
let groupMaskCacheTime = 0;
const GROUP_MASK_CACHE_TTL = 15000; // 15秒缓存

// 好友备注与昵称缓存: uin -> { nickname, remark, lastUpdated }
const friendCache = new Map();
let lastFriendRefresh = 0;
const FRIEND_CACHE_TTL = 300000; // 5分钟自动刷新缓存

/**
 * 刷新好友列表缓存（获取所有好友的最新备注与原始昵称）
 */
async function refreshFriendCache(ctx, force = false) {
  const now = Date.now();
  if (!force && friendCache.size > 0 && now - lastFriendRefresh < FRIEND_CACHE_TTL) {
    return;
  }
  try {
    const res = await ctx.actions.call('get_friend_list', {}, ctx.adapterName, ctx.pluginManager?.config);
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
      const info = await ctx.actions.call('get_stranger_info', { user_id: Number(uin) }, ctx.adapterName, ctx.pluginManager?.config);
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
function scheduleSaveMessageMap() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!dataDir) return;
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const mapFile = path.join(dataDir, 'message_map.json');
      const list = [];
      for (const [id, info] of messageMap.entries()) {
        list.push({ id, info });
      }
      fs.writeFileSync(mapFile, JSON.stringify(list), 'utf-8');
      saveTimer = null;
    } catch (err) {
      logger?.warn('[Relay] 保存消息映射文件失败:', err);
    }
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
  messageMap.set(key, info);
  scheduleSaveMessageMap();
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
  try {
    await ctx.actions.call('set_friend_add_request', {
      flag: String(reqInfo.flag),
      approve: approve,
      remark: remark || ''
    }, ctx.adapterName, ctx.pluginManager.config);

    // 清理已处理的申请记录
    pendingFriendRequests.delete(String(reqInfo.user_id));
    pendingFriendRequests.delete(String(reqInfo.flag));

    if (approve && remark) {
      friendCache.set(String(reqInfo.user_id), {
        nickname: reqInfo.nickname || '',
        remark: remark,
        lastUpdated: Date.now()
      });
    }

    const actionText = approve ? '✅ 已成功同意好友申请' : '❌ 已拒绝好友申请';
    const remarkText = (approve && remark) ? `\n🏷️ 备注名: ${remark}` : '';
    const userDisplay = await getUserDisplayName(ctx, reqInfo.user_id, reqInfo.nickname);

    await ctx.actions.call('send_private_msg', {
      user_id: targetQq,
      message: `${actionText}！\n📌 好友: ${userDisplay} (${reqInfo.user_id})${remarkText}`
    }, ctx.adapterName, ctx.pluginManager.config);

    logger?.info(`[Relay] 管理员已${approve ? '同意' : '拒绝'} ${reqInfo.user_id} 的好友申请`);
  } catch (err) {
    logger?.error('[Relay] 执行好友申请处理失败:', err);
    await ctx.actions.call('send_private_msg', {
      user_id: targetQq,
      message: `❌ 处理好友申请失败: ${err.message || err}`
    }, ctx.adapterName, ctx.pluginManager.config);
  }
}

/**
 * 处理好友申请事件
 */
async function handleFriendRequestEvent(ctx, event) {
  if (!currentConfig.forward_friend_request) return;

  const targetQq = String(currentConfig.target_qq || '').trim();
  if (!targetQq) return;

  const applicantId = String(event.user_id || '').trim();
  const flag = String(event.flag || '');
  const comment = event.comment || '';

  // 1. 获取申请人备注名或昵称 (优先备注名)
  const displayName = await getUserDisplayName(ctx, applicantId, applicantId);

  const reqInfo = {
    user_id: applicantId,
    nickname: displayName,
    flag,
    comment,
    time: event.time ? Number(event.time) * 1000 : Date.now()
  };

  // 2. 检查自动同意逻辑
  const kw = (currentConfig.auto_approve_keyword || '').trim();
  const matchKw = kw && comment.includes(kw);
  if (currentConfig.auto_approve_friend || matchKw) {
    logger?.info(`[Relay] 触发自动同意好友申请规则: ${applicantId}`);
    try {
      await ctx.actions.call('set_friend_add_request', {
        flag,
        approve: true
      }, ctx.adapterName, ctx.pluginManager.config);

      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `🤖 【自动同意好友申请】\n━━━━━━━━━━━━━━━\n📌 申请人: ${displayName} (${applicantId})\n📝 验证消息: ${comment || '(无附言)'}\n💡 匹配规则: ${currentConfig.auto_approve_friend ? '全局自动同意' : `关键词「${kw}」`}`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    } catch (err) {
      logger?.error('[Relay] 自动同意好友申请失败:', err);
    }
  }

  // 3. 构建并向管理员推送审核通知卡片
  const timeStr = new Date(reqInfo.time).toLocaleString('zh-CN', { hour12: false });
  const notifyText =
    `👤 【收到新的好友申请】\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📌 申请人: ${displayName} (${applicantId})\n` +
    `📝 验证消息: ${comment || '(无附言)'}\n` +
    `⏱️ 申请时间: ${timeStr}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `👉 处理方式（二选一）:\n` +
    `1. 直接【引用回复】本消息：\n` +
    `   • 回复「同意」或「同意 备注名」通过申请\n` +
    `   • 回复「拒绝」拒绝申请\n` +
    `2. 发送指令：\n` +
    `   • #同意 ${applicantId} [备注名]\n` +
    `   • #拒绝 ${applicantId}`;

  try {
    const res = await ctx.actions.call('send_private_msg', {
      user_id: targetQq,
      message: notifyText
    }, ctx.adapterName, ctx.pluginManager.config);

    if (res && res.message_id) {
      const sentId = String(res.message_id);
      // 记录到引用回复映射
      recordMessageMapping(sentId, {
        is_friend_request: true,
        user_id: applicantId,
        nickname,
        flag,
        comment,
        time: Date.now()
      });
      // 记录到待办申请表
      pendingFriendRequests.set(sentId, reqInfo);
    }
    pendingFriendRequests.set(applicantId, reqInfo);
    pendingFriendRequests.set(flag, reqInfo);

    logger?.info(`[Relay] 已将 ${nickname}(${applicantId}) 的好友申请推达管理员 QQ: ${targetQq}`);
  } catch (err) {
    logger?.error('[Relay] 推送好友申请至管理员失败:', err);
  }
}

/**
 * 检查当前会话框是否处于免打扰状态 (Do Not Disturb)
 * @param {object} ctx NapCat 上下文
 * @param {object} event 接收到的消息事件
 * @returns {Promise<boolean>} 若免打扰则返回 true
 */
async function isChatDND(ctx, event) {
  const senderId = String(event.user_id || '').trim();
  const groupId = event.group_id ? String(event.group_id).trim() : '';

  // 1. 检查手动自定义免打扰/黑名单名单
  if (currentConfig.dnd_list && Array.isArray(currentConfig.dnd_list)) {
    if (senderId && currentConfig.dnd_list.includes(senderId)) {
      logger?.info(`[Relay] 发送者 ${senderId} 在免打扰名单中，跳过中转`);
      return true;
    }
    if (groupId && currentConfig.dnd_list.includes(groupId)) {
      logger?.info(`[Relay] 群聊 ${groupId} 在免打扰名单中，跳过中转`);
      return true;
    }
  }

  // 若未开启 QQ 客户端免打扰自动检测，则仅依手动名单判断
  if (!currentConfig.ignore_dnd) {
    return false;
  }

  // 2. 群聊会话免打扰检测
  if (event.message_type === 'group' && groupId) {
    // A. 从 event.raw 的 protobuf 扩展字段快速检测 groupMask
    // QQ 协议规范: 1 = 接收并提醒; 2 = 接收不提醒 (免打扰); 3 = 屏蔽群消息; 4 = 进群助手
    try {
      if (event.raw) {
        if (event.raw.groupMask !== undefined) {
          const gm = Number(event.raw.groupMask);
          if (gm === 2 || gm === 3 || gm === 4) {
            logger?.info(`[Relay] 群聊 [${groupId}] 原始数据标记免打扰/屏蔽 (groupMask=${gm})，跳过转发`);
            return true;
          }
        }
        if (Array.isArray(event.raw.elements)) {
          for (const el of event.raw.elements) {
            if (el?.extraInfo?.groupMask !== undefined) {
              const gm = Number(el.extraInfo.groupMask);
              if (gm === 2 || gm === 3 || gm === 4) {
                logger?.info(`[Relay] 群聊 [${groupId}] 元素标记免打扰/屏蔽 (groupMask=${gm})，跳过转发`);
                return true;
              }
            }
          }
        }
      }
    } catch (e) {
      logger?.debug('[Relay] 检测 raw groupMask 异常:', e);
    }

    // B. 通过 QQ NT Kernel GroupService.getGroupMsgMask() 接口查询群屏蔽状态
    try {
      const groupService = ctx.core?.context?.session?.getGroupService?.();
      if (groupService && typeof groupService.getGroupMsgMask === 'function') {
        const now = Date.now();
        if (!groupMaskCache || now - groupMaskCacheTime > GROUP_MASK_CACHE_TTL) {
          groupMaskCache = await groupService.getGroupMsgMask();
          groupMaskCacheTime = now;
        }

        if (groupMaskCache) {
          let mask = undefined;
          if (groupMaskCache instanceof Map) {
            mask = groupMaskCache.get(groupId) ?? groupMaskCache.get(Number(groupId)) ?? groupMaskCache.get(BigInt(groupId));
          } else if (Array.isArray(groupMaskCache)) {
            const item = groupMaskCache.find(it => String(it.groupCode || it.code || it.id) === groupId);
            mask = item ? (item.groupMask ?? item.mask) : undefined;
          } else if (typeof groupMaskCache === 'object') {
            mask = groupMaskCache[groupId] ?? groupMaskCache[Number(groupId)];
          }

          if (mask !== undefined) {
            const maskNum = Number(mask);
            // 1 为正常提醒，2 为接收不提醒(免打扰)，3 为屏蔽群，4 为群助手
            if (maskNum !== 1) {
              logger?.info(`[Relay] 群聊 [${groupId}] QQ客户端设置为免打扰/不提醒 (mask=${maskNum})，跳过转发`);
              return true;
            }
          }
        }
      }
    } catch (err) {
      logger?.debug('[Relay] 查询 KernelGroupService.getGroupMsgMask 异常:', err);
    }
  }

  // 3. 私聊会话免打扰与屏蔽检测
  if (event.message_type === 'private' && senderId) {
    try {
      const buddyService = ctx.core?.context?.session?.getBuddyService?.();
      if (buddyService) {
        const uid = event.sender?.uid || event.raw?.senderUid || event.raw?.peerUid;
        if (uid && typeof buddyService.isBlocked === 'function') {
          const blocked = await buddyService.isBlocked(uid);
          if (blocked) {
            logger?.info(`[Relay] 私聊用户 ${senderId} (uid: ${uid}) 已被屏蔽，跳过转发`);
            return true;
          }
        }
      }
    } catch (err) {
      logger?.debug('[Relay] 查询 KernelBuddyService.isBlocked 异常:', err);
    }
  }

  return false;
}

// ========================================================
// 定时群发月薪喵表情包核心调度模块
// ========================================================

let catImageBase64Cache = null;
let scheduleTimer = null;
let lastTriggerMinute = '';

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
  let groups = [];
  if (targetGroupOverride) {
    groups = [String(targetGroupOverride).trim()];
  } else {
    groups = (currentConfig.schedule_groups || '')
      .split(/[,，\s\n]+/)
      .map(g => g.trim())
      .filter(g => /^\d+$/.test(g));
  }

  if (groups.length === 0) {
    logger?.warn(`[Relay Schedule] ${sourceLabel}: 未配置任何有效的目标群号，跳过发送`);
    return { success: false, message: '未配置任何有效的目标群号，请在插件设置中配置群号或使用指令 #设置群聊 <群号>' };
  }

  let imageFile = currentConfig.schedule_custom_image?.trim();
  if (!imageFile) {
    imageFile = getCatImageBase64();
  }

  if (!imageFile) {
    logger?.error(`[Relay Schedule] ${sourceLabel}: 无法获取月薪喵表情包资源`);
    return { success: false, message: '无法获取表情包资源文件' };
  }

  const msgElements = [];
  if (currentConfig.schedule_text && currentConfig.schedule_text.trim()) {
    msgElements.push({
      type: 'text',
      data: { text: currentConfig.schedule_text.trim() + '\n' }
    });
  }
  msgElements.push({
    type: 'image',
    data: { file: imageFile }
  });

  let successCount = 0;
  let failCount = 0;

  for (const gid of groups) {
    try {
      await ctx.actions.call('send_group_msg', {
        group_id: Number(gid),
        message: msgElements
      }, ctx.adapterName, ctx.pluginManager?.config);
      successCount++;
      logger?.info(`[Relay Schedule] ✅ ${sourceLabel}: 已成功发送月薪喵表情包至群聊: ${gid}`);
    } catch (err) {
      failCount++;
      logger?.error(`[Relay Schedule] ❌ ${sourceLabel}: 发送表情包至群聊 ${gid} 失败:`, err);
    }
  }

  return {
    success: successCount > 0,
    successCount,
    failCount,
    total: groups.length,
    message: `成功发送至 ${successCount}/${groups.length} 个群聊`
  };
}

/**
 * 启动定时调度轮询器
 */
function startScheduler(ctx) {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }

  scheduleTimer = setInterval(async () => {
    try {
      if (!currentConfig.enable_schedule) return;

      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const currentTimeStr = `${hours}:${minutes}`;
      const currentDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const triggerKey = `${currentDateStr} ${currentTimeStr}`;

      if (lastTriggerMinute === triggerKey) {
        return; // 该分钟已执行
      }

      const configuredTimes = (currentConfig.schedule_times || '')
        .split(/[,，\s]+/)
        .map(t => t.trim())
        .filter(Boolean)
        .map(t => {
          const parts = t.split(':');
          if (parts.length === 2) {
            return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
          }
          return t;
        });

      if (!configuredTimes.includes(currentTimeStr)) {
        return;
      }

      lastTriggerMinute = triggerKey;
      logger?.info(`[Relay Schedule] ⏰ 到达定时发送时间点: ${currentTimeStr}，开始执行群聊广播...`);

      await sendCatToConfiguredGroups(ctx, `定时任务(${currentTimeStr})`);
    } catch (err) {
      logger?.error('[Relay Schedule] 定时任务轮询执行异常:', err);
    }
  }, 25000);

  logger?.info('[Relay Schedule] 定时调度引擎已启动 (轮询周期: 25秒)');
}

/**
 * 插件初始化
 */
export const plugin_init = async (ctx) => {
  logger = ctx.logger;
  logger.info("消息中转与好友申请处理插件正在初始化...");

  dataDir = ctx.dataPath || '';
  pluginConfigPath = ctx.configPath || '';

  // 1. 加载配置
  try {
    if (pluginConfigPath && fs.existsSync(pluginConfigPath)) {
      const savedConfig = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf-8'));
      Object.assign(currentConfig, savedConfig);
      if (typeof currentConfig.dnd_list_str === 'string' && currentConfig.dnd_list_str.trim()) {
        currentConfig.dnd_list = currentConfig.dnd_list_str.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean);
      }
      logger.info("[Relay] 配置加载成功:", currentConfig);
    }
  } catch (err) {
    logger.warn("[Relay] 读取配置文件失败，使用默认配置:", err);
  }

  // 2. 加载历史消息映射
  loadMessageMap();

  // 3. 启动定时任务调度器
  startScheduler(ctx);

  // 4. 预加载好友列表与备注缓存
  refreshFriendCache(ctx).catch(err => logger?.debug?.('[Relay] 预加载好友缓存失败:', err));

  // 5. 构建 WebUI 配置界面
  if (ctx.NapCatConfig) {
    plugin_config_ui = ctx.NapCatConfig.combine(
      ctx.NapCatConfig.html('<div style="padding: 12px; background: rgba(0,0,0,0.04); border-radius: 8px; margin-bottom: 10px;">' +
        '<h3 style="margin: 0 0 6px 0;">📨 消息中转与引用回复插件</h3>' +
        '<p style="margin: 0; color: #666; font-size: 13px;">自动将接收到的私聊/群聊消息转发给指定管理员QQ。管理员直接【引用回复】中转消息可原路送达，对好友申请通知【引用回复】可一键同意/拒绝。</p>' +
        '</div>'),
      ctx.NapCatConfig.text("target_qq", "目标管理员 QQ", "", "接收所有转发消息与好友申请的目标好友QQ号"),
      ctx.NapCatConfig.boolean("forward_private", "转发私聊消息", true, "开启后，所有好友和陌生人发给机器人的私聊消息均会转发给管理员"),
      ctx.NapCatConfig.boolean("forward_group", "转发群聊消息", false, "是否转发群聊消息给管理员（建议谨慎开启，避免群消息过多）"),
      ctx.NapCatConfig.boolean("forward_group_at_only", "群聊仅转发@我的消息", true, "当开启群聊转发时，仅转发艾特机器人的群消息"),
      ctx.NapCatConfig.boolean("forward_file", "转发文件消息", true, "收到私聊/群聊文件时，自动向管理员转发 QQ 原生文件卡片并推送文件详情与下载直链"),
      ctx.NapCatConfig.boolean("enable_quote_reply", "回复对方时使用引用回复", true, "管理员引用回复中转消息时，机器人向原好友发送消息是否【引用回复】对方最初发送的那条消息"),
      ctx.NapCatConfig.boolean("show_original_nickname", "备注名后显示原QQ昵称", false, "开启后，若好友设置了备注名，则显示为「备注名 (原昵称)」；关闭则仅显示「备注名」"),
      ctx.NapCatConfig.boolean("forward_friend_request", "转发好友申请通知", true, "收到好友申请时推送到管理员私聊，支持管理员引用回复或发指令一键同意/拒绝"),
      ctx.NapCatConfig.boolean("auto_approve_friend", "自动同意所有好友申请", false, "无需管理员审核，收到的所有好友申请直接自动通过"),
      ctx.NapCatConfig.text("auto_approve_keyword", "关键词自动同意好友", "", "当好友申请的验证消息包含指定关键词时自动通过（留空不启用）"),
      ctx.NapCatConfig.boolean("ignore_dnd", "自动过滤QQ客户端免打扰会话", true, "自动识别并跳过QQ客户端中设置了【消息免打扰】（接收不提醒）或【屏蔽】的群聊与好友会话"),
      ctx.NapCatConfig.text("dnd_list_str", "手动免打扰名单 (QQ/群号)", "", "额外的免打扰名单，多个QQ号或群号可用逗号、空格或换行分隔，设置后这些会话的消息不会被转发"),
      ctx.NapCatConfig.boolean("show_sender_info", "显示发送者信息前缀", true, "转发消息时附加 [来自私聊: 备注名(QQ)] 标识"),
      ctx.NapCatConfig.boolean("send_confirmation", "发送回复成功回执", true, "管理员引用回复成功转回后，是否向管理员发送成功提示"),
      // 定时发送月薪喵表情包配置
      ctx.NapCatConfig.html(
        '<div style="margin: 15px 0 10px; padding: 12px; background: rgba(64, 158, 255, 0.08); border-left: 4px solid #409eff; border-radius: 4px;">' +
        '  <h4 style="margin: 0 0 5px; color: #409eff;">⏰ 定时发送月薪喵表情包</h4>' +
        '  <span style="font-size: 13px; color: #666;">支持在每天固定时间自动向指定的QQ群批量发送最新月薪喵打工表情包。群号与发送时间均可自定义。</span>' +
        '</div>'
      ),
      ctx.NapCatConfig.boolean("enable_schedule", "开启定时发送", true, "是否启用每日固定时间群发月薪喵表情包"),
      ctx.NapCatConfig.text("schedule_groups", "定时发送目标群号", "", "需要定时发送表情包的群号列表，支持多个群号，用逗号、空格或换行分隔（如：123456, 7891011）"),
      ctx.NapCatConfig.text("schedule_times", "每日定时发送时间点", "09:00, 12:00, 18:00", "24小时制 HH:mm，多个时间用逗号分隔，例如：09:00, 12:00, 18:00"),
      ctx.NapCatConfig.text("schedule_text", "附带文本说明 (可选)", "", "发送表情包时随图附带的文字，留空则纯发表情包"),
      ctx.NapCatConfig.text("schedule_custom_image", "自定义表情图片 (可选)", "", "留空则默认使用内置的最新月薪喵动态表情；可填写本地绝对路径、网络图片URL或 base64://")
    );
  }

  logger.info(`[Relay] 插件初始化完成！目标管理员: ${currentConfig.target_qq || '(未配置)'}，免打扰过滤: ${currentConfig.ignore_dnd ? '开' : '关'}，好友申请转发: ${currentConfig.forward_friend_request ? '开' : '关'}，定时月薪喵: ${currentConfig.enable_schedule ? '开' : '关'}`);
};

/**
 * 通用事件监听 (捕获好友申请 request 事件等)
 */
export const plugin_onevent = async (ctx, event) => {
  if (!event) return;

  // 捕获好友申请事件 (OneBot 11 request.friend)
  if (event.post_type === 'request' && event.request_type === 'friend') {
    await handleFriendRequestEvent(ctx, event);
  }
};

/**
 * 消息事件监听
 */
export const plugin_onmessage = async (ctx, event) => {
  if (!event || event.post_type !== 'message') return;

  const senderId = String(event.user_id || '').trim();
  const targetQq = String(currentConfig.target_qq || '').trim();
  const selfUin = String(ctx.core?.selfInfo?.uin || '').trim();

  // 未配置目标管理员或自身消息时直接忽略
  if (!targetQq || senderId === selfUin) return;

  // ========================================================
  // 分支一：来自管理员的消息 -> 检查指令或引用回复
  // ========================================================
  if (senderId === targetQq) {
    const rawText = (event.raw_message || '').trim();

    // 1. 管理员调试与状态指令
    if (rawText === '#中转状态' || rawText === '#relay' || rawText === '#relay status') {
      const dndCount = (currentConfig.dnd_list || []).length;
      const dndPreview = dndCount > 0 ? (currentConfig.dnd_list.slice(0, 5).join(', ') + (dndCount > 5 ? ` 等共${dndCount}个` : '')) : '无';
      const statusText =
        `🤖 【消息中转传话插件运行状态】\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 管理员账号: ${targetQq}\n` +
        `📥 私聊转发: ${currentConfig.forward_private ? '✅ 开启' : '❌ 关闭'}\n` +
        `👥 群聊转发: ${currentConfig.forward_group ? '✅ 开启' : '❌ 关闭'}\n` +
        `🎯 群聊仅@: ${currentConfig.forward_group_at_only ? '✅ 开启' : '❌ 关闭'}\n` +
        `📁 文件转发: ${currentConfig.forward_file ? '✅ 开启' : '❌ 关闭'}\n` +
        `🏷️ 备注名优先: ✅ 开启 (原昵称追加: ${currentConfig.show_original_nickname ? '开启' : '关闭'})\n` +
        `💬 引用回复原消息: ${currentConfig.enable_quote_reply ? '✅ 开启' : '❌ 关闭'}\n` +
        `🤝 好友申请推送: ${currentConfig.forward_friend_request ? '✅ 开启' : '❌ 关闭'}\n` +
        `🤖 好友自动通过: ${currentConfig.auto_approve_friend ? '✅ 全自动' : (currentConfig.auto_approve_keyword ? `🔑 关键词「${currentConfig.auto_approve_keyword}」` : '❌ 手动审核')}\n` +
        `🔕 QQ免打扰过滤: ${currentConfig.ignore_dnd ? '✅ 自动过滤' : '❌ 未启用'}\n` +
        `📋 手动免打扰名单: ${dndPreview}\n` +
        `🔔 发送回执: ${currentConfig.send_confirmation ? '✅ 开启' : '❌ 关闭'}\n` +
        `⏰ 定时月薪喵: ${currentConfig.enable_schedule ? '✅ 开启' : '❌ 关闭'}\n` +
        `🕒 每日触发时间: ${currentConfig.schedule_times || '未设置'}\n` +
        `📢 定时目标群聊: ${currentConfig.schedule_groups || '未配置'}\n` +
        `📊 活跃引用映射条数: ${messageMap.size} 条 | 好友缓存: ${friendCache.size} 位\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💡 快捷管理指令:\n` +
        `• 【引用回复】消息：自动原路回复该好友/群聊\n` +
        `• 【引用回复】好友申请：回复「同意」或「拒绝」处理申请\n` +
        `• 发送 #刷新好友 (立即同步最新QQ好友备注)\n` +
        `• 发送 #开启原名 / #关闭原名 (切换是否显示原昵称)\n` +
        `• 发送 #开启引用回复 / #关闭引用回复\n` +
        `• 发送 #测试月薪喵 [群号] / #月薪喵\n` +
        `• 发送 #设置群聊 <群号1,群号2...>\n` +
        `• 发送 #设置时间 <09:00,12:00,18:00>\n` +
        `• 发送 #开启月薪喵 / #关闭月薪喵\n` +
        `• 发送 #同意 <QQ号> [备注名] / #拒绝 <QQ号>\n` +
        `• 发送 #免打扰 查看免打扰设置与指令`;

      try {
        await ctx.actions.call('send_private_msg', {
          user_id: targetQq,
          message: statusText
        }, ctx.adapterName, ctx.pluginManager.config);
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
        await ctx.actions.call('send_private_msg', {
          user_id: targetQq,
          message: text
        }, ctx.adapterName, ctx.pluginManager.config);
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
        await ctx.actions.call('send_private_msg', {
          user_id: targetQq,
          message: `✅ 已成功将 [${targetId}] 加入免打扰名单！来自该好友/群聊的消息将不再转发给你。`
        }, ctx.adapterName, ctx.pluginManager.config);
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
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `✅ 已将 [${targetId}] 从免打扰名单移除，后续消息将恢复转发。`
          }, ctx.adapterName, ctx.pluginManager.config);
        } catch (e) {
          logger?.error('[Relay] 发送移除免打扰回执失败:', e);
        }
      } else {
        try {
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `⚠️ 免打扰名单中未找到 [${targetId}]。`
          }, ctx.adapterName, ctx.pluginManager.config);
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
        await ctx.actions.call('send_private_msg', {
          user_id: targetQq,
          message: `⚠️ 未找到账号/标识为 [${targetId}] 的待处理好友申请，可能已处理或已过期。`
        }, ctx.adapterName, ctx.pluginManager.config);
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
        await ctx.actions.call('send_private_msg', {
          user_id: targetQq,
          message: `⚠️ 未找到账号/标识为 [${targetId}] 的待处理好友申请，可能已处理或已过期。`
        }, ctx.adapterName, ctx.pluginManager.config);
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
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: res.success ? `✅ 已成功向群聊 [${targetGroup}] 发送月薪喵表情包！` : `❌ 发送失败: ${res.message}`
          }, ctx.adapterName, ctx.pluginManager.config);
        } else {
          const configuredGroups = (currentConfig.schedule_groups || '')
            .split(/[,，\s\n]+/)
            .map(g => g.trim())
            .filter(g => /^\d+$/.test(g));

          if (configuredGroups.length > 0) {
            const res = await sendCatToConfiguredGroups(ctx, '管理员手动指令');
            await ctx.actions.call('send_private_msg', {
              user_id: targetQq,
              message: `✅ 已执行向所有配置群聊发送月薪喵表情包，结果: ${res.message}`
            }, ctx.adapterName, ctx.pluginManager.config);
          } else {
            const imgFile = currentConfig.schedule_custom_image?.trim() || getCatImageBase64();
            await ctx.actions.call('send_private_msg', {
              user_id: targetQq,
              message: [
                { type: 'text', data: { text: '🐱 【月薪喵表情包预览】\n（当前尚未配置定时发送目标群聊，可在 WebUI 或私聊发送 #设置群聊 <群号> 进行配置）：\n' } },
                { type: 'image', data: { file: imgFile } }
              ]
            }, ctx.adapterName, ctx.pluginManager.config);
          }
        }
      } catch (err) {
        logger?.error('[Relay] 执行月薪喵测试指令异常:', err);
        await ctx.actions.call('send_private_msg', {
          user_id: targetQq,
          message: `❌ 测试发送月薪喵失败: ${err.message || err}`
        }, ctx.adapterName, ctx.pluginManager.config);
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
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `✅ 已成功更新定时发送群聊列表 (共 ${groups.length} 个有效群)：\n${groups.join(', ')}\n\n💡 发送 #测试月薪喵 可立即进行测试。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }

    // 9. 快捷指令：设置定时时间 (#设置时间 <09:00,12:00,18:00>)
    const setTimesMatch = rawText.match(/^#(?:设置时间|配置时间|定时时间)\s+(.+)$/);
    if (setTimesMatch) {
      const input = setTimesMatch[1].trim();
      currentConfig.schedule_times = input;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `✅ 已成功更新每日定时发送时间点：\n${input}\n\n系统将在每天上述设定时间向目标群聊自动发送月薪喵表情包。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }

    // 10. 快捷指令：开启/关闭月薪喵定时
    if (rawText === '#开启月薪喵' || rawText === '#启用月薪喵') {
      currentConfig.enable_schedule = true;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启定时群发月薪喵表情包。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }
    if (rawText === '#关闭月薪喵' || rawText === '#停用月薪喵' || rawText === '#禁用月薪喵') {
      currentConfig.enable_schedule = false;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已暂停定时群发月薪喵表情包。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }

    // 11. 快捷指令：开启/关闭引用回复
    if (rawText === '#开启引用回复' || rawText === '#启用引用回复') {
      currentConfig.enable_quote_reply = true;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启引用回复功能！管理员回复消息时，机器人将【引用回复】原好友/群聊的原始提问消息。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }
    if (rawText === '#关闭引用回复' || rawText === '#停用引用回复' || rawText === '#禁用引用回复') {
      currentConfig.enable_quote_reply = false;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已关闭引用回复功能，机器人回复时将直接发送普通消息。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }

    // 12. 快捷指令：开启/关闭在备注后显示原昵称
    if (rawText === '#开启原名' || rawText === '#显示原名' || rawText === '#开启原昵称') {
      currentConfig.show_original_nickname = true;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启原昵称显示！好友展示格式为：「备注名 (原昵称) (QQ号)」。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }
    if (rawText === '#关闭原名' || rawText === '#隐藏原名' || rawText === '#关闭原昵称') {
      currentConfig.show_original_nickname = false;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `✅ 已关闭原昵称显示！好友展示格式将默认仅保留「备注名 (QQ号)」。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }

    // 13. 快捷指令：开启/关闭文件转发
    if (rawText === '#开启文件转发' || rawText === '#启用文件转发') {
      currentConfig.forward_file = true;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `✅ 已开启文件转发功能！收到好友或群聊发送的文件时将自动向你推送。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }
    if (rawText === '#关闭文件转发' || rawText === '#停用文件转发') {
      currentConfig.forward_file = false;
      saveConfigToFile();
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `⏸️ 已关闭文件转发功能。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }

    // 14. 快捷指令：强制刷新好友备注列表缓存 (#刷新好友 / #更新好友)
    if (rawText === '#刷新好友' || rawText === '#更新好友' || rawText === '#同步好友') {
      await refreshFriendCache(ctx, true);
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `✅ 好友备注信息已同步刷新！当前已缓存 ${friendCache.size} 位好友的备注与昵称。`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }

    // 15. 检测引用回复
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
      if (mapped && mapped.is_friend_request) {
        friendReq = mapped;
      }
    }

    if (friendReq) {
      // 检查管理员输入是否为同意或拒绝
      const isApprove = /^(?:同意|通过|接收|接受|ok|yes)(?:\s+(.+))?$/i.exec(cleanText);
      if (isApprove) {
        const remark = (isApprove[1] || '').trim();
        await executeFriendRequestAction(ctx, friendReq, true, remark, targetQq);
        return;
      }

      const isReject = /^(?:拒绝|不通过|忽略|no)$/i.test(cleanText);
      if (isReject) {
        await executeFriendRequestAction(ctx, friendReq, false, '', targetQq);
        return;
      }

      // 如果既不是同意也不是拒绝，向管理员友好提示操作格式
      await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: `💡 【好友申请处理提示】\n检测到你正在引用回复好友申请通知：\n• 发送「同意」或「同意 备注名」通过申请\n• 发送「拒绝」拒绝申请`
      }, ctx.adapterName, ctx.pluginManager.config);
      return;
    }

    // B. 对普通中转消息的引用回复 -> 原路转回发送者
    const targetInfo = messageMap.get(repliedMsgId);
    if (!targetInfo) {
      logger?.debug(`[Relay] 管理员引用的消息ID (${repliedMsgId}) 不在转发映射表中，可能已过期或并非转发消息`);
      return;
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

        await ctx.actions.call('send_private_msg', {
          user_id: targetInfo.sender_id,
          message: finalPayload
        }, ctx.adapterName, ctx.pluginManager.config);

        // 获取最新格式化备注名
        const currentDisplayName = await getUserDisplayName(ctx, targetInfo.sender_id, targetInfo.sender_name);

        logger?.info(`[Relay] ✅ 成功将管理员回复转发给私聊好友 ${currentDisplayName}(${targetInfo.sender_id})`);

        if (currentConfig.send_confirmation) {
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `✅ 已成功回复给私聊好友: ${currentDisplayName} (${targetInfo.sender_id})`
          }, ctx.adapterName, ctx.pluginManager.config);
        }
      } catch (err) {
        logger?.error(`[Relay] 转发回复给私聊好友失败:`, err);
        const currentDisplayName = await getUserDisplayName(ctx, targetInfo.sender_id, targetInfo.sender_name);
        if (currentConfig.send_confirmation) {
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `❌ 回复给 ${currentDisplayName}(${targetInfo.sender_id}) 失败: ${err.message || err}`
          }, ctx.adapterName, ctx.pluginManager.config);
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

        await ctx.actions.call('send_group_msg', {
          group_id: targetInfo.group_id,
          message: groupMsg
        }, ctx.adapterName, ctx.pluginManager.config);

        const currentDisplayName = await getUserDisplayName(ctx, targetInfo.sender_id, targetInfo.sender_name);
        logger?.info(`[Relay] ✅ 成功将管理员回复转发到群聊 ${targetInfo.group_id} 并回复 ${currentDisplayName}(${targetInfo.sender_id})`);

        if (currentConfig.send_confirmation) {
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `✅ 已成功回复到群聊: ${targetInfo.group_name || targetInfo.group_id} (@${currentDisplayName})`
          }, ctx.adapterName, ctx.pluginManager.config);
        }
      } catch (err) {
        logger?.error(`[Relay] 转发回复到群聊失败:`, err);
        if (currentConfig.send_confirmation) {
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `❌ 回复到群聊 ${targetInfo.group_id} 失败: ${err.message || err}`
          }, ctx.adapterName, ctx.pluginManager.config);
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
        const res = await ctx.actions.call('send_private_msg', {
          user_id: targetQq,
          message: fileNotice
        }, ctx.adapterName, ctx.pluginManager.config);

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
          await ctx.actions.call('forward_friend_single_msg', {
            message_id: event.message_id,
            user_id: Number(targetQq)
          }, ctx.adapterName, ctx.pluginManager.config);
          logger?.info(`[Relay] 已成功将 ${senderName}(${senderId}) 的文件卡片转发至管理员`);
        } catch (fwdErr) {
          logger?.warn(`[Relay] forward_friend_single_msg 原生转发文件失败，尝试 upload_private_file:`, fwdErr);
          if (fileUrl) {
            try {
              await ctx.actions.call('upload_private_file', {
                user_id: targetQq,
                file: fileUrl,
                name: fileName
              }, ctx.adapterName, ctx.pluginManager.config);
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
      const res = await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: forwardMsg
      }, ctx.adapterName, ctx.pluginManager.config);

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

  // 处理群聊转发
  if (event.message_type === 'group') {
    if (!currentConfig.forward_group) return;

    // 免打扰检查：设置了免打扰/接收不提醒/屏蔽的群聊会话框不予转发
    if (await isChatDND(ctx, event)) {
      return;
    }

    if (currentConfig.forward_group_at_only) {
      const isAtMe = Array.isArray(event.message) && event.message.some(
        seg => seg.type === 'at' && String(seg.data?.qq) === selfUin
      );
      if (!isAtMe) return;
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
        `📁 【收到群聊文件】\n` +
        `━━━━━━━━━━━━━━━\n` +
        `👥 来自群聊: ${groupName} (${groupId})\n` +
        `👤 发送人: ${senderName} (${senderId})\n` +
        `📄 文件名: ${fileName}\n` +
        `📦 大小: ${sizeText}\n` +
        (fileUrl ? `🔗 下载直链: ${fileUrl}\n` : '') +
        `━━━━━━━━━━━━━━━\n` +
        `💡 提示: 已向你转发文件卡片。直接【引用回复】此消息即可回复该群聊。`;

      try {
        const res = await ctx.actions.call('send_private_msg', {
          user_id: targetQq,
          message: fileNotice
        }, ctx.adapterName, ctx.pluginManager.config);

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
          await ctx.actions.call('forward_friend_single_msg', {
            message_id: event.message_id,
            user_id: Number(targetQq)
          }, ctx.adapterName, ctx.pluginManager.config);
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
      ? `[来自群聊: ${groupName}(${groupId}) - ${senderName}(${senderId})]:\n`
      : '';

    let filteredMsg = Array.isArray(event.message)
      ? event.message.filter(seg => !(seg.type === 'at' && String(seg.data?.qq) === selfUin))
      : (event.raw_message || '');

    let forwardMsg = null;
    if (Array.isArray(filteredMsg)) {
      forwardMsg = prefix ? [{ type: 'text', data: { text: prefix } }, ...filteredMsg] : filteredMsg;
    } else {
      forwardMsg = prefix + filteredMsg;
    }

    try {
      const res = await ctx.actions.call('send_private_msg', {
        user_id: targetQq,
        message: forwardMsg
      }, ctx.adapterName, ctx.pluginManager.config);

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
        logger?.info(`[Relay] 已将群聊 [${groupName}] 内 ${senderName}(${senderId}) 的消息转发至管理员，映射ID: ${res.message_id}`);
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
  Object.assign(currentConfig, config);

  if (typeof currentConfig.dnd_list_str === 'string') {
    currentConfig.dnd_list = currentConfig.dnd_list_str.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean);
  }

  saveConfigToFile(ctx?.configPath);
};

/**
 * 插件卸载/清理资源
 */
export const plugin_cleanup = async () => {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
    logger?.info('[Relay Schedule] 定时调度器已停止');
  }
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
};
