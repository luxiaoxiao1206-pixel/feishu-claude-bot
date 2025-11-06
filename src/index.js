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

// 对话历史存储 - 使用 Map 存储每个聊天的历史记录
// key: chatId, value: 对话历史数组
const conversationHistory = new Map();

// 文档缓存存储 - 记录会话中讨论过的文档
// key: chatId, value: [{docId, title, summary, time}]
const documentCache = new Map();

// 获取对话历史
function getConversationHistory(chatId) {
  if (!conversationHistory.has(chatId)) {
    conversationHistory.set(chatId, []);
  }
  return conversationHistory.get(chatId);
}

// 添加消息到历史
function addToConversationHistory(chatId, role, content) {
  const history = getConversationHistory(chatId);
  history.push({ role, content });

  // 保留最近10轮对话（20条消息），避免超过 token 限制
  const MAX_MESSAGES = 20;
  if (history.length > MAX_MESSAGES) {
    history.splice(0, history.length - MAX_MESSAGES);
  }

  console.log(`💬 [${chatId}] 对话历史长度: ${history.length} 条消息`);
}

// 清除对话历史（可选功能）
function clearConversationHistory(chatId) {
  conversationHistory.delete(chatId);
  console.log(`🗑️ [${chatId}] 对话历史已清除`);
}

// ==================== 文档缓存管理 ====================

// 添加文档到缓存
function addDocumentToCache(chatId, docId, title, summary) {
  if (!documentCache.has(chatId)) {
    documentCache.set(chatId, []);
  }
  const docs = documentCache.get(chatId);

  // 检查是否已存在
  const existingIndex = docs.findIndex(d => d.docId === docId);
  if (existingIndex !== -1) {
    // 更新现有文档
    docs[existingIndex] = { docId, title, summary, time: new Date().toISOString() };
  } else {
    // 添加新文档到开头
    docs.unshift({ docId, title, summary, time: new Date().toISOString() });
  }

  // 只保留最近10个文档
  if (docs.length > 10) {
    docs.pop();
  }

  console.log(`📄 [${chatId}] 文档已缓存: ${title}`);
}

// 获取最近的文档
function getRecentDocuments(chatId) {
  return documentCache.get(chatId) || [];
}

// ==================== 工作报告生成 ====================

// 生成工作报告（日报/周报）
async function generateWorkReport(chatId, reportType) {
  const history = getConversationHistory(chatId);

  if (history.length === 0) {
    return '📝 暂无对话历史，无法生成报告。\n\n💡 提示：请先与我进行一些工作相关的对话，我会基于对话内容为您生成报告。';
  }

  console.log(`📊 开始生成${reportType === 'daily' ? '日报' : '周报'}，历史记录数: ${history.length}`);

  // 构建提示词
  const systemPrompt = `你是一个专业的工作报告生成助手。基于用户的对话历史，生成一份${reportType === 'daily' ? '工作日报' : '工作周报'}。

要求：
1. 从对话历史中提取工作相关内容（如讨论的项目、分析的数据、创建的文档等）
2. 忽略闲聊和非工作内容
3. 生成结构化报告

报告格式：
📅 ${reportType === 'daily' ? '工作日报' : '工作周报'} - [今天的日期]

## 📌 主要工作内容
- [提取的工作事项1]
- [提取的工作事项2]

## ✅ 完成情况
- [已完成的工作]

## 🔄 进行中/遇到问题
- [正在处理的工作或遇到的问题]

## 📋 ${reportType === 'daily' ? '明日计划' : '下周计划'}
- [如果对话中提到了计划，在此列出]

注意：
- 使用清晰的标题和列表
- 简洁专业，突出重点
- 如果某个部分没有内容，可以省略该部分`;

  const userPrompt = `基于以下对话历史，生成一份${reportType === 'daily' ? '今日工作日报' : '本周工作周报'}：

对话历史：
${history.map((msg, index) => `${index + 1}. ${msg.role === 'user' ? '我' : 'AI助手'}: ${msg.content.substring(0, 200)}${msg.content.length > 200 ? '...' : ''}`).join('\n\n')}

请生成报告：`;

  try {
    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    console.log(`✅ ${reportType === 'daily' ? '日报' : '周报'}生成成功`);
    return claudeResponse.content[0].text;
  } catch (error) {
    console.error('生成报告失败:', error);
    throw error;
  }
}

