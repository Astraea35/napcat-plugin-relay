import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, 'index.mjs'), 'utf8');
const admin = '10001', self = '10002', friend = '10003', group = '10004';
const noon = '2026-10-23T04:30:00Z';
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function fixture(t, config = {}, time = noon) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse(time) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-relay-test-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.copyFileSync(path.join(root, 'assets/monthly_salary_cat.gif'), path.join(dir, 'assets/monthly_salary_cat.gif'));
  const file = path.join(dir, 'test-plugin.mjs');
  fs.writeFileSync(file, source + `
export const testing = {
  setup(dir, config) { dataDir = dir; pluginConfigPath = path.join(dir, 'config.json');
    logger = { info(){}, debug(){}, warn(){}, error(){} }; Object.assign(currentConfig, config);
    backgroundOperationGapMs = 0; backgroundGate = { tail: Promise.resolve(), lastFinished: null };
    globalThis[backgroundGateKey] = backgroundGate; },
  config: currentConfig, activity: groupActivityMap, plans: dailySchedulePlan, mappings: messageMap,
  pending: pendingFriendRequests, cards: protectedGroupCards, restores: pendingCardRestores,
  generateDailySchedulePlan, sendCatToConfiguredGroups, handleGroupActivityOnMessage,
  getGroupActivity, refreshActivityFromHistory, activityHistoryCheckDue, isChatDND, readGroupMasks, callAction, checkAndScheduleCardRestore, executeCardRestore,
  saveGroupActivity, loadGroupActivity, saveMessageMapNow, loadMessageMap, startScheduler,
  runBackgroundOperation, callBackgroundAction, getJoinedGroupIds,
  setBackgroundGap(ms) { backgroundOperationGapMs = ms; },
  timing: { cardPollMs: CARD_POLL_INTERVAL_MS, historyCheckMs: ACTIVITY_HISTORY_TTL, backgroundGapMs: BACKGROUND_OPERATION_GAP_MS },
  resetPlans() { dailySchedulePlan.clear(); currentPlanDate = ''; },
  resetMask() { groupMaskCache = null; groupMaskCacheTime = 0; },
};`);
  const plugin = await import(pathToFileURL(file).href);
  plugin.testing.setup(dir, {
    target_qq: admin, schedule_groups: group, ignore_dnd: false,
    schedule_send_image: false, schedule_text: 'Test reminder', ...config
  });
  const calls = [], handlers = {};
  let serial = 20000;
  const ctx = {
    core: { selfInfo: { uin: self }, context: { session: {} }, apis: {} },
    adapterName: 'test', pluginManager: { config: {} },
    actions: { async call(action, params) {
      calls.push({ action, params: structuredClone(params) });
      if (handlers[action]) return await handlers[action](params);
      if (action === 'get_group_list') return [{ group_id: group }];
      if (action === 'get_friend_list') return [];
      if (action === 'get_group_msg_history') return { messages: [] };
      if (action === 'get_login_info') return { user_id: self };
      if (action === 'get_stranger_info') return { nickname: 'Test user' };
      if (action === 'get_group_member_info') return { card: 'Expected' };
      if (action.startsWith('send_') || action === 'forward_friend_single_msg') return { message_id: ++serial };
      return null;
    } }
  };
  const sent = action => calls.filter(c => c.action === action);
  t.after(async () => {
    await plugin.plugin_cleanup();
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { plugin, api: plugin.testing, ctx, calls, handlers, sent, dir };
}

const text = value => ({ type: 'text', data: { text: value } });
function message(user = friend, type = 'private', content = [text('Hello')], id = 9000) {
  return { post_type: 'message', message_type: type, user_id: user,
    group_id: type === 'group' ? group : undefined, message_id: id,
    message: content, raw_message: content.filter(s => s.type === 'text').map(s => s.data.text).join(''),
    sender: { nickname: 'Test user' }, time: Math.floor(Date.now() / 1000) };
}
function reply(id, value) { return message(admin, 'private', [{ type: 'reply', data: { id: String(id) } }, text(value)]); }
const request = flag => ({ post_type: 'request', request_type: 'friend', user_id: friend, flag, comment: 'Hello' });

test('private forwarding and quoted reply preserve the original destination and message id', async t => {
  const { plugin, ctx, sent } = await fixture(t);
  await plugin.plugin_onmessage(ctx, message());
  assert.equal(sent('send_private_msg').length, 1);
  assert.equal(sent('send_private_msg')[0].params.user_id, admin);
  await plugin.plugin_onmessage(ctx, reply(20001, 'Reply text'));
  const outgoing = sent('send_private_msg').find(c => c.params.user_id === friend);
  assert.equal(outgoing.params.message[0].data.id, '9000');
  assert.equal(outgoing.params.message.at(-1).data.text, 'Reply text');
});

test('ordinary group messages are ignored; @self forwards and quoted admin reply returns to that group', async t => {
  const { plugin, ctx, sent } = await fixture(t);
  await plugin.plugin_onmessage(ctx, message(friend, 'group'));
  assert.equal(sent('send_private_msg').length, 0);
  await plugin.plugin_onmessage(ctx, message(friend, 'group', [{ type: 'at', data: { qq: self } }, text('Question')], 9001));
  assert.equal(sent('send_private_msg').length, 1);
  await plugin.plugin_onmessage(ctx, reply(20001, 'Answer'));
  assert.equal(sent('send_group_msg').length, 1);
  assert.equal(sent('send_group_msg')[0].params.group_id, group);
  assert.equal(sent('send_group_msg')[0].params.message[0].data.id, '9001');
});

test('only admin private messages execute commands; admin group chatter counts as activity', async t => {
  const { plugin, api, ctx, sent } = await fixture(t);
  await plugin.plugin_onmessage(ctx, message(admin, 'group', [text('#关闭月薪喵')]));
  assert.equal(api.config.enable_schedule, true);
  assert.equal(api.getGroupActivity(group).otherMsgCount, 1);
  assert.equal(sent('send_private_msg').length, 0);
  await plugin.plugin_onmessage(ctx, message(self, 'group'));
  assert.equal(api.getGroupActivity(group).otherMsgCount, 1);
});

test('DND handles raw group flags, cached maps, friend notification settings and manual exclusions', async t => {
  const { plugin, api, ctx, sent } = await fixture(t, { ignore_dnd: true });
  const at = message(friend, 'group', [{ type: 'at', data: { qq: self } }, text('Muted')]);
  at.raw = { groupMask: 2 };
  await plugin.plugin_onmessage(ctx, at);
  assert.equal(sent('send_private_msg').length, 0);
  ctx.core.context.session.getGroupService = () => ({ getGroupMsgMask: () => ({ groupMaskMap: new Map([[group, 3]]) }) });
  delete at.raw;
  assert.equal(await api.isChatDND(ctx, at), true);
  api.resetMask();
  ctx.core.context.session.getGroupService = () => ({ getGroupMsgMask: () => new Map([[group, 1]]) });
  assert.equal(await api.isChatDND(ctx, at), false);
  ctx.core.apis.UserApi = { getUidByUinV2: async () => 'test-uid' };
  ctx.core.context.session.getBuddyService = () => ({ isBlocked: () => false });
  ctx.core.context.session.getRecentContactService = () => ({ getContacts: () => ({ foundContacts: [{ chatType: 1, peerUid: 'test-uid', isMsgDisturb: true, isBlock: false }] }) });
  await plugin.plugin_onmessage(ctx, message());
  assert.equal(sent('send_private_msg').length, 0);
  ctx.core.context.session.getBuddyService = () => ({ isBlocked: () => ({ isBlocked: false }) });
  ctx.core.apis.UserApi.getUidByUinV2 = async () => 'unmuted-uid';
  ctx.core.context.session.getRecentContactService = () => ({ getContacts: () => ({ foundContacts: [{ chatType: 1, peerUid: 'unmuted-uid', isMsgDisturb: false, isBlock: false }] }) });
  assert.equal(await api.isChatDND(ctx, message()), false);
  api.config.dnd_list = [friend];
  assert.equal(await api.isChatDND(ctx, message()), true);
});

test('manual friend notification deduplicates, quoted approval works, already processed quotes cannot reject again', async t => {
  const { plugin, ctx, sent } = await fixture(t, { auto_approve_friend: false });
  await Promise.all([plugin.plugin_onevent(ctx, request('test-flag')), plugin.plugin_onevent(ctx, request('test-flag'))]);
  assert.equal(sent('send_private_msg').length, 1);
  await plugin.plugin_onmessage(ctx, reply(20001, '同意 Test remark'));
  assert.deepEqual(sent('set_friend_add_request')[0].params, { flag: 'test-flag', approve: true, remark: 'Test remark' });
  await plugin.plugin_onmessage(ctx, reply(20001, '拒绝'));
  assert.equal(sent('set_friend_add_request').length, 1);
});

test('automatic approval is silent and persisted; keyword automatic approval is silent too', async t => {
  const { plugin, api, ctx, sent } = await fixture(t, { auto_approve_friend: true });
  await plugin.plugin_onevent(ctx, request('auto-flag'));
  assert.equal(sent('set_friend_add_request').length, 1);
  assert.equal(sent('send_private_msg').length, 0);
  api.mappings.clear();
  api.loadMessageMap();
  await plugin.plugin_onevent(ctx, request('auto-flag'));
  assert.equal(sent('set_friend_add_request').length, 1);
  api.config.auto_approve_friend = false;
  api.config.auto_approve_keyword = 'Hello';
  await plugin.plugin_onevent(ctx, request('keyword-flag'));
  assert.equal(sent('set_friend_add_request').length, 2);
  assert.equal(sent('send_private_msg').length, 0);
});

test('failed approval retains the request and reports failure instead of pretending success', async t => {
  const { plugin, api, ctx, sent, handlers } = await fixture(t, { auto_approve_friend: false });
  await plugin.plugin_onevent(ctx, request('failing-flag'));
  handlers.set_friend_add_request = () => { throw new Error('Rejected by server'); };
  await plugin.plugin_onmessage(ctx, reply(20001, '同意'));
  assert.ok(sent('send_private_msg').at(-1).params.message.includes('处理好友申请失败'));
  assert.ok(api.pending.has('failing-flag'));
  assert.equal(api.mappings.get('20001').processed, undefined);
});

test('manual rejection and quoted notification still work after reloading persisted mappings', async t => {
  const { plugin, api, ctx, sent } = await fixture(t);
  await plugin.plugin_onevent(ctx, request('reload-flag'));
  api.saveMessageMapNow();
  api.pending.clear(); api.mappings.clear(); api.loadMessageMap();
  await plugin.plugin_onmessage(ctx, reply(20001, '拒绝'));
  assert.equal(sent('set_friend_add_request')[0].params.approve, false);
});

test('daily limit is enforced for single-group sends, concurrent sends and when activity filtering is disabled', async t => {
  const { api, ctx, sent } = await fixture(t, { enable_schedule_activity_check: false });
  const result = await Promise.all(Array.from({ length: 12 }, () => api.sendCatToConfiguredGroups(ctx, 'Test', group)));
  assert.equal(sent('send_group_msg').length, 1);
  assert.equal(result.filter(r => r.successCount === 1).length, 1);
  await api.sendCatToConfiguredGroups(ctx);
  assert.equal(sent('send_group_msg').length, 1);
});

test('Shanghai 08:00 floor applies to manual and automatic sends across UTC date boundaries', async t => {
  const { api, ctx, sent } = await fixture(t, {}, '2026-10-22T23:59:59Z');
  await api.sendCatToConfiguredGroups(ctx, 'Test', group);
  assert.equal(sent('send_group_msg').length, 0);
  t.mock.timers.setTime(Date.parse('2026-10-23T00:00:00Z'));
  await api.sendCatToConfiguredGroups(ctx, 'Test', group);
  assert.equal(sent('send_group_msg').length, 1);
  assert.equal(api.getGroupActivity(group).lastSentDate, '2026-10-23');
});

test('strict > n threshold survives multiple idle days and resets only after a successful send', async t => {
  const { api, ctx, sent } = await fixture(t, { schedule_min_other_msgs: 2 });
  await api.sendCatToConfiguredGroups(ctx);
  for (const day of [24, 25, 26]) {
    t.mock.timers.setTime(Date.parse(`2026-10-${day}T04:30:00Z`));
    await api.sendCatToConfiguredGroups(ctx);
    assert.equal(sent('send_group_msg').length, 1);
  }
  api.getGroupActivity(group).otherMsgCount = 2;
  await api.sendCatToConfiguredGroups(ctx, 'Threshold', group);
  assert.equal(sent('send_group_msg').length, 1);
  api.getGroupActivity(group).otherMsgCount = 3;
  await api.sendCatToConfiguredGroups(ctx, 'Threshold', group);
  assert.equal(sent('send_group_msg').length, 2);
  assert.equal(api.getGroupActivity(group).otherMsgCount, 0);
  assert.equal(api.getGroupActivity(group).waitingForActivity, false);
});

test('deferred send is released by n+1 other messages, excludes self and duplicate deliveries', async t => {
  const { api, ctx, sent } = await fixture(t, { schedule_min_other_msgs: 1 });
  await api.sendCatToConfiguredGroups(ctx);
  t.mock.timers.setTime(Date.parse('2026-10-24T04:30:00Z'));
  api.generateDailySchedulePlan();
  await api.sendCatToConfiguredGroups(ctx);
  await api.handleGroupActivityOnMessage(ctx, message(self, 'group', [text('Self')], 9100));
  await api.handleGroupActivityOnMessage(ctx, message(friend, 'group', [text('One')], 9101));
  await api.handleGroupActivityOnMessage(ctx, message(friend, 'group', [text('One duplicate')], 9101));
  assert.equal(sent('send_group_msg').length, 1);
  await api.handleGroupActivityOnMessage(ctx, message(friend, 'group', [text('Two')], 9102));
  assert.equal(sent('send_group_msg').length, 2);
});

test('zero threshold requires one other message; waiting state and last attempt persist across reload', async t => {
  const { api, ctx, sent } = await fixture(t, { schedule_min_other_msgs: 0 });
  await api.sendCatToConfiguredGroups(ctx);
  t.mock.timers.setTime(Date.parse('2026-10-24T04:30:00Z'));
  await api.sendCatToConfiguredGroups(ctx);
  api.activity.clear(); api.loadGroupActivity();
  assert.equal(api.getGroupActivity(group).waitingForActivity, true);
  assert.equal(sent('send_group_msg').length, 1);
  api.generateDailySchedulePlan();
  await api.handleGroupActivityOnMessage(ctx, message(friend, 'group', [text('One')], 9103));
  assert.equal(sent('send_group_msg').length, 2);
  api.activity.clear(); api.loadGroupActivity();
  await api.sendCatToConfiguredGroups(ctx);
  assert.equal(sent('send_group_msg').length, 2);
});

test('ambiguous network failure keeps a persisted daily reservation, preventing retries after reload', async t => {
  const { api, ctx, sent, handlers } = await fixture(t);
  handlers.send_group_msg = () => { throw new Error('Network timeout'); };
  await api.sendCatToConfiguredGroups(ctx);
  api.activity.clear(); api.loadGroupActivity();
  await api.sendCatToConfiguredGroups(ctx);
  assert.equal(sent('send_group_msg').length, 1);
});

test('random windows stay within the same Shanghai date after 08:00 and persist across reload', async t => {
  const { api, dir } = await fixture(t, { schedule_times: '00:30 08:00 23:59 25:00 12:99', schedule_random_minutes: 120 }, '2026-10-22T17:00:00Z');
  api.generateDailySchedulePlan();
  assert.equal(api.plans.size, 3);
  for (const plan of api.plans.values()) {
    assert.ok(plan.targetTimestamp >= Date.parse('2026-10-23T00:00:00Z'));
    assert.ok(plan.targetTimestamp <= Date.parse('2026-10-23T15:59:59Z'));
  }
  const before = [...api.plans.values()].map(p => p.targetTimestamp);
  api.resetPlans(); api.generateDailySchedulePlan();
  assert.deepEqual([...api.plans.values()].map(p => p.targetTimestamp), before);
  assert.ok(fs.existsSync(path.join(dir, 'daily_schedule_plan.json')));
});

test('text-only sends are valid and empty text-only payloads are refused', async t => {
  const { api, ctx, sent } = await fixture(t);
  api.config.schedule_text = '';
  assert.equal((await api.sendCatToConfiguredGroups(ctx)).success, false);
  api.config.schedule_text = 'Text-only reminder';
  await api.sendCatToConfiguredGroups(ctx);
  assert.deepEqual(sent('send_group_msg')[0].params.message, [text('Text-only reminder')]);
});

test('card protection detects only our own card, deduplicates pending warnings and restores the baseline', async t => {
  const { plugin, api, ctx, sent } = await fixture(t, { default_group_card: 'Expected' });
  const event = { post_type: 'notice', notice_type: 'group_card', group_id: group, user_id: friend, card_new: 'Changed' };
  await plugin.plugin_onevent(ctx, event);
  assert.equal(api.restores.size, 0);
  event.user_id = self;
  await plugin.plugin_onevent(ctx, event);
  await plugin.plugin_onevent(ctx, event);
  assert.equal(api.restores.size, 1);
  assert.equal(sent('send_private_msg').length, 1);
  await api.executeCardRestore(ctx, group);
  assert.equal(sent('set_group_card')[0].params.card, 'Expected');
  assert.equal(sent('send_private_msg').length, 2);
});

test('card safety polling runs even when scheduled messaging is disabled', async t => {
  const { api, ctx, sent } = await fixture(t, { enable_schedule: false, default_group_card: 'Expected' });
  api.startScheduler(ctx);
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(15000); await settle(); }
  assert.equal(sent('get_group_member_info').length, 0);
  for (let i = 0; i < 32; i++) { t.mock.timers.tick(15000); await settle(); }
  assert.equal(sent('get_group_member_info').length, 1);
  assert.equal(sent('send_group_msg').length, 0);
});

