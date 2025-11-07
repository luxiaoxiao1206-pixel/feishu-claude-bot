import express from 'express';
import dotenv from 'dotenv';
import * as lark from '@larksuiteoapi/node-sdk';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

// 🔍 环境变量诊断日志
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔍 环境变量检查:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('FEISHU_APP_ID:', process.env.FEISHU_APP_ID ? '✅ 已配置' : '❌ 未配置');
console.log('FEISHU_APP_SECRET:', process.env.FEISHU_APP_SECRET ? '✅ 已配置' : '❌ 未配置');
console.log('FEISHU_ENCRYPT_KEY:', process.env.FEISHU_ENCRYPT_KEY ? '✅ 已配置' : '⚠️  未配置（可选）');
console.log('CLAUDE_API_KEY:', process.env.CLAUDE_API_KEY ? '✅ 已配置' : '❌ 未配置');
console.log('PORT:', process.env.PORT || '3000');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 初始化飞书客户端
const feishuClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Lark, // 使用国际版 Lark (larksuite.com)
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

// 文件缓存存储 - 记录群聊中的文件
// key: chatId, value: [{type, name, time, sender, messageId}]
const fileCache = new Map();

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

  // 保留最近100轮对话（200条消息）
  // Claude Opus 4.1 支持200K tokens上下文窗口，足够处理长对话
  const MAX_MESSAGES = 200;
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

// ==================== 文件缓存管理 ====================

// 添加文件到缓存
function addFileToCache(chatId, fileInfo) {
  if (!fileCache.has(chatId)) {
    fileCache.set(chatId, []);
  }
  const files = fileCache.get(chatId);

  // 添加新文件到开头（最新的在前面）
  files.unshift(fileInfo);

  // 只保留最近100个文件
  if (files.length > 100) {
    files.pop();
  }

  console.log(`📁 [${chatId}] 文件已缓存: ${fileInfo.name} (类型: ${fileInfo.type})`);
}

