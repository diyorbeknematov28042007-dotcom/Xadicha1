require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { Pool } = require("pg");

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = [7153696822, 8013328081];

// ═══════════════════════════════════════
// NEON POSTGRESQL
// ═══════════════════════════════════════
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
        username TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz', joined TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT DEFAULT '' );
      CREATE TABLE IF NOT EXISTS legacy (
        id SERIAL PRIMARY KEY, type VARCHAR(20) NOT NULL, title TEXT NOT NULL,
        description TEXT DEFAULT '', year TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz',
        file_id TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS photos ( id SERIAL PRIMARY KEY, file_id TEXT NOT NULL, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW() );
      CREATE TABLE IF NOT EXISTS memory ( id SERIAL PRIMARY KEY, type VARCHAR(10) NOT NULL, file_id TEXT, url TEXT, caption TEXT DEFAULT '', added TIMESTAMP DEFAULT NOW() );
      CREATE TABLE IF NOT EXISTS forced_channels ( id SERIAL PRIMARY KEY, channel TEXT UNIQUE NOT NULL );
      CREATE TABLE IF NOT EXISTS contacts ( id SERIAL PRIMARY KEY, type TEXT NOT NULL UNIQUE, value TEXT NOT NULL );
      CREATE TABLE IF NOT EXISTS quizzes (
        id SERIAL PRIMARY KEY, question TEXT NOT NULL, option_a TEXT NOT NULL, option_b TEXT NOT NULL,
        option_c TEXT NOT NULL, option_d TEXT NOT NULL, correct VARCHAR(1) NOT NULL,
        lang VARCHAR(5) DEFAULT 'uz', added TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS quiz_results ( id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, quiz_id INT NOT NULL, answer VARCHAR(1) NOT NULL, is_correct BOOLEAN NOT NULL, answered_at TIMESTAMP DEFAULT NOW() );
      CREATE TABLE IF NOT EXISTS voice_messages ( id SERIAL PRIMARY KEY, title TEXT DEFAULT '', file_id TEXT NOT NULL, description TEXT DEFAULT '', lang VARCHAR(5) DEFAULT 'uz', added TIMESTAMP DEFAULT NOW() );
    `);
    console.log("✅ Neon PostgreSQL jadvallar tayyor!");
  } catch (err) { console.error("❌ DB init xatosi:", err); }
  finally { client.release(); }
}

// ═══════════════════════════════════════
// DB HELPERS
// ═══════════════════════════════════════
async function q(sql, params = []) { return await pool.query(sql, params); }

async function getSetting(k) { const r = await q("SELECT value FROM settings WHERE key=$1", [k]); return r.rows[0]?.value || ""; }
async function setSetting(k, v) { await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, v]); }

async function upsertUser(msg) {
  const u = msg.from;
  await q("INSERT INTO users(user_id,first_name,last_name,username) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET first_name=$2,last_name=$3,username=$4",
    [u.id, u.first_name||"", u.last_name||"", u.username||""]);
}
async function getUserLang(uid) { const r = await q("SELECT lang FROM users WHERE user_id=$1", [uid]); return r.rows[0]?.lang || "uz"; }
async function setUserLang(uid, lang) { await q("INSERT INTO users(user_id,lang) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET lang=$2", [uid, lang]); }
async function getAllUserIds() { return (await q("SELECT user_id FROM users")).rows.map(r => r.user_id); }
async function countUsers() { return parseInt((await q("SELECT COUNT(*) as c FROM users")).rows[0].c); }
async function countTodayUsers() { return parseInt((await q("SELECT COUNT(*) as c FROM users WHERE joined::date=CURRENT_DATE")).rows[0].c); }
async function getLangStats() { const r = await q("SELECT lang,COUNT(*) as c FROM users GROUP BY lang"); const s={}; for(const x of r.rows) s[x.lang||"uz"]=parseInt(x.c); return s; }

async function addLegacy(type,title,desc,year,lang,fid) { await q("INSERT INTO legacy(type,title,description,year,lang,file_id) VALUES($1,$2,$3,$4,$5,$6)", [type,title,desc||"",year||"",lang||"uz",fid||""]); }
async function getLegacy(type) { return (await q("SELECT * FROM legacy WHERE type=$1 ORDER BY added DESC", [type])).rows; }
async function countLegacy(type) { return parseInt((await q("SELECT COUNT(*) as c FROM legacy WHERE type=$1", [type])).rows[0].c); }

async function addPhoto(fid,cap) { await q("INSERT INTO photos(file_id,caption) VALUES($1,$2)", [fid,cap]); }
async function getPhotos() { return (await q("SELECT * FROM photos ORDER BY added DESC")).rows; }
async function countPhotos() { return parseInt((await q("SELECT COUNT(*) as c FROM photos")).rows[0].c); }

async function addMemory(type,fid,url,cap) { await q("INSERT INTO memory(type,file_id,url,caption) VALUES($1,$2,$3,$4)", [type,fid||null,url||null,cap||""]); }
async function getMemories() { return (await q("SELECT * FROM memory ORDER BY added DESC")).rows; }
async function countMemories() { return parseInt((await q("SELECT COUNT(*) as c FROM memory")).rows[0].c); }

async function getForcedChannels() { return (await q("SELECT channel FROM forced_channels")).rows.map(r=>r.channel); }
async function addForcedChannel(ch) { await q("INSERT INTO forced_channels(channel) VALUES($1) ON CONFLICT(channel) DO NOTHING", [ch]); }
async function removeForcedChannel(ch) { await q("DELETE FROM forced_channels WHERE channel=$1", [ch]); }

async function addContact(t,v) { await q("INSERT INTO contacts(type,value) VALUES($1,$2) ON CONFLICT(type) DO UPDATE SET value=$2", [t,v]); }
async function getContacts() { return (await q("SELECT type,value FROM contacts ORDER BY id")).rows; }

async function addQuiz(question,a,b,c,d,correct,lang) { await q("INSERT INTO quizzes(question,option_a,option_b,option_c,option_d,correct,lang) VALUES($1,$2,$3,$4,$5,$6,$7)", [question,a,b,c,d,correct.toUpperCase(),lang||"uz"]); }
async function getAllQuizzes() { return (await q("SELECT * FROM quizzes ORDER BY id")).rows; }
async function getQuizById(id) { const r = await q("SELECT * FROM quizzes WHERE id=$1", [id]); return r.rows[0]||null; }
async function countQuizzes() { return parseInt((await q("SELECT COUNT(*) as c FROM quizzes")).rows[0].c); }
async function saveQuizResult(uid,qid,ans,ok) { await q("INSERT INTO quiz_results(user_id,quiz_id,answer,is_correct) VALUES($1,$2,$3,$4)", [uid,qid,ans,ok]); }
async function getUserQuizResults(uid) { const r = await q("SELECT COUNT(*) as t, SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) as c FROM quiz_results WHERE user_id=$1", [uid]); return {total:parseInt(r.rows[0].t)||0, correct:parseInt(r.rows[0].c)||0}; }
async function getAnsweredQuizIds(uid) { return (await q("SELECT DISTINCT quiz_id FROM quiz_results WHERE user_id=$1", [uid])).rows.map(r=>r.quiz_id); }

async function addVoiceMsg(title,fid,desc,lang) { await q("INSERT INTO voice_messages(title,file_id,description,lang) VALUES($1,$2,$3,$4)", [title,fid,desc||"",lang||"uz"]); }
async function getVoiceMessages() { return (await q("SELECT * FROM voice_messages ORDER BY added DESC")).rows; }
async function countVoice() { return parseInt((await q("SELECT COUNT(*) as c FROM voice_messages")).rows[0].c); }

// ═══════════════════════════════════════
// EXPRESS + BOT
// ═══════════════════════════════════════
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Xadicha Sulaymonova Bot ishlayapti! 🎓"));
app.get("/health", async (req, res) => { try { res.json({status:"ok",users:await countUsers()}); } catch(e) { res.status(500).json({error:e.message}); } });

const bot = new TelegramBot(TOKEN);
app.post(`/bot${TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

// ═══════════════════════════════════════
// TRANSLATIONS
// ═══════════════════════════════════════
const tr = {
  uz: {
    welcome: "🎓 *Xadicha Sulaymonova haqidagi botga xush kelibsiz!*\n\nO'zbekiston SSR Fanlar akademiyasi akademigi, yuridik fanlar doktori, professor, birinchi o'zbek ayol huquqshunos olima — Xadicha Sulaymonovaga bag'ishlangan bot.\n\nQuyidagi bo'limlardan birini tanlang:",
    menu: "📋 Quyidagi bo'limlardan birini tanlang:",
    choose_lang: "🌐 Tilni tanlang:",
    lang_set: "✅ Til o'zbek tiliga o'zgartirildi.",
    no_data: "📭 Hozircha ma'lumot qo'shilmagan.",
    chat_intro: "💬 *Olima bilan suhbat*\n\nSiz hozir akademik Xadicha Sulaymonova bilan suhbatlashyapsiz. Huquq, jinoyat huquqi, ayollar huquqlari va boshqa mavzularda savol bering.\n\n_Chiqish uchun /menu buyrug'ini yuboring._",
    chat_thinking: "🤔 O'ylayapman...",
    chat_error: "❌ Xatolik yuz berdi. Qaytadan urinib ko'ring.",
    subscribe_first: "📢 Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling va /start bosing:",
    legacy_stats: "📊 *Ilmiy meros statistikasi:*\n\n📝 Maqolalar: {articles}\n📕 Asarlar: {books}\n📘 Darsliklar: {textbooks}",
    admin_only: "⛔️ Bu buyruq faqat adminlar uchun.",
    quiz_correct: "✅ To'g'ri javob!", quiz_wrong: "❌ Noto'g'ri. To'g'ri javob: {correct}",
    quiz_done: "🏆 *Test yakunlandi!*\n\n✅ To'g'ri: {correct}/{total}\n📊 Ball: {percent}%",
    quiz_empty: "📭 Hozircha test savollari qo'shilmagan.",
    quiz_all_done: "✅ Barcha savollarni ishlab bo'lgansiz!\n\n🏆 Natija: {correct}/{total} ({percent}%)\n\nQayta boshlash uchun yana bosing.",
    voice_empty: "📭 Hozircha ovozli tushuntirishlar qo'shilmagan.",
    btn_chat: "💬 Olima bilan suhbat", btn_bio: "📖 Biografiya", btn_legacy: "📚 Ilmiy merosi",
    btn_photos: "🖼 Suratlar", btn_memory: "🕯 Xotirasi", btn_contacts: "📞 Bog'lanish",
    btn_scholarship: "🎓 Stipendiya nizomi", btn_quiz: "📝 Quiz test", btn_voice: "🎙 Ovozli tushuntirish",
    btn_website: "🌐 Maxsus sayt", btn_lang: "🌐 Tilni o'zgartirish", btn_back: "⬅️ Orqaga",
    btn_articles: "📝 Maqolalar", btn_books: "📕 Asarlar", btn_textbooks: "📘 Darsliklar",
  },
  ru: {
    welcome: "🎓 *Добро пожаловать в бот о Хадиче Сулаймановой!*\n\nАкадемик АН Узбекской ССР, доктор юридических наук, профессор, первая узбекская женщина-учёный в области права.\n\nВыберите раздел:",
    menu: "📋 Выберите раздел:",
    choose_lang: "🌐 Выберите язык:", lang_set: "✅ Язык изменён на русский.",
    no_data: "📭 Данные ещё не добавлены.",
    chat_intro: "💬 *Беседа с учёной*\n\nВы беседуете с академиком Хадичой Сулаймановой. Задавайте вопросы по праву, уголовному праву, правам женщин.\n\n_Для выхода отправьте /menu._",
    chat_thinking: "🤔 Думаю...", chat_error: "❌ Произошла ошибка.",
    subscribe_first: "📢 Подпишитесь на каналы и нажмите /start:",
    legacy_stats: "📊 *Научное наследие:*\n\n📝 Статьи: {articles}\n📕 Труды: {books}\n📘 Учебники: {textbooks}",
    admin_only: "⛔️ Только для администраторов.",
    quiz_correct: "✅ Правильно!", quiz_wrong: "❌ Неверно. Правильный ответ: {correct}",
    quiz_done: "🏆 *Тест завершён!*\n\n✅ Правильно: {correct}/{total}\n📊 Балл: {percent}%",
    quiz_empty: "📭 Тесты ещё не добавлены.",
    quiz_all_done: "✅ Вы ответили на все вопросы!\n\n🏆 Результат: {correct}/{total} ({percent}%)",
    voice_empty: "📭 Голосовые пояснения ещё не добавлены.",
    btn_chat: "💬 Беседа с учёной", btn_bio: "📖 Биография", btn_legacy: "📚 Научное наследие",
    btn_photos: "🖼 Фотографии", btn_memory: "🕯 Память", btn_contacts: "📞 Контакты",
    btn_scholarship: "🎓 Стипендия", btn_quiz: "📝 Тест", btn_voice: "🎙 Голосовые",
    btn_website: "🌐 Сайт", btn_lang: "🌐 Сменить язык", btn_back: "⬅️ Назад",
    btn_articles: "📝 Статьи", btn_books: "📕 Труды", btn_textbooks: "📘 Учебники",
  },
  en: {
    welcome: "🎓 *Welcome to Xadicha Sulaymonova Bot!*\n\nFirst Uzbek female legal scholar, Academician, Doctor of Legal Sciences, Professor.\n\nChoose a section:",
    menu: "📋 Choose a section:",
    choose_lang: "🌐 Choose language:", lang_set: "✅ Language changed to English.",
    no_data: "📭 No data added yet.",
    chat_intro: "💬 *Chat with the Scholar*\n\nYou are chatting with Academician Xadicha Sulaymonova. Ask about law, criminal law, women's rights.\n\n_Send /menu to exit._",
    chat_thinking: "🤔 Thinking...", chat_error: "❌ An error occurred.",
    subscribe_first: "📢 Subscribe to channels and press /start:",
    legacy_stats: "📊 *Scientific Legacy:*\n\n📝 Articles: {articles}\n📕 Works: {books}\n📘 Textbooks: {textbooks}",
    admin_only: "⛔️ Admins only.",
    quiz_correct: "✅ Correct!", quiz_wrong: "❌ Wrong. Correct answer: {correct}",
    quiz_done: "🏆 *Quiz completed!*\n\n✅ Correct: {correct}/{total}\n📊 Score: {percent}%",
    quiz_empty: "📭 No quiz questions yet.",
    quiz_all_done: "✅ All questions answered!\n\n🏆 Result: {correct}/{total} ({percent}%)",
    voice_empty: "📭 No voice explanations yet.",
    btn_chat: "💬 Chat with Scholar", btn_bio: "📖 Biography", btn_legacy: "📚 Scientific Legacy",
    btn_photos: "🖼 Photos", btn_memory: "🕯 Memory", btn_contacts: "📞 Contacts",
    btn_scholarship: "🎓 Scholarship", btn_quiz: "📝 Quiz", btn_voice: "🎙 Voice",
    btn_website: "🌐 Website", btn_lang: "🌐 Change Language", btn_back: "⬅️ Back",
    btn_articles: "📝 Articles", btn_books: "📕 Works", btn_textbooks: "📘 Textbooks",
  },
};

async function T(cid, key) { const l = await getUserLang(cid); return (tr[l]&&tr[l][key])||tr.uz[key]||key; }
function isAdmin(uid) { return ADMIN_IDS.includes(uid); }

// ═══════════════════════════════════════
// INLINE KEYBOARDS
// ═══════════════════════════════════════
async function mainMenuKB(cid) {
  return { reply_markup: { inline_keyboard: [
    [{ text: await T(cid,"btn_chat"), callback_data: "chat" }],
    [{ text: await T(cid,"btn_bio"), callback_data: "bio" }, { text: await T(cid,"btn_legacy"), callback_data: "legacy" }],
    [{ text: await T(cid,"btn_photos"), callback_data: "photos" }, { text: await T(cid,"btn_memory"), callback_data: "memory" }],
    [{ text: await T(cid,"btn_scholarship"), callback_data: "scholarship" }, { text: await T(cid,"btn_contacts"), callback_data: "contacts" }],
    [{ text: await T(cid,"btn_quiz"), callback_data: "quiz" }, { text: await T(cid,"btn_voice"), callback_data: "voice" }],
    [{ text: await T(cid,"btn_website"), callback_data: "website" }],
    [{ text: await T(cid,"btn_lang"), callback_data: "change_lang" }],
  ]}, parse_mode: "Markdown" };
}

async function backBtnKB(cid, to="main_menu") {
  return { reply_markup: { inline_keyboard: [[{ text: await T(cid,"btn_back"), callback_data: to }]] }, parse_mode: "Markdown" };
}

function langKB() {
  return { reply_markup: { inline_keyboard: [[
    { text: "🇺🇿 O'zbekcha", callback_data: "lang_uz" },
    { text: "🇷🇺 Русский", callback_data: "lang_ru" },
    { text: "🇬🇧 English", callback_data: "lang_en" },
  ]] } };
}

// ═══════════════════════════════════════
// SUBSCRIPTION + STATES
// ═══════════════════════════════════════
async function checkSub(cid) {
  const chs = await getForcedChannels(); if(chs.length===0) return true;
  for(const ch of chs) { try { const m = await bot.getChatMember(ch,cid); if(["left","kicked"].includes(m.status)) return false; } catch(e){return false;} }
  return true;
}

const chatStates = {}, adminStates = {}, quizStates = {};

// ═══════════════════════════════════════
// GEMINI AI
// ═══════════════════════════════════════
async function askGemini(cid, userMsg) {
  const lang = await getUserLang(cid);
  const langN = {uz:"o'zbek",ru:"russkiy",en:"English"};
  const sys = `Sen akademik Xadicha Sulaymonova (1913-yil 3-iyun, Andijon – 1965-yil 26-noyabr, Toshkent) sifatida javob berasan. Sen ayol olimasan.

Xadicha Sulaymonova haqida:
- 1913-yil Andijonda tug'ilgan
- 1935-yilda birinchi o'zbek ayol xalq sudyasi
- 1945-yilda nomzodlik dissertatsiyasi — huquqshunoslik bo'yicha birinchi o'zbek ayol
- 1951 yuridik fanlar doktori, 1952 professor
- 1956 O'zbekiston SSR Fanlar akademiyasi akademigi
- 1954 O'zbekiston SSRda xizmat ko'rsatgan fan arbobi
- 1956-1958 O'zbekiston SSR Adliya vaziri
- 1959-1964 Yuridik komissiya raisi
- 1964-dan O'zbekiston SSR Oliy sudi raisi
- 80+ ilmiy nashrlar muallifi, 16 ta fan nomzodi tayyorlagan
- Jinoyat huquqi bo'yicha o'zbek tilida birinchi darslik rahbari
- 3 jildlik "O'zbekiston Sovet davlati va huquqi tarixi" hammuallifi
- Xalqaro kongresslarda ishtirok etgan (Amsterdam, London, Sofiya, Qohira, Tokio)
- Respublika sud-ekspertiza markazi tashabbuskori
- Ayollar huquqlari, jinoyat huquqi sohasida izlanishlar

Foydalanuvchi ${langN[lang]} tilida yozyapti. Shu tilda javob ber.
Ayol olima sifatida muloyim, donishmand, ustoza kabi javob ber.`;

  const history = chatStates[cid]?.history || [];
  const contents = [];
  for(const h of history.slice(-10)) contents.push({role:h.role, parts:[{text:h.text}]});
  contents.push({role:"user", parts:[{text:userMsg}]});

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ system_instruction:{parts:[{text:sys}]}, contents, generationConfig:{temperature:0.7,maxOutputTokens:1024} }),
    });
    const data = await res.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || await T(cid,"chat_error");
    if(!chatStates[cid]) chatStates[cid]={mode:"chat",history:[]};
    chatStates[cid].history.push({role:"user",text:userMsg},{role:"model",text:reply});
    if(chatStates[cid].history.length>20) chatStates[cid].history=chatStates[cid].history.slice(-20);
    return reply;
  } catch(e) { console.error("Gemini err:",e); return await T(cid,"chat_error"); }
}

