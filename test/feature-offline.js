// Trae 桥新增能力的离线回归：文生图参数校验、应答解析、token 续期的 DeviceProof 串，
// 以及 main.js 里把本地路径转成 markdown 图片 URL 的那段。
//
// 全部不联网、不碰上游额度 —— 这几段都是「踩过坑才得出的结论」，
// 没有回归测试，下次重构一定再踩一遍。
'use strict';

const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const trae = require('../plugin/node/trae.cjs');

// main.js 是浏览器沙箱脚本：一加载就会调 cindy.onHostMessage，直接 require 会炸。
// 跟 e2e-brain.js 一样把它放进 vm 上下文，只是这里注入一个什么都不做的假 cindy，
// 只为把 localImageUrl 这个纯函数拿出来测。
const brainSandbox = {
  BroadcastChannel: class { constructor() {} postMessage() {} },
  cindy: {
    node: { async request() { return { ok: false }; } },
    onHostMessage() {},
    send() {},
  },
  setTimeout, clearTimeout, console,
};
vm.createContext(brainSandbox);
vm.runInContext(readFileSync(join(__dirname, '..', 'plugin', 'main.js'), 'utf8'), brainSandbox, { filename: 'main.js' });
const localImageUrl = brainSandbox.localImageUrl;

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log('  \u2713 ' + msg); }
function bad(msg) { fail++; console.log('  \u2717 ' + msg); }
function eq(a, b, msg) { if (a === b) ok(msg); else bad(`${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }
function truthy(v, msg) { if (v) ok(msg); else bad(msg); }
function throws(fn, re, msg) {
  try { fn(); bad(msg + '（没有抛错）'); }
  catch (e) { if (re.test(e.message)) ok(msg); else bad(`${msg}（抛了但文案不对：${e.message}）`); }
}

console.log('\n=== 第 1 组：文生图尺寸校验 ===');
// 硬约束来自实测：总像素必须落在 [3686400, 16777216]，512x512 / 1024x1024 会被上游拒。
truthy(trae.imageSizeOk('1920x1920'), '1920x1920 = 3686400 正好卡下限，通过');
truthy(trae.imageSizeOk('4096x4096'), '4096x4096 = 16777216 正好卡上限，通过');
truthy(!trae.imageSizeOk('512x512'), '512x512 太小被拒');
truthy(!trae.imageSizeOk('1024x1024'), '1024x1024 总像素不够被拒（看似合理其实不行）');
truthy(!trae.imageSizeOk('5000x5000'), '5000x5000 超过上限被拒');
truthy(trae.imageSizeOk('2k'), '预设 2k 通过');
truthy(trae.imageSizeOk('square_hd'), '预设 square_hd 通过');
truthy(trae.imageSizeOk('1920X1920'), '大写 X 也认');
truthy(!trae.imageSizeOk('1920*1920'), '乘号用 * 不认');
truthy(!trae.imageSizeOk(''), '空串不认');

console.log('\n=== 第 2 组：文生图请求体 ===');
const b1 = trae.buildImageBody({ prompt: '  一只猫  ' });
eq(JSON.stringify(b1), JSON.stringify({ prompt: '一只猫' }), '只带 prompt 时 body 只有 prompt（不允许多余字段）');
const b2 = trae.buildImageBody({ prompt: '猫', size: '2k' });
eq(JSON.stringify(b2), JSON.stringify({ prompt: '猫', image_size: '2k' }), '带 size 时映射成 image_size');
const b3 = trae.buildImageBody({ prompt: '猫', size: '' });
eq(b3.image_size, undefined, 'size 为空串时不写 image_size');
throws(() => trae.buildImageBody({ prompt: '   ' }), /prompt 不能为空/, '空 prompt 抛错');
throws(() => trae.buildImageBody({ prompt: '猫', size: '100x100' }), /不被接受/, '尺寸不合规时抛错并说明范围');

console.log('\n=== 第 3 组：生图应答解析 ===');
// 成功应答是扁平 JSON，没有 {code:0,data} 信封
eq(trae.parseImageResponse({ message: 'success', uri: 'tos://abc' }), 'tos://abc', '扁平应答里的 uri 能取到');
eq(trae.parseImageResponse({ code: 0, data: { image_url: 'https://x/y.png' } }), 'https://x/y.png', '嵌套应答也能递归找到图片地址');
throws(() => trae.parseImageResponse({ code: 3003, message: 'no such model' }), /code=3003/, 'code 非 0 时抛错并带上游码');
throws(() => trae.parseImageResponse({ message: 'success' }), /没有图片地址/, '成功但没有地址时报错');
throws(() => trae.parseImageResponse({ message: 'success', uri: '   ' }), /没有图片地址/, '空白 uri 当作没有');

console.log('\n=== 第 4 组：DeviceProof 待签串格式 ===');
// 六段必须用 \n 连接。用空格拼同样的字段会被上游判 20403 Token device not match，
// 而且跟密钥错长得一模一样，会往错方向查很久。
const msg = trae.deviceProofMessage('/trae/api/v3/oauth/ExchangeToken', 'client-1', 'refresh-1', 1700000000, 'nonce-1');
const parts = msg.split('\n');
eq(parts.length, 6, '待签串正好 6 段');
eq(parts[0], 'POST', '第 1 段是方法 POST');
eq(parts[1], '/trae/api/v3/oauth/ExchangeToken', '第 2 段是路径');
eq(parts[2], 'client-1', '第 3 段是 ClientID');
eq(parts[3], 'refresh-1', '第 4 段是 RefreshToken');
eq(parts[4], '1700000000', '第 5 段是时间戳（字符串化）');
eq(parts[5], 'nonce-1', '第 6 段是 nonce');
truthy(!msg.includes(' '), '段之间用换行连接，不含空格分隔');

// 签名：EC 私钥 + sha256，写成 RSA-SHA256 会直接抛
const { generateKeyPairSync } = require('node:crypto');
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const sig = trae.signDeviceProof('/p', 'c', 'r', pem, 1700000000, 'n');
truthy(typeof sig.Signature === 'string' && sig.Signature.length > 20, 'EC 私钥能签出非空 base64 签名');
eq(sig.Timestamp, 1700000000, '签名结构里带 Timestamp');
eq(sig.Nonce, 'n', '签名结构里带 Nonce');

console.log('\n=== 第 5 组：本地图片路径转 markdown URL ===');
if (typeof localImageUrl === 'function') {
  const r = localImageUrl('C:\\Users\\x\\AppData\\Roaming\\trae-bridge\\images\\a.png');
  eq(r.url, 'file:///C:/Users/x/AppData/Roaming/trae-bridge/images/a.png', '反斜杠转成正斜杠并加 file:// 前缀');
  eq(r.path, 'C:\\Users\\x\\AppData\\Roaming\\trae-bridge\\images\\a.png', 'path 保留原始 Windows 路径给用户复制');
  truthy(!r.url.includes('\\'), 'URL 里没有反斜杠');

  const sp = localImageUrl('C:\\my dir\\a b.png');
  truthy(!/\s/.test(sp.url), '路径里的空格被处理（URL 里不留裸空格）');

  const hs = localImageUrl('C:\\a#b\\c.png');
  truthy(hs.url.includes('%23'), '井号被编码成 %23（否则会被当成锚点）');

  const qs = localImageUrl('C:\\a?b\\c.png');
  truthy(qs.url.includes('%3F'), '问号被编码成 %3F（否则会被当成 query 起点）');

  const already = localImageUrl('https://example.com/a.png');
  eq(already.url, 'https://example.com/a.png', '已是 http(s) URL 的不会被再包一层');
  const fileUrl = localImageUrl('file:///C:/a.png');
  eq(fileUrl.url, 'file:///C:/a.png', '已是 file:// URL 的不会被再包一层');
} else {
  bad('main.js 没有导出 localImageUrl 供测试（需要在 main.js 末尾加 __test__ 导出）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
