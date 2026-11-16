# 🍈 LinguaGacha 灵瓜小说精翻（Antigravity 插件版）

> 基于上游项目 [`neavo/LinguaGacha (v0.141.2)`](https://github.com/neavo/LinguaGacha) 迁移适配并持续优化的 **Google Antigravity（反重力）** 本地全局插件。

## ⚠️ 致谢与特别声明（使用前必读）

- **上游致谢**：本项目的核心技能体系、预设规则与工作区契约源自 [`neavo/LinguaGacha`](https://github.com/neavo/LinguaGacha)，特此向原作者 **neavo** 致以诚挚谢意。若需体验带图形界面及音视频、PDF、游戏解包全套能力的桌面完整版，请直接前往上游仓库下载。
- **署名与非商用约定**（遵循上游项目要求）：
  - 如您在公开发布的翻译作品中使用了本插件或 [LinguaGacha](https://github.com/neavo/LinguaGacha)，请在作品信息或发布页面的显要位置注明出处。
  - **本项目仅供个人学习、阅读与非商业交流使用**。如涉及任何商业行为或商业收益，请务必先联系上游原作者获得授权。

---

## ✨ 这是什么？

安装并启用本插件后，您的反重力聊天助手就会自带全套**轻小说与电子书精翻工作台**：

- **不用敲命令、不用懂代码**：全程在聊天框里用日常语言吩咐助手即可完成导入、提取术语、试译、整书翻译、精校与导出。
- **保留排版的电子书直出**：直接导入日文/英文 `.epub` 小说（自动剥离日文 `<ruby>` 振假名干扰、保留插图封面与目录、自动将日文竖排转为中文横排），完成后一键导出**纯中文 `.epub`** 与**双语对照 `.epub`**。
- **省 Token 且高质量的精校体系**：
  - 底层自动维护干净去重的独立术语文件（`work/glossary-clean.json`），避免子代理数据包重复塞入术语烧额度。
  - 内置 **单轮小包逐句精校（每包约 100 条高注意力捉硬伤）+ 程序化种子循环 + 6 类自动校对警告**（假名残留、术语未遵循、行数错配、标点错配、漏翻相似、保护标签损坏），一遍到位不返工。

---

## 📦 安装教程（发给朋友看这里！）

本插件采用纯原生 Node.js 编写，**零第三方依赖，无需执行 `npm install`**。只需两步即可装好：

### 第 1 步：确保电脑装有 Node.js

插件后台本地服务需要调用系统的 `node` 命令。打开终端（Windows 打开 PowerShell 或 CMD）输入：

```powershell
node -v
```

如果能显示版本号（建议 **v22.x** 及以上 LTS 版本）即可直接进入下一步。若提示找不到命令，请先前往 [Node.js 官网](https://nodejs.org/) 下载安装 LTS 版并重启终端。

### 第 2 步：放入反重力插件目录（二选一）

#### 方式 A：直接复制文件夹（最简单，推荐新手）

1. 点击本页面右上角绿色的 **`<> Code` -> `Download ZIP`** 下载并解压（或 `git clone` 本仓库）。
2. 找到解压出来的 **`plugins/linguagacha`** 文件夹，将整个 `linguagacha` 文件夹复制到系统的反重力插件目录中：
   - **Windows**：`%USERPROFILE%\.gemini\config\plugins\linguagacha`
     *(提示：直接复制 `%USERPROFILE%\.gemini\config` 粘贴到资源管理器地址栏回车，若里面没有 `plugins` 文件夹就新建一个，把 `linguagacha` 放进去即可)*
   - **macOS / Linux**：`~/.gemini/config/plugins/linguagacha`

#### 方式 B：通过 `plugins.json` 挂载 Git 目录（适合喜欢 `git pull` 追更的朋友）

1. 将本仓库 `git clone` 到任意固定目录（例如 `D:/Plugins/linguagacha-antigravity`）。
2. 打开 `~/.gemini/config/plugins.json`（Windows 为 `%USERPROFILE%\.gemini\config\plugins.json`，不存在可新建），将本仓库下的 `plugins` 目录加入 `entries`：

```json
{
  "entries": [
    {
      "path": "D:/Plugins/linguagacha-antigravity/plugins"
    }
  ]
}
```

### 第 3 步：确认启用

打开（或重启）Antigravity，在聊天框输入 `/plugin`（或打开右上角 **Customizations -> Plugins** 页面），确认看到 **LinguaGacha 灵瓜小说精翻** 处于开启状态，即安装成功！

---

## 🚀 日常翻小说：推荐省流高质量操作法

### 1. 放好小说文件

在电脑任意位置新建一个专属文件夹（比如 `D:\小说\第一卷`），把要翻的小说放进去。
支持直接放入：`.epub`、`.txt`、`.md`、`.srt` / `.vtt` / `.ass` 字幕、`.json`。

### 2. 打开聊天框，按阶段发话

您可以在反重力中直接打开该小说文件夹，或在消息里直接写出文件夹路径：

- **① 导入小说 + 提取术语表（推荐新书第一步）**
  > `帮我打开 D:\小说\第一卷 这个工程，把里面的小说导进来，先扫描提取一份角色名和专有名词术语表给我确认。`

- **② 随机抽样试译定文风（可选，强烈推荐！）**
  > `从全书随机抽 100 条左右的切片试译给我看看文风，先不写入工程。`
  *(看完试译后，如果有不喜欢的用词或需要避开的坑，直接告诉助手，它会自动记入本工程知识库。)*

- **③ 正式翻译全书 + 单轮小包精校 + 导出电子书**
  > `按术语表和定好的要求把整本书翻译并审校一遍，修掉校对警告，最后导出纯中文版和双语对照版 EPUB。`

- **④ 译后随机抽检（可选）**
  > `随机抽样检查一下译文，看看有没有什么问题。`

### 3. 去文件夹里拿成品电子书

完成后，会在您的小说文件夹内自动生成成品目录：

- `书名_译文/`：干净清爽的纯中文译本（可直接传到手机、平板、Kindle 或阅读器阅读）
- `书名_双语对照/`：一段原文配一段译文的双语对照版（方便核对细节或对照学外语）

*(注：术语表、工程知识与进度存档均保存在小说文件夹下的 `.lg_project` 与 `.lg_workspace` 中，后续翻译第 2 卷时可直接复用同一套术语表！)*

---

## ⚡ 两种翻译动力模式（按需切换）

### 模式 A：零配置内置模型模式（默认开启，开箱即用）

- **用法**：无需配置任何外部密钥，直接发消息即可。
- **原理**：直接调用您当前反重力窗口所选的大模型，通过拆分子代理并发完成整书翻译与约 100 条一包的精细审校。

### 模式 B：外部 API 高速并发初翻模式（可选）

如果您想用外部 API（如 DeepSeek、Gemini、OpenAI 兼容接口或本地 SakuraLLM）快速跑完初翻，再交由反重力做精校收尾：

1. 找到插件目录下的模板文件：`plugins/linguagacha/runtime/api_config.example.json`
2. 复制一份并改名为 **`api_config.json`**，放到您的**小说文件夹**里（或直接放到 `plugins/linguagacha/api_config.json` 全局生效）。
3. 打开 `api_config.json` 填入真实密钥：

```json
{
  "active_profile": "deepseek",
  "profiles": {
    "deepseek": {
      "api_format": "openai",
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-在这里填入您的真实密钥",
      "model": "deepseek-chat",
      "concurrency": 6,
      "batch_size": 25
    }
  }
}
```

4. 保存后吩咐助手：`用外部并发接口把整本书初翻完，然后帮我审校一遍并导出！`

> 🔒 **安全提示**：`api_config.json` 已列入 `.gitignore`，不会被 Git 提交。切勿将自己的密钥文件上传公开。

---

## 🎭 自定义助手人设与平时写代码切换

- **平时写代码想暂时关闭插件时**：在聊天框输入 `/plugin`（或进入 **Customizations -> Plugins**），点击开关关闭 **LinguaGacha 灵瓜小说精翻** 即可立即恢复普通编程助手，无需重启；要翻小说时再打开即可。
- **想更换助手对话人设时**：当前默认对话人设为《BanG Dream!》丰川祥子（端庄典雅大小姐风格，仅用于日常对话，翻译正文严格保持客观中立）。若您想换成其他角色或原版傲娇搭档风格，直接编辑 `plugins/linguagacha/presets/agent/personality.md` 与 `plugins/linguagacha/rules/AGENTS.md` 中的 `# 角色设定` 段落即可。

---

## 📊 功能实装范围一览

本插件专注于**小说、电子书与纯文本类全链路精翻**，与上游桌面端 `LinguaGacha v0.141.2` 的能力对照如下：

| 功能模块 | 当前状态 | 详细说明 |
| :--- | :---: | :--- |
| 系统工作流宪章与可定制对话人设 | ✅ 已实装 | 位于 `rules/AGENTS.md` 与 `agent-charter` |
| 领域与格式技能包 + 内置脚本 | ✅ 已实装 | 含 `translation`（附独立逐句精校标准 `review-criteria.md`）、`glossary`、`writing-guide`、`epub` 等 |
| 预设规则库（`presets/`） | ✅ 已实装 | 含基础写作提示词前缀 `base.txt`、译前/译后替换与文本保护预设 |
| Aho-Corasick 术语扫描 & 去重术语自动同步 | ✅ 已实装 | 毫秒级词频匹配，自动生成并覆盖纯净去重版 `work/glossary-clean.json` |
| 6 类自动校对警告质检引擎 | ✅ 已实装 | 外文假名残留、术语未遵循、行数错配、首尾标点错配、原文高度相似（漏翻）、保护标签损坏 |
| `EPUB` 轻小说单语 & 双语引擎 | ✅ 已实装 | 自动清理 `<ruby>` 注音、保持封面插图与目录、竖排 `vertical-rl` 自动转横排、标准无压缩 `mimetype` 封包 |
| `TXT` / `Markdown` / `JSON` / `SRT` / `.generic` | ✅ 已实装 | 支持单语导出、双语对照导出、同文去重自动联动（`DUPLICATED`） |
| 本地工程快照与事务安全工作区（MCP） | ✅ 已实装 | 提供 `workspace_open`、`workspace_run`、`workspace_apply`、`read_skill`、`batch_item_translation`、`batch_llm_request` |
| 游戏专用二进制解封包引擎 | ⚪ 未内置 | 如 `.pck`、`.wolf`、`.rpa` 等请使用[上游桌面版](https://github.com/neavo/LinguaGacha) |
| `PDF` C++ MuPDF 排版重绘引擎 | ⚪ 未内置 | 建议先转为 EPUB/TXT，或使用[上游桌面版](https://github.com/neavo/LinguaGacha) |
| 本地显卡语音识别与音频合成（Media） | ⚪ 未内置 | 现成 `.srt` / `.vtt` / `.ass` / `.lrc` 字幕可直接导入精翻；音视频识别请使用[上游桌面版](https://github.com/neavo/LinguaGacha) |

---

## 🗂️ 目录结构速览

```text
linguagacha-antigravity/
├── README.md                          # 仓库安装与使用说明书
├── plugins/
│   └── linguagacha/                   # 反重力插件本体
│       ├── plugin.json                # 插件清单与快捷提示词
│       ├── mcp_config.json            # 本地 MCP 服务启动配置
│       ├── README.md                  # 反重力插件面板内嵌说明文档
│       ├── rules/AGENTS.md            # 系统工作流宪章与对话人设
│       ├── skills/                    # 23 个技能包（含逐句审校标准与可执行脚本）
│       ├── presets/                   # 预设规则与翻译提示词模板库
│       └── runtime/                   # 纯 Node.js 本地解析、校对、工作区事务与并发 API 引擎
│           └── api_config.example.json # 外部 API 并发配置模板
└── tests/                             # 自动化验收测试套件
```
