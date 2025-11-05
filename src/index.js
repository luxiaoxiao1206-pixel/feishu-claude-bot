import express from 'express';
import dotenv from 'dotenv';
import * as lark from '@larksuiteoapi/node-sdk';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 初始化飞书客户端
const feishuClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

// 初始化加密工具（如果配置了 Encrypt Key）
let cipher = null;
if (process.env.FEISHU_ENCRYPT_KEY) {
  cipher = new lark.AESCipher(process.env.FEISHU_ENCRYPT_KEY);
  console.log('✅ 加密模式已启用');
} else {
  console.log('ℹ️  未配置加密密钥，使用明文模式');
}

// 初始化Claude客户端
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 飞书事件回调接口
app.post('/webhook/event', async (req, res) => {
  try {
    let body = req.body;
    console.log('收到原始请求，body:', JSON.stringify(body, null, 2));

    // 处理加密消息
    if (body.encrypt) {
      console.log('🔐 检测到加密消息，开始解密...');
      if (!cipher) {
        console.error('❌ 收到加密消息但未配置 FEISHU_ENCRYPT_KEY');
        return res.status(400).json({
          code: -1,
          msg: '服务器未配置加密密钥'
        });
      }

      try {
        // 解密消息
        const decryptedString = cipher.decrypt(body.encrypt);
        console.log('✅ 解密成功，解密后的字符串:', decryptedString);

        // 解析 JSON
        body = JSON.parse(decryptedString);
        console.log('📦 解析后的消息体:', JSON.stringify(body, null, 2));
      } catch (decryptError) {
        console.error('❌ 解密失败:', decryptError);
        return res.status(400).json({
          code: -1,
          msg: '消息解密失败'
        });
      }
    }

    // URL验证
    if (body.type === 'url_verification') {
      console.log('✅ URL验证请求');
      console.log('challenge值:', body.challenge);
      const response = { challenge: body.challenge };
      console.log('准备返回:', JSON.stringify(response));
      return res.json(response);
    }

    // 处理事件回调
    if (body.header?.event_type === 'im.message.receive_v1') {
      // 立即返回200，避免飞书重复推送
      res.json({ code: 0, msg: 'success' });

      // 异步处理消息
      handleMessage(body).catch(err => {
        console.error('处理消息失败:', err);
      });
      return;
    }

    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    console.error('事件处理失败:', error);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

// 处理消息
async function handleMessage(event) {
  try {
    const messageEvent = event.event;
    const messageId = messageEvent.message.message_id;
    const chatId = messageEvent.message.chat_id;
    const senderId = messageEvent.sender.sender_id.user_id;

    // 解析消息内容
    const content = JSON.parse(messageEvent.message.content);
    const userMessage = content.text;

    console.log(`收到消息 [${chatId}]: ${userMessage}`);

    // 调用Claude API
    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: `你是一个飞书企业 AI 助手机器人，由 Claude AI 提供支持。

你的身份和功能：
- 你运行在飞书平台上，用户通过飞书与你对话
- 你可以帮助用户回答问题、进行对话交流
- 你即将支持分析飞书多维表格数据
- 你即将支持创建飞书文档来整理信息

回答风格：
- 以飞书机器人的身份回答，不要说"我不在飞书中运行"
- 简洁、专业、友好
- 如果用户问到你的功能，直接介绍你能做什么
- 使用中文回答`,
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ],
    });

    const reply = claudeResponse.content[0].text;
    console.log('Claude回复:', reply);

    // 发送回复到飞书
    await feishuClient.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({
          text: reply,
        }),
      },
    });

    console.log('消息发送成功');
  } catch (error) {
    console.error('处理消息时出错:', error);

    // 尝试发送错误消息给用户
    try {
      await feishuClient.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: event.event.message.chat_id,
          msg_type: 'text',
          content: JSON.stringify({
            text: `抱歉，处理您的消息时出现错误: ${error.message}`,
          }),
        },
      });
    } catch (sendError) {
      console.error('发送错误消息失败:', sendError);
    }
  }
}

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`事件回调地址: http://localhost:${PORT}/webhook/event`);
  console.log(`健康检查地址: http://localhost:${PORT}/health`);
});
