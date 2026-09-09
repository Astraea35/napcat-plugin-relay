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
  ignore_dnd: true,       // 自动检测并跳过QQ客户端设置了“消息免打扰”或“屏蔽”的会话
  dnd_list: [],           // 手动免打扰/黑名单列表 (QQ号或群号字符串数组)
  dnd_list_str: "",       // 供 WebUI 展示的免打扰名单文本
};

// 内存中的消息映射: sent_msg_id -> target info
// key: String(sent_message_id)
// value: { sender_id, sender_name, chat_type, group_id, group_name, original_msg_id, time }
const messageMap = new Map();
const MAX_MAP_SIZE = 5000;
let saveTimer = null;
let dataDir = '';

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
  logger.info("消息中转传话插件正在初始化...");

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
        '<p style="margin: 0; color: #666; font-size: 13px;">自动将接收到的私聊/群聊消息转发给指定管理员QQ。管理员直接【引用回复】该转发消息时，插件将自动把回复内容传回给原发送者。</p>' +
        '</div>'),
      ctx.NapCatConfig.text("target_qq", "目标管理员 QQ", "", "接收所有转发消息的目标好友QQ号"),
      ctx.NapCatConfig.boolean("forward_private", "转发私聊消息", true, "开启后，所有好友和陌生人发给机器人的私聊消息均会转发给管理员"),
      ctx.NapCatConfig.boolean("forward_group", "转发群聊消息", false, "是否转发群聊消息给管理员（建议谨慎开启，避免群消息过多）"),
      ctx.NapCatConfig.boolean("forward_group_at_only", "群聊仅转发@我的消息", true, "当开启群聊转发时，仅转发艾特机器人的群消息"),
      ctx.NapCatConfig.boolean("ignore_dnd", "自动过滤QQ客户端免打扰会话", true, "自动识别并跳过QQ客户端中设置了【消息免打扰】（接收不提醒）或【屏蔽】的群聊与好友会话"),
      ctx.NapCatConfig.text("dnd_list_str", "手动免打扰名单 (QQ/群号)", "", "额外的免打扰名单，多个QQ号或群号可用逗号、空格或换行分隔，设置后这些会话的消息不会被转发"),
      ctx.NapCatConfig.boolean("show_sender_info", "显示发送者信息前缀", true, "转发消息时附加 [来自私聊: 昵称(QQ)] 标识"),
      ctx.NapCatConfig.boolean("send_confirmation", "发送回复成功回执", true, "管理员引用回复成功转回后，是否向管理员发送成功提示")
    );
  }

  logger.info(`[Relay] 插件初始化完成！目标管理员: ${currentConfig.target_qq || '(未配置)'}，免打扰过滤: ${currentConfig.ignore_dnd ? '开' : '关'}`);
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
        `🔕 QQ免打扰过滤: ${currentConfig.ignore_dnd ? '✅ 自动过滤' : '❌ 未启用'}\n` +
        `📋 手动免打扰名单: ${dndPreview}\n` +
        `🔔 发送回执: ${currentConfig.send_confirmation ? '✅ 开启' : '❌ 关闭'}\n` +
        `📊 活跃引用映射条数: ${messageMap.size} 条\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💡 提示指令:\n` +
        `• 直接【引用回复】中转消息可自动送达原发送者\n` +
        `• 发送 #免打扰 查看免打扰名单与说明\n` +
        `• 发送 #添加免打扰 <QQ或群号> 屏蔽该会话\n` +
        `• 发送 #删除免打扰 <QQ或群号> 解除屏蔽`;

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

    // 2. 管理员查看免打扰名单指令
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

    // 3. 管理员添加免打扰指令
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

    // 4. 管理员删除免打扰指令
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

    // 5. 检测引用回复
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

    // 查询映射表
    const targetInfo = messageMap.get(repliedMsgId);
    if (!targetInfo) {
      logger?.debug(`[Relay] 管理员引用的消息ID (${repliedMsgId}) 不在转发映射表中，可能已过期或并非转发消息`);
      return;
    }

    // 提取管理员实际回复内容（过滤掉 reply 节点）
    let replyPayload = null;
    if (Array.isArray(event.message)) {
      replyPayload = event.message.filter(seg => seg.type !== 'reply');
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
      const cleanRaw = (event.raw_message || '').replace(/\[CQ:reply,id=-?\d+\]\s*/, '').trim();
      if (cleanRaw) {
        replyPayload = cleanRaw;
      }
    }

    if (!replyPayload || (Array.isArray(replyPayload) && replyPayload.length === 0)) {
      logger?.warn('[Relay] 管理员回复的内容为空，不予转发');
      return;
    }

    // 执行回传原发送者
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