test('known void Actions accept null success but failed statuses and send errors remain errors', async t => {
  const { api, ctx } = await fixture(t);
  ctx.actions.get = () => ({ handle: async () => ({ status: 'ok', retcode: 0, data: null }) });
  assert.equal(await api.callAction(ctx, 'set_group_card'), null);
  ctx.actions.get = () => ({ handle: async () => ({ status: 'failed', retcode: 1200, message: 'Denied' }) });
  await assert.rejects(api.callAction(ctx, 'set_group_card'), /Denied/);
  delete ctx.actions.get;
  ctx.actions.call = async () => { throw new Error('No data returned'); };
  assert.equal(await api.callAction(ctx, 'set_group_card'), null);
  await assert.rejects(api.callAction(ctx, 'send_group_msg'), /No data returned/);
});

test('configuration rejects invalid times and types before changing live settings', async t => {
  const { plugin, api, ctx } = await fixture(t);
  await assert.rejects(plugin.plugin_set_config(ctx, { schedule_times: '25:00' }), /HH:mm/);
  await assert.rejects(plugin.plugin_set_config(ctx, { enable_schedule: 'false' }), /类型/);
  await assert.rejects(plugin.plugin_set_config(ctx, { schedule_random_minutes: Infinity }), /之间/);
  assert.equal(api.config.enable_schedule, true);
  await plugin.plugin_set_config(ctx, { schedule_min_other_msgs: 0 });
  assert.equal(api.config.schedule_min_other_msgs, 0);
});

