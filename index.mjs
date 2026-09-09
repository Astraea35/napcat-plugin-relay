import fs from 'fs';
import path from 'path';

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
  ignore_dnd: true,                // 自动检测并跳过QQ客户端设置了“消息免打扰”或“屏蔽”的会话
  dnd_list: [],                    // 手动免打扰/黑名单列表 (QQ号或群号字符串数组)
  dnd_list_str: "",                // 供 WebUI 展示的免打扰名单文本
  forward_friend_request: true,    // 转发好友申请给管理员
  auto_approve_friend: false,      // 是否自动同意好友申请
  auto_approve_keyword: "",        // 附言包含关键字时自动同意（留空不启用）
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

    const actionText = approve ? '✅ 已成功同意好友申请' : '❌ 已拒绝好友申请';
    const remarkText = (approve && remark) ? `\n🏷️ 备注名: ${remark}` : '';
    const userDisplay = reqInfo.nickname ? `${reqInfo.nickname} (${reqInfo.user_id})` : reqInfo.user_id;

    await ctx.actions.call('send_private_msg', {
      user_id: targetQq,
      message: `${actionText}！\n📌 好友: ${userDisplay}${remarkText}`
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

  // 1. 获取申请人昵称 (如有)
  let nickname = applicantId;
  try {
    const info = await ctx.actions.call('get_stranger_info', {
      user_id: Number(applicantId)
    }, ctx.adapterName, ctx.pluginManager.config);
    if (info && info.nickname) {
      nickname = info.nickname;
    }
  } catch (e) {
    logger?.debug('[Relay] 获取陌生人信息异常:', e);
  }

  const reqInfo = {
    user_id: applicantId,
    nickname,
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
        message: `🤖 【自动同意好友申请】\n━━━━━━━━━━━━━━━\n📌 申请人: ${nickname} (${applicantId})\n📝 验证消息: ${comment || '(无附言)'}\n💡 匹配规则: ${currentConfig.auto_approve_friend ? '全局自动同意' : `关键词「${kw}」`}`
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
    `📌 申请人: ${nickname} (${applicantId})\n` +
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

  // 3. 构建 WebUI 配置界面
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
      ctx.NapCatConfig.boolean("forward_friend_request", "转发好友申请通知", true, "收到好友申请时推送到管理员私聊，支持管理员引用回复或发指令一键同意/拒绝"),
      ctx.NapCatConfig.boolean("auto_approve_friend", "自动同意所有好友申请", false, "无需管理员审核，收到的所有好友申请直接自动通过"),
      ctx.NapCatConfig.text("auto_approve_keyword", "关键词自动同意好友", "", "当好友申请的验证消息包含指定关键词时自动通过（留空不启用）"),
      ctx.NapCatConfig.boolean("ignore_dnd", "自动过滤QQ客户端免打扰会话", true, "自动识别并跳过QQ客户端中设置了【消息免打扰】（接收不提醒）或【屏蔽】的群聊与好友会话"),
      ctx.NapCatConfig.text("dnd_list_str", "手动免打扰名单 (QQ/群号)", "", "额外的免打扰名单，多个QQ号或群号可用逗号、空格或换行分隔，设置后这些会话的消息不会被转发"),
      ctx.NapCatConfig.boolean("show_sender_info", "显示发送者信息前缀", true, "转发消息时附加 [来自私聊: 昵称(QQ)] 标识"),
      ctx.NapCatConfig.boolean("send_confirmation", "发送回复成功回执", true, "管理员引用回复成功转回后，是否向管理员发送成功提示")
    );
  }

  logger.info(`[Relay] 插件初始化完成！目标管理员: ${currentConfig.target_qq || '(未配置)'}，免打扰过滤: ${currentConfig.ignore_dnd ? '开' : '关'}，好友申请转发: ${currentConfig.forward_friend_request ? '开' : '关'}`);
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
        `🤝 好友申请推送: ${currentConfig.forward_friend_request ? '✅ 开启' : '❌ 关闭'}\n` +
        `🤖 好友自动通过: ${currentConfig.auto_approve_friend ? '✅ 全自动' : (currentConfig.auto_approve_keyword ? `🔑 关键词「${currentConfig.auto_approve_keyword}」` : '❌ 手动审核')}\n` +
        `🔕 QQ免打扰过滤: ${currentConfig.ignore_dnd ? '✅ 自动过滤' : '❌ 未启用'}\n` +
        `📋 手动免打扰名单: ${dndPreview}\n` +
        `🔔 发送回执: ${currentConfig.send_confirmation ? '✅ 开启' : '❌ 关闭'}\n` +
        `📊 活跃引用映射条数: ${messageMap.size} 条\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💡 提示指令:\n` +
        `• 【引用回复】消息：自动原路回复该好友/群聊\n` +
        `• 【引用回复】好友申请：回复「同意」或「拒绝」即可处理申请\n` +
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

    // 7. 检测引用回复
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
        await ctx.actions.call('send_private_msg', {
          user_id: targetInfo.sender_id,
          message: replyPayload
        }, ctx.adapterName, ctx.pluginManager.config);

        logger?.info(`[Relay] ✅ 成功将管理员回复转发给私聊好友 ${targetInfo.sender_name}(${targetInfo.sender_id})`);

        if (currentConfig.send_confirmation) {
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `✅ 已成功回复给私聊好友: ${targetInfo.sender_name} (${targetInfo.sender_id})`
          }, ctx.adapterName, ctx.pluginManager.config);
        }
      } catch (err) {
        logger?.error(`[Relay] 转发回复给私聊好友失败:`, err);
        if (currentConfig.send_confirmation) {
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `❌ 回复给 ${targetInfo.sender_name}(${targetInfo.sender_id}) 失败: ${err.message || err}`
          }, ctx.adapterName, ctx.pluginManager.config);
        }
      }
    } else if (targetInfo.chat_type === 'group') {
      // 执行回传原群聊
      try {
        const atSeg = { type: 'at', data: { qq: targetInfo.sender_id } };
        const spaceSeg = { type: 'text', data: { text: ' ' } };
        const groupMsg = Array.isArray(replyPayload)
          ? [atSeg, spaceSeg, ...replyPayload]
          : [atSeg, spaceSeg, { type: 'text', data: { text: replyPayload } }];

        await ctx.actions.call('send_group_msg', {
          group_id: targetInfo.group_id,
          message: groupMsg
        }, ctx.adapterName, ctx.pluginManager.config);

        logger?.info(`[Relay] ✅ 成功将管理员回复转发到群聊 ${targetInfo.group_id} 并@${targetInfo.sender_name}(${targetInfo.sender_id})`);

        if (currentConfig.send_confirmation) {
          await ctx.actions.call('send_private_msg', {
            user_id: targetQq,
            message: `✅ 已成功回复到群聊: ${targetInfo.group_name || targetInfo.group_id} (@${targetInfo.sender_name})`
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

    const senderName = event.sender?.card || event.sender?.nickname || senderId;
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

    const senderName = event.sender?.card || event.sender?.nickname || senderId;
    const groupId = String(event.group_id);
    const groupName = event.group_name || groupId;
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
