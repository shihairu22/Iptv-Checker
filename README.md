<div align="center">

# 📺 IPTV Checker

**基于 Node.js 构建的现代化、高性能 IPTV 组播流状态检测工具。**

![Iptv-Checker 检测空数据界面](./public/preview-empty.png)

[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/cgg888/iptv-checker?style=flat-square&color=blue)](https://github.com/cgg888/iptv-checker/releases)
[![Build Status](https://img.shields.io/github/actions/workflow/status/cgg888/iptv-checker/docker-image.yml?branch=main&style=flat-square)](https://github.com/cgg888/iptv-checker/actions)
[![GitHub Downloads](https://img.shields.io/github/downloads/cgg888/iptv-checker/total?style=flat-square&color=success)](https://github.com/cgg888/iptv-checker/releases)
[![GHCR](https://img.shields.io/badge/GHCR-iptv--checker-2ea44f?style=flat-square&logo=github)](https://github.com/cgg888/iptv-checker/pkgs/container/iptv-checker)
</div>

> [!NOTE]
> **致敬源项目**：本项目 Fork 自 [CGG888/Iptv-Checker](https://github.com/CGG888/Iptv-Checker)。
> 非常感谢原作者建立的优秀底层与构思。本仓库在此基础上，借助 AI 工具进行了一系列深度改造与性能升级（如彻底剥离前端冗余脚本、重写多并发架构、引入防注入级别的安全校验以及原子级写入等），以更契合我个人的极客使用习惯与高负载需求。

---

## 🚀 核心优势 (v1.3.0 高性能版)

本工具专为大规模 IPTV 列表管理打造，在 v1.3.0 中实现了**系统级性能飞跃**：

- ⚡ **原生高并发**: 抛弃传统线程模型，采用智能进程池，轻松应对 **200+ 并发**扫描。
- 🛡️ **智能网络预检**: 独创 Pre-flight 机制 (8秒超时)，极其快速地剔除死链，拒绝无效 FFprobe 等待。
- 📉 **极致带宽优化**: 前后端引入 Socket.IO 增量数据推送机制，流量节省 **99%**，数万级频道在前端依旧丝滑刷新。
- 💾 **无感持久化**: 内存+磁盘混合防颠簸策略，零感知自动保存检测状态。

---

## ✨ 主要功能

- 🔍 **全维度检测**：自动检测在线状态、分辨率 (SD/HD/4K)、视频编码、帧率信息。
- 🔄 **智能合并策略**：同地址检测仅更新状态字段，不覆盖精心调整的频道名称、分组及 Logo。
- 🧠 **同名优选算法**：在同名频道中，按照质量优先原则排序 (`组播 4K > HD > SD > 单播`)，保障观看体验最佳。
- 📤 **增强型导出**：完美支持 TXT / M3U 导出。M3U 格式支持 `tvg-*` 标签、分组信息、自选回放源 (Catchup) 与质量后缀。
- 🖼️ **可视化频道编辑**：弹窗支持台标实时预览，集成 PotPlayer 一键调起播放能力。
- 📝 **内置版本管理**：快照式保存机制，支持一键切换历史检测状态，防误删防出错。

---

## 🐳 Docker 快速部署 (推荐)

部署 IPTV Checker 最优雅的方式是使用 Docker。

> [!IMPORTANT]
> **高并发环境必读**: v1.3.0 优化了文件句柄管理，请务必在 Compose 文件中配置 `ulimits`，以防高并发扫描时触发系统的 `Too many open files` 限制。

**`docker-compose.yml` 示例说明:**

```yaml
services:
  iptv-checker:
    image: ghcr.io/cgg888/iptv-checker:latest
    container_name: iptv-checker
    ports:
      - "8848:8848"
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/app/data   # [必须] 映射数据目录以持久化
    ulimits:               # [关键] v1.3.0 性能基石，突破高并发文件句柄限制
      nofile:
        soft: 65535
        hard: 65535
    restart: unless-stopped
```

运行：`docker-compose up -d`
访问：`http://localhost:8848`

---

## 💻 本地 Node.js 部署

如果需要二次开发或在低配设备轻量化运行：

1. **环境准备**:
   - Node.js 18+
   - **必需依赖**: `ffmpeg` (包含 ffprobe)。请确保命令行输入 `ffprobe -version` 有正常回显。
2. **克隆与安装**:

   ```bash
   git clone https://github.com/cgg888/iptv-checker.git
   cd iptv-checker
   npm install
   ```

3. **启动**:

   ```bash
   npm start
   ```

---

## 📖 使用指南

- 🎯 **开始检测**:
  - 支持直接粘贴多行 `频道名,rtp://ip:port` 格式的文本。
  - 支持载入远程网络 TXT/M3U 链接。
  - 支持上传本地 TXT/M3U 文件。
- ⚙️ **内外网模式联动**:
  - 内网导出: 自动使用服务端设置的 UDPXY 地址作为组播基址。
  - 外网导出: 可走外网代理；受 Token 安全校验保护。
- ⏪ **时移 (Catchup)**:
  - 可在全局设置配置默认时移源，导出 M3U 时可一键套用 `fmt=default/ku9/mytv` 等多格式时移模板。

---

## 📁 核心数据结构

所有用户数据及状态均持久化在 `/data` 映射目录中：

- `streams.json`: 当前核心检测流状态字典。
- `settings` / `udpxy` / `app_settings` 等 JSON：承载全局选项。
- `streams-YYYY...json`: 借助页面“版本管理”独立打的历史快照。

*注：内存常驻确保极速响应，文件实时覆写确保持久化，纯净且无需臃肿外部数据库。*

---

## 📜 变更历史 (Changelog)

### v1.3.0 (2026-02-20) 🚀 性能革命

- **[提升]** 彻底抛弃 Worker API，采用 `p-queue` 进程池调度，CPU调度更稳定。
- **[优化]** `ffprobe` 分析超时延长至 10s，专门针对海外及高延迟 IPTV 源防误判。
- **[优化]** 引入基于 UDP Payload 监听的极速网络嗅探，8000ms 快速丢弃纯死亡节点。
- **[优化]** 前后端改造为 Socket.IO 增量状态同步，彻底解决 100 线程并发时前端浏览器卡死与网络崩溃阻塞问题。
- **[优化]** 禁用磁盘文件冗余全量备份机制，转为定点静默覆写，大幅降低宿主机磁盘 IOPS 负荷。

### v1.2.2 (2026-02-18)

- 优化 EPG 与回看兼容性，组播自动拼接单播播放参数。

### v1.2.0 (2026-02-18)

- 接口弹窗分离，强化内外网 Token 拦截校验。扩展 M3U 时移格式定义。

### v1.0.0

- 初始化发布，支持基础批量检测、美观 UI 及 Docker 打包。

---

## ⚠️ 免责声明

1. 本软件为**开源项目**，仅供学习、测试及技术交流之目的。
2. 严禁将本检测器用于批量窃拿、商业牟利或其他违反相关法律法规的用途。
3. 软件生成的内容均依赖于您输入的源，作者既不提供任何可播放影视接口，也不对因使用产生之侵权、连带损失承担责任。

<div align="center">
🙏 如果 IPTV Checker 帮您省下大把时间，欢迎给本仓库点个 ⭐️ Star！
</div>
