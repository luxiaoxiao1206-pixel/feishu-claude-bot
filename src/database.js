import pkg from 'pg';
const { Pool } = pkg;

// PostgreSQL连接池
let pool = null;

// 初始化数据库连接
export async function initDatabase() {
  try {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      console.log('⚠️  DATABASE_URL未配置，将使用内存存储（数据会在重启后丢失）');
      return false;
    }

    pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false // Render PostgreSQL需要SSL
      },
      max: 20, // 最大连接数
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // 测试连接
    const client = await pool.connect();
    console.log('✅ PostgreSQL数据库连接成功');
    client.release();

    // 创建表结构
    await createTables();
    console.log('✅ 数据库表结构初始化完成');

    return true;
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
    console.log('⚠️  将使用内存存储（数据会在重启后丢失）');
    return false;
  }
}

// 创建数据库表结构
async function createTables() {
  const queries = [
    // 对话历史表
    `CREATE TABLE IF NOT EXISTS conversation_history (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      content TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_chat_id ON conversation_history(chat_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_timestamp ON conversation_history(timestamp)`,

    // 文件缓存表
    `CREATE TABLE IF NOT EXISTS file_cache (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      message_id VARCHAR(255) NOT NULL,
      file_type VARCHAR(100) NOT NULL,
      file_name TEXT NOT NULL,
      sender_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_file_cache_chat_id ON file_cache(chat_id)`,
    `CREATE INDEX IF NOT EXISTS idx_file_cache_created_at ON file_cache(created_at)`,

    // 文档缓存表
    `CREATE TABLE IF NOT EXISTS document_cache (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      doc_url TEXT NOT NULL,
      doc_title VARCHAR(500),
      doc_type VARCHAR(50),
      content TEXT,
      accessed_count INT DEFAULT 1,
      last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, doc_url)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_document_cache_chat_id ON document_cache(chat_id)`,
    `CREATE INDEX IF NOT EXISTS idx_document_cache_last_accessed ON document_cache(last_accessed)`
  ];

  for (const query of queries) {
    await pool.query(query);
  }
}

// ==================== 对话历史管理 ====================

export async function saveConversationMessage(chatId, role, content) {
  if (!pool) return false;

  try {
    const timestamp = Date.now();
    await pool.query(
      'INSERT INTO conversation_history (chat_id, role, content, timestamp) VALUES ($1, $2, $3, $4)',
      [chatId, role, content, timestamp]
    );
    return true;
  } catch (error) {
    console.error('保存对话消息失败:', error);
    return false;
  }
}

export async function getConversationHistory(chatId, limit = 100) {
  if (!pool) return [];

  try {
    const result = await pool.query(
      'SELECT role, content, timestamp FROM conversation_history WHERE chat_id = $1 ORDER BY timestamp DESC LIMIT $2',
      [chatId, limit]
    );

    // 按时间正序返回
    return result.rows.reverse().map(row => ({
      role: row.role,
      content: row.content
    }));
  } catch (error) {
    console.error('获取对话历史失败:', error);
    return [];
  }
}

export async function clearConversationHistory(chatId) {
  if (!pool) return false;

  try {
    await pool.query('DELETE FROM conversation_history WHERE chat_id = $1', [chatId]);
    return true;
  } catch (error) {
    console.error('清除对话历史失败:', error);
    return false;
  }
}

// ==================== 文件缓存管理 ====================

export async function saveFileToCache(chatId, fileInfo) {
  if (!pool) return false;

  try {
    await pool.query(
      'INSERT INTO file_cache (chat_id, message_id, file_type, file_name, sender_id) VALUES ($1, $2, $3, $4, $5)',
      [chatId, fileInfo.messageId, fileInfo.type, fileInfo.name, fileInfo.sender]
    );
    return true;
  } catch (error) {
    console.error('保存文件缓存失败:', error);
    return false;
  }
}

export async function getCachedFiles(chatId, limit = 100) {
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT message_id as "messageId", file_type as type, file_name as name,
              sender_id as sender, created_at as time
       FROM file_cache
       WHERE chat_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [chatId, limit]
    );

    return result.rows.map(row => ({
      messageId: row.messageId,
      type: row.type,
      name: row.name,
      sender: row.sender,
      time: new Date(row.time).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      })
    }));
  } catch (error) {
    console.error('获取文件缓存失败:', error);
    return [];
  }
}

// ==================== 文档缓存管理 ====================

export async function saveDocumentToCache(chatId, docUrl, docInfo) {
  if (!pool) return false;

  try {
    await pool.query(
      `INSERT INTO document_cache (chat_id, doc_url, doc_title, doc_type, content)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chat_id, doc_url)
       DO UPDATE SET
         accessed_count = document_cache.accessed_count + 1,
         last_accessed = CURRENT_TIMESTAMP`,
      [chatId, docUrl, docInfo.title, docInfo.type, docInfo.content]
    );
    return true;
  } catch (error) {
    console.error('保存文档缓存失败:', error);
    return false;
  }
}

export async function getDocumentFromCache(chatId, docUrl) {
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT doc_title as title, doc_type as type, content, accessed_count, last_accessed
       FROM document_cache
       WHERE chat_id = $1 AND doc_url = $2`,
      [chatId, docUrl]
    );

    if (result.rows.length === 0) return null;

    return result.rows[0];
  } catch (error) {
    console.error('获取文档缓存失败:', error);
    return null;
  }
}

export async function getRecentDocuments(chatId, limit = 20) {
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT doc_url as url, doc_title as title, doc_type as type,
              accessed_count as count, last_accessed as time
       FROM document_cache
       WHERE chat_id = $1
       ORDER BY last_accessed DESC
       LIMIT $2`,
      [chatId, limit]
    );

    return result.rows.map(row => ({
      url: row.url,
      title: row.title,
      type: row.type,
      accessCount: row.count,
      lastAccess: new Date(row.time).toLocaleString('zh-CN')
    }));
  } catch (error) {
    console.error('获取最近文档失败:', error);
    return [];
  }
}

// ==================== 统计信息 ====================

export async function getDatabaseStats() {
  if (!pool) return null;

  try {
    const [conversations, files, documents] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM conversation_history'),
      pool.query('SELECT COUNT(*) as count FROM file_cache'),
      pool.query('SELECT COUNT(*) as count FROM document_cache')
    ]);

    return {
      conversationMessages: parseInt(conversations.rows[0].count),
      cachedFiles: parseInt(files.rows[0].count),
      cachedDocuments: parseInt(documents.rows[0].count)
    };
  } catch (error) {
    console.error('获取数据库统计失败:', error);
    return null;
  }
}

// 关闭数据库连接
export async function closeDatabase() {
  if (pool) {
    await pool.end();
    console.log('✅ 数据库连接已关闭');
  }
}
