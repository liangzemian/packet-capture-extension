# Packet Capture Extension - CLAUDE.md

## 项目概述

Chrome Extension（Manifest V3）HTTP 抓包归档工具。基于 `chrome.debugger` (CDP) 实现完整的请求/响应捕获，支持会话管理、过滤和多格式导出。

## 技术栈

- Chrome Extension Manifest V3
- Service Worker（后台脚本）
- IndexedDB（持久化存储）
- Chrome DevTools Protocol (CDP) 1.3
- 原生 HTML/CSS/JS，无框架依赖

## 项目结构

```
├── manifest.json       # MV3 清单，声明权限和入口
├── background.js       # Service Worker，CDP 抓包核心逻辑
├── popup.html          # Popup 页面结构
├── popup.css           # 暗色主题样式
├── popup.js            # Popup 交互逻辑、消息通信
├── docs/               # 业务分析文档
│   └── DreaminaCapCut注册流程抓包业务分析.md
└── test/               # 抓包导出样例
    └── capture-*.json
```

## 核心架构

### 数据流

```
Popup (UI) ──sendMessage──> Service Worker ──CDP──> Chrome Tab
                               │
                               ▼
                          IndexedDB
                     ┌─────────┴─────────┐
                  sessions          requests
               (会话元数据)      (请求/响应详情)
```

### 关键 API

| 组件 | API | 用途 |
|------|-----|------|
| 抓包核心 | `chrome.debugger` | 附加到 Tab，通过 CDP 捕获网络事件 |
| 状态持久化 | `chrome.storage.local` | 保存抓包状态、会话 ID（SW 重启恢复） |
| 文件下载 | `chrome.downloads` | 导出 HAR/JSON 文件 |
| 后台保活 | `chrome.alarms` | Service Worker 30s 唤醒一次 |
| 数据存储 | IndexedDB | 请求和会话的持久化存储 |

### CDP 事件处理

`background.js` 监听 4 个核心 CDP Network 事件：

1. `Network.requestWillBeSent` → 记录请求 URL、方法、Headers、Body
2. `Network.responseReceived` → 记录响应状态、Headers、Content-Type
3. `Network.loadingFinished` → 获取响应 Body（`Network.getResponseBody`），持久化
4. `Network.loadingFailed` → 标记失败请求，持久化

### 消息协议

Popup 与 Service Worker 通过 `chrome.runtime.sendMessage` 通信：

| action | 方向 | 说明 |
|--------|------|------|
| `startCapture` | popup → sw | 开始抓包，传入 tabId |
| `stopCapture` | popup → sw | 停止抓包 |
| `getStatus` | popup → sw | 获取当前状态 |
| `getRequests` | popup → sw | 查询请求列表（支持过滤） |
| `getRequestDetail` | popup → sw | 获取单个请求详情 |
| `getSessions` | popup → sw | 获取所有历史会话 |
| `exportHAR` | popup → sw | 构建 HAR 数据并返回给 popup 下载 |
| `exportJSON` | popup → sw | 构建原始 JSON 数据并返回给 popup 下载 |
| `clearRequests` | popup → sw | 清空请求数据 |
| `deleteSession` | popup → sw | 删除会话及其请求 |

### IndexedDB Schema

**requests store**：`{ id (auto), sessionId, url, method, status, requestHeaders, responseHeaders, requestBody, responseBody, contentType, size, duration, failed, errorText, timestamp, ... }`

**sessions store**：`{ id, tabId, tabUrl, startTime, endTime, requestCount, name }`

## 开发约束

- 响应体超过 500KB 自动截断，防止 IndexedDB 溢出
- Service Worker 可被浏览器随时挂起，抓包状态通过 `chrome.storage.local` 恢复
- 抓包期间浏览器顶部出现黄色调试提示条（CDP 机制，无法去除）
- 抓包期间不要按 F12 打开 DevTools，会导致调试器冲突
- 导出由 popup 端调用 `chrome.downloads.download` 完成（SW 端 `URL.createObjectURL` 不可用）

## 构建与安装

无需构建步骤。直接加载到 Chrome：

1. `chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序
2. 选择本项目根目录
3. 点击扩展图标使用

## 修改注意事项

- 修改 `background.js` 后需在 `chrome://extensions/` 点击刷新按钮
- 修改 `popup.html/css/js` 后关闭再打开 popup 即可生效
- `manifest.json` 修改权限后需要重新加载扩展
