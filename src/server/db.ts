import { Pool } from 'pg';

// Support DATABASE_URL for Neon PostgreSQL (e.g. postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require)
let rawConnectionString = (process.env.DATABASE_URL || '').trim();

let pool: Pool | null = null;
let isNeonConnected = false;
let connectionErrorMessage: string | null = null;
let isPlaceholder = false;

// Check if user set the example placeholder from .env.example
if (
  rawConnectionString &&
  (rawConnectionString.includes('endpoint.neon.tech') ||
   rawConnectionString.includes('user:password@') ||
   rawConnectionString.includes('ep-example'))
) {
  isPlaceholder = true;
  connectionErrorMessage = 'DATABASE_URL đang sử dụng tên miền ví dụ ("endpoint.neon.tech"). Vui lòng vào console.neon.tech, copy chuỗi kết nối thực tế của dự án bạn và cập nhật vào biến môi trường trên Render.';
  console.warn('⚠️ [Neon DB] CẢNH BÁO CẤU HÌNH:');
  console.warn('   DATABASE_URL trên máy chủ đang chứa hostname mẫu ("endpoint.neon.tech").');
  console.warn('   -> Hãy vào https://console.neon.tech -> Copy Connection String thật (ví dụ: postgresql://neondb_owner:***@ep-xyz.aws.neon.tech/neondb?sslmode=require)');
  console.warn('   -> Cập nhật vào mục Environment của Render Web Service.');
  console.warn('   -> Ứng dụng hiện đang chạy an toàn bằng bộ lưu trữ bộ nhớ (in-memory) để đảm bảo không bị gián đoạn!');
} else if (rawConnectionString) {
  try {
    // Format connection string with uselibpqcompat to suppress node-pg warning:
    // "SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'"
    let cleanUrl = rawConnectionString;
    if (cleanUrl.includes('sslmode=require') && !cleanUrl.includes('uselibpqcompat')) {
      cleanUrl += cleanUrl.includes('?') ? '&uselibpqcompat=true' : '?uselibpqcompat=true';
    }

    pool = new Pool({
      connectionString: cleanUrl,
      ssl: {
        rejectUnauthorized: false
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 7000
    });
  } catch (err: any) {
    console.error('Failed to initialize Neon PostgreSQL pool:', err);
    connectionErrorMessage = err.message || 'Database initialization error';
  }
} else {
  connectionErrorMessage = 'DATABASE_URL chưa được thiết lập. Ứng dụng đang hoạt động bằng bộ nhớ cục bộ. Thêm DATABASE_URL để kết nối Neon PostgreSQL.';
}

export async function initDatabase() {
  if (isPlaceholder) {
    console.log('[Neon DB] Bỏ qua kết nối Neon vì hostname là placeholder ví dụ. Đang chạy fallback an toàn.');
    return false;
  }

  if (!pool) {
    console.log('[Neon DB] No DATABASE_URL provided. App running with local fallback.');
    return false;
  }

  try {
    const client = await pool.connect();
    try {
      console.log('[Neon DB] Successfully connected to Neon PostgreSQL. Initializing tables...');

      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          uid VARCHAR(128) PRIMARY KEY,
          email VARCHAR(255),
          display_name VARCHAR(255) NOT NULL,
          custom_class_name VARCHAR(50),
          base_grade INT DEFAULT 10,
          registered_academic_year INT DEFAULT 2026,
          friend_code VARCHAR(50) UNIQUE,
          role VARCHAR(20) DEFAULT 'STUDENT',
          selected_grade INT DEFAULT 10,
          level INT DEFAULT 1,
          xp INT DEFAULT 0,
          highest_score INT DEFAULT 0,
          monthly_score INT DEFAULT 0,
          last_score_month_key VARCHAR(20),
          streak_days INT DEFAULT 1,
          avatar_color VARCHAR(30),
          status VARCHAR(255),
          pin VARCHAR(100),
          approval_status VARCHAR(30) DEFAULT 'APPROVED',
          rejection_reason TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Safe migrations for existing users table
        ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) DEFAULT 'APPROVED';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

        CREATE TABLE IF NOT EXISTS assignments (
          id VARCHAR(128) PRIMARY KEY,
          teacher_uid VARCHAR(128),
          teacher_name VARCHAR(255),
          grade INT,
          title VARCHAR(255),
          description TEXT,
          questions JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS custom_words (
          id VARCHAR(128) PRIMARY KEY,
          word VARCHAR(100) NOT NULL,
          ipa VARCHAR(100),
          meaning TEXT NOT NULL,
          example TEXT,
          grade INT,
          unit_id VARCHAR(100),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS custom_grammar (
          id VARCHAR(128) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          grade INT,
          structure TEXT,
          usage TEXT,
          example TEXT,
          exercise JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS friends (
          id SERIAL PRIMARY KEY,
          user_uid VARCHAR(128) NOT NULL,
          friend_uid VARCHAR(128) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE(user_uid, friend_uid)
        );

        CREATE TABLE IF NOT EXISTS system_settings (
          key VARCHAR(100) PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      isNeonConnected = true;
      connectionErrorMessage = null;
      console.log('[Neon DB] Tables verified/created successfully.');
      return true;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[Neon DB] Error connecting or initializing tables:', err);
    isNeonConnected = false;
    connectionErrorMessage = err.message || 'Neon connection error';
    return false;
  }
}

export function getDatabaseStatus() {
  return {
    isNeonConfigured: !!rawConnectionString && !isPlaceholder,
    isConnected: isNeonConnected,
    isNeonUrl: rawConnectionString ? rawConnectionString.includes('neon.tech') : false,
    isPlaceholder,
    message: isNeonConnected
      ? 'Đã kết nối cơ sở dữ liệu Neon PostgreSQL đám mây thành công!'
      : connectionErrorMessage || 'Chưa kết nối Neon database.'
  };
}

export { pool };