test('turning off card protection cancels pending timers and prevents automatic restores', async t => {
  const { plugin, api, ctx, sent } = await fixture(t, { default_group_card: 'Expected' });
  await api.checkAndScheduleCardRestore(ctx, group, 'Changed');
  assert.equal(api.restores.size, 1);
  await plugin.plugin_set_config(ctx, { auto_protect_group_card: false });
  assert.equal(api.restores.size, 0);
  await api.executeCardRestore(ctx, group);
  assert.equal(sent('set_group_card').length, 0);
});

test('forwarded native file card itself can be quoted to reply', async t => {
  const { plugin, ctx, sent } = await fixture(t);
  await plugin.plugin_onmessage(ctx, message(friend, 'private', [{ type: 'file', data: { file: 'example.txt', file_size: 64 } }]));
  assert.equal(sent('forward_friend_single_msg').length, 1);
  await plugin.plugin_onmessage(ctx, reply(20002, 'File received'));
  assert.ok(sent('send_private_msg').some(c => c.params.user_id === friend));
});

test('no send occurs if the daily reservation cannot be persisted', async t => {
  const { api, ctx, sent } = await fixture(t);
  t.mock.method(fs, 'renameSync', () => { throw new Error('Disk unavailable'); });
  const result = await api.sendCatToConfiguredGroups(ctx);
  assert.equal(result.failCount, 1);
  assert.equal(sent('send_group_msg').length, 0);
});

