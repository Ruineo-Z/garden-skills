#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'gpt-image-2.5-flare';
const HELP = `用 BananaRouter 生成一张图片（Node.js 20+，无需安装依赖）。

node scripts/generate.mjs --prompt-file prompt.json --note 披肩街拍 --name cover \\
  --image 商品.png --image 背景.png

必填：
  --prompt-file FILE     原始提示词文件（JSON 或纯文本，不接受 Markdown 记录）
  --note NAME            在当前工作目录建立 YYYY-MM-DD-笔记名称 目录
  --dir DIR              或使用已有笔记目录；与 --note 二选一
  --name NAME            cover、1、2 等；修改用 cover-v2、1-v2 等

选填：
  --image FILE_OR_URL    参考图，可重复；顺序对应 REFERENCE_0、REFERENCE_1…
  --size WxH            默认 1152x1536（3:4），也可用 auto
  --quality VALUE       默认 high；auto/low/medium/high/xhigh/max
  --format VALUE        默认 png；png/jpeg/webp
  --timeout SECONDS     请求超时，默认 600 秒；不自动重试
  --help                显示帮助

环境变量：BANANAROUTER_API_KEY；可选 BANANAROUTER_BASE_URL
默认服务地址：https://api.bananarouter.com（可带 /v1）
模型固定为 ${MODEL}；未传参考图使用文生图接口，传图使用编辑接口。
保存同名图片和 .md 记录；已有文件时拒绝调用，请选择新版本名称。`;

function parseArgs(argv) {
  const args = { image: [], size: '1152x1536', quality: 'high', format: 'png', timeout: '600' };
  const keys = new Set(['prompt-file', 'note', 'dir', 'name', 'image', 'size', 'quality', 'format', 'timeout']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!keys.has(key)) throw new Error(`未知参数：${argv[i]}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${key} 缺少值`);
    if (key === 'image') args.image.push(value);
    else {
      if (seen.has(key)) throw new Error(`--${key} 不能重复`);
      seen.add(key);
      args[key] = value;
    }
  }
  if (!args['prompt-file'] || !args.name || Boolean(args.note) === Boolean(args.dir)) {
    throw new Error('需要 --prompt-file、--name，以及 --note 或 --dir 中的一个。用 --help 查看示例。');
  }
  if (!/^(cover|[1-9]\d*)(?:-v[2-9]\d*|-v1\d+)?$/.test(args.name)) {
    throw new Error('--name 必须是 cover、配图正整数编号，或带 -v2、-v3 等版本号的名称。');
  }
  if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(args.quality)) throw new Error('quality 无效');
  if (!['png', 'jpeg', 'webp'].includes(args.format)) throw new Error('format 无效');
  args.timeout = Number(args.timeout);
  if (!Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > 3600) throw new Error('timeout 必须大于 0 且不超过 3600 秒');
  if (args.size !== 'auto') {
    const match = /^(\d+)x(\d+)$/.exec(args.size);
    if (!match) throw new Error('size 必须是 auto 或 宽x高');
    const [w, h] = match.slice(1).map(Number);
    if (w <= 0 || h <= 0 || w > 3840 || h > 3840 || w % 16 || h % 16 || Math.max(w, h) / Math.min(w, h) > 3 || w * h < 655360 || w * h > 8294400) {
      throw new Error('尺寸不符合 BananaRouter 的边长、比例或总像素限制。');
    }
  }
  return args;
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('图片数据不是可识别的 PNG、JPEG 或 WebP。');
}

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('图片或接口地址必须是无用户名和密码的 HTTP/HTTPS URL。');
  return url;
}

async function reference(value) {
  if (/^https?:\/\//i.test(value)) return { source: httpUrl(value).href, input: value };
  const source = path.resolve(value);
  const bytes = await readFile(source);
  if (!bytes.length || bytes.length >= 50 * 1024 * 1024) throw new Error(`参考图必须非空且小于 50MB：${source}`);
  const format = imageType(bytes);
  return { source, input: `data:image/${format};base64,${bytes.toString('base64')}` };
}

function noteDirectory(note) {
  const cleaned = note.trim().replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '-');
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('笔记名称不能为空或仅为点号。');
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  return path.resolve(`${date}-${cleaned}`);
}

