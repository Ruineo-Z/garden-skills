# BananaRouter 生图工具

需要生成图片时使用 [generate.mjs](../scripts/generate.mjs)。Node.js 20+，无额外依赖，可随整个 Skill 安装到全局 Agents Skills 目录。

## 配置

推荐安装后在 Skill 根目录单独配置一次。以 `~/.agents/skills/xhs-note-creation/` 为例，将 [config.example.json](../config.example.json) 复制为同目录的 `config.local.json`，然后填写 BananaRouter 密钥：

```json
{
  "apiKey": "在这里填写你的 BananaRouter API Key"
}
```

配置文件的完整位置是 `~/.agents/skills/xhs-note-creation/config.local.json`。脚本根据自身所在位置寻找配置，不依赖 Agent 的工作目录；能访问这个全局 Skill 并运行 Node.js 的 Agent 都可使用同一份配置，无需各自设置环境变量。

可在终端复制模板并限制文件访问权限，再用编辑器填写：

```bash
cp ~/.agents/skills/xhs-note-creation/config.example.json ~/.agents/skills/xhs-note-creation/config.local.json
chmod 600 ~/.agents/skills/xhs-note-creation/config.local.json
```

只在首次配置时复制模板，已有配置时直接编辑，避免覆盖密钥。更新 Skill 时保留本地 `config.local.json`。

非空环境变量 `BANANAROUTER_API_KEY` 优先于本地配置；未设置或为空时读取 `config.local.json` 的 `apiKey`。两者都没有可用密钥时，脚本在请求前报错并指出配置位置。脚本不自动加载 `.env`。

真实密钥只放在本地配置或环境变量中，不写入 `SKILL.md`、示例文件或提示词。`config.local.json` 已被 Git 忽略，仓库发布打包脚本也会排除它；自行分享或打包 Skill 时同样排除该文件。Agent 直接运行脚本即可，不需要读取或输出密钥内容。

- 默认服务地址：`https://api.bananarouter.com`。
- 可选环境变量 `BANANAROUTER_BASE_URL` 可以指定服务地址，末尾可带 `/v1`。
- 模型固定为 `gpt-image-2.5-flare`，不自动换模型。
- 默认 `1152x1536`（3:4）、`high`、PNG；`--quality` 可选 `auto/low/medium/high/xhigh/max`，`--format` 可选 `png/jpeg/webp`。

## 调用

先完成创作推导，将实际发送的提示词保存为独立 JSON 或纯文本文件。JSON 会整体作为 `prompt` 字符串发送，不被当成 API 请求体。不要把整份 Markdown 记录传给脚本。

首次生成封面，从 Agent 的默认工作目录调用；以下路径需替换成真实路径：

```bash
node /path/to/xhs-note-creation/scripts/generate.mjs \
  --prompt-file /path/to/cover.prompt.json \
  --note '披肩秋日街拍' --name cover \
  --image /path/to/product.png \
  --image /path/to/background.jpg
```

目录按机器本地日期命名，如 `2026-10-06-披肩秋日街拍/`。实际使用时可先建好笔记目录保存原始提示词，再用 `--dir` 指向它。后续配图和修改始终使用原笔记目录，不因日期变化建新目录：

```bash
node /path/to/xhs-note-creation/scripts/generate.mjs \
  --prompt-file /path/to/笔记目录/1.prompt.json \
  --dir /path/to/笔记目录 --name 1 \
  --image /path/to/product.png \
  --image /path/to/笔记目录/cover.png
```

修改时传入自然语言指令，目标原图放第一张：

```bash
node /path/to/xhs-note-creation/scripts/generate.mjs \
  --prompt-file /path/to/笔记目录/cover-v2.prompt.txt \
  --dir /path/to/笔记目录 --name cover-v2 \
  --image /path/to/笔记目录/cover.png \
  --image /path/to/product.png
```

`--image` 可重复传入本地 PNG/JPEG/WebP 或 HTTP/HTTPS 图片 URL，顺序对应 `REFERENCE_0`、`REFERENCE_1` 等。参考图职责仍由提示词明确。URL 会由网关下载，必须可公开访问；本地文件被编码为 data URL 发送，不需要上传到单独的图床。带参考图使用 `/v1/images/edits`，无参考图使用 `/v1/images/generations`；本 skill 的商品配图仍需按创作规则传商品图。

## 保存与失败处理

- 每次请求 `n=1`。先生成封面，用户认可后再逐张生成后续配图。
- 保存 `<name>.md` 和同名图片。扩展名由返回的实际 PNG/JPEG/WebP 数据决定。
- 已有同名记录或图片时，在调用前拒绝请求；选择 `cover-v2`、`1-v2` 等新版本。已确认的提示词记录如需执行，按 [保存规则](prompt-and-saving.md) 保留旧记录。
- 失败保留提示词和有顺序的参考图记录，不填写不存在的图片路径。
- 请求默认超时 600 秒，可用 `--timeout` 调整。脚本不自动重试；超时或连接中断不能证明服务端未生成、未计费，先检查网站调用记录。
- 保存成功后直接交付图片，保留由用户判断和提出修改的流程，不自动进行视觉审核或再次生成。

接口依据：[BananaRouter 文档](https://bananarouter.com/docs)中的 `gpt-image-2` 章节，公开 Markdown：[文档内容接口](https://bananarouter.com/api/docs/pages/gpt-image-2?locale=zh)。模型实际可调用性取决于密钥授权和网站上游状态。