test('deferred activity reached before the scheduled slot waits for the slot, then sends once', async t => {
  const { api, ctx, sent } = await fixture(t, { schedule_min_other_msgs: 0 });
  await api.sendCatToConfiguredGroups(ctx);
  t.mock.timers.setTime(Date.parse('2026-10-24T00:00:00Z'));
  api.getGroupActivity(group).waitingForActivity = true;
  await api.handleGroupActivityOnMessage(ctx, message(friend, 'group', [text('Morning')], 9200));
  assert.equal(sent('send_group_msg').length, 1);
  t.mock.timers.setTime(Date.parse('2026-10-24T04:30:00Z'));
  api.startScheduler(ctx);
  t.mock.timers.tick(15000); await settle();
  assert.equal(sent('send_group_msg').length, 2);
});

test('automatic approvals work silently when manual request notifications are disabled', async t => {
  const { plugin, ctx, sent } = await fixture(t, { auto_approve_friend: true, forward_friend_request: false });
  await plugin.plugin_onevent(ctx, request('silent-without-notifications'));
  assert.equal(sent('set_friend_add_request').length, 1);
  assert.equal(sent('send_private_msg').length, 0);
});

test('QQ NT asynchronous group mask result uses msgMask and coalesces concurrent queries', async t => {
  const { api, ctx } = await fixture(t, { ignore_dnd: true });
  let queries = 0;
  ctx.core.eventWrapper = { async callNormalEventV2(service, listener) {
    assert.equal(service, 'NodeIKernelGroupService/getGroupMsgMask');
    assert.equal(listener, 'NodeIKernelGroupListener/onGroupsMsgMaskResult');
    queries++;
    await Promise.resolve();
    return [{}, [{ groupCode: group, msgMask: 4 }]];
  } };
  const results=await Promise.all(Array.from({ length: 5 }, () => api.isChatDND(ctx, message(friend,'group'))));
  assert.deepEqual(results, [true,true,true,true,true]);
  assert.equal(queries, 1);
});

