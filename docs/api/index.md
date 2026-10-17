# API 文档

## 认证接口

### 获取 GitHub 关联状态

```
GET /api/auth/github/status
```

**响应：**

```json
{
  "connected": true,
  "username": "github_user",
  "connectedAt": "2026-03-22T10:00:00Z"
}
```

### 发起 GitHub OAuth

```
GET /api/auth/github/begin
```

**响应：**

```json
{
  "success": true,
  "redirectUrl": "https://github.com/login/oauth/authorize?..."
}
```

### 处理 OAuth 回调

```
GET /api/auth/github/callback?code=xxx&state=xxx
```

### 断开 GitHub 关联

```
DELETE /api/auth/github/disconnect
```

---

## 回放规则接口

### 检查规则更新

```
GET /api/replay-rules/check-update
```

**响应：**

```json
{
  "hasUpdate": true,
  "latestVersion": "1.0.1",
  "currentVersion": "1.0.0",
  "changelog": ["新增广东电信规则"]
}
```

### 获取规则库

```
GET /api/replay-rules/library
```

**响应：**

```json
{
  "success": true,
  "latest": "1.0.0",
  "versions": [
    {
      "version": "1.0.0",
      "published_at": "2026-03-17",
      "changelog": ["Initial release"],
      "total_rules": 2
    }
  ]
}
```

### 应用远程规则

```
POST /api/replay-rules/apply-remote
Content-Type: application/json

{
  "version": "1.0.0"
}
```

**响应：**

```json
{
  "success": true,
  "version": "1.0.0",
  "snapshotId": "snapshot_xxx",
  "baseRulesCount": 2,
  "timeRulesCount": 15
}
```

---

## 贡献接口

### 提交规则

```
POST /api/replay-rules/contributions
Content-Type: application/json
Authorization: Bearer <github_token>

{
  "province": "广东",
  "operator": "电信",
  "city": "广州",
  "m3uLine": "#EXTINF:-1 tvg-name=\"频道\" ... http://...",
  "description": "可选说明"
}
```

**响应：**

```json
{
  "success": true,
  "issueUrl": "https://github.com/CGG888/channel-sentinel/issues/10#issuecomment-xxx",
  "commentId": "123456789"
}
```

---

## 扫描队列接口

后台任务模式：请求立即返回，任务在服务端队列里跑，进度靠轮询 `status` 拿。
所有接口都需要登录 Cookie；未登录返回 401。

### 启动任务

```
POST /api/scan-tasks/start
Content-Type: application/json

{
  "type": "batch",              // batch | range
  "batchText": "CCTV1,rtp://239.255.0.1:5000\nrtp://239.255.0.[10-20]:5000",
  "udpxyUrl": "http://192.168.1.1:4022",
  "concurrency": 20,             // 1~200
  "retry": 1,                    // 0~5
  "throttle": { "enabled": true, "runMinutes": 30, "pauseMinutes": 10 }
}
```

`type=range` 时改用 `startUrl` / `endUrl` / `ports`（`ports` 可为 `"9000,9020"`）。

**响应：**

```json
{ "success": true, "started": true, "total": 128, "concurrency": 20 }
```

任务进行中再次 start 返回 409。

### 查询进度

```
GET /api/scan-tasks/status
```

```json
{
  "success": true,
  "running": true,
  "paused": false,
  "type": "batch",
  "concurrency": 20,
  "retry": 1,
  "progress": { "total": 128, "finished": 47, "success": 31, "failed": 16, "pending": 79, "inFlight": 2 },
  "throttle": { "enabled": true, "runMinutes": 30, "pauseMinutes": 10, "phase": "run", "remainingSeconds": 1024 },
  "elapsedSeconds": 812,
  "logs": ["[22:39:37] 任务启动：批量列表，共 128 项，并发 20"]
}
```

### 停止 / 继续

```
POST /api/scan-tasks/stop      → 在飞项收尾后回填为 pending
POST /api/scan-tasks/resume    → 接着未完成项跑
```

### 失败明细 / 重扫失败

```
GET  /api/scan-tasks/failures?limit=50
POST /api/scan-tasks/retry-failed
```

`failures` 返回 `{ failures: [{ url, udpxyUrl, attempts, error, updatedAt }] }`；
`retry-failed` 把 failed 项打回 pending 并立即开跑，任务进行中调用返回 409。

---

## 错误码

| 错误码 | 说明 |
|--------|------|
| `AUTH_REQUIRED` | 需要登录 GitHub |
| `INVALID_TOKEN` | GitHub Token 无效 |
| `NETWORK_ERROR` | 网络请求失败 |
| `RULE_NOT_FOUND` | 规则文件不存在 |
| `VERSION_NOT_FOUND` | 指定版本不存在 |
