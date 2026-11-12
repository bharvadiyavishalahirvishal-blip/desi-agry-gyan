import express from 'express';
import { db, nowIso } from './db.js';
import { hashPin, verifyPin, createSession, destroySession, requireAuth } from './auth.js';
import { analyzeCropImage, chatAnswer, aiInfo, AiError } from './ai.js';
import { FERTILIZERS, UNITS, UNIT_CONSTANTS, calculateFertilizer, FertilizerError } from './fertilizer.js';

const router = express.Router();

/* ------------------------------------------------------------------ helpers */

const bad = (res, message, code = 'bad_request', status = 400) =>
  res.status(status).json({ error: { code, message } });

const parseJson = (value, fallback = null) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.reset <= now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}
const limitKey = (req, scope) => `${scope}:${req.user ? `u${req.user.id}` : req.ip}`;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) if (entry.reset <= now) buckets.delete(key);
}, 60000).unref?.();

const normaliseMobile = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/* --------------------------------------------------------------- app meta */

router.get('/meta', (req, res) => {
  res.json({
    app: 'DESI AGRY GYAN',
    ai: aiInfo(),
    user: req.user || null
  });
});

/* ------------------------------------------------------------------- auth */

router.post('/auth/register', (req, res) => {
  if (rateLimited(limitKey(req, 'register'), 12, 15 * 60 * 1000)) {
    return bad(res, 'ઘણા પ્રયત્નો થઈ ગયા. ૧૫ મિનિટ પછી ફરી પ્રયત્ન કરો.', 'rate_limited', 429);
  }

  const name = String(req.body?.name || '').trim();
  const mobile = normaliseMobile(req.body?.mobile);
  const pin = String(req.body?.pin || '').trim();

  if (name.length < 2 || name.length > 60) return bad(res, 'તમારું નામ ભરો (ઓછામાં ઓછા ૨ અક્ષર).');
  if (!/^[6-9]\d{9}$/.test(mobile)) return bad(res, '૧૦ અંકનો સાચો મોબાઈલ નંબર ભરો.');
  if (!/^\d{4,6}$/.test(pin)) return bad(res, 'પિન ૪ થી ૬ અંકનો હોવો જોઈએ.');

  const existing = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mobile);
  if (existing) {
    return bad(res, 'આ મોબાઈલ નંબર પહેલેથી નોંધાયેલો છે. લોગિન કરો.', 'mobile_exists', 409);
  }

  const info = db
    .prepare('INSERT INTO users (name, mobile, pin_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(name, mobile, hashPin(pin), nowIso());

  createSession(req, res, Number(info.lastInsertRowid));
  res.status(201).json({
    user: { id: Number(info.lastInsertRowid), name, mobile },
    message: 'તમારું ખાતું બની ગયું છે. સ્વાગત છે!'
  });
});

router.post('/auth/login', (req, res) => {
  if (rateLimited(limitKey(req, 'login'), 15, 15 * 60 * 1000)) {
    return bad(res, 'ઘણા પ્રયત્નો થઈ ગયા. ૧૫ મિનિટ પછી ફરી પ્રયત્ન કરો.', 'rate_limited', 429);
  }

  const mobile = normaliseMobile(req.body?.mobile);
  const pin = String(req.body?.pin || '').trim();
  if (!/^[6-9]\d{9}$/.test(mobile) || !pin) return bad(res, 'મોબાઈલ નંબર અને પિન બંને ભરો.');

  const user = db.prepare('SELECT * FROM users WHERE mobile = ?').get(mobile);
  if (!user || !verifyPin(pin, user.pin_hash)) {
    return bad(res, 'મોબાઈલ નંબર કે પિન ખોટો છે.', 'invalid_credentials', 401);
  }

  createSession(req, res, user.id);
  res.json({ user: { id: user.id, name: user.name, mobile: user.mobile }, message: 'લોગિન સફળ થયું.' });
});

router.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ message: 'લોગઆઉટ થઈ ગયું.' });
});

router.get('/auth/me', (req, res) => {
  res.json({ user: req.user || null, ai: aiInfo() });
});

/* ------------------------------------------------------------ crop doctor */

const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/;