// ==================== 表格数据高级处理 ====================

// 批量处理表格数据
async function processTableData(bitableData, userMessage) {
  console.log(`📊 开始高级处理表格数据: ${bitableData.tableName}`);

  // 检测操作类型
  let operation = '分析';
  if (/筛选|过滤|查找|满足条件/i.test(userMessage)) {
    operation = '筛选';
  } else if (/统计|求和|平均|计数|总数|多少个/i.test(userMessage)) {
    operation = '统计';
  } else if (/排序|从高到低|从低到高|最大|最小|前.*名/i.test(userMessage)) {
    operation = '排序';
  } else if (/对比|比较|差异|变化/i.test(userMessage)) {
    operation = '对比';
  }

  console.log(`🔍 检测到操作类型: ${operation}`);

  const systemPrompt = `你是一个专业的数据分析助手。用户提供了一个飞书多维表格的数据，需要你进行「${operation}」操作。

你的任务：
1. 仔细分析表格的字段和数据
2. 理解用户的具体需求
3. 执行相应的数据处理操作
4. 返回清晰、结构化的结果

支持的操作：
- 筛选：根据条件筛选符合要求的数据行
- 统计：计算总和、平均值、计数、最大值、最小值等
- 排序：按指定字段对数据进行排序
- 对比：对比分析不同数据的差异和趋势

输出要求：
- 使用清晰的表格或列表格式
- 突出关键数据和结论
- 如果数据量大，只显示最相关的前10-20条`;

  const userPrompt = `表格名称：${bitableData.tableName}

字段列表：
${bitableData.fields.map(f => `- ${f.name} (${f.type})`).join('\n')}

数据记录（共 ${bitableData.records.length} 条，展示前50条）：
${JSON.stringify(bitableData.records.slice(0, 50), null, 2)}

用户要求：${userMessage}

请执行「${operation}」操作并返回结果：`;

  try {
    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    console.log(`✅ 表格数据处理完成，操作类型: ${operation}`);
    return claudeResponse.content[0].text;
  } catch (error) {
    console.error('表格数据处理失败:', error);
    throw error;
  }
}

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

// 解析飞书多维表格 URL
function extractBitableUrl(text) {
  // 匹配飞书多维表格链接
  const bitableRegex = /https?:\/\/[^/]+\/base\/([a-zA-Z0-9]+)(?:\?table=([a-zA-Z0-9]+))?/;
  const match = text.match(bitableRegex);

  if (match) {
    return {
      found: true,
      appToken: match[1],
      tableId: match[2] || null,
      fullUrl: match[0]
    };
  }

  return { found: false };
}

// 获取多维表格数据
async function fetchBitableData(appToken, tableId = null) {
  try {
    console.log(`📊 开始获取多维表格数据: appToken=${appToken}, tableId=${tableId}`);

    // 如果没有指定 tableId，获取第一个表格
    if (!tableId) {
      const tablesResponse = await feishuClient.bitable.appTable.list({
        path: { app_token: appToken },
        params: { page_size: 1 }
      });

      if (!tablesResponse.data?.items || tablesResponse.data.items.length === 0) {
        throw new Error('多维表格中没有找到表格');
      }

      tableId = tablesResponse.data.items[0].table_id;
      console.log(`📋 使用第一个表格: ${tableId}`);
    }

    // 获取字段信息
    const fieldsResponse = await feishuClient.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 }
    });

    const fields = fieldsResponse.data?.items || [];
    console.log(`📝 获取到 ${fields.length} 个字段`);

    // 获取记录数据（最多100条）
    const recordsResponse = await feishuClient.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 }
    });

    const records = recordsResponse.data?.items || [];
    console.log(`📊 获取到 ${records.length} 条记录`);

    return {
      fields,
      records,
      tableId
    };
  } catch (error) {
    console.error('获取多维表格数据失败:', error);
    throw error;
  }
}

