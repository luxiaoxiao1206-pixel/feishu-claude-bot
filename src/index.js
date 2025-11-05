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

    // 将内容转换为 markdown 格式
    const markdown = `# ${title}\n\n${content}`;

    // 调用飞书 API 创建文档
    const response = await feishuClient.docx.document.create({
      data: {
        folder_token: '', // 空字符串表示创建在根目录
        title: title
      }
    });

    if (!response.data?.document?.document_id) {
      throw new Error('创建文档失败，未返回文档ID');
    }

    const documentId = response.data.document.document_id;
    console.log(`✅ 文档创建成功: ${documentId}`);

    // 向文档中添加内容（使用批量更新API）
    await feishuClient.docx.documentBlockChildren.create({
      path: { document_id: documentId, block_id: response.data.document.body.block_id },
      data: {
        children: [
          {
            block_type: 1, // 文本块
            text: {
              elements: [
                {
                  text_run: {
                    content: content
                  }
                }
              ]
            }
          }
        ]
      }
    });

    // 构建文档链接
    const docUrl = `https://feishu.cn/docx/${documentId}`;
    console.log(`📄 文档链接: ${docUrl}`);

    return {
      documentId,
      url: docUrl,
      title
    };
  } catch (error) {
    console.error('创建文档失败:', error);
    console.error('错误详情:', error.response?.data || error.message);
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

    console.log(`收到消息 [${chatId}]: ${userMessage}`);

    let reply;

    // 检测是否包含多维表格链接
    const bitableInfo = extractBitableUrl(userMessage);
    // 检测是否包含文档链接
    const docInfo = extractDocUrl(userMessage);
    // 检测是否请求群成员信息
    const requestMembers = /群成员|成员列表|有哪些人|谁在群里|查看成员|群里有谁/i.test(userMessage);
    // 检测是否请求创建文档
    const requestCreateDoc = /创建文档|新建文档|生成文档|帮我写一个文档|整理成文档/i.test(userMessage);
    // 检测是否请求创建表格
    const requestCreateTable = /创建表格|新建表格|生成表格|创建多维表格|新建多维表格/i.test(userMessage);

    if (bitableInfo.found) {
      console.log('🔍 检测到多维表格链接');

      try {
        // 发送"正在分析"提示
        await feishuClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: '📊 正在读取和分析表格数据，请稍候...' }),
          },
        });

        // 获取表格数据
        const bitableData = await fetchBitableData(bitableInfo.appToken, bitableInfo.tableId);

        // 分析表格数据
        reply = await analyzeBitableData(bitableData, userMessage);

      } catch (error) {
        console.error('多维表格分析失败:', error);
        reply = `抱歉，分析多维表格时出现错误: ${error.message}\n\n请确保：\n1. 机器人有权限访问该表格\n2. 表格链接正确\n3. 表格包含数据`;
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

      } catch (error) {
        console.error('文档分析失败:', error);
        reply = `抱歉，读取文档时出现错误: ${error.message}\n\n请确保：\n1. 机器人有权限访问该文档\n2. 文档链接正确\n3. 文档类型支持（docx/doc/docs）`;
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

      } catch (error) {
        console.error('获取群成员失败:', error);
        reply = `抱歉，获取群成员信息时出现错误: ${error.message}\n\n请确保机器人有权限查看群成员列表。`;
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
3. 返回格式必须是 JSON: {"title": "文档标题", "content": "文档内容"}
4. 内容要专业、清晰、结构化`,
          messages: [
            {
              role: 'user',
              content: `用户请求: ${userMessage}\n\n请生成文档的标题和内容，以JSON格式返回。`
            }
          ],
        });

        const docData = JSON.parse(claudeResponse.content[0].text);

        // 创建文档
        const doc = await createFeishuDoc(docData.title, docData.content);

        reply = `✅ 文档创建成功！\n\n📄 文档标题: ${doc.title}\n🔗 文档链接: ${doc.url}`;

      } catch (error) {
        console.error('创建文档失败:', error);
        reply = `抱歉，创建文档时出现错误: ${error.message}\n\n请确保机器人有权限创建文档。`;
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

      } catch (error) {
        console.error('创建表格失败:', error);
        reply = `抱歉，创建表格时出现错误: ${error.message}\n\n请确保机器人有权限创建多维表格。`;
      }
    } else {
      // 普通对话
      const claudeResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        system: `你是一个飞书企业 AI 助手机器人，由 Claude AI 提供支持。

你的身份和功能：
- 你运行在飞书平台上，用户通过飞书与你对话
- 你可以帮助用户回答问题、进行对话交流

📊 数据分析能力：
- ✅ 分析飞书多维表格数据（用户发送表格链接）
- ✅ 读取和分析飞书文档（用户发送文档链接）
- ✅ 查看群组成员列表（用户询问"群成员"或"有哪些人"）

📝 创建能力：
- ✅ 创建飞书文档（用户说"创建文档"或"生成文档"）
- ✅ 创建多维表格（用户说"创建表格"或"新建表格"）

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

      reply = claudeResponse.content[0].text;
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
