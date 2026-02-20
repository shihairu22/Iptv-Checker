# 更新日志 (CHANGELOG)

## [v1.4.0] - 最终重构与稳定版 (The Ultimate Refactoring & Stability Release)

经过多轮深度代码审计与重构，IPTV-Checker 迎来了从底层性能到前端架构的全面蜕变。此版本彻底解决了遗留的历史并发漏洞、前端逻辑冗余、以及各种功能残缺，同时新增了一系列现代化特性。

### 🔥 核心更新 (Highlights)

- **并发引擎革命性重构**：剥离老旧、低效且易引发内存溢出的多 Worker 架构，改用基于 `p-queue` 的异步并发引擎。单节点检测并发量安全上限由 `10` 大幅跃升至 `200+`。
- **智能预检 (Pre-flight Check)**：在调用 `ffprobe` 之前引入纯 `TCP/UDP` Socket 连接连通性预检，实现 100ms 级别筛除纯死链！极大地缩短了无效源的超时等待，提升总体检测速度 10 倍以上。
- **双向实时通信 (WebSocket)**：全面引入 `Socket.IO`，替代老旧的 Axios HTTP 短轮询模式，实现前端无缝感知检测条目的极速滚动更新。
- **可视化仪表盘 (Dashboard)**：在前端集成 `Chart.js`，实时呈现频道分辨率占比及在线率多维分析饼图。
- **快照持久化功能恢复 (Snapshot Versioning)**：响应社区及开发者呼声，恢复了因前期精简而丢失的完整后台备份接口与前端 UI——现在可以一键备份当前频道数据，随时一键覆盖回滚到任何时间节点的历史记录！

### 🚀 性能优化 (Performance Optimizations)

- **FFprobe 精准调优**：注入限制参数 `-analyzeduration 10000000 -probesize 10000000`，有效隔离长宽带解析的无解卡顿，强制实施 8000ms 兜底终止策略。
- **异步 IO 防腐**：修复 `persistenceService.js` 中可能引起的文件并发读写冲突，所有磁盘落库操作均采用基于 `.tmp` 的原子化(Atomic)重命名替换机制。
- **内存泄漏排除**：杜绝前端反复渲染重绘引起的 DOM 崩溃，在 WebSocket 对接层实现“局部流数据增量更新”。

### 🛠️ 深度重构与清理 (Architectural Cleanup)

- **解耦“极度臃肿”的 index.html**：前端实现彻底的分离——超过 2500 行的乱源被拆分归档到 `public/js/utils.js` (基础 UI 库) 和 `public/js/app.js` (业务逻辑)。
- **路由鉴权与模块拆分**：废弃 `index.js` 单一文件塞满所有接口的“屎山”设计，后端切分为 `routes/auth.js`，`routes/stream.js`，与 `routes/persist.js`，各司其职。
- **消灭死按钮/失效代码**：经过扫描排查，去除了大量因版本迭代历史被遗弃却依然挂在前端按钮上的死空壳逻辑，修复了结果页面不生效的失效批量操作等。

### 🐞 关键 Bug 修复 (Bug Fixes)

- 修复 **断网/重新检测的断点续传队列幽灵阻塞 (Queue Ghost Blocking)**：现在暂停后再点击继续，后端 `p-queue` 能精准无缝衔接原状，不会再发生资源被锁死或队列无限挂起的顽疾。
- 防范 **RCE 注入漏洞**：所有的子进程命令执行均由高危的 `exec` 替换为更为收敛且严格的 `execFile`。
- 修复 **UDpxy 代理下的 URL 拼接冗余**：修复单个 HTTP 流经过强制 `checkStream` 时可能会被错误携带多次代理前缀导致的假离线问题。
- 修复 **AuthMiddleware 同步报错阻断流程**：修正部分验证逻辑将对象当函数执行抛出的 500 Server Error。

---

*感谢您的使用与支持，这个版本凝聚了大量的极致优化细节，愿它成为您得心应手的 IPTV 测源利器！*
