require('dotenv').config();
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SUBCATS, CAT_LABEL, BOT_STR } = require('./catalogMeta');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'change-me';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v22.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const DATA_FILE = path.join(__dirname, 'data', 'products.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

app.get('/', (req, res) => {
  res.send('Дүкен боты жұмыс істеп тұр. Тауарды басқару үшін /admin бетіне өтіңіз.');
});

/* ---------------- product storage ---------------- */
function loadProducts() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch (e) { return []; }
}
function saveProducts(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

/* ---------------- admin auth ---------------- */
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ---------------- admin REST API ---------------- */
app.get('/api/meta', requireAdmin, (req, res) => {
  res.json({ SUBCATS, CAT_LABEL });
});

app.get('/api/products', requireAdmin, (req, res) => {
  res.json(loadProducts());
});

app.post('/api/products', requireAdmin, (req, res) => {
  const list = loadProducts();
  const p = { id: crypto.randomUUID(), cat: 'women', sub: '', nameKz: '', nameRu: '', price: 0, quality: '', qty: 0, size: '', photoUrl: '', ...req.body };
  list.unshift(p);
  saveProducts(list);
  res.json(p);
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const list = loadProducts();
  const idx = list.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  list[idx] = { ...list[idx], ...req.body, id: list[idx].id };
  saveProducts(list);
  res.json(list[idx]);
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  let list = loadProducts();
  list = list.filter(x => x.id !== req.params.id);
  saveProducts(list);
  res.json({ ok: true });
});

/* ---------------- photo upload ---------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

app.post('/api/upload', requireAdmin, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/uploads/${req.file.filename}` });
});

/* ================= WHATSAPP WEBHOOK ================= */

// Meta-ның webhook-ты растауы / Верификация webhook Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Хабарламаларды қабылдау / Приём сообщений
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Meta-ға дереу жауап беру керек (2 секундтан аспай)
  try {
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];
    if (!message) return; // status update немесе басқа event
    const from = message.from;
    await handleIncoming(from, message);
  } catch (err) {
    console.error('Webhook өңдеу қатесі / Ошибка обработки webhook:', err.message);
  }
});

/* ---------------- session (жады ішінде / в памяти) ---------------- */
const sessions = new Map(); // wa_id -> { lang, cat, sub }
function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, {});
  return sessions.get(from);
}

/* ---------------- WhatsApp жіберу функциялары / функции отправки ---------------- */
const GRAPH_URL = () => `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

async function waSend(payload) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    console.warn('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID орнатылмаған. Хабарлама жіберілмеді.');
    return;
  }
  try {
    await axios.post(GRAPH_URL(), { messaging_product: 'whatsapp', ...payload }, {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('WhatsApp API қатесі / ошибка:', e.response ? e.response.data : e.message);
  }
}

function sendText(to, body) {
  return waSend({ to, type: 'text', text: { body } });
}

// max 3 button, id.title <= 20 таңба / символа
function sendButtons(to, bodyText, buttons) {
  return waSend({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}

// max 10 row / список до 10 строк
function sendList(to, bodyText, buttonText, rows) {
  return waSend({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonText.slice(0, 20),
        sections: [{ title: bodyText.slice(0, 24), rows: rows.slice(0, 10).map(r => ({ id: r.id, title: r.title.slice(0, 24), description: (r.description || '').slice(0, 72) })) }],
      },
    },
  });
}

function sendImage(to, link, caption) {
  return waSend({ to, type: 'image', image: { link, caption } });
}

/* ---------------- бот логикасы / логика бота ---------------- */
async function handleIncoming(from, message) {
  const session = getSession(from);

  let selectedId = null;
  let textBody = '';
  if (message.type === 'interactive') {
    const it = message.interactive;
    if (it.type === 'button_reply') selectedId = it.button_reply.id;
    if (it.type === 'list_reply') selectedId = it.list_reply.id;
  } else if (message.type === 'text') {
    textBody = (message.text.body || '').trim().toLowerCase();
  }

  // Тілді таңдау / Выбор языка
  if (selectedId === 'lang_kz' || selectedId === 'lang_ru') {
    session.lang = selectedId === 'lang_kz' ? 'kz' : 'ru';
    session.cat = null; session.sub = null;
    return sendCategoryMenu(from, session);
  }

  // Санатты таңдау / Выбор категории
  if (selectedId && selectedId.startsWith('cat_')) {
    session.cat = selectedId.replace('cat_', '');
    session.sub = null;
    return sendSubMenu(from, session);
  }

  // Ішкі санатты таңдау / Выбор подкатегории
  if (selectedId && selectedId.startsWith('sub_')) {
    session.sub = selectedId.replace('sub_', '');
    return sendProducts(from, session);
  }

  // Навигация батырмалары
  if (selectedId === 'go_menu') { session.cat = null; session.sub = null; return sendCategoryMenu(from, session); }
  if (selectedId === 'go_back_sub') { session.sub = null; return sendSubMenu(from, session); }

  // Мәтіндік бастау сөздері / Текстовые команды старта
  const startWords = ['start', 'сәлем', 'салем', 'сэлем', 'привет', 'здравствуйте', 'меню', 'мәзір', 'hi', 'hello'];
  if (!session.lang || startWords.includes(textBody)) {
    return sendLangMenu(from);
  }

  // Басқа жағдайда — қазіргі қадамды қайта көрсету
  const s = BOT_STR[session.lang || 'kz'];
  await sendText(from, s.unknown);
  if (session.sub) return sendProducts(from, session);
  if (session.cat) return sendSubMenu(from, session);
  return sendCategoryMenu(from, session);
}

async function sendLangMenu(to) {
  await sendButtons(to, BOT_STR.kz.greeting, BOT_STR.kz.langButtons);
}

async function sendCategoryMenu(to, session) {
  const s = BOT_STR[session.lang];
  const buttons = ['women', 'men', 'children'].map(c => ({ id: `cat_${c}`, title: CAT_LABEL[c][session.lang] }));
  await sendButtons(to, s.askCategory, buttons);
}

async function sendSubMenu(to, session) {
  const s = BOT_STR[session.lang];
  const rows = SUBCATS[session.cat].map(sc => ({ id: `sub_${sc.id}`, title: session.lang === 'kz' ? sc.kz : sc.ru }));
  await sendList(to, s.askSub, s.menuBtn.replace('🏠 ', ''), rows);
}

async function sendProducts(to, session) {
  const s = BOT_STR[session.lang];
  const products = loadProducts().filter(p => p.cat === session.cat && p.sub === session.sub);
  if (products.length === 0) {
    await sendText(to, s.noProducts);
  } else {
    await sendText(to, s.productsFound(products.length));
    for (const p of products) {
      const name = session.lang === 'kz' ? (p.nameKz || p.nameRu) : (p.nameRu || p.nameKz);
      const caption = `*${name}*\n${s.priceLabel}: ${Number(p.price || 0).toLocaleString()} ₸\n${s.qualityLabel}: ${p.quality || '—'}\n${s.sizeLabel}: ${p.size || '—'}\n${s.qtyLabel}: ${p.qty || 0}`;
      if (p.photoUrl) {
        await sendImage(to, p.photoUrl, caption);
      } else {
        await sendText(to, caption);
      }
    }
    await sendText(to, s.orderHint);
  }
  await sendButtons(to, '\u200b', [
    { id: 'go_back_sub', title: s.backBtn },
    { id: 'go_menu', title: s.menuBtn },
  ]);
}

app.listen(PORT, () => console.log(`Сервер іске қосылды / Сервер запущен: порт ${PORT}`));
