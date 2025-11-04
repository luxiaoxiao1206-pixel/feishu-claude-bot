# VPS 部署完整指南

如果你选择 VPS，需要完成以下步骤：

## 前置要求
- 基本的 Linux 命令行知识
- SSH 连接经验
- 域名（可选但推荐）

## 必须完成的任务

### 1. 服务器基础配置（1-2小时）
```bash
# 更新系统
apt update && apt upgrade

# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 安装 Git
apt install git

# 配置防火墙
ufw allow 22    # SSH
ufw allow 80    # HTTP
ufw allow 443   # HTTPS
ufw enable
```

### 2. 配置 HTTPS（1小时）
```bash
# 安装 Nginx
apt install nginx

# 配置 SSL（Let's Encrypt）
apt install certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com
```

### 3. 进程守护（30分钟）
```bash
# 安装 PM2
npm install -g pm2

# 配置开机自启
pm2 startup
pm2 save
```

### 4. 日志管理（30分钟）
```bash
# 配置日志轮转
# 防止日志文件占满硬盘
```

### 5. 监控配置（1小时）
```bash
# 安装监控工具
# 配置告警通知
```

### 6. 安全加固（1小时）
```bash
# 禁用 root 登录
# 配置 SSH 密钥认证
# 安装 fail2ban 防暴力破解
# 定期更新系统
```

### 7. 持续运维
- 每周检查服务器状态
- 每月更新系统补丁
- 监控磁盘空间
- 处理突发故障

## 推荐的 VPS 服务商（如果选择VPS）

### 亚洲节点（低延迟到菲律宾）

1. **Vultr 新加坡节点** ⭐⭐⭐⭐⭐
   - $6/月 (1核2GB)
   - 到菲律宾 ~20-30ms
   - 按小时计费，随时删除

2. **DigitalOcean 新加坡** ⭐⭐⭐⭐
   - $6/月 (1核1GB)
   - 稳定性好
   - 文档完善

3. **Linode 新加坡** ⭐⭐⭐⭐
   - $5/月 (1核1GB)
   - 性价比高

## 部署脚本（简化版）

```bash
#!/bin/bash
# 快速部署脚本

# 1. 克隆代码
git clone <你的仓库>
cd feishu-claude-bot

# 2. 安装依赖
npm install

# 3. 配置环境变量
nano .env

# 4. 启动服务
pm2 start src/index.js --name feishu-bot
pm2 save
```

## 注意事项

⚠️ **如果你不熟悉以上操作，强烈建议用 Render！**

- VPS 配置错误可能导致安全问题
- 服务挂了需要自己排查修复
- 需要持续关注服务器状态