test('private DND snapshot fallback matches the sender and respects disabling native filtering', async t => {
  const { api, ctx } = await fixture(t, { ignore_dnd: true });
  ctx.core.apis.UserApi = {
    getUidByUinV2: async () => 'correct-uid',
    getRecentContactListSnapShot: async () => ({ info: { changedList: [
      { chatType: 1, peerUid: 'someone-else', isMsgDisturb: false },
      { chatType: 1, peerUid: 'correct-uid', isMsgDisturb: true }
    ] } })
  };
  assert.equal(await api.isChatDND(ctx, message()), true);
  api.config.ignore_dnd=false;
  assert.equal(await api.isChatDND(ctx, message()), false);
});

function historyMessage(id, user=friend, seconds=5) {
  return { message_id: id, message_seq: id, user_id: user, group_id: group,
    time: Math.floor(Date.now()/1000)-seconds };
}

test('missed offline history restores eligibility without sending twice today', async t => {
  const { api, ctx, sent, handlers } = await fixture(t, { schedule_min_other_msgs: 15 });
  Object.assign(api.getGroupActivity(group), { lastSentDate: '2026-10-21', lastSentTime: Date.now()-2*86400000, otherMsgCount: 7 });
  handlers.get_group_msg_history=()=>({ messages: Array.from({length:34},(_,i)=>historyMessage(30000+i)) });
  await api.sendCatToConfiguredGroups(ctx);
  assert.equal(sent('send_group_msg').length,1);
  await api.sendCatToConfiguredGroups(ctx);
  assert.equal(sent('send_group_msg').length,1);
  assert.equal(sent('get_group_msg_history').length,1);
});

