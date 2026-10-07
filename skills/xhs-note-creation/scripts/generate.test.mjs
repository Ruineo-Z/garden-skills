import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, copyFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./generate.mjs', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('BananaRouter 脚本的 HTTP 调用与文件保存', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'xhs-image-test-')));
  const installedScript = path.join(root, 'skills/xhs-note-creation/scripts/generate.mjs');
  const configFile = path.join(root, 'skills/xhs-note-creation/config.local.json');
  await mkdir(path.dirname(installedScript), { recursive: true });
  await copyFile(script, installedScript);
  const requests = [];
  let reply = () => ({ data: [{ b64_json: png.toString('base64') }] });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { url: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined };
    requests.push(call);
    if (req.url === '/result') { res.end(png); return; }
    const result = reply(call);
    if (result.delay) await new Promise(resolve => setTimeout(resolve, result.delay));
    res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
    res.end(result.raw ?? JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const prompt = JSON.stringify({ goal: '披肩封面', references: [{ id: 'REFERENCE_0', role: '商品' }, { id: 'REFERENCE_1', role: '背景' }] }, null, 2);
  const promptFile = path.join(root, 'prompt.json');
  const product = path.join(root, 'product.png');
  await writeFile(promptFile, prompt);
  await writeFile(product, png);

  async function run(dir, extra = [], env = {}, source = promptFile) {
    const child = spawn(process.execPath, [installedScript, '--prompt-file', source, '--dir', path.join(root, dir), '--name', 'cover', ...extra], {
      cwd: root, env: { ...process.env, BANANAROUTER_API_KEY: 'test-secret', BANANAROUTER_BASE_URL: `${base}/v1`, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  }

  await t.test('从安装目录读取密钥，不依赖工作目录；环境变量可覆盖', async () => {
    await writeFile(configFile, JSON.stringify({ apiKey: '  local-test-secret  ' }));
    try {
      const result = await run('local-key', [], { BANANAROUTER_API_KEY: '' });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.at(-1).headers.authorization, 'Bearer local-test-secret');
      const record = await readFile(path.join(root, 'local-key/cover.md'), 'utf8');
      assert.ok(!record.includes('local-test-secret'));
      assert.ok(!result.stdout.includes('local-test-secret'));
      assert.equal((await run('env-key')).code, 0);
      assert.equal(requests.at(-1).headers.authorization, 'Bearer test-secret');

      reply = () => ({ status: 403, error: { message: '权限不足 local-test-secret' } });
      const failed = await run('local-key-error', [], { BANANAROUTER_API_KEY: ' ' });
      assert.equal(failed.code, 1);
      assert.ok(!failed.stderr.includes('local-test-secret'));
      assert.ok(!(await readFile(path.join(root, 'local-key-error/cover.md'), 'utf8')).includes('local-test-secret'));
    } finally {
      reply = () => ({ data: [{ b64_json: png.toString('base64') }] });
      await rm(configFile);
    }
  });

  await t.test('配置错误在请求前报错，不输出配置内容；有效环境变量无需读取配置', async () => {
    try {
      for (const source of ['{"apiKey":"private-secret"', '{"apiKey":123}', 'null', '[]', '{"apiKey":" "}']) {
        await writeFile(configFile, source);
        const count = requests.length;
        const result = await run('bad-config', [], { BANANAROUTER_API_KEY: '' });
        assert.equal(result.code, 1);
        assert.ok(result.stderr.includes(configFile));
        assert.ok(!result.stderr.includes('private-secret'));
        assert.equal(requests.length, count);
      }
      await writeFile(configFile, 'invalid json');
      assert.equal((await run('env-with-bad-config')).code, 0);
      assert.equal(requests.at(-1).headers.authorization, 'Bearer test-secret');
    } finally { await rm(configFile); }
  });

  await t.test('多参考图按序进入编辑接口；原始提示词和职责被保存', async () => {
    const remote = 'https://example.com/background.jpg';
    const result = await run('multi', ['--image', product, '--image', remote]);
    assert.equal(result.code, 0, result.stderr);
    const call = requests.at(-1);
    assert.equal(call.url, '/v1/images/edits');
    assert.equal(call.headers.authorization, 'Bearer test-secret');
    assert.equal(call.body.model, 'gpt-image-2.5-flare');
    assert.equal(call.body.n, 1);
    assert.equal(call.body.size, '1152x1536');
    assert.equal(call.body.prompt, prompt);
    assert.deepEqual(call.body.images, [`data:image/png;base64,${png.toString('base64')}`, remote]);
    assert.deepEqual(await readFile(path.join(root, 'multi/cover.png')), png);
    const markdown = await readFile(path.join(root, 'multi/cover.md'), 'utf8');
    assert.ok(markdown.includes(prompt));
    assert.ok(markdown.includes(`REFERENCE_0：${product}；用途：商品`));
    assert.ok(markdown.includes(`REFERENCE_1：${remote}；用途：背景`));
    assert.ok(markdown.includes('交付：已生成'));
    assert.ok(!markdown.includes('test-secret'));
  });

  await t.test('同名输出在发请求前拒绝，旧图不变', async () => {
    const count = requests.length;
    const result = await run('multi');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /已有文件/);
    assert.equal(requests.length, count);
    assert.deepEqual(await readFile(path.join(root, 'multi/cover.png')), png);
  });

  await t.test('无参考图走文生图接口；质量和尺寸可以指定', async () => {
    const result = await run('text', ['--quality', 'xhigh', '--size', '1024x1024']);
    assert.equal(result.code, 0, result.stderr);
    const call = requests.at(-1);
    assert.equal(call.url, '/v1/images/generations');
    assert.equal(call.body.quality, 'xhigh');
    assert.equal(call.body.size, '1024x1024');
    assert.equal(call.body.images, undefined);
  });

  await t.test('自然语言修改保留原图优先和版本名称', async () => {
    const edit = path.join(root, 'edit.txt');
    await writeFile(edit, '保留人物，调整右手与披肩接触。');
    const child = spawn(process.execPath, [installedScript, '--prompt-file', edit, '--dir', path.join(root, 'multi'), '--name', 'cover-v2', '--image', path.join(root, 'multi/cover.png'), '--image', product], {
      env: { ...process.env, BANANAROUTER_API_KEY: 'test-secret', BANANAROUTER_BASE_URL: base },
      stdio: 'ignore',
    });
    assert.equal((await once(child, 'close'))[0], 0);
    assert.equal(requests.at(-1).body.prompt, '保留人物，调整右手与披肩接触。');
    assert.ok((await readdir(path.join(root, 'multi'))).includes('cover-v2.png'));
    assert.deepEqual(await readFile(path.join(root, 'multi/cover.png')), png);
  });

  await t.test('URL 输出下载时不携带 API 密钥', async () => {
    reply = () => ({ data: [{ url: `${base}/result` }] });
    const result = await run('url');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.at(-1).headers.authorization, undefined);
    assert.deepEqual(await readFile(path.join(root, 'url/cover.png')), png);
  });

  await t.test('返回格式决定扩展名，而非强行改名为 PNG', async () => {
    reply = () => ({ data: [{ b64_json: png.toString('base64') }] });
    const result = await run('format', ['--format', 'jpeg']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.at(-1).body.output_format, 'jpeg');
    assert.deepEqual((await readdir(path.join(root, 'format'))).sort(), ['cover.md', 'cover.png']);
  });

  await t.test('业务失败和空结果均保留提示词、不重试、不创建图片', async () => {
    for (const [dir, resultBody] of [['error', { status: 403, error: { message: '权限不足 test-secret' } }], ['empty', { data: [] }], ['invalid-image', { data: [{ b64_json: Buffer.from('<html>error</html>').toString('base64') }] }], ['non-json', { raw: '<html>error</html>' }]]) {
      reply = () => resultBody;
      const count = requests.length;
      const result = await run(dir);
      assert.equal(result.code, 1);
      assert.equal(requests.length, count + 1);
      assert.ok(!result.stderr.includes('test-secret'));
      assert.deepEqual(await readdir(path.join(root, dir)), ['cover.md']);
      const markdown = await readFile(path.join(root, dir, 'cover.md'), 'utf8');
      assert.ok(markdown.includes(prompt));
      assert.ok(markdown.includes('交付：生成失败'));
      assert.ok(!markdown.includes('- 图片：'));
      assert.ok(!markdown.includes('test-secret'));
    }
  });

  await t.test('缺少密钥、无效尺寸、缺图和 Markdown 输入不发送请求', async () => {
    const count = requests.length;
    for (const [extra, env] of [[[], { BANANAROUTER_API_KEY: '' }], [['--size', '100x100'], {}], [['--image', path.join(root, 'missing.png')], {}]]) {
      assert.equal((await run('invalid', extra, env)).code, 1);
    }
    const md = path.join(root, 'record.md');
    await writeFile(md, '# 记录');
    assert.match((await run('invalid', [], {}, md)).stderr, /不要将 Markdown/);
    assert.equal(requests.length, count);
  });

  await t.test('请求超时不重新提交；记录提醒核实服务端计费', async () => {
    reply = () => ({ delay: 150, data: [{ b64_json: png.toString('base64') }] });
    const count = requests.length;
    const result = await run('timeout', ['--timeout', '0.05']);
    assert.equal(result.code, 1);
    assert.equal(requests.length, count + 1);
    const markdown = await readFile(path.join(root, 'timeout/cover.md'), 'utf8');
    assert.ok(markdown.includes('服务端可能已生成并计费'));
    assert.deepEqual(await readdir(path.join(root, 'timeout')), ['cover.md']);
  });

  await t.test('新笔记目录保留中文名称并使用本地日期', async () => {
    reply = () => ({ data: [{ b64_json: png.toString('base64') }] });
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const child = spawn(process.execPath, [installedScript, '--prompt-file', promptFile, '--note', '披肩/街拍', '--name', 'cover'], {
      cwd: root, env: { ...process.env, BANANAROUTER_API_KEY: 'test-secret', BANANAROUTER_BASE_URL: base }, stdio: 'ignore',
    });
    assert.equal((await once(child, 'close'))[0], 0);
    assert.deepEqual(await readFile(path.join(root, `${date}-披肩-街拍/cover.png`)), png);
  });
});
