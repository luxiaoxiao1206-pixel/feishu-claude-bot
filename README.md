# 飞书 Claude AI 机器人

这是一个将 Claude AI 接入飞书的机器人项目。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，并填入你的配置：

```bash
cp .env.example .env
```

在 `.env` 文件中填入以下信息：

#### 飞书配置（从飞书开发者后台获取）
- `FEISHU_APP_ID`: 你的应用ID（在"凭证与基础信息"页面）
- `FEISHU_APP_SECRET`: 你的应用Secret（在"凭证与基础信息"页面）
- `FEISHU_VERIFICATION_TOKEN`: 验证令牌（在"事件与回调"页面）
- `FEISHU_ENCRYPT_KEY`: 加密密钥（在"事件与回调"页面，可选）

#### Claude配置
- `CLAUDE_API_KEY`: 你的Claude API密钥

### 3. 本地运行

```bash
npm start
```

服务器将在 `http://localhost:3000` 启动。

## 部署到公网

在配置飞书事件回调之前，你需要将服务部署到公网。推荐使用以下方式：

### 方案一：使用 ngrok（快速测试）

1. 安装 ngrok: https://ngrok.com/
2. 启动本地服务: `npm start`
3. 在另一个终端运行: `ngrok http 3000`
4. 使用 ngrok 提供的公网地址配置飞书

### 方案二：部署到云服务器

推荐平台：
- Vercel (免费，适合小项目)
- Railway (简单易用)
- 阿里云/腾讯云服务器

### 方案三：使用阿里云函数计算

适合无服务器架构，按需付费。

## 在飞书后台配置

### 1. 配置事件订阅

在飞书开发者后台 -> 事件与回调 -> 事件配置：

1. **请求地址URL**: `https://你的域名/webhook/event`
2. **添加事件**:
   - 选择 `im.message.receive_v1` (接收消息)

### 2. 配置权限

在飞书开发者后台 -> 权限管理，添加以下权限：

- `im:message` - 获取与发送单聊、群组消息
- `im:message.group_at_msg` - 获取群组中所有消息
- `im:message.p2p_msg` - 获取用户发给机器人的单聊消息

### 3. 配置机器人

在飞书开发者后台 -> 机器人：

- 配置机器人名称、描述、头像等信息

### 4. 发布版本

在飞书开发者后台 -> 版本管理与发布：

1. 创建版本
2. 提交审核或直接发布（企业自建应用可直接发布）

## 测试

1. 在飞书中搜索你的机器人
2. 发送消息测试
3. 查看服务器日志确认运行状态

## 常见问题

### Q: 事件回调配置失败？
A: 确保你的服务器已经启动，并且公网可以访问。检查 URL 是否正确。

### Q: 机器人不回复？
A: 检查：
1. 环境变量是否配置正确
2. Claude API Key 是否有效
3. 飞书权限是否配置完整
4. 查看服务器日志排查错误

### Q: 如何查看日志？
A: 服务器会在控制台输出日志，包括收到的消息和发送的回复。

## 项目结构

```
.
├── src/
│   └── index.js          # 主服务器文件
├── .env.example          # 环境变量模板
├── .gitignore           # Git忽略文件
├── package.json         # 项目配置
└── README.md           # 项目说明
```

## 技术栈

- Node.js
- Express
- @larksuiteoapi/node-sdk (飞书SDK)
- anthropic (Claude SDK)
