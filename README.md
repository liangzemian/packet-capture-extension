# 抓包归档 - Chrome Extension

基于 Chrome DevTools Protocol (CDP) 的 HTTP 请求抓包与归档工具。零依赖，开箱即用。

## 功能特性

- **完整抓包**：捕获 HTTP 请求的 URL、方法、Headers、Body 和完整的响应内容
- **会话管理**：每次抓包自动创建会话，支持查看和删除历史归档
- **实时过滤**：按 URL 搜索、HTTP 方法、状态码过滤请求
- **请求详情**：查看完整的请求/响应 Headers 和 Body（JSON 自动格式化）
- **多格式导出**：支持 HAR 1.2（可导入 DevTools/Charles）和原始 JSON 格式
- **重定向追踪**：正确处理 301/302 重定向请求的分离记录
- **状态恢复**：Service Worker 重启后自动恢复抓包状态
- **暗色主题**：仿 DevTools 风格的暗色 UI

## 技术方案

| 方案 | API | 响应体 | 需开 DevTools | 调试警告 |
|------|-----|--------|:---:|:---:|
| **本项目** | `chrome.debugger` (CDP) | 完整 | 否 | 顶部黄条 |
| 对照 | `chrome.webRequest` | 不可获取 | 否 | 无 |
| 对照 | `chrome.devtools.network` | 完整 | 是 | 无 |

选择 CDP 方案的原因：无需打开 DevTools 即可获取完整的请求和响应数据。

## 安装

1. 克隆仓库

```bash
git clone https://github.com/hailaobao2026/packet-capture-extension.git
```

2. 打开 Chrome，访问 `chrome://extensions/`

3. 开启右上角「开发者模式」

4. 点击「加载已解压的扩展程序」，选择项目目录

5. 工具栏出现扩展图标，点击即可使用

## 使用方法

### 基本流程

```
点击扩展图标 → 开始抓包 → 在页面操作 → 停止抓包 → 查看/导出数据
```

### 实时抓包

1. 点击「开始抓包」按钮，浏览器顶部出现调试提示条
2. 在目标页面进行操作，所有 HTTP 请求自动捕获
3. 点击「停止抓包」结束捕获

### 过滤请求

- **搜索框**：输入关键词过滤 URL
- **方法过滤**：GET / POST / PUT / DELETE / PATCH
- **状态码过滤**：2xx / 3xx / 4xx / 5xx

### 查看详情

点击任意请求行，展开底部详情面板，可查看：

- General（URL、方法、状态、类型、耗时、大小）
- Request Headers
- Request Body
- Response Headers
- Response Body

### 导出数据

- **导出 HAR**：标准 HAR 1.2 格式，可导入 Chrome DevTools、Charles、Fiddler
- **导出 JSON**：原始请求数据数组，方便程序化处理

### 历史归档

切换到「历史归档」标签页，可查看所有抓包会话。每个会话显示：

- 抓包时间和名称
- 请求总数
- 持续时间

支持的操作：查看请求、导出 HAR、删除会话。

## 项目结构

```
├── manifest.json       # Manifest V3 清单
├── background.js       # Service Worker（CDP 抓包核心）
├── popup.html          # Popup 页面
├── popup.css           # 暗色主题样式
├── popup.js            # Popup 交互逻辑
├── docs/               # 业务分析文档
└── test/               # 导出样例
```

## 架构设计

```
┌──────────┐  sendMessage  ┌──────────────┐  CDP Events  ┌───────────┐
│  Popup   │ ◄──────────► │  Service     │ ◄──────────► │ Chrome    │
│  (UI)    │              │  Worker      │              │ Tab       │
└──────────┘              └──────┬───────┘              └───────────┘
                                 │
                                 ▼
                          ┌─────────────┐
                          │  IndexedDB  │
                          │  ┌────────┐ │
                          │  │sessions│ │
                          │  ├────────┤ │
                          │  │requests│ │
                          │  └────────┘ │
                          └─────────────┘
```

## 注意事项

- 抓包时浏览器顶部会显示黄色调试提示条（CDP 机制，无法去除）
- 抓包期间避免按 F12 打开 DevTools，可能导致调试器冲突
- 响应体超过 500KB 会自动截断，防止存储溢出
- 大多数基于 Chromium 的指纹浏览器（比特、AdsPower 等）可直接安装使用

## 适用场景

- Web 应用接口调试与分析
- 注册/登录等业务流程抓包
- API 逆向分析
- 指纹浏览器中的流量录制
- 自动化测试中的请求归档

## License

MIT
