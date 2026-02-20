<div align="center">

# 📺 IPTV Checker

**基于 Node.js 的 IPTV 组播流状态检测工具**

![Iptv-Checker 检测空数据界面](./public/preview-empty.png)

[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/shihairu22/Iptv-Checker?style=flat-square&color=blue)](https://github.com/shihairu22/Iptv-Checker/releases)
[![Build Status](https://img.shields.io/github/actions/workflow/status/shihairu22/Iptv-Checker/docker-image.yml?branch=main&style=flat-square)](https://github.com/shihairu22/Iptv-Checker/actions)
[![GitHub Downloads](https://img.shields.io/github/downloads/shihairu22/Iptv-Checker/total?style=flat-square&color=success)](https://github.com/shihairu22/Iptv-Checker/releases)
[![GHCR](https://img.shields.io/badge/GHCR-iptv--checker-2ea44f?style=flat-square&logo=github)](https://github.com/shihairu22/Iptv-Checker/pkgs/container/iptv-checker)
</div>

> [!NOTE]
> 本项目 Fork 自 [CGG888/Iptv-Checker](https://github.com/CGG888/Iptv-Checker)。
> 感谢原作者提供的开源项目基础。出于个人使用习惯和特定需求，我在此基础上借助 AI 工具，对前端界面表现和部分后台并发处理逻辑进行了修改和日常调整。

---

## 🚀 核心特性

本工具用于 IPTV 列表的主动管理，主要包含以下特点：

- ⚡ **并发处理**: 采用进程池调度，支持较高数量的并发扫描，提高检测效率。
- 🛡️ **网络预检**: 提供请求超时控制机制，提前过滤无效链接，减少不必要的 FFprobe 等待时间。
- 📉 **状态同步**: 前后端采用 Socket.IO 进行数据推送，降低带宽开销和前端页面的渲染卡顿。
- 💾 **自动保存**: 检测状态自动写入本地 JSON 存储，减少由于意外造成的数据丢失。

---

## ✨ 主要功能

- 🔍 **流状态检测**：自动获取频道在线状态、分辨率 (SD/HD/4K)、视频编码、帧率等编解码信息。
- 🔄 **数据合并更新**：针对相同地址的频道仅更新可访问状态和质量字段，保留用户自定义整理的名称、分组与 Logo。
- 🧠 **频道排序**：自动按照画面质量规则进行排序 (`组播 4K > HD > SD > 单播`)，让高清频道优先靠前。
- 📤 **播放列表导出**：支持 TXT / M3U 两种格式导出，M3U 格式支持时移 (Catchup)、群组成员分类与扩展标签。
- 🖼️ **可视化编辑**：提供频道信息的弹窗编辑功能，并支持通过调用 PotPlayer 快速预览画面。
- 📝 **历史快照备份**：支持将不同时间点的完整检测状态独立保存为版本，方便进行列表比对和回溯。

---

## 🐳 Docker 部署说明

利用 Docker 运行 IPTV Checker 是比较简单快捷的方式。

> [!IMPORTANT]
> **关于系统资源限制**: 运行数量非常大的多任务并行检测时，建议在 Compose 文件中配置 `ulimits` 适当增加文件描述符上限，避免出现运行系统的 `Too many open files` 报错中断。

**`docker-compose.yml` 示例说明:**

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
      - ./data:/app/data   # 映射数据挂载卷以保存程序的持久化状态文件
    ulimits:               # 增加文件句柄限制以支撑并发任务对资源池的消耗
      nofile:
        soft: 65535
        hard: 65535
    restart: unless-stopped
```

启动命令：`docker-compose up -d`
访问地址：`http://localhost:8848`

---

## 💻 本地 Node.js 运行

若需直接调整代码或安装在常规系统环境下：

1. **基础依赖**:
   - Node.js 18 或更高版本
   - **核心组件**: `ffmpeg` (包含 `ffprobe`)。请安装并在系统命令行输入 `ffprobe -version` 确认可正常执行。

2. **克隆与安装**:

   ```bash
   git clone https://github.com/shihairu22/Iptv-Checker.git
   cd iptv-checker
   npm install
   ```

3. **启动程序**:

   ```bash
   npm start
   ```

---

## 📖 使用简述

- 🎯 **导入方式**:
  - 直接于页面粘贴 `频道名,rtp://ip:port` 格式的文本源。
  - 填入网络 TXT/M3U 的外链链接进行直连拉取。
  - 上传整理好的本地 TXT/M3U 文件进行覆盖或增量添加。
- ⚙️ **内外网访问转换**:
  - 内网导出: 自动使用用户设置里的 UDPXY 地址作为组播协议的转换前缀。
  - 外网导出: 可添加 Token 进行基础的安全校验防护来输出播放单。
- ⏪ **时移功能 (Catchup)**:
  - 可以在设置中配置默认的时移域名与天数，在导出 M3U 时可套用对应的格式标签。

---

## 📁 数据存储说明

所有的应用配置、用户手动修改以及扫描状态的数据，都仅依赖本地 `/data` 数据目录，未引入复杂的外部数据库：

- `streams.json`: 保存主列表以及各频道的全部参数字典。
- `settings` / `udpxy` / `app_settings` 等分离的 JSON 配置文件：存储全局与特定功能的设置项。
- `streams-YYYY...json`: 由基础备份演变而来的历史离线快照归档。

---

## 📜 简明变更历史 (Changelog)

### v1.3.1 (2026-02-20)

- 修复 FFprobe 执行参数处理中的注入隐患
- 调整 UDP Multicast 侦听逻辑中的并发争用机制
- 修复 PQueue 对已暂停任务恢复时的执行调用链问题
- 补充后台任务并发原子锁

### v1.3.0 (2026-02-20)

- 进程并发管理由 Worker Threads 调整为轻量级的 `p-queue`
- 增加针对纯死链的预先网络探测超时过滤
- 增加前对后端通信状态的 WebSocket / Socket.IO 短链接分段更新传输
- 降低非必要的本地全量历史数据同步存档频率

### v1.2.2 (2026-02-18)

- 优化了组播转换为单播地址的方法与播放器的对接逻辑

### v1.2.0 (2026-02-18)

- UI 及后端接口代码结构进行了分离重构，增加了防护校验处理

### v1.0.0

- 项目立项，发布初版应用界面及主要的探测调度

---

## ⚠️ 免责声明

1. 本项目只是一个开放源码的管理程序，仅供学习探讨与技术交流目的开放。
2. 建议请勿将本工具的任何部分用于具有商业牟利用途的活动以及其它违反互联网规范的动作。
3. 软件中展现乃至输出的流媒体列表均直接取决于您自身的私有输入，系统和代码作者不提供、不附带任何具有影像播放实体的直播服务器节点。对由于对生成后的频道播放列表的分发而引起的其他相关连带争议，项目维护方不予承担法律维系及后果。