test('history and live counts overlap; own, old and duplicate history messages do not count', async t => {
  const { api, ctx, sent, handlers } = await fixture(t, { schedule_min_other_msgs: 15 });
  Object.assign(api.getGroupActivity(group), { lastSentTime: Date.now()-100000, otherMsgCount: 9 });
  const recent=Array.from({length:12},(_,i)=>historyMessage(31000+i));
  handlers.get_group_msg_history=()=>({messages:[...recent,...recent,historyMessage(32000,self),historyMessage(32001,friend,200)]});
  await api.sendCatToConfiguredGroups(ctx);
  assert.equal(api.getGroupActivity(group).otherMsgCount,12);
  assert.equal(sent('send_group_msg').length,0);
  await api.handleGroupActivityOnMessage(ctx,message(friend,'group',[text('Delayed delivery')],31000));
  assert.equal(api.getGroupActivity(group).otherMsgCount,12);
});

test('history paginates with the oldest message id and deduplicates overlapping pages', async t => {
  const { api, ctx, handlers, sent } = await fixture(t, { schedule_min_other_msgs: 15 });
  api.getGroupActivity(group).lastSentTime=Date.now()-100000;
  const first=Array.from({length:10},(_,i)=>historyMessage(33000+i,friend,10-i));
  handlers.get_group_msg_history=params=>{
    if(!params.message_seq) return {messages:first};
    assert.equal(params.message_seq,'33000');
    return {messages:[first[0],...Array.from({length:8},(_,i)=>historyMessage(34000+i,friend,30-i))]};
  };
  await api.refreshActivityFromHistory(ctx,group);
  assert.equal(api.getGroupActivity(group).otherMsgCount,18);
  assert.equal(sent('get_group_msg_history').length,2);
});