// ═══════════════════════════════════════
// QUIZ LOGIC
// ═══════════════════════════════════════
async function startQuiz(cid) {
  const all = await getAllQuizzes();
  if(all.length===0) return bot.sendMessage(cid, await T(cid,"quiz_empty"), await mainMenuKB(cid));
  const answered = await getAnsweredQuizIds(cid);
  const remaining = all.filter(q=>!answered.includes(q.id));
  if(remaining.length===0) {
    const r = await getUserQuizResults(cid);
    const pct = r.total>0?Math.round(r.correct/r.total*100):0;
    const msg = (await T(cid,"quiz_all_done")).replace("{correct}",r.correct).replace("{total}",r.total).replace("{percent}",pct);
    await q("DELETE FROM quiz_results WHERE user_id=$1",[cid]);
    return bot.sendMessage(cid, msg, await mainMenuKB(cid));
  }
  quizStates[cid] = {ids:remaining.map(q=>q.id), cur:0, correct:0};
  await sendNextQuiz(cid);
}

async function sendNextQuiz(cid) {
  const st = quizStates[cid];
  if(!st || st.cur >= st.ids.length) {
    const total = st?st.ids.length:0, correct = st?st.correct:0;
    const pct = total>0?Math.round(correct/total*100):0;
    const msg = (await T(cid,"quiz_done")).replace("{correct}",correct).replace("{total}",total).replace("{percent}",pct);
    quizStates[cid] = null;
    return bot.sendMessage(cid, msg, await mainMenuKB(cid));
  }
  const quiz = await getQuizById(st.ids[st.cur]);
  if(!quiz) { st.cur++; return sendNextQuiz(cid); }
  const text = `📝 *Savol ${st.cur+1}/${st.ids.length}:*\n\n${quiz.question}\n\nA) ${quiz.option_a}\nB) ${quiz.option_b}\nC) ${quiz.option_c}\nD) ${quiz.option_d}`;
  bot.sendMessage(cid, text, { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[
    {text:"A",callback_data:`qz_${quiz.id}_A`},{text:"B",callback_data:`qz_${quiz.id}_B`},
    {text:"C",callback_data:`qz_${quiz.id}_C`},{text:"D",callback_data:`qz_${quiz.id}_D`},
  ]]}});
}

