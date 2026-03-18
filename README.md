<div align="center">

# 📺 IPTV Checker

**一个面向 IPTV 组播/单播源管理、检测、导出与播放验证的 Web 工具**

![Iptv-Checker 预览图](./public/preview-empty.png)

[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/shihairu22/Iptv-Checker?style=flat-square&color=blue)](https://github.com/shihairu22/Iptv-Checker/releases)
[![Build Status](https://img.shields.io/github/actions/workflow/status/shihairu22/Iptv-Checker/docker-image.yml?branch=main&style=flat-square)](https://github.com/shihairu22/Iptv-Checker/actions)
[![GitHub Downloads](https://img.shields.io/github/downloads/shihairu22/Iptv-Checker/total?style=flat-square&color=success)](https://github.com/shihairu22/Iptv-Checker/releases)
[![GHCR](https://img.shields.io/badge/GHCR-iptv--checker-2ea44f?style=flat-square&logo=github)](https://github.com/shihairu22/Iptv-Checker/pkgs/container/iptv-checker)
</div>

> [!NOTE]
> 本项目 Fork 自 [CGG888/Iptv-Checker](https://github.com/CGG888/Iptv-Checker)。
> 当前仓库基于原作者的开源项目持续维护和扩展，保留原项目的核心思路，并结合实际使用需求对界面、检测链路、持久化、播放器与安全细节做了多轮调整。

---

## 项目定位

IPTV Checker 主要解决这几类日常工作：

- 导入 TXT / M3U / 远程文本源，集中整理 IPTV 频道列表
- 批量检测频道可用性、分辨率、帧率、码率、编码信息
- 在结果页统一维护频道名称、分组、台标、EPG、FCC、回看参数
- 生成适合内网或外网环境的播放地址、M3U / TXT / JSON 导出结果
- 使用内置播放器或外部播放器对频道进行快速验证
- 保存快照、恢复历史版本、查看运行日志

---

## 当前版本的主要能力

- `p-queue` 驱动的高并发检测任务，支持暂停、恢复和滑动窗口调度
- 登录鉴权、验证码、会话持久化
- SQLite 持久化存储，配置和频道数据统一落到 `data/iptv.db`
- 首页导入、批量检测、分页查看、批量删除、快照备份
- 结果页频道编辑、分组规则、台标模板、FCC 服务器、EPG 源、代理配置
- 内置播放器、线路切换、外网模式加载、台标代理、HLS 代理
- 日志页查看、下载与实时流式刷新
- Docker 镜像发布与 GitHub Release 工作流

---

## 技术实现概览

- 后端：`Node.js + Express + Socket.IO`
- 数据层：`better-sqlite3`，主数据文件为 `data/iptv.db`
- 检测链路：`ffprobe` + 网络预检
- 前端：原生 HTML / CSS / JavaScript，多页面结构
- 播放能力：内置播放器 + HLS / 流代理

---

## 目录结构

```text
src/
  index.js                  服务入口
  taskCheck.js              检测任务管理
  services/                 持久化、日志、流数据服务
  routes/                   登录、频道、配置、快照等接口
  utils/streamUrl.js        组播地址归一化与代理地址生成
public/
  index.html                首页
  results.html              结果页
  player.html               内置播放器页
  logs.html                 日志页
  js/                       前端脚本
data/
  iptv.db                   SQLite 数据库
```

---

## 环境要求

### 运行依赖

- Node.js 18 或更高版本
- `ffmpeg` / `ffprobe`

可先执行：

```bash
node -v
ffprobe -version
```

---

## 快速开始

### 方式一：Docker

```yaml
services:
  iptv-checker:
    image: ghcr.io/shihairu22/iptv-checker:latest
    container_name: iptv-checker
    ports:
      - "8848:8848"
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    ulimits:
      nofile:
        soft: 65535
        hard: 65535
```

启动：

```bash
docker compose up -d
```

访问：

```text
http://localhost:8848
```

### 方式二：本地源码运行

```bash
git clone https://github.com/shihairu22/Iptv-Checker.git
cd Iptv-Checker
npm install
npm start
```

默认监听端口：

```text
8848
```

也可以自定义端口：

```bash
PORT=8850 npm start
```

---

## 首次登录

- 默认账号：`admin`
- 默认密码：`admin`
- 登录需要验证码

如果希望首次启动就使用自定义管理员密码，可以在启动前设置环境变量：

```bash
IPTV_ADMIN_PASSWORD=your-password
```

---

## 页面说明

### 首页

首页主要负责导入、批量检测和快照管理。

- 支持粘贴 `频道名,地址` 的文本内容
- 支持加载本地 TXT / M3U 文件
- 支持抓取远程文本地址
- 支持批量检测、停止检测、恢复任务
- 支持保存当前版本、加载历史版本、删除快照

### 结果页

结果页主要负责频道管理和导出。

- 查看在线 / 离线状态
- 编辑频道名称、台标、分组、TVG 信息、FCC、回看参数
- 管理分组规则、台标模板、FCC 服务器、EPG 源、代理配置
- 导出 M3U / TXT / JSON
- 区分内网模式与外网模式

### 播放器页

- 支持内置播放器直接播放
- 支持频道线路切换
- 支持根据内外网模式加载不同播放地址
- 支持台标代理与外网导出 JSON 直连

### 日志页

- 支持查看日志文件列表
- 支持下载日志
- 支持实时流式查看应用日志

---

## 数据与配置存储

当前版本以 SQLite 为主，不再依赖旧版 `streams.json` 作为主存储。

### 主要数据文件

- `data/iptv.db`

### 数据内容

- 频道列表
- 检测任务队列
- 快照备份
- 登录会话
- 用户信息
- 台标模板、FCC、UDPXY、代理、EPG、分组规则等配置

### 兼容说明

程序首次启动时会尝试把旧版 JSON 配置迁移到 SQLite 中。

---

## 导出与播放地址规则

### 内网模式

- 组播地址会结合 UDPXY / rtp2httpd 基址生成可播放 URL
- HTTP / HTTPS 单播地址默认保留原始地址

### 外网模式

- 组播优先使用“组播代理”配置，其次回退到外网基址
- HTTP / HTTPS 单播优先使用“单播代理”配置
- 支持开启 Token 校验，用于外部播放器或外部客户端读取 JSON 导出

---

## 安全与访问控制

当前项目包含以下基础安全措施：

- 登录验证码
- Cookie 会话鉴权
- Socket.IO 鉴权
- 日志输出中的敏感参数脱敏
- 流代理请求的来源限制与签名校验
- HLS 清单 URI 改写

需要注意：

- `/api/export/json` 在外网模式下可配合 Token 使用
- 建议部署到受控网络环境，不建议直接裸露到公网

---

## 快照与恢复

项目支持保存当前频道列表和配置快照，并在后续恢复。

- 保存快照：将当前频道和配置存入备份记录
- 加载快照：把选定版本恢复到当前工作状态
- 删除快照：移除不再需要的历史记录

这套机制适合在大规模批量导入、分组调整、规则重构前先做一次备份。

---

## 常见问题

### 1. 启动后登录不上

- 确认验证码输入正确
- 确认是否有旧进程占用了同一端口
- 若需重置，可删除对应用户配置或重新初始化数据目录

### 2. 检测结果为空或大量超时

- 检查 `ffprobe` 是否已正确安装
- 检查服务器网络是否可以访问目标源
- 检查并发值是否设置过高

### 3. 外网播放器无法加载

- 检查外网基址、组播代理、单播代理设置
- 检查是否启用了 Token 且播放器请求里是否带上 token
- 检查目标代理服务是否可从外网访问

### 4. Docker 挂载后数据不保存

- 检查宿主机目录是否可写
- 检查是否正确挂载到 `/app/data`

---

## 更新说明

- 当前服务端接口会返回版本号
- 自动更新接口目前返回 `501`
- 建议使用 `git pull` 或重新拉取 Docker 镜像的方式更新

---

## 致谢

- 原始项目作者：[CGG888/Iptv-Checker](https://github.com/CGG888/Iptv-Checker)
- 当前维护仓库：[shihairu22/Iptv-Checker](https://github.com/shihairu22/Iptv-Checker)

感谢原作者提供项目起点，也感谢后续所有为这个项目贡献想法、测试和修复的使用者。

---

## 免责声明

1. 本项目仅用于学习、研究、测试和个人管理场景。
2. 项目本身不提供任何直播源，也不附带任何可直接商用的媒体内容。
3. 用户导入、维护、导出和分发的流媒体内容，由用户自行负责合规性。