async function ensureAbsent(file) {
  try { await access(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`已有文件：${file}；请使用新的版本名称。`);
}

function record(args, prompt, refs, state, image, detail) {
  let roles = [];
  try { roles = JSON.parse(prompt).references || []; } catch { /* 修改提示词可以是自然语言。 */ }
  const longest = Math.max(0, ...[...prompt.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const kind = args.name.includes('-v') ? '图片修改' : args.name === 'cover' ? '封面' : '后续配图';
  const mapping = refs.length ? refs.map((ref, i) => `- REFERENCE_${i}：${ref.source}${roles[i]?.role ? `；用途：${roles[i].role}` : ''}`).join('\n') : '- 无参考图';
  return `# ${args.name}\n\n## 最终提示词\n\n${fence}text\n${prompt}\n${fence}\n\n## 参考图\n\n${mapping}\n\n## 状态\n\n- 类型：${kind}\n- 交付：${state}\n${image ? `- 图片：${image}\n` : ''}- 模型：${MODEL}\n- 尺寸：${args.size}\n- 质量：${args.quality}\n${detail ? `- 说明：${detail}\n` : ''}`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return; }
  const key = process.env.BANANAROUTER_API_KEY?.trim();
  if (!key) throw new Error('缺少 BANANAROUTER_API_KEY');
  const base = httpUrl(process.env.BANANAROUTER_BASE_URL || 'https://api.bananarouter.com');
  if (base.search || base.hash || !['', '/', '/v1', '/v1/'].includes(base.pathname)) throw new Error('服务地址路径只能为空或 /v1。');
  const endpoint = `${base.origin}/v1/images/${args.image.length ? 'edits' : 'generations'}`;
  if (/\.md$/i.test(args['prompt-file'])) throw new Error('请传入原始提示词文件，不要将 Markdown 记录作为提示词。');
  const prompt = await readFile(args['prompt-file'], 'utf8');
  if (!prompt.trim()) throw new Error('提示词不能为空。');
  // 顺序读取并发送，保持 REFERENCE 编号与输入顺序一致。
  const refs = [];
  for (const image of args.image) refs.push(await reference(image));
  const dir = args.dir ? path.resolve(args.dir) : noteDirectory(args.note);
  const stem = path.join(dir, args.name);
  for (const ext of ['md', 'png', 'jpg', 'jpeg', 'webp']) await ensureAbsent(`${stem}.${ext}`);
  await mkdir(dir, { recursive: true });
  const markdown = `${stem}.md`;
  await writeFile(markdown, record(args, prompt, refs, '生成中'), { flag: 'wx' });
  let imageFile;
  const cleanError = error => String(error.message || error).split(key).join('[密钥已隐藏]').replace(/[\r\n]+/g, ' ').slice(0, 600);
  try {
    const body = { model: MODEL, prompt, n: 1, size: args.size, quality: args.quality, output_format: args.format, response_format: 'b64_json' };
    if (refs.length) body.images = refs.map(ref => ref.input);
    console.log(`正在生成 ${args.name}，模型 ${MODEL}，参考图 ${refs.length} 张。`);
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Math.ceil(args.timeout * 1000)),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`接口返回非 JSON 响应（HTTP ${response.status}）。`); }
    if (!response.ok || payload?.error) throw new Error(`HTTP ${response.status}：${payload?.error?.message || payload?.error || '请求失败'}`);
    if (!Array.isArray(payload?.data) || payload.data.length !== 1) throw new Error('接口未返回预期的一张图片。');
    const result = payload.data[0];
    let bytes;
    if (typeof result?.b64_json === 'string' && result.b64_json) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result.b64_json)) throw new Error('接口返回无效的 base64 图片。');
      bytes = Buffer.from(result.b64_json, 'base64');
    } else if (typeof result?.url === 'string' && result.url) {
      const download = await fetch(httpUrl(result.url), { signal: AbortSignal.timeout(60000) });
      if (!download.ok) throw new Error(`图片下载失败（HTTP ${download.status}）。`);
      bytes = Buffer.from(await download.arrayBuffer());
    } else throw new Error('接口未返回图片数据或下载地址。');
    const actualFormat = imageType(bytes);
    imageFile = `${stem}.${actualFormat === 'jpeg' ? 'jpg' : actualFormat}`;
    await writeFile(imageFile, bytes, { flag: 'wx' });
    await writeFile(markdown, record(args, prompt, refs, '已生成', imageFile));
    console.log(JSON.stringify({ image: imageFile, record: markdown, model: MODEL }, null, 2));
  } catch (error) {
    const detail = `${cleanError(error)}；没有自动重试。超时或连接中断时，服务端可能已生成并计费，请先核实再重新调用。`;
    await writeFile(markdown, record(args, prompt, refs, imageFile ? '图片已返回，保存未完成' : '生成失败', undefined, detail));
    throw new Error(`${detail} 提示词记录：${markdown}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