// 分析多维表格数据
async function analyzeBitableData(bitableData, userQuestion) {
  try {
    // 构建表格数据的文本描述
    const fieldNames = bitableData.fields.map(f => f.field_name).join(', ');
    const recordCount = bitableData.records.length;

    // 提取前10条记录作为示例
    const sampleRecords = bitableData.records.slice(0, 10).map(record => {
      const row = {};
      bitableData.fields.forEach(field => {
        const value = record.fields[field.field_id];
        row[field.field_name] = value;
      });
      return row;
    });

    const tableDescription = `
多维表格数据概览：
- 字段: ${fieldNames}
- 总记录数: ${recordCount}
- 示例数据（前10条）:
${JSON.stringify(sampleRecords, null, 2)}
`;

    console.log('📊 发送表格数据给 Claude 分析');

    // 调用 Claude 分析
    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: `你是一个飞书企业 AI 助手机器人，擅长分析多维表格数据。

分析要求：
- 理解表格的结构和内容
- 根据用户的问题提供准确的分析
- 如果用户没有具体问题，提供数据的概览和关键洞察
- 使用清晰的格式，包含具体数字和示例
- 使用中文回答`,
      messages: [
        {
          role: 'user',
          content: `${tableDescription}\n\n用户问题: ${userQuestion || '请分析这个表格的数据'}`
        }
      ],
    });

    return claudeResponse.content[0].text;
  } catch (error) {
    console.error('分析多维表格数据失败:', error);
    throw error;
  }
}

// 解析飞书文档 URL
function extractDocUrl(text) {
  // 匹配飞书文档链接 (docx, doc, docs)
  const docxRegex = /https?:\/\/[^/]+\/docx\/([a-zA-Z0-9]+)/;
  const docRegex = /https?:\/\/[^/]+\/doc\/([a-zA-Z0-9]+)/;
  const docsRegex = /https?:\/\/[^/]+\/docs\/([a-zA-Z0-9]+)/;

  let match = text.match(docxRegex);
  if (match) {
    return { found: true, documentId: match[1], type: 'docx', fullUrl: match[0] };
  }

  match = text.match(docRegex);
  if (match) {
    return { found: true, documentId: match[1], type: 'doc', fullUrl: match[0] };
  }

  match = text.match(docsRegex);
  if (match) {
    return { found: true, documentId: match[1], type: 'docs', fullUrl: match[0] };
  }

  return { found: false };
}

// 获取飞书文档内容
async function fetchDocContent(documentId) {
  try {
    console.log(`📄 开始获取文档内容: documentId=${documentId}`);

    // 获取文档纯文本内容 - 正确的API路径
    const response = await feishuClient.docx.document.rawContent({
      path: { document_id: documentId },
      params: { lang: 0 }
    });

    console.log('📄 文档API响应:', JSON.stringify(response, null, 2));

    if (!response.data?.content) {
      throw new Error('无法读取文档内容');
    }

    const content = response.data.content;
    console.log(`📝 获取到文档内容，长度: ${content.length} 字符`);

    return content;
  } catch (error) {
    console.error('获取文档内容失败:', error);
    console.error('错误详情:', error.response?.data || error.message);
    throw error;
  }
}