router.post('/crop/analyze', requireAuth, async (req, res) => {
  if (rateLimited(limitKey(req, 'crop'), 20, 60 * 60 * 1000)) {
    return bad(res, 'એક કલાકમાં ઘણા ફોટા મોકલાયા. થોડી વાર પછી પ્રયત્ન કરો.', 'rate_limited', 429);
  }

  const image = String(req.body?.image || '').trim();
  const cropName = String(req.body?.cropName || '').trim().slice(0, 60);
  const note = String(req.body?.note || '').trim().slice(0, 400);

  const match = IMAGE_DATA_URL.exec(image);
  if (!match) {
    return bad(res, 'ફોટો સાચા સ્વરૂપમાં મળ્યો નથી. ફોટો ફરી પસંદ કરો (JPG/PNG/WEBP).', 'invalid_image');
  }

  const mime = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const base64 = match[2].replace(/\s+/g, '');
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes < 1024) return bad(res, 'ફોટો ખૂબ નાનો છે. સ્પષ્ટ ફોટો લો.', 'image_too_small');
  if (bytes > 6 * 1024 * 1024) return bad(res, 'ફોટો ખૂબ મોટો છે (મહત્તમ ૬ MB).', 'image_too_large', 413);

  const { analysis, model } = await analyzeCropImage({ imageBase64: base64, mime, cropName, note });

  const info = db
    .prepare(
      `INSERT INTO crop_reports (user_id, crop_name, note, image_mime, image_data, analysis, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, cropName || null, note || null, mime, base64, JSON.stringify(analysis), model || null, nowIso());

  const id = Number(info.lastInsertRowid);
  res.status(201).json({
    message: 'ફોટાનું વિશ્લેષણ પૂર્ણ થયું.',
    report: {
      id,
      cropName: cropName || null,
      note: note || null,
      createdAt: nowIso(),
      analysis,
      imageUrl: `/api/crop/reports/${id}/image`
    }
  });
});

const reportSummary = (row) => {
  const analysis = parseJson(row.analysis, {}) || {};
  return {
    id: row.id,
    cropName: row.crop_name,
    note: row.note,
    createdAt: row.created_at,
    crop: analysis.crop || null,
    confidence: analysis.overall_confidence || null,
    summary: analysis.summary || '',
    issueNames: Array.isArray(analysis.possible_issues) ? analysis.possible_issues.map((i) => i.name).filter(Boolean) : [],
    askExpert: analysis.ask_expert === true,
    imageUrl: `/api/crop/reports/${row.id}/image`
  };
};

router.get('/crop/reports', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, crop_name, note, created_at, analysis FROM crop_reports WHERE user_id = ? ORDER BY id DESC LIMIT 100')
    .all(req.user.id);
  res.json({ reports: rows.map(reportSummary) });
});

router.get('/crop/reports/:id', requireAuth, (req, res) => {
  const row = db
    .prepare('SELECT * FROM crop_reports WHERE id = ? AND user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!row) return bad(res, 'આ રિપોર્ટ મળ્યો નહીં.', 'not_found', 404);
  res.json({
    report: {
      ...reportSummary(row),
      analysis: parseJson(row.analysis, {}) || {},
      model: row.model
    }
  });
});

router.get('/crop/reports/:id/image', requireAuth, (req, res) => {
  const row = db
    .prepare('SELECT image_mime, image_data FROM crop_reports WHERE id = ? AND user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).end();
  const buffer = Buffer.from(row.image_data, 'base64');
  res.setHeader('Content-Type', row.image_mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
});

router.delete('/crop/reports/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM crop_reports WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (info.changes === 0) return bad(res, 'આ રિપોર્ટ મળ્યો નહીં.', 'not_found', 404);
  res.json({ message: 'રિપોર્ટ ડિલીટ થઈ ગયો.' });
});

/* ------------------------------------------------------------------- chat */

const DEFAULT_TITLE = 'નવી વાતચીત';

router.get('/chat/conversations', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
        WHERE c.user_id = ?
        ORDER BY c.updated_at DESC
        LIMIT 60`
    )
    .all(req.user.id);
  res.json({
    conversations: rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count
    }))
  });
});

router.post('/chat/conversations', requireAuth, (req, res) => {
  const timestamp = nowIso();
  const info = db
    .prepare('INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, DEFAULT_TITLE, timestamp, timestamp);
  res.status(201).json({
    conversation: {
      id: Number(info.lastInsertRowid),
      title: DEFAULT_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0
    }
  });
});

function getOwnedConversation(id, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

router.get('/chat/conversations/:id', requireAuth, (req, res) => {
  const conversation = getOwnedConversation(req.params.id, req.user.id);
  if (!conversation) return bad(res, 'આ વાતચીત મળી નહીં.', 'not_found', 404);
  const messages = db
    .prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 200')
    .all(conversation.id);
  res.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at
    },
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at }))
  });
});