test('failed history requests retain counts and are throttled rather than blocking all future checks', async t => {
  const { api, ctx, handlers, sent } = await fixture(t);
  Object.assign(api.getGroupActivity(group),{lastSentTime:Date.now()-100000,otherMsgCount:3});
  handlers.get_group_msg_history=()=>{throw new Error('History unavailable');};
  await api.refreshActivityFromHistory(ctx,group);
  await api.refreshActivityFromHistory(ctx,group);
  assert.equal(sent('get_group_msg_history').length,1);
  assert.equal(api.getGroupActivity(group).otherMsgCount,3);
  t.mock.timers.setTime(Date.now()+299999);
  assert.equal(api.activityHistoryCheckDue(group),false);
  t.mock.timers.setTime(Date.now()+2);
  assert.equal(api.activityHistoryCheckDue(group),true);
});

test('background operations share a ten-second gap; foreground replies stay immediate', async t => {
  const { api, ctx, sent } = await fixture(t);
  api.setBackgroundGap(10000);
  const started = [];
  const first = api.runBackgroundOperation(async () => { started.push(Date.now()); });
  const second = api.runBackgroundOperation(async () => { started.push(Date.now()); });
  const third = api.runBackgroundOperation(async () => { started.push(Date.now()); });
  await settle();
  assert.equal(started.length, 1);
  await api.callAction(ctx, 'send_private_msg', { user_id: admin, message: 'Immediate reply' });
  assert.equal(sent('send_private_msg').length, 1);
  t.mock.timers.tick(9999); await settle();
  assert.equal(started.length, 1);
  t.mock.timers.tick(1); await settle();
  assert.equal(started.length, 2);
  t.mock.timers.tick(10000); await settle();
  await Promise.all([first, second, third]);
  assert.deepEqual(started.map(t => t-started[0]), [0, 10000, 20000]);
});

test('the ten-second gap starts when the previous operation finishes', async t => {
  const { api } = await fixture(t);
  api.setBackgroundGap(10000);
  let finish;
  const started=[];
  const first=api.runBackgroundOperation(()=>new Promise(resolve=>{ finish=resolve; started.push(Date.now()); }));
  const second=api.runBackgroundOperation(async()=>{ started.push(Date.now()); });
  await settle();
  t.mock.timers.tick(8000); finish(); await settle();
  t.mock.timers.tick(9999); await settle();
  assert.equal(started.length,1);
  t.mock.timers.tick(1); await settle();
  await Promise.all([first,second]);
  assert.equal(started[1]-started[0],18000);
});

test('a failed background operation also enforces the gap before the next operation', async t => {
  const { api } = await fixture(t);
  api.setBackgroundGap(10000);
  const first=api.runBackgroundOperation(async()=>{ throw new Error('API failed'); });
  const failed=assert.rejects(first,/API failed/);
  let calls=0;
  const next=api.runBackgroundOperation(async()=>{ calls++; });
  await failed; await settle();
  assert.equal(calls,0);
  t.mock.timers.tick(10000); await settle();
  await next;
  assert.equal(calls,1);
});

test('unloading cancels queued background operations without sending or reserving the day', async t => {
  const { plugin, api, ctx, sent } = await fixture(t);
  await api.getJoinedGroupIds(ctx);
  api.setBackgroundGap(10000);
  await api.runBackgroundOperation(async()=>{});
  const sending=api.sendCatToConfiguredGroups(ctx);
  await settle();
  assert.equal(api.getGroupActivity(group).lastAttemptDate,'');
  await plugin.plugin_cleanup();
  const result=await sending;
  assert.equal(result.skippedCount,1);
  assert.equal(sent('send_group_msg').length,0);
  assert.equal(api.getGroupActivity(group).lastAttemptDate,'');
});