// 分析文档内容
async function analyzeDocContent(docContent, userQuestion) {
  try {
    console.log('📄 发送文档内容给 Claude 分析');

    // 限制文档内容长度（避免超过 token 限制）
    const maxLength = 50000; // 约 12500 tokens
    const truncatedContent = docContent.length > maxLength
      ? docContent.substring(0, maxLength) + '\n\n...(内容过长，已截断)'
      : docContent;

    // 调用 Claude 分析
    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: `你是一个飞书企业 AI 助手机器人，擅长分析和总结文档内容。

分析要求：
- 理解文档的主要内容和结构
- 根据用户的问题提供准确的分析或总结
- 如果用户没有具体问题，提供文档的概要和关键要点
- 使用清晰的格式，突出重点信息
- 使用中文回答`,
      messages: [
        {
          role: 'user',
          content: `文档内容：\n\n${truncatedContent}\n\n用户问题: ${userQuestion || '请总结这个文档的主要内容'}`
        }
      ],
    });

    return claudeResponse.content[0].text;
  } catch (error) {
    console.error('分析文档内容失败:', error);
    throw error;
  }
}

// 创建飞书文档
async function createFeishuDoc(title, content) {
  try {
    console.log(`📝 开始创建文档: ${title}`);
    console.log(`📄 文档内容预览: ${content.substring(0, 100)}...`);

    // 步骤1: 调用飞书 API 创建文档
    const createResponse = await feishuClient.docx.document.create({
      data: {
        folder_token: '', // 空字符串表示创建在根目录
        title: title
      }
    });

    console.log('📊 创建文档API响应:', JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data?.document?.document_id) {
      throw new Error('创建文档失败，未返回文档ID');
    }

    const documentId = createResponse.data.document.document_id;
    console.log(`✅ 文档创建成功: ${documentId}`);

    // 步骤2: 获取文档详情以获取 block_id
    console.log('📋 正在获取文档详情...');

    // 方法1: 尝试通过 document.get 获取
    let blockId = null;
    try {
      const docInfoResponse = await feishuClient.docx.document.get({
        path: { document_id: documentId }
      });
      console.log('📊 文档详情API响应:', JSON.stringify(docInfoResponse.data, null, 2));
      blockId = docInfoResponse.data?.document?.body?.block_id;
    } catch (e) {
      console.warn('⚠️ 通过 document.get 获取 block_id 失败:', e.message);
    }

    // 方法2: 如果方法1失败，使用 document_id 作为 block_id（根block）
    if (!blockId) {
      console.log('📍 尝试使用 document_id 作为根 block_id');
      blockId = documentId;
    }

    console.log(`📍 使用 block_id: ${blockId}`);

    // 步骤3: 向文档中添加内容
    console.log('✍️ 正在添加文档内容...');

    // 将内容分段（按换行符分割）
    const paragraphs = content.split('\n').filter(p => p.trim());

    // 构建文档块
    const children = paragraphs.map(paragraph => ({
      block_type: 2, // 2 = 文本块
      text: {
        elements: [
          {
            text_run: {
              content: paragraph
            }
          }
        ]
      }
    }));

    await feishuClient.docx.documentBlockChildren.create({
      path: { document_id: documentId, block_id: blockId },
      data: { children }
    });

    console.log('✅ 文档内容添加成功');

    // 构建文档链接
    const docUrl = `https://feishu.cn/docx/${documentId}`;
    console.log(`📄 文档链接: ${docUrl}`);

    return {
      documentId,
      url: docUrl,
      title,
      content
    };
  } catch (error) {
    console.error('创建文档失败:', error);
    console.error('错误详情:', error.response?.data || error.message);

    // 如果是添加内容失败，提供更友好的错误信息
    if (error.message.includes('block_id')) {
      throw new Error('文档已创建但添加内容失败，请手动编辑文档');
    }

    throw error;
  }
}