// 获取缓存的文件列表
function getCachedFiles(chatId) {
  return fileCache.get(chatId) || [];
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
      model: 'claude-opus-4-1-20250805',
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
      model: 'claude-opus-4-1-20250805',
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
      model: 'claude-opus-4-1-20250805',
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
      model: 'claude-opus-4-1-20250805',
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

// 创建飞书文档并填充内容
async function createFeishuDoc(title, content, userId) {
  try {
    console.log(`📝 开始创建文档: ${title}`);

    // 步骤1: 创建空文档
    const createResponse = await feishuClient.docx.document.create({
      data: {
        title: title
      }
    });

    console.log('📊 创建文档API响应:', JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data?.document?.document_id) {
      throw new Error('创建文档失败，未返回文档ID');
    }

    const documentId = createResponse.data.document.document_id;
    const documentUrl = createResponse.data.document.url; // SDK 可能返回完整 URL
    console.log(`✅ 文档创建成功: ${documentId}`);
    console.log(`📊 SDK返回的URL: ${documentUrl}`);

    // 步骤2: 尝试填充内容
    let contentFilled = false;
    try {
      console.log('✍️ 尝试填充文档内容...');

      // 等待文档初始化
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 将内容分段
      const lines = content.split('\n').filter(line => line.trim());
      console.log(`📝 准备添加 ${lines.length} 行内容`);

      // 飞书API限制：单次最多添加500个块，我们分批处理
      const BATCH_SIZE = 500;
      const totalBatches = Math.ceil(lines.length / BATCH_SIZE);

      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const start = batchIndex * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, lines.length);
        const batchLines = lines.slice(start, end);

        console.log(`📄 填充批次 ${batchIndex + 1}/${totalBatches}: ${batchLines.length} 行 (${start + 1}-${end})`);

        // 构建块数组 - 使用最简单的文本块结构
        const blocks = batchLines.map(line => ({
          block_type: 2,
          text: {
            style: {},
            elements: [{
              text_run: {
                content: line,
                text_element_style: {}
              }
            }]
          }
        }));

        // 添加内容到文档
        await feishuClient.docx.documentBlockChildren.create({
          path: {
            document_id: documentId,
            block_id: documentId
          },
          data: {
            children: blocks,
            index: start  // 指定插入位置
          }
        });

        // 批次间添加短暂延迟，避免API限流
        if (batchIndex < totalBatches - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log(`✅ 内容填充成功 - 共 ${lines.length} 行，${totalBatches} 个批次`);
      contentFilled = true;

    } catch (contentError) {
      console.warn('⚠️ 自动填充内容失败:', contentError.message);
      console.log('💡 文档已创建，但内容需要手动填写');
    }

    // 使用 SDK 返回的 URL，如果没有则构建国际版Lark链接
    const docUrl = documentUrl || `https://larksuite.com/docx/${documentId}`;
    console.log(`📄 最终使用的文档链接: ${docUrl}`);

    // 步骤3: 添加用户为协作者（让文档出现在用户的云空间）
    if (userId) {
      try {
        console.log(`👥 正在添加用户 ${userId} 为协作者...`);
        await feishuClient.drive.permissionMember.create({
          path: { token: documentId },
          params: {
            type: 'docx',
            need_notification: false
          },
          data: {
            member_type: 'openid',
            member_id: userId,
            perm: 'edit'  // 编辑权限
          }
        });
        console.log('✅ 协作权限添加成功');
      } catch (permError) {
        console.error('⚠️ 添加协作权限失败:', permError);
        console.error('详细错误:', permError.response?.data);
        // 不影响文档创建，只是权限添加失败
      }
    }

    return {
      documentId,
      url: docUrl,
      title,
      contentFilled,
      content: content
    };
  } catch (error) {
    console.error('创建文档失败:', error);
    console.error('错误详情:', error.response?.data || error.message);
    throw error;
  }
}

// 创建多维表格（增强版：支持自动填充数据）
async function createBitableApp(name, userRequest = '', userId = null) {
  try {
    console.log(`📊 开始创建多维表格: ${name}`);
    console.log(`📝 用户需求: ${userRequest}`);

    // 第1步：使用Claude生成表格结构和数据
    console.log('🤖 正在生成表格结构和数据...');
    const structureResponse = await anthropic.messages.create({
      model: 'claude-opus-4-1-20250805',
      max_tokens: 4096,
      system: `你是飞书表格结构设计助手。根据用户需求设计表格结构并生成示例数据。

返回格式（必须是有效JSON）：
{
  "tableName": "表格名称",
  "fields": [
    {"field_name": "字段1", "type": 1, "ui_type": "Text"},
    {"field_name": "字段2", "type": 2, "ui_type": "Number"},
    {
      "field_name": "字段3",
      "type": 3,
      "ui_type": "SingleSelect",
      "property": {
        "options": [
          {"name": "选项A"},
          {"name": "选项B"},
          {"name": "选项C"}
        ]
      }
    }
  ],
  "records": [
    {"字段1": "值1", "字段2": 123, "字段3": "选项A"},
    {"字段1": "值2", "字段2": 456, "字段3": "选项B"}
  ]
}

字段类型说明（type 和 ui_type 必须对应）：
- type: 1, ui_type: "Text" (多行文本) - 无需property
- type: 2, ui_type: "Number" (数字) - 无需property
- type: 3, ui_type: "SingleSelect" (单选) - 需要property.options数组
- type: 5, ui_type: "DateTime" (日期) - 无需property

规则：
1. 第一个字段必须是多行文本类型（type: 1, ui_type: "Text"）作为主字段
2. 至少设计3个字段，最多8个字段
3. 生成3-5条示例数据
4. 字段必须包含 field_name、type、ui_type 属性
5. 单选字段(SingleSelect)必须包含 property.options 数组，每个选项只需 name 属性
6. records中的key使用字段的中文名称（不带field_name前缀）
7. 只返回JSON，不要其他内容`,
      messages: [{
        role: 'user',
        content: `用户需求：${userRequest || name}\n\n请设计表格结构并生成示例数据（只返回JSON）：`
      }]
    });

    let tableStructure;
    try {
      let jsonText = structureResponse.content[0].text.trim();
      // 提取JSON（如果有代码块）
      if (jsonText.includes('```json')) {
        const match = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
        if (match) jsonText = match[1].trim();
      } else if (jsonText.includes('```')) {
        const match = jsonText.match(/```\s*([\s\S]*?)\s*```/);
        if (match) jsonText = match[1].trim();
      }
      tableStructure = JSON.parse(jsonText);
      console.log('✅ 表格结构生成成功:', JSON.stringify(tableStructure, null, 2));
    } catch (parseError) {
      console.error('❌ JSON解析失败:', parseError);
      console.log('原始响应:', structureResponse.content[0].text);
      throw new Error('生成表格结构失败，JSON格式错误');
    }

    // 第2步：创建 Base App
    const appResponse = await feishuClient.bitable.app.create({
      data: {
        name: tableStructure.tableName || name,
        folder_token: ''
      }
    });

    if (!appResponse.data?.app?.app_token) {
      throw new Error('创建多维表格失败，未返回app_token');
    }

    const appToken = appResponse.data.app.app_token;
    const appUrl = appResponse.data.app.url; // SDK 可能返回完整 URL
    console.log(`✅ Base App创建成功: ${appToken}`);
    console.log(`📊 SDK返回的表格URL: ${appUrl}`);

    // 第3步：创建表格和字段
    const tableResponse = await feishuClient.bitable.appTable.create({
      path: { app_token: appToken },
      data: {
        table: {
          name: tableStructure.tableName || name,
          default_view_name: '表格视图',
          fields: tableStructure.fields
        }
      }
    });

    const tableId = tableResponse.data?.table_id;
    if (!tableId) {
      throw new Error('创建表格失败，未返回table_id');
    }
    console.log(`✅ 表格创建成功: ${tableId}`);

    // 第4步：添加数据记录
    if (tableStructure.records && tableStructure.records.length > 0) {
      console.log(`📝 开始添加 ${tableStructure.records.length} 条记录...`);

      for (const record of tableStructure.records) {
        try {
          await feishuClient.bitable.appTableRecord.create({
            path: { app_token: appToken, table_id: tableId },
            data: { fields: record }
          });
          console.log('✅ 记录添加成功');
        } catch (recordError) {
          console.error('⚠️ 添加记录失败:', recordError.message);
        }
      }
    }

    // 使用 SDK 返回的 URL，如果没有则构建国际版Lark链接
    const bitableUrl = appUrl || `https://larksuite.com/base/${appToken}`;
    console.log(`📄 最终使用的表格链接: ${bitableUrl}`);
    console.log(`🎉 表格创建并填充完成`);

    // 添加用户为协作者（让表格出现在用户的云空间）
    if (userId) {
      try {
        console.log(`👥 正在添加用户 ${userId} 为协作者...`);
        await feishuClient.drive.permissionMember.create({
          path: { token: appToken },
          params: {
            type: 'bitable',
            need_notification: false
          },
          data: {
            member_type: 'openid',
            member_id: userId,
            perm: 'edit'  // 编辑权限
          }
        });
        console.log('✅ 协作权限添加成功');
      } catch (permError) {
        console.error('⚠️ 添加协作权限失败:', permError);
        console.error('详细错误:', permError.response?.data);
        // 不影响表格创建，只是权限添加失败
      }
    }

    return {
      appToken,
      tableId,
      url: bitableUrl,
      name: tableStructure.tableName || name,
      fieldsCount: tableStructure.fields.length,
      recordsCount: tableStructure.records.length
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

// 根据文件名识别文件类型
function getFileType(fileName) {
  if (!fileName) return '其他文件';

  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

  if (!ext) return '其他文件';

  // 文档类
  if (['doc', 'docx'].includes(ext)) return 'Word文档';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'Excel表格';
  if (['ppt', 'pptx'].includes(ext)) return 'PPT演示';
  if (['pdf'].includes(ext)) return 'PDF文档';
  if (['txt', 'md', 'log'].includes(ext)) return '文本文件';

  // 图片类
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) return '图片';

  // 视频类
  if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'].includes(ext)) return '视频';

  // 音频类
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'wma', 'ogg'].includes(ext)) return '音频';

  // 压缩包
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '压缩包';

  // 代码文件
  if (['js', 'ts', 'py', 'java', 'cpp', 'c', 'html', 'css', 'json', 'xml'].includes(ext)) return '代码文件';

  return '其他文件';
}

// 获取群聊历史消息中的文件列表
async function getChatFiles(chatId, limit = 50) {
  try {
    console.log(`📁 开始获取群文件列表: chatId=${chatId}, limit=${limit}`);

    const files = [];
    let pageToken = undefined;
    let fetchedCount = 0;

    // 最多获取指定数量的消息
    while (fetchedCount < limit) {
      console.log(`🔍 正在请求消息列表，page_size=${Math.min(50, limit - fetchedCount)}, page_token=${pageToken || '(首页)'}`);

      let response;
      try {
        response = await feishuClient.im.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            page_size: Math.min(50, limit - fetchedCount),
            ...(pageToken && { page_token: pageToken })
          }
        });
      } catch (apiError) {
        console.error('❌ API调用失败:', apiError);
        console.error('错误响应:', JSON.stringify(apiError.response?.data || apiError.message, null, 2));
        throw new Error(`获取消息列表失败: ${apiError.response?.data?.msg || apiError.message}`);
      }

      console.log('📊 API响应状态:', response.code, response.msg);

      const messages = response.data?.items || [];
      console.log(`📨 获取到 ${messages.length} 条消息`);

      // 筛选包含文件的消息
      for (const msg of messages) {
        const msgType = msg.msg_type;
        const createTime = new Date(parseInt(msg.create_time)).toLocaleString('zh-CN');

        // 解析消息内容
        let content = {};
        try {
          content = JSON.parse(msg.body?.content || '{}');
        } catch (e) {
          console.log('解析消息内容失败:', e.message);
        }

        // 根据消息类型提取文件信息
        if (msgType === 'file') {
          const fileName = content.file_name || '未命名文件';
          files.push({
            type: getFileType(fileName), // 使用智能识别
            name: fileName,
            time: createTime,
            sender: msg.sender?.sender_id?.open_id || '未知'
          });
        } else if (msgType === 'image') {
          files.push({
            type: '图片',
            name: content.image_key ? `图片_${content.image_key.slice(0, 8)}` : '图片',
            time: createTime,
            sender: msg.sender?.sender_id?.open_id || '未知'
          });
        } else if (msgType === 'media') {
          const fileName = content.file_name || '媒体文件';
          files.push({
            type: getFileType(fileName), // 使用智能识别
            name: fileName,
            time: createTime,
            sender: msg.sender?.sender_id?.open_id || '未知'
          });
        }
      }

      fetchedCount += messages.length;

      // 检查是否还有更多消息
      if (!response.data?.has_more || !response.data?.page_token) {
        break;
      }
      pageToken = response.data.page_token;
    }

    console.log(`📁 共找到 ${files.length} 个文件`);
    return files;
  } catch (error) {
    console.error('获取群文件列表失败:', error);
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
    const senderId = messageEvent.sender.sender_id.open_id || messageEvent.sender.sender_id.user_id;
    const msgType = messageEvent.message.msg_type; // 消息类型：text, file, image, media等

    // 🔍 调试日志：打印消息类型和内容结构
    console.log(`\n========== 收到消息 [${messageId}] ==========`);
    console.log(`📝 消息类型 (msg_type): "${msgType}"`);
    console.log(`💬 聊天ID: ${chatId}`);
    console.log(`👤 发送者: ${senderId}`);
    console.log(`📦 完整消息体:`, JSON.stringify(messageEvent.message, null, 2));

    // 获取聊天类型和@列表
    const chatType = messageEvent.message.chat_type; // 'p2p' 私聊 | 'group' 群聊
    const mentions = messageEvent.message.mentions || []; // @的用户列表

    // 解析消息内容
    const content = JSON.parse(messageEvent.message.content);

    // ==================== 文件消息自动记录 ====================
    // 如果是文件/图片/视频等，自动记录到缓存（不需要@机器人）
    console.log(`🔍 检查是否为文件消息: msgType="${msgType}"`);
    if (msgType === 'file' || msgType === 'image' || msgType === 'media') {
      console.log(`✅ 检测到文件类型消息！开始记录...`);
      const createTime = new Date().toLocaleString('zh-CN');
      let fileInfo = {
        messageId,
        time: createTime,
        sender: senderId
      };

      if (msgType === 'file') {
        const fileName = content.file_name || '未命名文件';
        fileInfo.type = getFileType(fileName);
        fileInfo.name = fileName;
      } else if (msgType === 'image') {
        fileInfo.type = '图片';
        fileInfo.name = content.image_key ? `图片_${content.image_key.slice(0, 8)}` : '图片';
      } else if (msgType === 'media') {
        const fileName = content.file_name || '媒体文件';
        fileInfo.type = getFileType(fileName);
        fileInfo.name = fileName;
      }

      // 添加到文件缓存
      addFileToCache(chatId, fileInfo);
      console.log(`✅ 文件已自动记录: ${fileInfo.name} [${fileInfo.type}]`);
      return; // 文件消息处理完毕，不继续处理
    }

    // ==================== 文本消息处理 ====================
    const rawMessage = content.text || '';

    // 只处理文本消息，忽略其他未知类型
    if (!rawMessage) {
      console.log(`⏭️ 跳过非文本消息（content中无text字段）`);
      return;
    }

    console.log(`收到原始消息 [${chatId}] [类型: ${chatType}]: "${rawMessage}"`);

    // ==================== 引用消息检测 ====================
    // 检查是否引用了之前的消息（飞书的"回复"功能）
    let quotedMessage = null;
    const parentId = messageEvent.message.parent_id;

    if (parentId) {
      console.log(`📌 检测到引用消息，parent_id: ${parentId}`);
      try {
        // 获取被引用的消息内容
        const parentMessageResponse = await feishuClient.im.message.get({
          path: { message_id: parentId },
        });

        if (parentMessageResponse.data?.message) {
          const parentContent = JSON.parse(parentMessageResponse.data.message.content);
          quotedMessage = parentContent.text || '';
          console.log(`✅ 成功获取引用消息内容: "${quotedMessage.substring(0, 100)}..."`);
        }
      } catch (error) {
        console.error('❌ 获取引用消息失败:', error.message);
        // 继续处理，即使无法获取引用消息
      }
    }

    // ==================== 群聊@检测 ====================
    // 如果是群聊，必须@机器人才处理消息（在清理消息之前检查）
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

        // 增强检测逻辑：支持多种匹配方式
        const isMentioned = mentions.some(mention => {
          // 方式1: 直接匹配各种ID字段
          const idMatch =
            mention.id?.user_id === botId ||
            mention.id?.open_id === botId ||
            mention.user_id === botId ||
            mention.open_id === botId;

          // 方式2: 检查是否@的是机器人（通过key判断）
          const isBot = mention.key === '@_user_1' || mention.key?.includes('_user_');

          // 方式3: 如果配置的是App ID (cli_开头)，则认为@了任何机器人都算
          const isAppId = botId.startsWith('cli_');

          console.log(`    检测结果: idMatch=${idMatch}, isBot=${isBot}, isAppId=${isAppId}`);

          return idMatch || (isAppId && isBot);
        });

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

    // 清理消息：移除@机器人产生的标记（如 @_user_1、_user_1 等）
    let userMessage = rawMessage
      .replace(/@_user_\d+/g, '')  // 移除 @_user_1 这样的标记
      .replace(/_user_\d+/g, '')   // 移除单独的 _user_1
      .replace(/\s+/g, ' ')        // 合并多个空格
      .trim();

    console.log(`清理后的消息: "${userMessage}"`);

    // 如果清理后消息为空，但用户@了机器人，给出友好提示
    if (!userMessage || userMessage.length === 0) {
      console.log('⚠️ 消息内容为空');
      reply = '你好！有什么我可以帮助你的吗？😊';

      await feishuClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: reply }),
        },
      });
      return;
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
    // 检测是否请求汇总群文件
    const requestFileList = /汇总.*文件|分类.*文件|整理.*文件|群.*文件|发过.*文件|历史.*文件|文件列表|文件清单/i.test(userMessage);
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

        // 使用 Claude 生成文档标题和内容（改用简单分隔符格式）
        const claudeResponse = await anthropic.messages.create({
          model: 'claude-opus-4-1-20250805',
          max_tokens: 4096,
          system: `你是一个飞书企业 AI 助手机器人。用户请求创建文档，你需要：
1. 根据用户的描述生成合适的文档标题
2. 生成详细的文档内容
3. 内容要专业、清晰、结构化

返回格式（使用简单分隔符）：
===TITLE===
文档标题
===CONTENT===
文档的详细内容

重要：严格按照上述格式返回，标题和内容之间用 ===TITLE=== 和 ===CONTENT=== 分隔。`,
          messages: [
            {
              role: 'user',
              content: `用户请求: ${userMessage}\n\n请按照格式返回文档标题和内容。`
            }
          ],
        });

        // 提取标题和内容
        let responseText = claudeResponse.content[0].text.trim();
        console.log('📄 Claude原始响应长度:', responseText.length);
        console.log('📄 响应开头:', responseText.substring(0, 200));

        // 使用分隔符提取标题和内容
        const titleMatch = responseText.match(/===TITLE===\s*([\s\S]*?)\s*===CONTENT===/);
        const contentMatch = responseText.match(/===CONTENT===\s*([\s\S]*?)$/);

        if (!titleMatch || !contentMatch) {
          console.error('❌ 无法提取标题或内容');
          console.error('📄 完整响应:', responseText.substring(0, 500));
          throw new Error('文档内容格式解析失败，请重新描述您的需求');
        }

        const docData = {
          title: titleMatch[1].trim(),
          content: contentMatch[1].trim()
        };

        console.log('✅ 提取成功 - 标题:', docData.title);
        console.log('✅ 提取成功 - 内容长度:', docData.content.length);

        // 验证必需字段
        if (!docData.title || !docData.content) {
          throw new Error('文档数据不完整，缺少标题或内容');
        }

        // 创建文档（传入用户ID以添加协作权限）
        const doc = await createFeishuDoc(docData.title, docData.content, senderId);

        // 根据是否成功填充内容显示不同的消息
        if (doc.contentFilled) {
          // 内容已自动填充
          const contentPreview = doc.content.substring(0, 300);
          reply = `✅ 文档创建成功！内容已自动填充。\n\n📄 文档标题: ${doc.title}\n🔗 文档链接: ${doc.url}\n\n📝 内容预览:\n${contentPreview}${doc.content.length > 300 ? '...' : ''}\n\n💡 提示：点击链接查看完整文档。`;
        } else {
          // 内容未能自动填充，提供手动填写指引
          const contentPreview = doc.content.substring(0, 200);
          reply = `✅ 文档创建成功！\n\n📄 文档标题: ${doc.title}\n🔗 文档链接: ${doc.url}\n\n⚠️ 自动填充内容失败，请手动复制以下内容到文档中：\n\n📝 内容预览:\n${contentPreview}${doc.content.length > 200 ? '...' : ''}\n\n💡 完整内容已生成，请复制下方内容填入文档：\n\n${doc.content}`;
        }

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

        // 创建多维表格（传入完整用户需求和用户ID以添加协作权限）
        const bitable = await createBitableApp(tableName, userMessage, senderId);

        reply = `✅ 多维表格创建成功并已自动填充数据！\n\n📊 表格名称: ${bitable.name}\n🔗 表格链接: ${bitable.url}\n📋 字段数量: ${bitable.fieldsCount}\n📝 数据记录: ${bitable.recordsCount} 条\n\n💡 提示：表格已包含示例数据，你可以直接查看或继续添加。`;

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
    } else if (requestFileList) {
      // ==================== 新功能3: 汇总群文件（使用缓存） ====================
      console.log('📁 检测到群文件汇总请求');

      // 获取缓存的文件列表（无需API调用，即时返回）
      const files = getCachedFiles(chatId);

      if (files.length === 0) {
        reply = '📁 暂无文件记录。\n\n💡 提示：从现在开始，我会自动记录群里发送的所有文件（不需要@我）。发送文件后再试试"汇总文件"吧！';
      } else {
        // 按类型分类
        const filesByType = {};
        files.forEach(file => {
          if (!filesByType[file.type]) {
            filesByType[file.type] = [];
          }
          filesByType[file.type].push(file);
        });

        // 生成分类清单
        let fileList = `📁 群文件汇总（共 ${files.length} 个文件）：\n\n`;

        Object.keys(filesByType).forEach(type => {
          const typeFiles = filesByType[type];
          fileList += `\n### ${type}（${typeFiles.length}个）\n`;
          typeFiles.slice(0, 20).forEach((file, index) => {
            fileList += `${index + 1}. ${file.name}\n   ⏰ ${file.time}\n`;
          });
          if (typeFiles.length > 20) {
            fileList += `   ... 还有 ${typeFiles.length - 20} 个${type}\n`;
          }
        });

        fileList += '\n\n💡 提示：我会自动记录群里的所有文件（无需@我），最多保留最近100个文件。';
        reply = fileList;
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

        // 如果有引用消息，将其添加到用户消息中作为上下文
        let finalUserMessage = userMessage;
        if (quotedMessage) {
          finalUserMessage = `【用户引用了之前的消息】
引用内容："""
${quotedMessage}
"""

用户当前的问题：${userMessage}`;
          console.log(`📝 已将引用消息添加到上下文中`);
        }

        // 构建消息数组：历史 + 当前消息
        const messages = [
          ...history,
          {
            role: 'user',
            content: finalUserMessage
          }
        ];

        const claudeResponse = await anthropic.messages.create({
          model: 'claude-opus-4-1-20250805',
          max_tokens: 4096,
          system: `你是一个运行在飞书平台上的 AI 助手，基于 Claude Opus 4.1 模型。

核心能力：
- 回答各类问题、提供信息和建议
- 分析和处理飞书文档、多维表格
- 进行多轮对话，记住上下文（最多100轮）
- 创建飞书文档和表格
- 生成工作报告

回答原则：
- 直接、准确、有帮助
- 如果不确定，诚实说明
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