// ═══════════════════════════════════════
// /start & /menu
// ═══════════════════════════════════════
bot.onText(/\/start/, async (msg) => {
  const cid = msg.chat.id; await upsertUser(msg);
  if(!(await checkSub(cid))) {
    const chs = await getForcedChannels(); let t = (await T(cid,"subscribe_first"))+"\n\n";
    for(const ch of chs) t+=`▪️ ${ch}\n`;
    return bot.sendMessage(cid,t,{parse_mode:"Markdown"});
  }
  chatStates[cid]=null;
  bot.sendMessage(cid, await T(cid,"welcome"), await mainMenuKB(cid));
});
bot.onText(/\/menu/, async (msg) => { chatStates[msg.chat.id]=null; bot.sendMessage(msg.chat.id, await T(msg.chat.id,"menu"), await mainMenuKB(msg.chat.id)); });

// ═══════════════════════════════════════
// ADMIN COMMANDS
// ═══════════════════════════════════════
bot.onText(/\/admin/, async (msg) => {
  const cid=msg.chat.id; if(!isAdmin(msg.from.id)) return bot.sendMessage(cid, await T(cid,"admin_only"));
  bot.sendMessage(cid, `🔧 *Admin Panel*\n\n/add\\_bio — Biografiya\n/add\\_article — Maqola (PDF)\n/add\\_book — Asar (PDF)\n/add\\_textbook — Darslik (PDF)\n/add\\_photo — Surat\n/add\\_memory — Xotira\n/add\\_contact — Bog'lanish\n/add\\_scholarship — Stipendiya\n/add\\_quiz — Test savol\n/add\\_voice — Ovozli xabar\n/add\\_website — Sayt havolasi\n/add\\_channel @kanal\n/remove\\_channel @kanal\n/broadcast — Ommaviy post\n/stats — Statistika`, {parse_mode:"Markdown"});
});

