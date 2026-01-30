# Docker 部署（Neo4j + Redis + Sentra Agent）

本项目推荐使用 Docker Compose 一键拉起：

- `redis`：会话/状态持久化
- `neo4j`：RAG 图谱与混合检索后端
- `sentra-agent`：主服务
- `sentra-emo`：可选的情绪分析服务（profile）
- `sentra-config-ui`：可选的配置/运维面板（profile，推荐）

> 说明：Sentra Agent 需要连接你的 OneBot/NapCat WebSocket（QQ 平台）。该服务通常运行在宿主机或另一台机器上。

---

## 1. 准备配置

### 1.1 OneBot / NapCat WebSocket

在 `docker-compose.yml` 中，默认使用：

- `WS_HOST=host.docker.internal`
- `WS_PORT=6702`

如果你的 OneBot 不在宿主机：

- 把 `WS_HOST` 改为 OneBot 所在机器的 IP/域名

### 1.2 Neo4j 密码（必须改）

`docker-compose.yml` 默认：

- `NEO4J_AUTH=neo4j/please_change_me`
- `RAG_NEO4J_PASSWORD=please_change_me`

你需要把这两处改成一致的新密码。

### 1.3 LLM Key（必须配）

Sentra Agent 读取根目录 `.env`（或环境变量）。至少需要：

- `API_BASE_URL`
- `API_KEY`
- `MAIN_AI_MODEL`

建议复制 `.env.example` 为 `.env` 后按需修改。

---

## 2. 启动

### 2.1 仅启动核心（Agent + Redis + Neo4j）

```bash
docker compose up -d --build
```

### 2.2 启动情绪服务（可选）

```bash
docker compose --profile emo up -d --build
```

### 2.3 启动 Config UI 面板（推荐，可选）

Config UI 用于：

- 可视化管理各模块 `.env` / `.env.example`
- 管理 Redis（查看/编辑 key、排查状态）
- 查看服务状态与日志（以 UI 的能力为准）

启动：

```bash
docker compose --profile ui up -d --build
```

默认端口：

- UI 后端： http://localhost:7245

安全说明：

- `docker-compose.yml` 里为 UI 配了 `SECURITY_TOKEN`，请务必修改为强口令。
- UI 通过挂载 `./:/repo` 来读写各模块的 `.env` 文件（这是它能“管理配置”的关键）。

> 注意：在 Docker 模式下，UI 更适合做“配置与运维面板”。
> 真正的服务启停建议仍以 `docker compose up/down` 为准，避免容器内 PM2 去管理宿主机进程导致混乱。

---

## 3. 验证

- Redis：`localhost:6379`
- Neo4j Browser： http://localhost:7474 （账号 `neo4j`，密码为你设置的密码）
- Emo（可选）： http://localhost:7200/health

---

## 4. 数据持久化

Compose 已配置命名卷：

- `sentra_redis_data`
- `sentra_neo4j_data`
- `sentra_neo4j_logs`

容器重建不会丢数据。

---

## 5. 常见问题

### 5.1 Agent 连不上 OneBot

检查：

- OneBot/NapCat 服务是否在宿主机 `6702` 端口监听
- Windows / WSL 网络环境下，`host.docker.internal` 是否可用
- 若 OneBot 在另一台机器：把 `WS_HOST` 改成真实 IP

### 5.2 Neo4j 启动很慢

第一次初始化会较慢；同时确保机器内存足够。你也可以调小 compose 里的 heap/pagecache 配置。