// 创建多维表格
async function createBitableApp(name, description = '') {
  try {
    console.log(`📊 开始创建多维表格: ${name}`);

    // 创建 Base App
    const response = await feishuClient.bitable.app.create({
      data: {
        name: name,
        folder_token: '' // 空字符串表示创建在根目录
      }
    });

    if (!response.data?.app?.app_token) {
      throw new Error('创建多维表格失败，未返回app_token');
    }

    const appToken = response.data.app.app_token;
    console.log(`✅ 多维表格创建成功: ${appToken}`);

    // 构建表格链接
    const bitableUrl = `https://feishu.cn/base/${appToken}`;
    console.log(`📊 表格链接: ${bitableUrl}`);

    return {
      appToken,
      url: bitableUrl,
      name
    };
  } catch (error) {
    console.error('创建多维表格失败:', error);
    console.error('错误详情:', error.response?.data || error.message);
    throw error;
  }
}

// 获取群组成员列表
async function getChatMembers(chatId) {
  try {
    console.log(`👥 开始获取群组成员: chatId=${chatId}`);

    // 使用正确的 API 路径
    const response = await feishuClient.im.chatMembers.get({
      path: { chat_id: chatId },
      params: {
        member_id_type: 'open_id',
        page_size: 100
      }
    });

    console.log('📊 群成员API响应:', JSON.stringify(response, null, 2));

    const members = response.data?.items || [];
    console.log(`👥 获取到 ${members.length} 个群成员`);

    // 打印成员详细信息
    members.forEach((m, i) => {
      console.log(`成员 ${i + 1}:`, JSON.stringify(m, null, 2));
    });

    return members;
  } catch (error) {
    console.error('获取群组成员失败:', error);
    console.error('错误详情:', error.response?.data || error.message);
    throw error;
  }
}

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

    // 获取聊天类型
    const chatType = messageEvent.message.chat_type; // 'p2p' 私聊 | 'group' 群聊
    const mentions = messageEvent.message.mentions || []; // @的用户列表

    console.log(`收到消息 [${chatId}] [类型: ${chatType}]: ${userMessage}`);
    console.log('📋 完整消息事件:', JSON.stringify(messageEvent, null, 2));

    // ==================== 群聊@检测 ====================
    // 如果是群聊，必须@机器人才处理消息
    if (chatType === 'group') {
      console.log(`🔍 群聊消息检测 - mentions数量: ${mentions.length}`);
      console.log('📋 mentions详情:', JSON.stringify(mentions, null, 2));

      // 检查是否@了机器人
      const botId = process.env.FEISHU_BOT_ID; // 需要在环境变量中配置机器人ID
      console.log(`🤖 配置的Bot ID: ${botId || '未配置'}`);

      // 方法1: 如果配置了机器人ID，精确匹配
      if (botId && mentions.length > 0) {
        console.log('🔍 使用精确匹配模式检测@');

        mentions.forEach((mention, index) => {
          console.log(`  mention[${index}]:`, JSON.stringify(mention, null, 2));
        });

        const isMentioned = mentions.some(mention =>
          mention.id?.user_id === botId ||
          mention.id?.open_id === botId ||
          mention.user_id === botId ||
          mention.open_id === botId
        );

        if (!isMentioned) {
          console.log('⏭️ 群聊中未@机器人，跳过处理');
          return; // 不处理未@机器人的群消息
        }

        console.log('✅ 群聊中检测到@机器人，开始处理消息');
      }
      // 方法2: 如果没有配置机器人ID，检查是否有任何@（向后兼容）
      else if (mentions.length === 0) {
        console.log('⏭️ 群聊中未@任何人，跳过处理');
        return;
      } else {
        console.log('✅ 群聊中检测到@，开始处理消息（兼容模式）');
      }
    } else {
      console.log('✅ 私聊消息，直接处理');
    }

    let reply;

    // 检测是否包含多维表格链接
    const bitableInfo = extractBitableUrl(userMessage);
    // 检测是否包含文档链接
    const docInfo = extractDocUrl(userMessage);
    // 检测是否请求群成员信息
    const requestMembers = /群成员|成员列表|有哪些人|谁在群里|查看成员|群里有谁/i.test(userMessage);
    // 检测是否请求创建文档（支持更灵活的模式）
    const requestCreateDoc = /(创建|新建|生成|写|整理成?).{0,20}(文档|doc)/i.test(userMessage);
    // 检测是否请求创建表格（支持更灵活的模式）
    const requestCreateTable = /(创建|新建|生成).{0,20}(表格|多维表格|bitable)/i.test(userMessage);

    // ==================== 新功能检测 ====================
    // 检测是否请求生成日报/周报
    const requestReport = /(生成|写|创建|帮我写).{0,10}(日报|周报|工作总结|今日总结|本周总结)/i.test(userMessage);
    const isWeeklyReport = /周报|本周|这周|一周/i.test(userMessage);
    // 检测是否查询最近文档
    const requestRecentDocs = /最近.*文档|讨论.*文档|之前.*文档|看过.*文档|文档列表/i.test(userMessage);
    // 检测是否需要表格高级处理（筛选、统计、排序、对比）
    const requestTableAdvanced = bitableInfo.found && /筛选|过滤|统计|求和|平均|排序|对比|比较|查找.*满足|多少个|总数|最大|最小|前.*名/i.test(userMessage);

    if (bitableInfo.found) {
      console.log('🔍 检测到多维表格链接');

      try {
        // 发送"正在分析"提示
        const tipText = requestTableAdvanced
          ? '📊 正在处理表格数据，请稍候...'
          : '📊 正在读取和分析表格数据，请稍候...';

        await feishuClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: tipText }),
          },
        });

        // 获取表格数据
        const bitableData = await fetchBitableData(bitableInfo.appToken, bitableInfo.tableId);

        // 根据用户需求选择处理方式
        if (requestTableAdvanced) {
          // 高级处理：筛选、统计、排序、对比
          reply = await processTableData(bitableData, userMessage);
        } else {
          // 普通分析
          reply = await analyzeBitableData(bitableData, userMessage);
        }

        // 记录到对话历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);

      } catch (error) {
        console.error('多维表格分析失败:', error);
        reply = `抱歉，分析多维表格时出现错误: ${error.message}\n\n请确保：\n1. 机器人有权限访问该表格\n2. 表格链接正确\n3. 表格包含数据`;
        // 即使出错也记录到历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);
      }
    } else if (docInfo.found) {
      console.log('🔍 检测到文档链接');

      try {
        // 发送"正在读取"提示
        await feishuClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: '📄 正在读取和分析文档内容，请稍候...' }),
          },
        });

        // 获取文档内容
        const docContent = await fetchDocContent(docInfo.documentId);

        // 分析文档内容
        reply = await analyzeDocContent(docContent, userMessage);

        // 将文档添加到缓存（用于"最近文档"查询）
        const docTitle = `文档 ${docInfo.documentId.substring(0, 8)}...`;
        const docSummary = reply.substring(0, 150);
        addDocumentToCache(chatId, docInfo.documentId, docTitle, docSummary);

        // 记录到对话历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);

      } catch (error) {
        console.error('文档分析失败:', error);
        reply = `抱歉，读取文档时出现错误: ${error.message}\n\n请确保：\n1. 机器人有权限访问该文档\n2. 文档链接正确\n3. 文档类型支持（docx/doc/docs）`;
        // 即使出错也记录到历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);
      }
    } else if (requestMembers) {
      console.log('🔍 检测到群成员查询请求');

      try {
        // 获取群组成员
        const members = await getChatMembers(chatId);

        // 格式化成员列表
        const memberList = members.map((m, index) => {
          // 尝试多个可能的名称字段
          const displayName = m.name || m.member_name || m.user_name || `用户 ${m.member_id?.slice(0, 8)}`;
          return `${index + 1}. ${displayName}`;
        }).join('\n');

        reply = `👥 当前群组成员列表（共 ${members.length} 人）：\n\n${memberList}`;

        // 记录到对话历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);

      } catch (error) {
        console.error('获取群成员失败:', error);
        reply = `抱歉，获取群成员信息时出现错误: ${error.message}\n\n请确保机器人有权限查看群成员列表。`;
        // 即使出错也记录到历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);
      }
    } else if (requestCreateDoc) {
      console.log('🔍 检测到创建文档请求');

      try {
        // 发送"正在创建"提示
        await feishuClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: '📝 正在创建文档，请稍候...' }),
          },
        });

        // 使用 Claude 生成文档标题和内容
        const claudeResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: `你是一个飞书企业 AI 助手机器人。用户请求创建文档，你需要：
1. 根据用户的描述生成合适的文档标题
2. 生成详细的文档内容
3. 返回格式必须是纯 JSON，格式: {"title": "文档标题", "content": "文档内容"}
4. 内容要专业、清晰、结构化

重要：只返回JSON对象，不要添加任何其他文字、标签或解释。`,
          messages: [
            {
              role: 'user',
              content: `用户请求: ${userMessage}\n\n请直接返回JSON格式的文档标题和内容，不要添加任何其他内容。`
            }
          ],
        });

        // 提取 JSON（如果 Claude 返回了额外内容，尝试提取）
        let responseText = claudeResponse.content[0].text.trim();

        // 如果包含 JSON 代码块标记，提取其中的内容
        if (responseText.includes('```json')) {
          const match = responseText.match(/```json\s*([\s\S]*?)\s*```/);
          if (match) responseText = match[1].trim();
        } else if (responseText.includes('```')) {
          const match = responseText.match(/```\s*([\s\S]*?)\s*```/);
          if (match) responseText = match[1].trim();
        }

        const docData = JSON.parse(responseText);

        // 创建文档
        const doc = await createFeishuDoc(docData.title, docData.content);

        // 生成内容摘要
        const contentPreview = doc.content.length > 200
          ? doc.content.substring(0, 200) + '...'
          : doc.content;

        reply = `✅ 文档创建成功！\n\n📄 文档标题: ${doc.title}\n🔗 文档链接: ${doc.url}\n\n📝 内容摘要:\n${contentPreview}\n\n💡 提示：文档已自动填充内容。`;

        // 记录到对话历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);

      } catch (error) {
        console.error('创建文档失败:', error);
        reply = `抱歉，创建文档时出现错误: ${error.message}\n\n请确保机器人有权限创建文档。`;
        // 即使出错也记录到历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);
      }
    } else if (requestCreateTable) {
      console.log('🔍 检测到创建表格请求');

      try {
        // 发送"正在创建"提示
        await feishuClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: '📊 正在创建多维表格，请稍候...' }),
          },
        });

        // 提取表格名称（如果用户指定了）
        const tableNameMatch = userMessage.match(/创建.*?["'《](.+?)["'》]|创建(.+?)表格/);
        const tableName = tableNameMatch ? (tableNameMatch[1] || tableNameMatch[2]) : '新建表格';

        // 创建多维表格
        const bitable = await createBitableApp(tableName);

        reply = `✅ 多维表格创建成功！\n\n📊 表格名称: ${bitable.name}\n🔗 表格链接: ${bitable.url}\n\n💡 提示：你可以在表格中添加数据，然后发送链接给我分析。`;

        // 记录到对话历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);

      } catch (error) {
        console.error('创建表格失败:', error);
        reply = `抱歉，创建表格时出现错误: ${error.message}\n\n请确保机器人有权限创建多维表格。`;
        // 即使出错也记录到历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);
      }
    } else if (requestReport) {
      // ==================== 新功能1: 生成日报/周报 ====================
      console.log(`🔍 检测到${isWeeklyReport ? '周报' : '日报'}生成请求`);

      try {
        // 发送"正在生成"提示
        await feishuClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: `📝 正在生成${isWeeklyReport ? '周报' : '日报'}，请稍候...` }),
          },
        });

        const reportType = isWeeklyReport ? 'weekly' : 'daily';
        reply = await generateWorkReport(chatId, reportType);

        // 记录到对话历史
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);

      } catch (error) {
        console.error('生成报告失败:', error);
        reply = `抱歉，生成报告时出现错误: ${error.message}`;
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);
      }
    } else if (requestRecentDocs) {
      // ==================== 新功能2: 查询最近文档 ====================
      console.log('🔍 检测到最近文档查询请求');

      const recentDocs = getRecentDocuments(chatId);

      if (recentDocs.length === 0) {
        reply = '📄 暂无最近讨论的文档记录。\n\n💡 提示：发送文档链接给我分析后，我会记录下来。';
      } else {
        const docList = recentDocs.map((doc, index) => {
          const timeStr = new Date(doc.time).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
          return `${index + 1}. ${doc.title}\n   📅 时间: ${timeStr}\n   📝 摘要: ${doc.summary.substring(0, 80)}...`;
        }).join('\n\n');

        reply = `📚 最近讨论的文档（共 ${recentDocs.length} 个）：\n\n${docList}\n\n💡 提示：发送文档链接可以重新分析。`;
      }

      // 记录到对话历史
      addToConversationHistory(chatId, 'user', userMessage);
      addToConversationHistory(chatId, 'assistant', reply);
    } else {
      // 检测是否请求清除对话历史
      const requestClearHistory = /清除对话|重置对话|清空历史|新对话/i.test(userMessage);

      if (requestClearHistory) {
        clearConversationHistory(chatId);
        reply = '✅ 对话历史已清除，我们可以开始新的对话了！';
      } else {
        // 普通对话 - 使用对话历史
        const history = getConversationHistory(chatId);

        // 构建消息数组：历史 + 当前消息
        const messages = [
          ...history,
          {
            role: 'user',
            content: userMessage
          }
        ];

        const claudeResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: `你是一个飞书企业 AI 助手机器人，由 Claude AI 提供支持。

你的身份和功能：
- 你运行在飞书平台上，用户通过飞书与你对话
- 你可以帮助用户回答问题、进行对话交流
- 你可以记住之前的对话内容，支持多轮对话

## 📊 数据分析能力
- **分析多维表格**：发送表格链接给我，我可以帮你分析数据、生成报告
- **阅读文档**：发送文档链接，我可以总结内容、回答文档相关问题
- **查看群成员**：询问"群成员有哪些"或"有哪些人"

## 📝 内容创建
- **创建文档**：说"创建文档"或"生成文档"，我会帮你新建飞书文档
- **创建表格**：说"创建表格"或"新建表格"，我会创建多维表格

## 📈 高级数据处理（针对表格）
- **数据筛选**：发送表格链接 + "筛选满足条件的数据"
- **数据统计**：发送表格链接 + "统计总和/平均值/数量"
- **数据排序**：发送表格链接 + "按某字段从高到低排序"
- **数据对比**：发送表格链接 + "对比分析不同数据"

## 📋 工作效率提升
- **生成日报/周报**：说"生成今日工作日报"或"生成本周工作周报"，我会基于我们的对话历史自动生成
- **查看最近文档**：说"最近讨论的文档"或"之前看过的文档"，我会列出最近分析过的文档列表

## 💬 智能对话
- **多轮对话**：我会记住我们的对话历史，你可以连续提问
- **清除历史**：说"清除对话"或"重置对话"可以开始新话题

回答风格：
- 以飞书机器人的身份回答，不要说"我不在飞书中运行"
- 简洁、专业、友好
- 如果用户问到你的功能，直接介绍你能做什么
- 使用中文回答`,
          messages: messages,
        });

        reply = claudeResponse.content[0].text;

        // 将对话添加到历史记录
        addToConversationHistory(chatId, 'user', userMessage);
        addToConversationHistory(chatId, 'assistant', reply);
      }
    }

    console.log('回复内容:', reply);

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