test('queued group sends recheck the date and 08:00 floor after waiting', async t => {
  const { api, ctx, sent } = await fixture(t, {}, '2026-10-23T15:59:55Z');
  await api.getJoinedGroupIds(ctx);
  api.setBackgroundGap(10000);
  await api.runBackgroundOperation(async()=>{});
  const sending=api.sendCatToConfiguredGroups(ctx);
  await settle();
  t.mock.timers.tick(10000); await settle();
  const result=await sending;
  assert.equal(result.skippedCount,1);
  assert.equal(sent('send_group_msg').length,0);
  assert.equal(api.getGroupActivity(group).lastAttemptDate,'');
});

test('production intervals are ten minutes, five minutes, and ten seconds', async t => {
  const { api } = await fixture(t);
  assert.deepEqual(api.timing,{cardPollMs:600000,historyCheckMs:300000,backgroundGapMs:10000});
});

test('history throttle starts after a slow queued check completes and suppresses overlapping checks', async t => {
  const { api, ctx, handlers } = await fixture(t);
  api.getGroupActivity(group).lastSentTime=Date.now()-100000;
  let finish;
  handlers.get_group_msg_history=()=>new Promise(resolve=>{finish=resolve;});
  const checking=api.refreshActivityFromHistory(ctx,group);
  await settle();
  t.mock.timers.setTime(Date.now()+600000);
  assert.equal(api.activityHistoryCheckDue(group),false);
  finish({messages:[]}); await checking;
  t.mock.timers.setTime(Date.now()+299999);
  assert.equal(api.activityHistoryCheckDue(group),false);
  t.mock.timers.setTime(Date.now()+1);
  assert.equal(api.activityHistoryCheckDue(group),true);
});

test('a queued automatic operation rechecks its enabled flag before dispatch', async t => {
  const { api, ctx, sent } = await fixture(t);
  api.setBackgroundGap(10000);
  await api.runBackgroundOperation(async()=>{});
  let enabled=true;
  const pending=api.callBackgroundAction(ctx,'set_group_card',{group_id:group,user_id:self,card:'Expected'},()=>enabled);
  const cancelled=assert.rejects(pending,error=>error.code==='RELAY_BACKGROUND_CANCELLED');
  await settle();
  enabled=false;
  t.mock.timers.tick(10000); await cancelled;
  assert.equal(sent('set_group_card').length,0);
});

test('a group @ notification stays immediate while its activity-triggered reminder waits in the background', async t => {
  const { plugin, api, ctx, sent } = await fixture(t, { schedule_min_other_msgs:0 });
  await api.getJoinedGroupIds(ctx);
  api.setBackgroundGap(10000);
  await api.runBackgroundOperation(async()=>{});
  api.generateDailySchedulePlan();
  Object.assign(api.getGroupActivity(group),{lastSentDate:'2026-10-22',lastSentTime:Date.now()-86400000,waitingForActivity:true});
  await plugin.plugin_onmessage(ctx,message(friend,'group',[{type:'at',data:{qq:self}},text('Please reply')],39000));
  assert.equal(sent('send_private_msg').length,1);
  assert.equal(sent('send_group_msg').length,0);
  t.mock.timers.tick(10000); await settle();
  assert.equal(sent('send_group_msg').length,1);
});

test('queued automatic card restores cannot overwrite a newly changed expected card', async t => {
  const { api, ctx, sent } = await fixture(t, { default_group_card:'Expected' });
  api.setBackgroundGap(10000);
  const restoring=api.executeCardRestore(ctx,group);
  await settle();
  assert.equal(sent('get_group_list').length,1);
  api.config.default_group_card='New expected card';
  t.mock.timers.tick(10000); await settle();
  const result=await restoring;
  assert.equal(result.success,false);
  assert.equal(sent('set_group_card').length,0);
});

test('waiting groups periodically recover offline history even without new live messages', async t => {
  const { api, ctx, handlers, sent } = await fixture(t, { schedule_min_other_msgs: 15 });
  Object.assign(api.getGroupActivity(group),{lastSentDate:'2026-10-21',lastSentTime:Date.now()-2*86400000,otherMsgCount:7,waitingForActivity:true});
  handlers.get_group_msg_history=()=>({messages:Array.from({length:25},(_,i)=>historyMessage(35000+i))});
  api.startScheduler(ctx);
  t.mock.timers.tick(15000); await settle();
  assert.equal(sent('send_group_msg').length,1);
});
