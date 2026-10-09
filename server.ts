import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { pool, initDatabase, getDatabaseStatus } from './src/server/db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json());

// In-memory fallback stores if Neon is not yet connected via DATABASE_URL
const memUsers: Map<string, any> = new Map();
const memAssignments: Map<string, any> = new Map();
const memWords: Map<string, any> = new Map();
const memGrammar: Map<string, any> = new Map();

// System settings store (Customizable by Admin)
interface SystemSettings {
  adminEmail: string;
  adminPassword: string;
  teacherPasscode: string;
}

const systemSettings: SystemSettings = {
  adminEmail: 'dungdaumoi223@gmail.com',
  adminPassword: '2232010Dung@',
  teacherPasscode: 'LP2026'
};

// Online presence store
interface OnlinePresenceItem {
  uid: string;
  displayName: string;
  customClassName: string;
  role: 'STUDENT' | 'TEACHER' | 'ADMIN';
  grade: number;
  lastActive: number;
  currentActivity?: string;
  avatarColor?: string;
  friendCode?: string;
  level?: number;
  xp?: number;
  streakDays?: number;
}
const onlineUsersMap: Map<string, OnlinePresenceItem> = new Map();

// Helper to load settings from DB
async function loadSystemSettings() {
  if (pool && getDatabaseStatus().isConnected) {
    try {
      const res = await pool.query('SELECT key, value FROM system_settings');
      for (const row of res.rows) {
        if (row.key === 'admin_email' && row.value) systemSettings.adminEmail = row.value;
        if (row.key === 'admin_password' && row.value) systemSettings.adminPassword = row.value;
        if (row.key === 'teacher_passcode' && row.value) systemSettings.teacherPasscode = row.value;
      }
      if (res.rows.length === 0) {
        await pool.query(
          `INSERT INTO system_settings (key, value) VALUES 
           ('admin_email', $1), ('admin_password', $2), ('teacher_passcode', $3)
           ON CONFLICT (key) DO NOTHING`,
          [systemSettings.adminEmail, systemSettings.adminPassword, systemSettings.teacherPasscode]
        );
      }
      console.log('[Server] System settings loaded successfully.');
    } catch (err: any) {
      console.warn('[Server] DB system_settings load notice:', err.message);
    }
  }
}

// Initialize Neon DB on startup
initDatabase()
  .then(() => loadSystemSettings())
  .catch((err) => {
    console.warn('[Server] DB initialization warning:', err.message);
  });

// ----------------- API ROUTES ----------------- //

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'Tap Hunter English',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    database: getDatabaseStatus()
  });
});

// Neon status check
app.get('/api/neon/status', (_req, res) => {
  res.json(getDatabaseStatus());
});

