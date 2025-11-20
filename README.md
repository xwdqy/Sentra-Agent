# Sentra Agent

一个为生产环境设计的全栈 AI Agent 框架。提供开箱即用的智能对话解决方案，支持多平台适配、工具生态、知识检索、情感分析和智能回复策略。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/sentra-agent?color=brightgreen)](https://www.npmjs.com/package/sentra-agent)
[![PM2](https://img.shields.io/badge/PM2-Ready-00D9FF.svg)](https://pm2.keymetrics.io/)
[![Redis](https://img.shields.io/badge/Redis-6.0+-DC382D.svg)](https://redis.io/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB.svg)](https://www.python.org/)

## 目录

- [简介](#简介)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [架构](#架构)
- [模块](#模块)
- [配置](#配置)
- [开发](#开发)
- [文档](#文档)
- [应用场景](#应用场景)
- [故障排查](#故障排查)
- [贡献](#贡献)
- [许可证](#许可证)

## 简介

Sentra Agent 是一个为生产环境设计的 AI Agent 框架。我们理解构建智能对话系统的挑战：如何让 AI 理解用户意图、自然交流、记住用户特点、稳定运行。

通过多阶段决策引擎、50+ 工具插件、RAG 知识检索、情感分析和智能回复策略，Sentra Agent 提供了完整的解决方案。

## 核心特性

- **多阶段决策引擎** - Judge、Plan、ArgGen、Evaluate、Summary 五个阶段，让 AI 像人一样思考
- **50+ 工具插件** - 网络搜索、文件操作、API 调用、多媒体处理等，开箱即用
- **RAG 知识检索** - 向量化知识库，混合检索策略，支持多种存储后端
- **多平台适配** - 支持 QQ、微信等主流 IM 平台，一次开发到处运行
- **情感分析** - 实时识别用户情绪，根据情绪调整回复风格
- **智能回复策略** - 基于欲望值算法，防止频繁回复和冷场
- **用户画像** - LLM 驱动的渐进式用户认知，越来越懂用户
- **可视化配置** - 配置界面，轻松管理环境变量
- **生产级部署** - PM2 进程管理，自动重启、日志管理、性能监控
...

## 快速开始

### 系统要求

| 组件 | 版本 | 用途 |
|------|------|------|
| Node.js | >= 18.0.0 | 主应用运行环境 |
| Redis | >= 6.0 | 消息缓存、去重、队列 |
| Neo4j | >= 4.4 | 知识图谱存储 |
| Python | >= 3.10 | 情绪分析服务（可选） |
| PM2 | 最新版 | 生产环境进程管理 |

### 安装前置依赖

下面给出常见平台的一行命令与官方链接，任选其一。安装完成后用右侧命令验证。

- Git：
  - Windows：请从官网下载并安装：https://git-scm.com/download/win
  - macOS：`brew install git`（先安装 Homebrew：https://brew.sh）
  - Ubuntu/Debian：`sudo apt update && sudo apt install -y git`
  - 验证：`git --version`

- Node.js（18+）：
  - Windows：请从官网下载并安装：https://nodejs.org/en/download/
  - macOS：`brew install node@18`
    如需切换：`brew link --overwrite node@18`
  - Ubuntu/Debian：
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install -y nodejs
    ```
  - 验证：`node -v && npm -v`

- Python（3.10+，可选，仅情绪服务需要）：
  - Windows：请从官网下载并安装（安装时勾选 Add Python to PATH）：https://www.python.org/downloads/windows/
  - macOS：`brew install python@3`
  - Ubuntu/Debian：`sudo apt install -y python3 python3-pip`
  - 验证：`python --version` 或 `python3 --version`

- Redis（6+）：
  - Windows：优先使用 Memurai（Redis 兼容）：https://www.memurai.com
    或通过 Docker Desktop 运行官方镜像
  - macOS：`brew install redis && brew services start redis`
  - Ubuntu/Debian：`sudo apt install -y redis-server && sudo systemctl enable --now redis-server`
  - 验证：`redis-cli ping`（返回 PONG）

- Neo4j（4.4+/5.x 任一均可）：
  - Windows：下载 Neo4j Desktop/Server 安装包：https://neo4j.com/download/
  - Docker（推荐）：
    ```bash
    docker run -d \
      --name neo4j \
      -p 7474:7474 -p 7687:7687 \
      -e NEO4J_AUTH=neo4j/password \
      neo4j:5
    ```
  - 本地安装（macOS/Linux）：https://neo4j.com/download/
  - 验证：浏览器访问 http://localhost:7474 （默认用户 neo4j/你设置的密码）

- PM2（生产进程管理）：
  - 全局安装：`npm i -g pm2`
  - 验证：`pm2 -v`

### 安装

推荐使用 Web 配置界面（Config UI）进行初始化和启动，无需手动编辑环境变量或记命令。

1. 克隆项目并进入 UI 目录
```bash
git clone https://github.com/JustForSO/Sentra-Agent.git
cd Sentra-Agent/sentra-config-ui
```

2. 安装 UI 依赖
```bash
npm install
```

3. 可选：一键初始化（安装所有子项目依赖、准备 Node/Python 环境）
```bash
npm run bootstrap          # 全量初始化
npm run bootstrap:node     # 仅 Node 相关
npm run bootstrap:python   # 仅 Python 情绪服务
```

4. 启动 Web UI
```bash
npm run dev
```
启动后浏览器访问 http://localhost:7244 按指引完成配置并启动服务。

生产环境可在 UI 目录使用下列脚本进行服务管理：
```bash
npm run service:pm2        # 使用 PM2 启动
npm run service:status     # 查看状态
npm run service:logs       # 查看日志
npm run service:monit      # 实时监控
...
```

---

5. 快速启动 (以QQ为例)

本指南以 QQ 为例，介绍从环境准备到服务启动的完整流程。

#### 一、 首次启动流程

如果是第一次运行，请按照以下步骤完成依赖安装与构建。

##### 1. 环境准备与运行桌面应用
首先安装各个板块所需的依赖项，完成后运行桌面应用程序。

![安装各个板块依赖](https://filesystem.site/cdn/20251120/4bQGe8rQPLC7Wm9d4me2A7f6h6VRV4.png)

##### 2. 构建通讯服务 SDK
构建 NC 适配器的实时流通讯服务 SDK，以便进行数据交互。

![实时流通讯SDK构建](https://filesystem.site/cdn/20251120/06TEqX78XLQpdRdBwPhaFfbj5KXLVZ.png)

##### 3. 修改配置 (可选)
如需修改板块配置或 Mcp 插件配置，请按以下步骤操作：
1.  点击界面上的 **启动台**。
2.  选择需要修改配置的应用程序。
3.  修改完成后，点击 **保存**。

![点击启动台](https://filesystem.site/cdn/20251120/Hg1s5SnIsWbhJ0Mqf1isXLhUBNB0YF.png)
![选择需要修改的应用配置](https://filesystem.site/cdn/20251120/z3UTXWSyLJ7cUF29vnjR4ExFinGI4j.png)
![开始配置，保存](https://filesystem.site/cdn/20251120/kVaDvIv8fd8eYQ1uvHalp1XHwdWz0b.png)

##### 4. 启动 Sentra
确认配置无误后，点击启动按钮运行 Sentra。

![点击启动](https://filesystem.site/cdn/20251120/qZvWBHiu5zKPLacOIFHIMnBevoJntY.png)

---

#### 二、 后续启动说明

💡 **注意**：
首次配置并构建完成后，**下次启动无需重复安装依赖和构建 SDK**。您只需要执行以下两步：

1.  启动 **NC 适配器**。
2.  启动 **Sentra**。

## 架构

### 项目结构

```
sentra-agent/
├── Main.js                      # 主入口
├── agent.js                     # Agent 核心
├── src/
│   ├── agent/                   # Agent 逻辑（Judge、Plan、ArgGen、Eval、Summary）
│   ├── config/                  # 配置管理
│   └── utils/                   # 工具函数
├── utils/                       # 核心工具
│   ├── replyPolicy.js           # 智能回复策略
│   ├── userPersonaManager.js    # 用户画像管理
│   ├── groupHistoryManager.js   # 群聊历史管理
│   └── messageCache.js          # 消息缓存
├── sentra-mcp/                  # MCP 工具生态
├── sentra-rag/                  # RAG 知识检索
├── sentra-prompts/              # 提示词管理
├── sentra-emo/                  # 情绪分析服务
├── sentra-config-ui/            # 配置管理界面
├── docs/                        # 文档
└── ecosystem.config.cjs         # PM2 配置
```

## 配置

推荐：通过 Config UI 可视化管理所有配置，界面会引导你生成并保存 .env。

如需手动方式：创建配置文件并填入必要的密钥即可开始：

```bash
cp .env.example .env
# 打开 .env，至少设置：OPENAI_API_KEY（以及你使用到的外部服务密钥）
```

所有可选项与详细解释请参考：
- `.env.example`（完整字段与默认值）

## 文档

- [Sentra MCP](sentra-mcp/README.md) - 工具生态文档
- [Sentra RAG](sentra-rag/README.md) - 知识检索文档
- [Sentra Prompts](sentra-prompts/README.md) - 提示词管理文档
- [Sentra Emo](sentra-emo/README.md) - 情绪分析文档

## 故障排查

- 服务无法启动：检查端口（6702 是否占用）、`.env` 是否就绪、依赖是否安装、Redis/Neo4j 是否运行；查看日志 `npm run pm2:logs --err`。
- 没有回复：确认 `ENABLE_SMART_REPLY=true`，必要时降低 `BASE_REPLY_THRESHOLD`；查看 ReplyPolicy 相关日志。
- 画像不更新：确认 `ENABLE_USER_PERSONA=true`，满足消息数与时间间隔条件。
- 频繁重启：查看 `pm2 logs --err`、`pm2 monit`，检查内存与配置。
...

## 贡献

我们欢迎社区贡献！

### 提交 Issue

在 [GitHub Issues](https://github.com/JustForSO/Sentra-Agent/issues) 提交问题时，请提供：
- 清晰的标题
- 详细的描述
- 复现步骤
- 预期行为和实际行为
- 环境信息

### 贡献方向

欢迎贡献：
- Bug 修复
- 新功能
- 文档改进
- 测试用例
- 新的 MCP 工具
- 新的平台适配
- 性能优化

## 许可证

本项目采用 [MIT License](LICENSE) 开源协议。

你可以自由地使用、修改、分发本项目，但是禁止商业化。

---