bot.onText(/\/add_bio/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_bio_lang"}; bot.sendMessage(c,"Til?",{reply_markup:{inline_keyboard:[[{text:"🇺🇿",callback_data:"adm_bio_uz"},{text:"🇷🇺",callback_data:"adm_bio_ru"},{text:"🇬🇧",callback_data:"adm_bio_en"}]]}}); });
bot.onText(/\/add_article/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_legacy",type:"articles"}; bot.sendMessage(c,"📝 PDF yuboring. Caption: `Sarlavha | Tavsif | Yil | Til`",{parse_mode:"Markdown"}); });
bot.onText(/\/add_book/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_legacy",type:"books"}; bot.sendMessage(c,"📕 PDF yuboring. Caption: `Nomi | Tavsif | Yil | Til`",{parse_mode:"Markdown"}); });
bot.onText(/\/add_textbook/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_legacy",type:"textbooks"}; bot.sendMessage(c,"📘 PDF yuboring. Caption: `Nomi | Tavsif | Yil | Til`",{parse_mode:"Markdown"}); });
bot.onText(/\/add_photo/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_photo"}; bot.sendMessage(c,"📷 Surat yuboring:"); });
bot.onText(/\/add_memory/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_memory"}; bot.sendMessage(c,"🕯 Surat yoki havola:"); });
bot.onText(/\/add_contact/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_contact"}; bot.sendMessage(c,"`turi | havola`",{parse_mode:"Markdown"}); });
bot.onText(/\/add_scholarship/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_sch_lang"}; bot.sendMessage(c,"Til?",{reply_markup:{inline_keyboard:[[{text:"🇺🇿",callback_data:"adm_sch_uz"},{text:"🇷🇺",callback_data:"adm_sch_ru"},{text:"🇬🇧",callback_data:"adm_sch_en"}]]}}); });
bot.onText(/\/add_quiz/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_quiz"}; bot.sendMessage(c,"Format:\n`Savol\nA) variant\nB) variant\nC) variant\nD) variant\nJavob: A\nTil: uz`",{parse_mode:"Markdown"}); });
bot.onText(/\/add_voice/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_voice"}; bot.sendMessage(c,"🎙 Ovozli xabar yuboring. Caption: `Sarlavha | Tavsif | Til`"); });
bot.onText(/\/add_website/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"add_website"}; bot.sendMessage(c,"🌐 Sayt URL yuboring:"); });
bot.onText(/\/add_channel (.+)/, async(m,match)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return; await addForcedChannel(match[1].trim()); bot.sendMessage(c,`✅ ${match[1].trim()}`); });
bot.onText(/\/remove_channel (.+)/, async(m,match)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return; await removeForcedChannel(match[1].trim()); bot.sendMessage(c,`✅ O'chirildi`); });
bot.onText(/\/broadcast/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only")); adminStates[c]={action:"broadcast"}; bot.sendMessage(c,"📢 Xabar yuboring:"); });
bot.onText(/\/stats/, async(m)=>{ const c=m.chat.id; if(!isAdmin(m.from.id))return bot.sendMessage(c,await T(c,"admin_only"));
  const t=await countUsers(),td=await countTodayUsers(),ls=await getLangStats(),a=await countLegacy("articles"),b=await countLegacy("books"),tb=await countLegacy("textbooks"),p=await countPhotos(),mm=await countMemories(),qc=await countQuizzes(),vc=await countVoice();
  bot.sendMessage(c,`📊 *Statistika*\n\n👥 ${t} | 📅 ${td}\n🇺🇿 ${ls.uz||0} 🇷🇺 ${ls.ru||0} 🇬🇧 ${ls.en||0}\n📝 ${a} 📕 ${b} 📘 ${tb}\n🖼 ${p} 🕯 ${mm} 📝Test: ${qc} 🎙 ${vc}`,{parse_mode:"Markdown"});
});

// ═══════════════════════════════════════
// CALLBACK QUERIES
// ═══════════════════════════════════════
bot.on("callback_query", async (cb) => {
  const cid=cb.message.chat.id, d=cb.data;
  await bot.answerCallbackQuery(cb.id);

  // Sub check
  if(!(await checkSub(cid)) && !d.startsWith("lang_")) {
    const chs=await getForcedChannels(); let t=(await T(cid,"subscribe_first"))+"\n\n";
    for(const ch of chs) t+=`▪️ ${ch}\n`;
    return bot.sendMessage(cid,t,{parse_mode:"Markdown"});
  }

  // Lang
  if(d==="change_lang") return bot.sendMessage(cid, await T(cid,"choose_lang"), langKB());
  if(d.startsWith("lang_")) { await setUserLang(cid,d.replace("lang_","")); await bot.sendMessage(cid, await T(cid,"lang_set")); return bot.sendMessage(cid, await T(cid,"menu"), await mainMenuKB(cid)); }

  // Main menu
  if(d==="main_menu") { chatStates[cid]=null; quizStates[cid]=null; return bot.sendMessage(cid, await T(cid,"menu"), await mainMenuKB(cid)); }

  // Chat
  if(d==="chat") { chatStates[cid]={mode:"chat",history:[]}; return bot.sendMessage(cid, await T(cid,"chat_intro"), await backBtnKB(cid)); }

  // Bio
  if(d==="bio") { const l=await getUserLang(cid); let bio=await getSetting(`biography_${l}`); if(!bio) bio=await getSetting("biography_uz"); if(!bio) return bot.sendMessage(cid,await T(cid,"no_data"),await backBtnKB(cid)); return bot.sendMessage(cid,`📖 *Biografiya*\n\n${bio}`,await backBtnKB(cid)); }

  // Legacy
  if(d==="legacy") {
    const a=await countLegacy("articles"),b=await countLegacy("books"),tb=await countLegacy("textbooks");
    const stats=(await T(cid,"legacy_stats")).replace("{articles}",a).replace("{books}",b).replace("{textbooks}",tb);
    return bot.sendMessage(cid,stats,{parse_mode:"Markdown",reply_markup:{inline_keyboard:[
      [{text:`${await T(cid,"btn_articles")} (${a})`,callback_data:"leg_articles"}],
      [{text:`${await T(cid,"btn_books")} (${b})`,callback_data:"leg_books"}],
      [{text:`${await T(cid,"btn_textbooks")} (${tb})`,callback_data:"leg_textbooks"}],
      [{text:await T(cid,"btn_back"),callback_data:"main_menu"}],
    ]}});
  }
  if(d.startsWith("leg_")) {
    const type=d.replace("leg_",""), items=await getLegacy(type);
    if(items.length===0) return bot.sendMessage(cid,await T(cid,"no_data"),await backBtnKB(cid,"legacy"));
    for(const item of items) {
      if(item.file_id) {
        let cap=`📄 *${item.title}*`; if(item.year) cap+=`\n📅 ${item.year}`; if(item.description) cap+=`\n${item.description}`;
        try { await bot.sendDocument(cid,item.file_id,{caption:cap,parse_mode:"Markdown"}); } catch(e){}
      } else {
        let t=`📄 *${item.title}*`; if(item.year) t+=`\n📅 ${item.year}`; if(item.description) t+=`\n${item.description}`;
        await bot.sendMessage(cid,t,{parse_mode:"Markdown"});
      }
    }
    return bot.sendMessage(cid,`📚 ${items.length} ta`,{parse_mode:"Markdown",reply_markup:{inline_keyboard:[[{text:await T(cid,"btn_back"),callback_data:"legacy"}]]}});
  }

  // Photos
  if(d==="photos") { const ps=await getPhotos(); if(!ps.length) return bot.sendMessage(cid,await T(cid,"no_data"),await backBtnKB(cid)); for(const p of ps){try{await bot.sendPhoto(cid,p.file_id,{caption:p.caption||""});}catch(e){}} return bot.sendMessage(cid,`🖼 ${ps.length}`,await backBtnKB(cid)); }

  // Memory
  if(d==="memory") { const ms=await getMemories(); if(!ms.length) return bot.sendMessage(cid,await T(cid,"no_data"),await backBtnKB(cid)); for(const m of ms){if(m.type==="photo"&&m.file_id){try{await bot.sendPhoto(cid,m.file_id,{caption:m.caption||""});}catch(e){}}else if(m.type==="link") await bot.sendMessage(cid,`🔗 ${m.caption||""}\n${m.url||""}`);} return bot.sendMessage(cid,`🕯 ${ms.length}`,await backBtnKB(cid)); }

  // Contacts
  if(d==="contacts") { const rows=await getContacts(); if(!rows.length) return bot.sendMessage(cid,await T(cid,"no_data"),await backBtnKB(cid)); const icons={instagram:"📷",telegram:"✈️",facebook:"📘",youtube:"🎬",website:"🌐",phone:"📱",email:"📧"}; let t="📞 *Bog'lanish:*\n\n"; for(const r of rows) t+=`${icons[r.type]||"▪️"} ${r.type}: ${r.value}\n`; return bot.sendMessage(cid,t,await backBtnKB(cid)); }

  // Scholarship
  if(d==="scholarship") { const l=await getUserLang(cid); let s=await getSetting(`scholarship_${l}`); if(!s) s=await getSetting("scholarship_uz"); if(!s) return bot.sendMessage(cid,await T(cid,"no_data"),await backBtnKB(cid)); return bot.sendMessage(cid,`🎓 *Stipendiya nizomi*\n\n${s}`,await backBtnKB(cid)); }

  // Quiz
  if(d==="quiz") { chatStates[cid]=null; return startQuiz(cid); }

  // Quiz answer
  if(d.startsWith("qz_")) {
    const parts=d.split("_"), qid=parseInt(parts[1]), ans=parts[2];
    const quiz=await getQuizById(qid); if(!quiz) return;
    const ok=ans===quiz.correct; await saveQuizResult(cid,qid,ans,ok);
    if(ok) { await bot.sendMessage(cid,await T(cid,"quiz_correct")); if(quizStates[cid]) quizStates[cid].correct++; }
    else { const ct=quiz[`option_${quiz.correct.toLowerCase()}`]; await bot.sendMessage(cid,(await T(cid,"quiz_wrong")).replace("{correct}",`${quiz.correct}) ${ct}`)); }
    if(quizStates[cid]) { quizStates[cid].cur++; await sendNextQuiz(cid); }
  }

  // Voice
  if(d==="voice") { const vs=await getVoiceMessages(); if(!vs.length) return bot.sendMessage(cid,await T(cid,"voice_empty"),await backBtnKB(cid)); for(const v of vs){let cap=""; if(v.title) cap+=`🎙 *${v.title}*`; if(v.description) cap+=`\n${v.description}`; try{await bot.sendVoice(cid,v.file_id,{caption:cap,parse_mode:"Markdown"});}catch(e){}} return bot.sendMessage(cid,`🎙 ${vs.length}`,await backBtnKB(cid)); }

  // Website
  if(d==="website") { const url=await getSetting("website_url"); if(!url) return bot.sendMessage(cid,await T(cid,"no_data"),await backBtnKB(cid)); return bot.sendMessage(cid,"🌐",{reply_markup:{inline_keyboard:[[{text:"🌐 Saytga o'tish",url}],[{text:await T(cid,"btn_back"),callback_data:"main_menu"}]]}}); }

  // Admin bio/sch lang
  if(d.startsWith("adm_bio_")) { adminStates[cid]={action:"add_bio_text",lang:d.replace("adm_bio_","")}; return bot.sendMessage(cid,"Biografiya matnini yuboring:"); }
  if(d.startsWith("adm_sch_")) { adminStates[cid]={action:"add_sch_text",lang:d.replace("adm_sch_","")}; return bot.sendMessage(cid,"Stipendiya matnini yuboring:"); }
});

// ═══════════════════════════════════════
// MESSAGE HANDLER (admin + AI chat)
// ═══════════════════════════════════════
bot.on("message", async (msg) => {
  if(!msg.text&&!msg.photo&&!msg.video&&!msg.document&&!msg.voice&&!msg.audio) return;
  if(msg.text&&msg.text.startsWith("/")) return;
  const cid=msg.chat.id; await upsertUser(msg);

  // Admin
  if(isAdmin(msg.from.id)&&adminStates[cid]) {
    const st=adminStates[cid];
    if(st.action==="add_bio_text"&&msg.text) { await setSetting(`biography_${st.lang}`,msg.text); adminStates[cid]=null; return bot.sendMessage(cid,`✅ Biografiya saqlandi.`); }
    if(st.action==="add_legacy"&&msg.document) { const fid=msg.document.file_id,cap=msg.caption||"",p=cap.split("|").map(s=>s.trim()); if(!p[0]) return bot.sendMessage(cid,"❌ Caption kerak"); await addLegacy(st.type,p[0],p[1]||"",p[2]||"",p[3]||"uz",fid); adminStates[cid]=null; return bot.sendMessage(cid,`✅ Qo'shildi: ${p[0]}`); }
    if(st.action==="add_photo"&&msg.photo) { await addPhoto(msg.photo[msg.photo.length-1].file_id,msg.caption||""); adminStates[cid]=null; return bot.sendMessage(cid,"✅ Surat saqlandi."); }
    if(st.action==="add_memory") { if(msg.photo){await addMemory("photo",msg.photo[msg.photo.length-1].file_id,null,msg.caption||"");adminStates[cid]=null;return bot.sendMessage(cid,"✅ Saqlandi.");} else if(msg.text){await addMemory("link",null,msg.text,"");adminStates[cid]=null;return bot.sendMessage(cid,"✅ Saqlandi.");} }
    if(st.action==="add_contact"&&msg.text) { const p=msg.text.split("|").map(s=>s.trim()); if(p.length<2) return bot.sendMessage(cid,"❌ Format: turi | havola"); await addContact(p[0].toLowerCase(),p[1]); adminStates[cid]=null; return bot.sendMessage(cid,`✅ ${p[0]}=${p[1]}`); }
    if(st.action==="add_sch_text"&&msg.text) { await setSetting(`scholarship_${st.lang}`,msg.text); adminStates[cid]=null; return bot.sendMessage(cid,"✅ Stipendiya saqlandi."); }
    if(st.action==="add_quiz"&&msg.text) {
      const lines=msg.text.split("\n").map(l=>l.trim()).filter(Boolean);
      if(lines.length<6) return bot.sendMessage(cid,"❌ 6 qator kerak");
      const question=lines[0],a=lines[1].replace(/^A\)\s*/i,""),b=lines[2].replace(/^B\)\s*/i,""),c=lines[3].replace(/^C\)\s*/i,""),d=lines[4].replace(/^D\)\s*/i,"");
      const correct=lines[5].replace(/^Javob:\s*/i,"").replace(/^Answer:\s*/i,"").trim().toUpperCase().charAt(0);
      if(!["A","B","C","D"].includes(correct)) return bot.sendMessage(cid,"❌ Javob A/B/C/D");
      const lang=lines[6]?lines[6].replace(/^Til:\s*/i,"").trim():"uz";
      await addQuiz(question,a,b,c,d,correct,lang); adminStates[cid]=null;
      return bot.sendMessage(cid,`✅ Test qo'shildi`);
    }
    if(st.action==="add_voice"&&(msg.voice||msg.audio)) { const fid=msg.voice?msg.voice.file_id:msg.audio.file_id; const p=(msg.caption||"").split("|").map(s=>s.trim()); await addVoiceMsg(p[0]||"Ovozli",fid,p[1]||"",p[2]||"uz"); adminStates[cid]=null; return bot.sendMessage(cid,"✅ Ovozli saqlandi."); }
    if(st.action==="add_website"&&msg.text) { await setSetting("website_url",msg.text.trim()); adminStates[cid]=null; return bot.sendMessage(cid,`✅ Sayt: ${msg.text.trim()}`); }
    if(st.action==="broadcast") {
      adminStates[cid]=null; const uids=await getAllUserIds(); let s=0,f=0;
      await bot.sendMessage(cid,`📤 ${uids.length} ta...`);
      for(const uid of uids) { try { if(msg.text) await bot.sendMessage(uid,msg.text,{parse_mode:"Markdown"}); else if(msg.photo) await bot.sendPhoto(uid,msg.photo[msg.photo.length-1].file_id,{caption:msg.caption||""}); else if(msg.video) await bot.sendVideo(uid,msg.video.file_id,{caption:msg.caption||""}); else if(msg.document) await bot.sendDocument(uid,msg.document.file_id,{caption:msg.caption||""}); s++; } catch(e){f++;} if(s%25===0) await new Promise(r=>setTimeout(r,1000)); }
      return bot.sendMessage(cid,`✅ ${s} | ❌ ${f}`);
    }
  }

  // AI Chat
  if(chatStates[cid]?.mode==="chat"&&msg.text) {
    const thinking=await bot.sendMessage(cid,await T(cid,"chat_thinking"));
    const reply=await askGemini(cid,msg.text);
    try{await bot.deleteMessage(cid,thinking.message_id);}catch(e){}
    return bot.sendMessage(cid,reply,{parse_mode:"Markdown",reply_markup:{inline_keyboard:[[{text:await T(cid,"btn_back"),callback_data:"main_menu"}]]}});
  }
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
async function start() {
  await initDB();
  await bot.setWebHook(`${WEBHOOK_URL}/bot${TOKEN}`);
  app.listen(PORT, () => { console.log(`🤖 Xadicha Sulaymonova Bot: ${PORT}`); console.log(`🗄 Neon PostgreSQL`); });
}
start().catch(console.error);