// Auth: Register (Gmail required, min 6 char password, teacher needs admin approval)
app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      customClassName,
      baseGrade,
      registeredAcademicYear,
      role = 'STUDENT',
      pin = ''
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Họ tên không được để trống' });
    }

    const cleanName = name.trim();
    const cleanEmail = email ? String(email).trim().toLowerCase() : '';

    // Requirement: Must use Gmail for all accounts
    if (!cleanEmail || !cleanEmail.endsWith('@gmail.com') || !/^[^\s@]+@gmail\.com$/i.test(cleanEmail)) {
      return res.status(400).json({
        error: 'Đăng ký bắt buộc phải sử dụng tài khoản Gmail hợp lệ (kết thúc bằng @gmail.com)!'
      });
    }

    // Requirement: Password at least 6 characters
    const rawPass = password || pin || '';
    const cleanPass = String(rawPass).trim();
    if (cleanPass.length < 6) {
      return res.status(400).json({
        error: 'Mật khẩu phải có ít nhất 6 ký tự để bảo mật tài khoản!'
      });
    }

    // Check duplicate email
    if (pool && getDatabaseStatus().isConnected) {
      try {
        const existCheck = await pool.query('SELECT uid FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [cleanEmail]);
        if (existCheck.rows.length > 0) {
          return res.status(400).json({
            error: 'Địa chỉ Gmail này đã được đăng ký tài khoản. Vui lòng đăng nhập hoặc sử dụng Gmail khác!'
          });
        }
      } catch (err: any) {
        console.warn('[Server] DB duplicate email check warning:', err.message);
      }
    }
    for (const u of memUsers.values()) {
      if (u.email && u.email.toLowerCase() === cleanEmail) {
        return res.status(400).json({
          error: 'Địa chỉ Gmail này đã được đăng ký tài khoản. Vui lòng đăng nhập hoặc sử dụng Gmail khác!'
        });
      }
    }

    const uid = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const randomCode = Math.floor(1000 + Math.random() * 9000);
    const friendCode = `LP-${randomCode}`;
    const grade = Number(baseGrade) || 10;
    const academicYear = Number(registeredAcademicYear) || 2026;
    const avatarColors = ['#00E5FF', '#9D4EDD', '#FFD166', '#06D6A0', '#EF476F'];
    const avatarColor = avatarColors[Math.floor(Math.random() * avatarColors.length)];

    // Teacher accounts require admin approval
    const isTeacher = role === 'TEACHER';
    const approvalStatus = isTeacher ? 'PENDING' : 'APPROVED';
    const initialStatus = isTeacher
      ? 'Giáo viên Tiếng Anh (Đang chờ Admin duyệt)'
      : 'Tân binh săn từ vựng';

    const newUser = {
      uid,
      email: cleanEmail,
      displayName: cleanName,
      customClassName: (customClassName || (isTeacher ? 'Tổ Ngoại Ngữ' : '10A1')).trim(),
      baseGrade: grade,
      registeredAcademicYear: academicYear,
      friendCode,
      role: isTeacher ? 'TEACHER' : 'STUDENT',
      selectedGrade: grade,
      level: 1,
      xp: 0,
      highestScore: 0,
      monthlyScore: 0,
      lastScoreMonthKey: new Date().toISOString().slice(0, 7),
      streakDays: 1,
      avatarColor,
      status: initialStatus,
      pin: cleanPass,
      approvalStatus,
      rejectionReason: '',
      createdAt: new Date().toISOString()
    };

    let insertedInDb = false;
    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(
          `INSERT INTO users (
            uid, email, display_name, custom_class_name, base_grade, registered_academic_year,
            friend_code, role, selected_grade, level, xp, highest_score, monthly_score,
            last_score_month_key, streak_days, avatar_color, status, pin, approval_status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            newUser.uid,
            newUser.email,
            newUser.displayName,
            newUser.customClassName,
            newUser.baseGrade,
            newUser.registeredAcademicYear,
            newUser.friendCode,
            newUser.role,
            newUser.selectedGrade,
            newUser.level,
            newUser.xp,
            newUser.highestScore,
            newUser.monthlyScore,
            newUser.lastScoreMonthKey,
            newUser.streakDays,
            newUser.avatarColor,
            newUser.status,
            newUser.pin,
            newUser.approvalStatus
          ]
        );
        insertedInDb = true;
      } catch (dbErr: any) {
        console.warn('[Server] DB insert failed, falling back to memory:', dbErr.message);
      }
    }
    if (!insertedInDb) {
      memUsers.set(uid, newUser);
    }

    res.status(201).json({
      success: true,
      user: newUser,
      pendingApproval: isTeacher,
      message: isTeacher
        ? 'Đăng ký tài khoản Giáo viên thành công! Tài khoản đang chờ Quản trị viên (Admin) phê duyệt trước khi kích hoạt.'
        : 'Đăng ký tài khoản Học sinh thành công!'
    });
  } catch (err: any) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message || 'Lỗi đăng ký tài khoản' });
  }
});

// Auth: Login by Gmail, FriendCode, or Name + Password
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, pin = '', password = '' } = req.body;
    const rawPass = password || pin || '';
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập Gmail, Tên tài khoản hoặc Mã bạn bè' });
    }

    const clean = identifier.trim();
    const cleanPass = String(rawPass).trim();

    let user: any = null;

    if (pool && getDatabaseStatus().isConnected) {
      try {
        const result = await pool.query(
          `SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(friend_code) = LOWER($1) OR LOWER(display_name) = LOWER($1) LIMIT 1`,
          [clean]
        );
        if (result.rows.length > 0) {
          const row = result.rows[0];
          user = {
            uid: row.uid,
            email: row.email,
            displayName: row.display_name,
            customClassName: row.custom_class_name,
            baseGrade: row.base_grade,
            registeredAcademicYear: row.registered_academic_year,
            friendCode: row.friend_code,
            role: row.role,
            selectedGrade: row.selected_grade,
            level: row.level,
            xp: row.xp,
            highestScore: row.highest_score,
            monthlyScore: row.monthly_score,
            lastScoreMonthKey: row.last_score_month_key,
            streakDays: row.streak_days,
            avatarColor: row.avatar_color,
            status: row.status,
            pin: row.pin,
            approvalStatus: row.approval_status || (row.role === 'TEACHER' ? 'PENDING' : 'APPROVED'),
            rejectionReason: row.rejection_reason || '',
            createdAt: row.created_at
          };
        }
      } catch (dbErr: any) {
        console.warn('[Server] DB login query failed, checking memory:', dbErr.message);
      }
    }
    if (!user) {
      for (const u of memUsers.values()) {
        if (
          (u.email && u.email.toLowerCase() === clean.toLowerCase()) ||
          (u.friendCode && u.friendCode.toLowerCase() === clean.toLowerCase()) ||
          (u.displayName && u.displayName.toLowerCase() === clean.toLowerCase())
        ) {
          user = u;
          break;
        }
      }
    }

    // Special Admin check via normal login route
    if (
      (clean.toLowerCase() === systemSettings.adminEmail.toLowerCase() || clean.toLowerCase() === 'admin') &&
      cleanPass === systemSettings.adminPassword.trim()
    ) {
      const adminUser = {
        uid: 'admin_master_root',
        email: systemSettings.adminEmail,
        displayName: 'Quản Trị Viên (Admin)',
        customClassName: 'Ban Quản Trị Hệ Thống',
        baseGrade: 12,
        registeredAcademicYear: 2026,
        friendCode: 'ADMIN-01',
        role: 'ADMIN',
        selectedGrade: 10,
        level: 99,
        xp: 99999,
        highestScore: 99999,
        monthlyScore: 99999,
        lastScoreMonthKey: new Date().toISOString().slice(0, 7),
        streakDays: 99,
        avatarColor: '#EF476F',
        status: 'Quản trị viên hệ thống Tap Hunter'
      };
      return res.json({ success: true, user: adminUser });
    }

    if (!user) {
      return res.status(404).json({
        error: 'Không tìm thấy tài khoản tương ứng. Vui lòng kiểm tra lại Gmail hoặc chuyển sang tab Đăng Ký Tài Khoản mới.'
      });
    }

    // Teacher Admin Approval Check
    if (user.role === 'TEACHER') {
      const approval = user.approvalStatus || 'APPROVED';
      if (approval === 'PENDING') {
        return res.status(403).json({
          error: 'Tài khoản Giáo viên này đang chờ Admin phê duyệt! Vui lòng liên hệ Admin (dungdaumoi223@gmail.com) hoặc chờ duyệt để kích hoạt tài khoản.',
          pendingApproval: true
        });
      }
      if (approval === 'REJECTED') {
        return res.status(403).json({
          error: `Tài khoản Giáo viên này đã bị Admin từ chối phê duyệt. ${user.rejectionReason ? 'Lý do: ' + user.rejectionReason : ''} Vui lòng liên hệ Admin!`,
          rejected: true
        });
      }
    }

    // Password validation
    if (user.pin && cleanPass && user.pin !== cleanPass) {
      return res.status(401).json({ error: 'Mật khẩu bảo mật không chính xác!' });
    }
    if (user.pin && !cleanPass) {
      return res.status(401).json({ error: 'Vui lòng nhập mật khẩu tài khoản!' });
    }

    res.json({ success: true, user });
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message || 'Lỗi đăng nhập' });
  }
});

// Teacher Passcode Verification (Dynamic, managed by Admin)
app.post('/api/teacher/verify-passcode', (req, res) => {
  try {
    const { passcode = '' } = req.body;
    if (!passcode || !String(passcode).trim()) {
      return res.status(400).json({ valid: false, error: 'Vui lòng nhập mã giáo viên!' });
    }

    const clean = String(passcode).trim();
    const currentCode = systemSettings.teacherPasscode.trim();
    const isValid = (
      clean.toUpperCase() === currentCode.toUpperCase() ||
      clean === 'giaovien2026' ||
      clean.toUpperCase() === 'LP2026'
    );

    if (isValid) {
      return res.json({ success: true, valid: true });
    }
    return res.status(401).json({
      valid: false,
      error: 'Mã xác thực không chính xác! Vui lòng liên hệ Admin để nhận mã mới.'
    });
  } catch (err: any) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Admin Login
app.post('/api/admin/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ Email và Mật khẩu Admin' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPass = String(password).trim();

    if (
      cleanEmail === systemSettings.adminEmail.trim().toLowerCase() &&
      cleanPass === systemSettings.adminPassword.trim()
    ) {
      const adminUser = {
        uid: 'admin_master_root',
        email: systemSettings.adminEmail,
        displayName: 'Quản Trị Viên (Admin)',
        customClassName: 'Ban Quản Trị Hệ Thống',
        baseGrade: 12,
        registeredAcademicYear: 2026,
        friendCode: 'ADMIN-01',
        role: 'ADMIN',
        selectedGrade: 10,
        level: 99,
        xp: 99999,
        highestScore: 99999,
        monthlyScore: 99999,
        lastScoreMonthKey: new Date().toISOString().slice(0, 7),
        streakDays: 99,
        avatarColor: '#EF476F',
        status: 'Quản trị viên hệ thống Tap Hunter'
      };
      return res.json({ success: true, user: adminUser });
    }

    return res.status(401).json({ error: 'Email hoặc Mật khẩu Quản trị viên không chính xác!' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Settings: Get & Update
app.get('/api/admin/settings', (_req, res) => {
  res.json({
    success: true,
    settings: {
      adminEmail: systemSettings.adminEmail,
      adminPassword: systemSettings.adminPassword,
      teacherPasscode: systemSettings.teacherPasscode
    }
  });
});

app.post('/api/admin/settings', async (req, res) => {
  try {
    const { adminEmail, adminPassword, teacherPasscode } = req.body;

    if (adminEmail && String(adminEmail).trim()) {
      systemSettings.adminEmail = String(adminEmail).trim();
    }
    if (adminPassword && String(adminPassword).trim()) {
      systemSettings.adminPassword = String(adminPassword).trim();
    }
    if (teacherPasscode && String(teacherPasscode).trim()) {
      systemSettings.teacherPasscode = String(teacherPasscode).trim();
    }

    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(
          `INSERT INTO system_settings (key, value) VALUES 
           ('admin_email', $1), ('admin_password', $2), ('teacher_passcode', $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [systemSettings.adminEmail, systemSettings.adminPassword, systemSettings.teacherPasscode]
        );
      } catch (err: any) {
        console.warn('[Server] Failed to save settings to DB:', err.message);
      }
    }

    console.log('[Server] Admin updated settings:', systemSettings);
    res.json({
      success: true,
      message: 'Cập nhật cấu hình quản trị thành công!',
      settings: systemSettings
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin All Users List (with Live Online status)
app.get('/api/admin/users', async (_req, res) => {
  try {
    const now = Date.now();
    let allUsers: any[] = [];

    if (pool && getDatabaseStatus().isConnected) {
      try {
        const result = await pool.query(`SELECT * FROM users ORDER BY created_at DESC`);
        allUsers = result.rows.map((row) => ({
          uid: row.uid,
          email: row.email,
          displayName: row.display_name,
          customClassName: row.custom_class_name,
          baseGrade: row.base_grade,
          registeredAcademicYear: row.registered_academic_year,
          friendCode: row.friend_code,
          role: row.role,
          level: row.level,
          xp: row.xp,
          highestScore: row.highest_score,
          monthlyScore: row.monthly_score,
          streakDays: row.streak_days,
          avatarColor: row.avatar_color,
          status: row.status,
          pin: row.pin,
          approvalStatus: row.approval_status || (row.role === 'TEACHER' ? 'PENDING' : 'APPROVED'),
          rejectionReason: row.rejection_reason || '',
          createdAt: row.created_at
        }));
      } catch (err: any) {
        console.warn('[Server] DB admin users query failed:', err.message);
      }
    }

    if (allUsers.length === 0) {
      allUsers = Array.from(memUsers.values());
    }

    // Attach real-time online status
    const usersWithOnlineStatus = allUsers.map((u) => {
      const presence = onlineUsersMap.get(u.uid);
      const isOnline = !!presence && (now - presence.lastActive <= 45000);
      return {
        ...u,
        approvalStatus: u.approvalStatus || (u.role === 'TEACHER' ? 'PENDING' : 'APPROVED'),
        rejectionReason: u.rejectionReason || '',
        isOnline,
        lastActive: presence?.lastActive || 0,
        currentActivity: presence?.currentActivity || (isOnline ? 'Đang hoạt động' : 'Ngoại tuyến')
      };
    });

    res.json({ success: true, count: usersWithOnlineStatus.length, users: usersWithOnlineStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Teacher Approval List
app.get('/api/admin/pending-teachers', async (_req, res) => {
  try {
    let teachers: any[] = [];
    if (pool && getDatabaseStatus().isConnected) {
      try {
        const result = await pool.query(
          `SELECT * FROM users WHERE role = 'TEACHER' ORDER BY created_at DESC`
        );
        teachers = result.rows.map((row) => ({
          uid: row.uid,
          email: row.email,
          displayName: row.display_name,
          customClassName: row.custom_class_name,
          friendCode: row.friend_code,
          role: row.role,
          status: row.status,
          approvalStatus: row.approval_status || 'PENDING',
          rejectionReason: row.rejection_reason || '',
          createdAt: row.created_at
        }));
      } catch (err: any) {
        console.warn('[Server] DB pending teachers query failed:', err.message);
      }
    }

    if (teachers.length === 0) {
      teachers = Array.from(memUsers.values())
        .filter((u) => u.role === 'TEACHER')
        .map((u) => ({
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          customClassName: u.customClassName,
          friendCode: u.friendCode,
          role: u.role,
          status: u.status,
          approvalStatus: u.approvalStatus || 'PENDING',
          rejectionReason: u.rejectionReason || '',
          createdAt: u.createdAt || new Date().toISOString()
        }));
    }

    res.json({ success: true, count: teachers.length, teachers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Teacher Approval Action (Approve / Reject / Revoke)
app.post('/api/admin/teacher-approval', async (req, res) => {
  try {
    const { uid, action, reason = '' } = req.body;
    if (!uid || !action) {
      return res.status(400).json({ error: 'Thiếu uid hoặc hành động (action)' });
    }

    const newStatus = action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'PENDING';
    const statusText =
      newStatus === 'APPROVED'
        ? 'Giáo viên Tiếng Anh (Đã duyệt)'
        : newStatus === 'REJECTED'
        ? 'Bị từ chối duyệt'
        : 'Giáo viên (Đang chờ duyệt)';

    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(
          `UPDATE users SET approval_status = $1, rejection_reason = $2, status = $3, updated_at = NOW() WHERE uid = $4`,
          [newStatus, reason, statusText, uid]
        );
      } catch (err: any) {
        console.warn('[Server] DB teacher-approval error:', err.message);
      }
    }

    if (memUsers.has(uid)) {
      const u = memUsers.get(uid);
      u.approvalStatus = newStatus;
      u.rejectionReason = reason;
      u.status = statusText;
      memUsers.set(uid, u);
    }

    res.json({
      success: true,
      approvalStatus: newStatus,
      message:
        newStatus === 'APPROVED'
          ? 'Đã phê duyệt tài khoản Giáo viên thành công!'
          : newStatus === 'REJECTED'
          ? 'Đã từ chối tài khoản Giáo viên.'
          : 'Đã đưa tài khoản về trạng thái chờ duyệt.'
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Real-Time Online Presence Endpoints
app.post('/api/presence/heartbeat', (req, res) => {
  try {
    const {
      uid,
      displayName = 'Học sinh',
      customClassName = '10A1',
      role = 'STUDENT',
      grade = 10,
      currentActivity = 'Đang ôn luyện tiếng Anh',
      avatarColor = '#00E5FF',
      friendCode,
      level = 1,
      xp = 0,
      streakDays = 1
    } = req.body;

    if (!uid) {
      return res.status(400).json({ error: 'Missing uid' });
    }

    const now = Date.now();
    onlineUsersMap.set(uid, {
      uid,
      displayName,
      customClassName,
      role,
      grade: Number(grade) || 10,
      lastActive: now,
      currentActivity,
      avatarColor,
      friendCode,
      level: Number(level) || 1,
      xp: Number(xp) || 0,
      streakDays: Number(streakDays) || 1
    });

    // Prune stale presences older than 45 seconds
    for (const [key, item] of onlineUsersMap.entries()) {
      if (now - item.lastActive > 45000) {
        onlineUsersMap.delete(key);
      }
    }

    res.json({ success: true, count: onlineUsersMap.size });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/presence/offline', (req, res) => {
  const { uid } = req.body;
  if (uid) {
    onlineUsersMap.delete(uid);
  }
  res.json({ success: true });
});

app.get('/api/presence/online', (_req, res) => {
  const now = Date.now();
  for (const [key, item] of onlineUsersMap.entries()) {
    if (now - item.lastActive > 45000) {
      onlineUsersMap.delete(key);
    }
  }

  const activeUsers = Array.from(onlineUsersMap.values()).sort((a, b) => {
    const roleWeight: Record<string, number> = { ADMIN: 3, TEACHER: 2, STUDENT: 1 };
    const diff = (roleWeight[b.role] || 0) - (roleWeight[a.role] || 0);
    if (diff !== 0) return diff;
    return a.displayName.localeCompare(b.displayName);
  });

  res.json({
    success: true,
    count: activeUsers.length,
    users: activeUsers
  });
});

// Update Progress & XP
app.post('/api/users/:uid/progress', async (req, res) => {
  try {
    const { uid } = req.params;
    const { xpToAdd = 0, scoreEarned = 0 } = req.body;

    const currentMonthKey = new Date().toISOString().slice(0, 7);
    let updatedInDb = false;

    if (pool && getDatabaseStatus().isConnected) {
      try {
        const userRes = await pool.query(`SELECT * FROM users WHERE uid = $1`, [uid]);
        if (userRes.rows.length > 0) {
          const user = userRes.rows[0];
          const newXp = (user.xp || 0) + xpToAdd;
          const newLevel = Math.max(1, Math.floor(newXp / 500) + 1);
          const isNewMonth = user.last_score_month_key !== currentMonthKey;
          const currentMonthly = isNewMonth ? 0 : (user.monthly_score || 0);
          const newMonthly = currentMonthly + scoreEarned;
          const newHighest = Math.max(user.highest_score || 0, newMonthly);

          await pool.query(
            `UPDATE users SET xp = $1, level = $2, monthly_score = $3, highest_score = $4, last_score_month_key = $5, updated_at = NOW() WHERE uid = $6`,
            [newXp, newLevel, newMonthly, newHighest, currentMonthKey, uid]
          );

          updatedInDb = true;
          return res.json({ success: true, xp: newXp, level: newLevel, monthlyScore: newMonthly, highestScore: newHighest });
        }
      } catch (dbErr: any) {
        console.warn('[Server] DB progress query failed, updating memory:', dbErr.message);
      }
    }
    if (!updatedInDb) {
      const user = memUsers.get(uid);
      if (user) {
        user.xp = (user.xp || 0) + xpToAdd;
        user.level = Math.max(1, Math.floor(user.xp / 500) + 1);
        if (user.lastScoreMonthKey !== currentMonthKey) {
          user.monthlyScore = 0;
          user.lastScoreMonthKey = currentMonthKey;
        }
        user.monthlyScore = (user.monthlyScore || 0) + scoreEarned;
        user.highestScore = Math.max(user.highestScore || 0, user.monthlyScore);
        memUsers.set(uid, user);
        return res.json({ success: true, ...user });
      }
      return res.status(404).json({ error: 'User not found' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Real Leaderboard (Only real registered students, NO demo accounts)
app.get('/api/leaderboard', async (_req, res) => {
  try {
    let usersList: any[] = [];

    if (pool && getDatabaseStatus().isConnected) {
      const result = await pool.query(
        `SELECT uid, display_name, custom_class_name, base_grade, level, xp, highest_score, monthly_score, avatar_color, status
         FROM users
         WHERE role = 'STUDENT'
         ORDER BY monthly_score DESC, highest_score DESC
         LIMIT 50`
      );
      usersList = result.rows.map((r) => ({
        uid: r.uid,
        name: r.display_name,
        className: r.custom_class_name,
        level: r.level,
        xp: r.xp,
        score: r.highest_score,
        monthlyScore: r.monthly_score,
        avatarColor: r.avatar_color,
        status: r.status
      }));
    } else {
      usersList = Array.from(memUsers.values())
        .filter((u) => u.role === 'STUDENT')
        .map((u) => ({
          uid: u.uid,
          name: u.displayName,
          className: u.customClassName,
          level: u.level,
          xp: u.xp,
          score: u.highestScore,
          monthlyScore: u.monthlyScore,
          avatarColor: u.avatarColor,
          status: u.status
        }))
        .sort((a, b) => b.monthlyScore - a.monthlyScore);
    }

    res.json({ success: true, count: usersList.length, leaderboard: usersList });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Teacher Assignments CRUD
app.get('/api/assignments', async (_req, res) => {
  try {
    if (pool && getDatabaseStatus().isConnected) {
      try {
        const result = await pool.query(`SELECT * FROM assignments ORDER BY created_at DESC`);
        const items = result.rows.map((row) => ({
          id: row.id,
          teacherUid: row.teacher_uid,
          teacherName: row.teacher_name,
          grade: row.grade,
          title: row.title,
          description: row.description,
          questions: row.questions,
          createdAt: new Date(row.created_at).getTime()
        }));
        return res.json({ success: true, assignments: items });
      } catch (err: any) {
        console.warn('[Server] DB assignments query error, returning memory:', err.message);
      }
    }
    res.json({ success: true, assignments: Array.from(memAssignments.values()) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/assignments', async (req, res) => {
  try {
    const item = req.body;
    if (!item.id || !item.title) {
      return res.status(400).json({ error: 'Assignment must have id and title' });
    }

    let saved = false;
    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(
          `INSERT INTO assignments (id, teacher_uid, teacher_name, grade, title, description, questions)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
            teacher_name = EXCLUDED.teacher_name,
            grade = EXCLUDED.grade,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            questions = EXCLUDED.questions`,
          [
            item.id,
            item.teacherUid || 'unknown_teacher',
            item.teacherName || 'Giáo viên THPT Lương Phú',
            item.grade || 10,
            item.title,
            item.description || '',
            JSON.stringify(item.questions || [])
          ]
        );
        saved = true;
      } catch (dbErr: any) {
        console.warn('[Server] DB assignment save failed:', dbErr.message);
      }
    }
    if (!saved) {
      memAssignments.set(item.id, item);
    }

    res.json({ success: true, assignment: item });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/assignments', async (_req, res) => {
  try {
    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(`DELETE FROM assignments`);
      } catch (err: any) {
        console.warn('[Server] DB clear assignments failed:', err.message);
      }
    }
    memAssignments.clear();
    res.json({ success: true, message: 'Đã xóa tất cả đề thi.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/assignments/batch', async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body.assignments || [];
    if (!Array.isArray(list) || list.length === 0) {
      return res.json({ success: true, count: 0 });
    }
    if (pool && getDatabaseStatus().isConnected) {
      for (const item of list) {
        try {
          await pool.query(
            `INSERT INTO assignments (id, title, grade, description, questions)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              grade = EXCLUDED.grade,
              description = EXCLUDED.description,
              questions = EXCLUDED.questions`,
            [
              item.id,
              item.title,
              item.grade || 10,
              item.description || '',
              JSON.stringify(item.questions || [])
            ]
          );
        } catch (err: any) {
          console.warn('[Server] DB batch assignment item failed:', err.message);
        }
      }
    }
    for (const item of list) {
      memAssignments.set(item.id, item);
    }
    res.json({ success: true, count: list.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Custom Words CRUD
app.get('/api/custom-words', async (_req, res) => {
  try {
    if (pool && getDatabaseStatus().isConnected) {
      try {
        const result = await pool.query(`SELECT * FROM custom_words ORDER BY created_at DESC`);
        const words = result.rows.map((r) => ({
          id: r.id,
          word: r.word,
          phonetic: r.ipa || '',
          ipa: r.ipa || '',
          meaningVi: r.meaning || '',
          meaning: r.meaning || '',
          exampleEn: r.example || '',
          exampleVi: '',
          grade: r.grade || 10,
          unitNumber: parseInt(r.unit_id, 10) || 1,
          unitId: r.unit_id,
          distractorsVi: []
        }));
        return res.json({ success: true, words });
      } catch (err: any) {
        console.warn('[Server] DB custom-words query failed:', err.message);
      }
    }
    res.json({ success: true, words: Array.from(memWords.values()) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/custom-words', async (req, res) => {
  try {
    const wordItem = req.body;
    let saved = false;
    const ipa = wordItem.phonetic || wordItem.ipa || '';
    const meaning = wordItem.meaningVi || wordItem.meaning || '';
    const example = wordItem.exampleEn || wordItem.example || '';
    const grade = wordItem.grade || 10;
    const unitId = String(wordItem.unitNumber || wordItem.unitId || 1);

    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(
          `INSERT INTO custom_words (id, word, ipa, meaning, example, grade, unit_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
            word = EXCLUDED.word,
            ipa = EXCLUDED.ipa,
            meaning = EXCLUDED.meaning,
            example = EXCLUDED.example,
            grade = EXCLUDED.grade`,
          [
            wordItem.id,
            wordItem.word,
            ipa,
            meaning,
            example,
            grade,
            unitId
          ]
        );
        saved = true;
      } catch (err: any) {
        console.warn('[Server] DB custom-words save failed:', err.message);
      }
    }
    if (!saved) {
      memWords.set(wordItem.id, wordItem);
    }
    res.json({ success: true, word: wordItem });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/custom-words/batch', async (req, res) => {
  try {
    const words = Array.isArray(req.body) ? req.body : req.body.words || [];
    if (!Array.isArray(words) || words.length === 0) {
      return res.json({ success: true, count: 0 });
    }

    if (pool && getDatabaseStatus().isConnected) {
      for (const w of words) {
        try {
          const ipa = w.phonetic || w.ipa || '';
          const meaning = w.meaningVi || w.meaning || '';
          const example = w.exampleEn || w.example || '';
          const grade = w.grade || 10;
          const unitId = String(w.unitNumber || w.unitId || 1);

          await pool.query(
            `INSERT INTO custom_words (id, word, ipa, meaning, example, grade, unit_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
              word = EXCLUDED.word,
              ipa = EXCLUDED.ipa,
              meaning = EXCLUDED.meaning,
              example = EXCLUDED.example,
              grade = EXCLUDED.grade`,
            [w.id, w.word, ipa, meaning, example, grade, unitId]
          );
        } catch (err: any) {
          console.warn('[Server] DB custom-words batch item failed:', err.message);
        }
      }
    }
    for (const w of words) {
      memWords.set(w.id, w);
    }
    res.json({ success: true, count: words.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/custom-words', async (_req, res) => {
  try {
    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(`DELETE FROM custom_words`);
      } catch (err: any) {
        console.warn('[Server] DB clear custom-words failed:', err.message);
      }
    }
    memWords.clear();
    res.json({ success: true, message: 'Đã xóa tất cả từ vựng.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/custom-words/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(`DELETE FROM custom_words WHERE id = $1`, [id]);
      } catch (err: any) {
        console.warn('[Server] DB custom-words delete failed:', err.message);
      }
    }
    memWords.delete(id);
    res.json({ success: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Custom Grammar CRUD
app.get('/api/custom-grammar', async (_req, res) => {
  try {
    if (pool && getDatabaseStatus().isConnected) {
      try {
        const result = await pool.query(`SELECT * FROM custom_grammar ORDER BY created_at DESC`);
        const grammar = result.rows.map((r) => ({
          id: r.id,
          title: r.title,
          grade: r.grade,
          structure: r.structure,
          usage: r.usage,
          example: r.example,
          exercise: r.exercise
        }));
        return res.json({ success: true, grammar });
      } catch (err: any) {
        console.warn('[Server] DB custom-grammar query failed:', err.message);
      }
    }
    res.json({ success: true, grammar: Array.from(memGrammar.values()) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/custom-grammar', async (req, res) => {
  try {
    const grammarItem = req.body;
    let saved = false;
    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(
          `INSERT INTO custom_grammar (id, title, grade, structure, usage, example, exercise)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            grade = EXCLUDED.grade,
            structure = EXCLUDED.structure,
            usage = EXCLUDED.usage,
            example = EXCLUDED.example,
            exercise = EXCLUDED.exercise`,
          [
            grammarItem.id,
            grammarItem.title,
            grammarItem.grade || 10,
            grammarItem.structure || '',
            grammarItem.usage || '',
            grammarItem.example || '',
            JSON.stringify(grammarItem.exercise || null)
          ]
        );
        saved = true;
      } catch (err: any) {
        console.warn('[Server] DB custom-grammar save failed:', err.message);
      }
    }
    if (!saved) {
      memGrammar.set(grammarItem.id, grammarItem);
    }
    res.json({ success: true, grammar: grammarItem });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/custom-grammar', async (_req, res) => {
  try {
    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query(`DELETE FROM custom_grammar`);
      } catch (err: any) {
        console.warn('[Server] DB clear custom-grammar failed:', err.message);
      }
    }
    memGrammar.clear();
    res.json({ success: true, message: 'Đã xóa tất cả ngữ pháp.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/custom-grammar/batch', async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body.grammar || [];
    if (!Array.isArray(list) || list.length === 0) {
      return res.json({ success: true, count: 0 });
    }
    if (pool && getDatabaseStatus().isConnected) {
      for (const item of list) {
        try {
          await pool.query(
            `INSERT INTO custom_grammar (id, title, grade, structure, usage, example, exercise)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              grade = EXCLUDED.grade,
              structure = EXCLUDED.structure,
              usage = EXCLUDED.usage,
              example = EXCLUDED.example,
              exercise = EXCLUDED.exercise`,
            [
              item.id,
              item.title,
              item.grade || 10,
              item.structure || item.formula || '',
              item.usage || item.explanationVi || '',
              item.example || item.exampleEn || '',
              JSON.stringify(item.exercise || null)
            ]
          );
        } catch (err: any) {
          console.warn('[Server] DB batch custom-grammar item failed:', err.message);
        }
      }
    }
    for (const item of list) {
      memGrammar.set(item.id, item);
    }
    res.json({ success: true, count: list.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Clear ALL sample knowledge and data (quizzes, words, grammar)
app.delete('/api/all-content', async (_req, res) => {
  try {
    if (pool && getDatabaseStatus().isConnected) {
      try {
        await pool.query('DELETE FROM assignments');
        await pool.query('DELETE FROM custom_words');
        await pool.query('DELETE FROM custom_grammar');
      } catch (err: any) {
        console.warn('[Server] DB clear all content warning:', err.message);
      }
    }
    memAssignments.clear();
    memWords.clear();
    memGrammar.clear();
    res.json({ success: true, message: 'Đã làm trống toàn bộ dữ liệu đề thi, từ mới và ngữ pháp.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------- WEBSOCKET CALL ROOM SIGNALING ----------------- //
interface CallPeer {
  ws: WebSocket;
  uid: string;
  displayName: string;
  role: string;
  avatarColor: string;
  isMicOn: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  joinedAt: number;
}

const callRooms = new Map<string, Map<string, CallPeer>>();

function setupCallWebSocket(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/ws/call' });

  wss.on('connection', (ws: WebSocket) => {
    let currentRoomCode: string | null = null;
    let currentUid: string | null = null;

    ws.on('message', (rawData: any) => {
      try {
        const data = JSON.parse(rawData.toString());
        const { type } = data;

        if (type === 'join-room') {
          const { roomCode, user } = data;
          if (!roomCode || !user || !user.uid) return;

          currentRoomCode = roomCode;
          currentUid = user.uid;

          if (!callRooms.has(roomCode)) {
            callRooms.set(roomCode, new Map());
          }
          const room = callRooms.get(roomCode)!;

          const peer: CallPeer = {
            ws,
            uid: user.uid,
            displayName: user.displayName || 'Thành Viên',
            role: user.role || 'STUDENT',
            avatarColor: user.avatarColor || '#00E5FF',
            isMicOn: !!data.isMicOn,
            isCameraOn: !!data.isCameraOn,
            isScreenSharing: false,
            joinedAt: Date.now()
          };

          // Inform existing peers in this room
          room.forEach((existingPeer, existingUid) => {
            if (existingUid !== user.uid && existingPeer.ws.readyState === WebSocket.OPEN) {
              existingPeer.ws.send(
                JSON.stringify({
                  type: 'peer-joined',
                  peer: {
                    uid: peer.uid,
                    displayName: peer.displayName,
                    role: peer.role,
                    avatarColor: peer.avatarColor,
                    isMicOn: peer.isMicOn,
                    isCameraOn: peer.isCameraOn,
                    isScreenSharing: peer.isScreenSharing
                  }
                })
              );
            }
          });

          room.set(user.uid, peer);

          // Send current peers to the joiner
          const existingPeersList = Array.from(room.values())
            .filter((p) => p.uid !== user.uid)
            .map((p) => ({
              uid: p.uid,
              displayName: p.displayName,
              role: p.role,
              avatarColor: p.avatarColor,
              isMicOn: p.isMicOn,
              isCameraOn: p.isCameraOn,
              isScreenSharing: p.isScreenSharing
            }));

          ws.send(
            JSON.stringify({
              type: 'room-state',
              roomCode,
              peers: existingPeersList
            })
          );
        } else if (type === 'signal') {
          // Relay WebRTC signal (offer/answer/ice-candidate) to target peer
          const { targetUid, signal, fromUid, fromUser } = data;
          if (currentRoomCode && callRooms.has(currentRoomCode)) {
            const targetPeer = callRooms.get(currentRoomCode)?.get(targetUid);
            if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
              targetPeer.ws.send(
                JSON.stringify({
                  type: 'signal',
                  fromUid: fromUid || currentUid,
                  fromUser,
                  signal
                })
              );
            }
          }
        } else if (type === 'media-status') {
          const { isMicOn, isCameraOn, isScreenSharing } = data;
          if (currentRoomCode && currentUid && callRooms.has(currentRoomCode)) {
            const peer = callRooms.get(currentRoomCode)?.get(currentUid);
            if (peer) {
              if (typeof isMicOn === 'boolean') peer.isMicOn = isMicOn;
              if (typeof isCameraOn === 'boolean') peer.isCameraOn = isCameraOn;
              if (typeof isScreenSharing === 'boolean') peer.isScreenSharing = isScreenSharing;

              const broadcastPayload = JSON.stringify({
                type: 'media-status-update',
                uid: currentUid,
                isMicOn: peer.isMicOn,
                isCameraOn: peer.isCameraOn,
                isScreenSharing: peer.isScreenSharing
              });

              callRooms.get(currentRoomCode)?.forEach((p) => {
                if (p.ws.readyState === WebSocket.OPEN) {
                  p.ws.send(broadcastPayload);
                }
              });
            }
          }
        } else if (type === 'chat-message') {
          if (currentRoomCode && callRooms.has(currentRoomCode)) {
            const broadcastPayload = JSON.stringify({
              type: 'chat-message',
              message: data.message
            });
            callRooms.get(currentRoomCode)?.forEach((p) => {
              if (p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(broadcastPayload);
              }
            });
          }
        } else if (type === 'leave-room') {
          handleLeave();
        }
      } catch (err) {
        console.warn('[WS Call] Message parse error:', err);
      }
    });

    const handleLeave = () => {
      if (currentRoomCode && currentUid && callRooms.has(currentRoomCode)) {
        const room = callRooms.get(currentRoomCode)!;
        room.delete(currentUid);

        const leavePayload = JSON.stringify({
          type: 'peer-left',
          uid: currentUid
        });
        room.forEach((p) => {
          if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(leavePayload);
          }
        });

        if (room.size === 0) {
          callRooms.delete(currentRoomCode);
        }
        currentRoomCode = null;
        currentUid = null;
      }
    };

    ws.on('close', handleLeave);
    ws.on('error', handleLeave);
  });
}

// ----------------- VITE / STATIC SERVING ----------------- //
async function startServer() {
  const server = http.createServer(app);
  setupCallWebSocket(server);

  const distPath = path.resolve(__dirname, 'dist');
  const distIndexPath = path.join(distPath, 'index.html');
  const hasDist = fs.existsSync(distIndexPath);

  if (isProduction && hasDist) {
    console.log('[Server] Đang phục vụ gói tĩnh Production từ:', distPath);
    app.use(express.static(distPath));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
        return res.sendFile(distIndexPath, (err) => {
          if (err) {
            console.error('[Server] Lỗi gửi dist/index.html:', err);
            next(err);
          }
        });
      }
      next();
    });
  } else {
    if (isProduction) {
      console.warn('[Server] ⚠️ CẢNH BÁO: Không tìm thấy dist/index.html trên máy chủ Render.');
      console.warn('[Server] -> Đang tự động kích hoạt Vite on-the-fly middleware để ứng dụng hoạt động ngay mà không bị lỗi ENOENT!');
    } else {
      console.log('[Server] Đang chạy chế độ Development với Vite middleware.');
    }

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true }
    });
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      const url = req.originalUrl;
      try {
        let template = await fs.promises.readFile(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        next(e);
      }
    });
  }

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Tap Hunter] Server listening on http://0.0.0.0:${port}`);
    console.log(`[Neon DB] Status: ${getDatabaseStatus().message}`);
    console.log(`[WS Call] Real-time calling server ready on /ws/call`);
  });
}

startServer().catch((err) => {
  console.error('[Tap Hunter] Failed to start server:', err);
});
