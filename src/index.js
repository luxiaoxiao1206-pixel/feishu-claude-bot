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
    const body = req.body;

    // URL验证
    if (body.type === 'url_verification') {
      console.log('收到URL验证请求');
      return res.json({ challenge: body.challenge });
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
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
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