router.delete('/chat/conversations/:id', requireAuth, (req, res) => {
  const info = db
    .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (info.changes === 0) return bad(res, 'આ વાતચીત મળી નહીં.', 'not_found', 404);
  res.json({ message: 'વાતચીત ડિલીટ થઈ ગઈ.' });
});

router.post('/chat/conversations/:id/messages', requireAuth, async (req, res) => {
  if (rateLimited(limitKey(req, 'chat'), 60, 60 * 60 * 1000)) {
    return bad(res, 'એક કલાકમાં ઘણા સવાલ પૂછાયા. થોડી વાર પછી પ્રયત્ન કરો.', 'rate_limited', 429);
  }

  const conversation = getOwnedConversation(req.params.id, req.user.id);
  if (!conversation) return bad(res, 'આ વાતચીત મળી નહીં.', 'not_found', 404);

  const question = String(req.body?.message || '').trim();
  if (!question) return bad(res, 'તમારો સવાલ લખો.');
  if (question.length > 2000) return bad(res, 'સવાલ ટૂંકો કરો (મહત્તમ ૨૦૦૦ અક્ષર).');

  const history = db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 20')
    .all(conversation.id);

  const timestamp = nowIso();
  const userMessageInfo = db
    .prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(conversation.id, 'user', question, timestamp);

  const { answer, model } = await chatAnswer({ history, question });

  const assistantInfo = db
    .prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(conversation.id, 'assistant', answer, nowIso());

  const title = conversation.title === DEFAULT_TITLE ? question.slice(0, 60) : conversation.title;
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), conversation.id);

  res.status(201).json({
    conversation: { id: conversation.id, title, updatedAt: nowIso() },
    userMessage: {
      id: Number(userMessageInfo.lastInsertRowid),
      role: 'user',
      content: question,
      createdAt: timestamp
    },
    assistantMessage: {
      id: Number(assistantInfo.lastInsertRowid),
      role: 'assistant',
      content: answer,
      createdAt: nowIso(),
      model
    }
  });
});

/* ------------------------------------------------------------- fertilizer */

router.get('/fertilizer/options', (_req, res) => {
  res.json({ fertilizers: FERTILIZERS, units: UNITS, constants: UNIT_CONSTANTS });
});

router.post('/fertilizer/calculate', requireAuth, (req, res) => {
  const result = calculateFertilizer(req.body || {});
  const timestamp = nowIso();
  const info = db
    .prepare('INSERT INTO fertilizer_calcs (user_id, input, result, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, JSON.stringify(req.body || {}), JSON.stringify(result), timestamp);
  res.json({ id: Number(info.lastInsertRowid), createdAt: timestamp, result });
});

router.get('/fertilizer/history', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, input, result, created_at FROM fertilizer_calcs WHERE user_id = ? ORDER BY id DESC LIMIT 100')
    .all(req.user.id);
  res.json({
    calculations: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      input: parseJson(row.input, {}),
      result: parseJson(row.result, {})
    }))
  });
});

router.delete('/fertilizer/history/:id', requireAuth, (req, res) => {
  const info = db
    .prepare('DELETE FROM fertilizer_calcs WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (info.changes === 0) return bad(res, 'આ ગણતરી મળી નહીં.', 'not_found', 404);
  res.json({ message: 'ગણતરી ડિલીટ થઈ ગઈ.' });
});

/* ---------------------------------------------------------------- history */

router.get('/history/summary', requireAuth, (req, res) => {
  const count = (sql) => db.prepare(sql).get(req.user.id).c;
  res.json({
    reports: count('SELECT COUNT(*) AS c FROM crop_reports WHERE user_id = ?'),
    conversations: count('SELECT COUNT(*) AS c FROM conversations WHERE user_id = ?'),
    fertilizer: count('SELECT COUNT(*) AS c FROM fertilizer_calcs WHERE user_id = ?')
  });
});

/* ------------------------------------------------------------ error mapping */

router.use((error, _req, res, _next) => {
  if (error instanceof FertilizerError) {
    return res.status(400).json({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof AiError) {
    return res.status(error.status || 502).json({ error: { code: error.code, message: error.message } });
  }
  throw error;
});

export default router;
