require("dotenv").config();

const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("Bot aktif"));
app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
    console.log("Web server açık");
});

const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType
} = require("discord.js");

const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.PGCONNECTIONSTRING || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

/* ================= VERİTABANI TABLOLARI ================= */

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            coins BIGINT DEFAULT 0,
            last_daily BIGINT DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS animals (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            animal TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS levels (
            user_id TEXT PRIMARY KEY,
            xp INTEGER DEFAULT 0,
            level INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS chat_stats (
            user_id TEXT PRIMARY KEY,
            words BIGINT DEFAULT 0,
            coins BIGINT DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY DEFAULT 1,
            count INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS youtube_state (
            id INTEGER PRIMARY KEY DEFAULT 1,
            last_video_id TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS vip_boosts (
            user_id TEXT PRIMARY KEY,
            coin_boost_until BIGINT DEFAULT 0,
            xp_boost_until BIGINT DEFAULT 0,
            sans_artirici INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS mod_logs (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            islem TEXT NOT NULL,
            sebep TEXT DEFAULT 'Belirtilmedi',
            sure TEXT DEFAULT 'Kalıcı',
            yetkili_id TEXT,
            tarih BIGINT NOT NULL
        );
    `);
    await pool.query(`INSERT INTO tickets (id, count) VALUES (1, 1) ON CONFLICT DO NOTHING;`);
    await pool.query(`INSERT INTO youtube_state (id, last_video_id) VALUES (1, '') ON CONFLICT DO NOTHING;`);
    console.log("Veritabanı hazır!");
}

/* ================= VERİTABANI YARDIMCI FONKSİYONLARI ================= */

async function getUser(id) {
    await pool.query(`INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    const res = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return res.rows[0];
}

async function getChatData(id) {
    await pool.query(`INSERT INTO chat_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    const res = await pool.query(`SELECT * FROM chat_stats WHERE user_id = $1`, [id]);
    return res.rows[0];
}

async function getLevelData(id) {
    await pool.query(`INSERT INTO levels (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    const res = await pool.query(`SELECT * FROM levels WHERE user_id = $1`, [id]);
    return res.rows[0];
}

async function getNextTicketId() {
    const res = await pool.query(`UPDATE tickets SET count = count + 1 WHERE id = 1 RETURNING count`);
    return String(res.rows[0].count - 1).padStart(4, "0");
}

async function getVipBoost(userId) {
    await pool.query(`INSERT INTO vip_boosts (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    const res = await pool.query(`SELECT * FROM vip_boosts WHERE user_id = $1`, [userId]);
    return res.rows[0];
}

async function hasCoinBoost(userId) {
    const data = await getVipBoost(userId);
    return parseInt(data.coin_boost_until) > Date.now();
}

async function hasSansArtirici(userId) {
    const data = await getVipBoost(userId);
    return data.sans_artirici > 0;
}

function getVipLevel(member) {
    if (member.roles.cache.has(VIP_PLUS_ROLE)) return 2;
    if (member.roles.cache.has(VIP_ROLE)) return 1;
    return 0;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const TOKEN              = process.env.TOKEN;
const SUPPORT_ROLE       = "1516389895457996850";
const AUTO_ROLE          = "1516220513595162744";
const WELCOME_CHANNEL_ID = "1516790940440985681";
const VIP_ROLE           = "1517595427577266316";
const VIP_PLUS_ROLE      = "1517592377106104371";

/* ================= CONFIG ================= */

const spamMap        = new Map();
const spamWarn       = new Map();
const cooldowns      = new Map();
const ticketCooldown = new Set();

function isSpam(userId, content) {
    const now = Date.now();
    if (!spamMap.has(userId)) spamMap.set(userId, []);
    const msgs = spamMap.get(userId);
    const filtered = msgs.filter(m => now - m.time < 5000);
    filtered.push({ content, time: now });
    spamMap.set(userId, filtered);
    if (filtered.length > 5) return true;
    const ayni = filtered.filter(m => m.content.trim().toLowerCase() === content.trim().toLowerCase());
    if (ayni.length >= 4) return true;
    return false;
}

async function handleSpam(message) {
    const member = message.member;
    if (!member) return;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    if (member.roles.cache.has(SUPPORT_ROLE)) return;

    try {
        const mesajlar = await message.channel.messages.fetch({ limit: 50 });
        const spamMesajlar = mesajlar.filter(m =>
            m.author.id === message.author.id &&
            Date.now() - m.createdTimestamp < 10000
        );
        for (const m of spamMesajlar.values()) {
            try { await m.delete(); } catch {}
        }
    } catch {}

    const now = Date.now();
    if (!spamWarn.has(message.author.id)) spamWarn.set(message.author.id, { count: 0, lastReset: now });
    const warn = spamWarn.get(message.author.id);

    if (now - warn.lastReset > 3600000) {
        warn.count = 0;
        warn.lastReset = now;
    }

    warn.count++;
    spamWarn.set(message.author.id, warn);

    let sureSaniye = 0;
    let mesaj = "";

    if (warn.count === 1) {
        sureSaniye = 30;
        mesaj = `🛑 ${message.author} spam yaptığın için **30 saniye** zaman aşımı aldın!`;
    } else if (warn.count === 2) {
        sureSaniye = 300;
        mesaj = `🛑 ${message.author} tekrar spam! **5 dakika** zaman aşımı aldın!`;
    } else {
        sureSaniye = 3600;
        mesaj = `🛑 ${message.author} spam devam ediyor! **1 saat** zaman aşımı aldın!`;
    }

    try {
        await member.timeout(sureSaniye * 1000, "Otomatik spam koruması");
        await pool.query(
            `INSERT INTO mod_logs (user_id, islem, sebep, sure, yetkili_id, tarih) VALUES ($1, $2, $3, $4, $5, $6)`,
            [message.author.id, "Mute", "Otomatik spam koruması", `${sureSaniye} saniye`, client.user.id, Date.now()]
        );
        const uyari = await message.channel.send(mesaj);
        setTimeout(() => uyari.delete().catch(() => {}), 5000);
    } catch {}
}

function hasCooldown(userId, cmd, ms) {
    const now = Date.now();
    if (!cooldowns.has(userId)) cooldowns.set(userId, {});
    const userCd = cooldowns.get(userId);
    if (!userCd[cmd] || now - userCd[cmd] > ms) {
        userCd[cmd] = now;
        return false;
    }
    return true;
}

/* ================= GELİŞMİŞ KÜFÜR KONTROL SİSTEMİ ================= */

// Türkçe ve yaygın karakter değiştirmelerini normalleştir
function normalizeText(text) {
    return text
        .toLowerCase()
        // Sayı → harf (leetspeak)
        .replace(/0/g, 'o')
        .replace(/1/g, 'i')
        .replace(/3/g, 'e')
        .replace(/4/g, 'a')
        .replace(/5/g, 's')
        .replace(/6/g, 'g')
        .replace(/7/g, 't')
        .replace(/8/g, 'b')
        .replace(/9/g, 'g')
        // Türkçe harf → latin
        .replace(/ş/g, 's')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/ı/g, 'i')
        .replace(/İ/g, 'i')
        .replace(/Ş/g, 's')
        .replace(/Ğ/g, 'g')
        .replace(/Ü/g, 'u')
        .replace(/Ö/g, 'o')
        .replace(/Ç/g, 'c')
        // @ → a, $ → s gibi sembol değiştirme
        .replace(/@/g, 'a')
        .replace(/\$/g, 's')
        .replace(/!/g, 'i')
        .replace(/\+/g, 't')
        // Tüm boşluk, nokta, tire, alt çizgi, yıldız vb. sembolleri sil
        .replace(/[\s\.\-\_\*\,\;\:\'\"\`\~\^\|\\\/#%&\(\)\[\]\{\}<>]/g, '')
        // Geri kalan özel karakterleri sil
        .replace(/[^a-z0-9]/g, '');
}

// Tekrar eden harfleri tek hale getir: "sssik" → "sik", "oorroosspppuu" → "orospu"
function collapseRepeats(text) {
    return text.replace(/(.)\1+/g, '$1');
}

// Araya eklenmiş noktalama/boşlukları temizle: "s.i.k" → "sik"
function removeSeparators(text) {
    return text.replace(/[.\-_\s*]+/g, '');
}

const kufurListesi = [
    // Temel küfürler
    "orospu", "orospucocugu", "orosbucocugu", "oc", "got", "sik", "yarrak",
    "amk", "bok", "pic", "piclik", "ibne", "kahpe", "kaltak", "surtuk",
    "fahise", "haysiyetsiz", "serefsiz", "namussuz", "alcak", "rezil",
    "asagilik", "soysuz", "adi", "oe", "or", "siktir", "it",
    // Varyantlar ve türevler
    "bok", "boktan", "boklar", "orospu", "orospular",
    "sikik", "sikiyor", "sikeyim", "siksin", "sikerim",
    "gotlek", "gote", "gotur", "gotunu",
    "yaragi", "yarrak", "yarragi",
    "amcik", "amina", "aminakoyim", "aminakoyayim",
    "piclerin", "picler", "picin",
    "ibnelik", "ibneler",
    "siktiret", "siktirin", "siktirip",
    "oruspu", "orusbucocugu",
    "ocunu", "ocunun",
    "kahpeler", "kahpenin",
    "kaltaklar",
    "sururuk", "surtukluk",
    "salak", "aptal", "geri",
    // İngilizce küfürler
    "fuck", "fucker", "fucking", "fck", "fuk", "fuking",
    "shit", "sht", "shitt",
    "bitch", "btch", "bich",
    "asshole", "ass", "arse",
    "cunt", "cnt",
    "dick", "dck", "dik",
    "cock", "cok",
    "nigga", "niger", "nigger",
    "bastard", "bstrd",
    "whore", "whor",
    "slut", "slt",
    "pussy", "psy",
    "motherfucker", "mf", "mofo",
    "damn", "dmn",
    "idiot", "idot",
    "retard", "retarded"
];

const hakaretListesi = [
    "defol", "gitburdan", "cekil", "lanet", "kahrolsun",
    "geber", "ol", "kahret", "lanetli", "lanekolsun",
    "haysiyetsiz", "serefsiz", "namussuz", "rezalet", "utanmaz",
    "yuzsuz", "arsiz", "gerizerali", "gerizekalili", "mal",
    "yavsak", "dangalak", "gerizekalı", "gerizekalinin",
    "senin", "anneni", "bacini", "karini",
    "suicide", "kendinioldur", "olsun", "ezik", "pislik",
    "serserim", "serseri", "zibidi", "hergele", "kevaşe",
    "kerase", "otuzbir", "lavuk", "ocun", "ocunu"
];

// Regex tabanlı esnek eşleşme: kelime içinde rastgele karakter toleransı
function buildFlexRegex(word) {
    // Her harf arasına isteğe bağlı [^a-z]* ekle
    const escaped = word.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z]*');
    return new RegExp(escaped, 'i');
}

// Önceden regex'leri derle (performans için)
const kufurRegexler = kufurListesi.map(k => ({
    kelime: k,
    regex: buildFlexRegex(normalizeText(k))
}));

const hakaretRegexler = hakaretListesi.map(h => ({
    kelime: h,
    regex: buildFlexRegex(normalizeText(h))
}));

function kufurKontrol(icerik) {
    // 4 farklı normalize edilmiş versiyon üret
    const versiyonlar = [
        normalizeText(icerik),
        collapseRepeats(normalizeText(icerik)),
        normalizeText(removeSeparators(icerik)),
        collapseRepeats(normalizeText(removeSeparators(icerik)))
    ];

    for (const versiyon of versiyonlar) {
        for (const { regex } of kufurRegexler) {
            if (regex.test(versiyon)) return true;
        }
    }
    return false;
}

function hakaretKontrol(icerik) {
    const versiyonlar = [
        normalizeText(icerik),
        collapseRepeats(normalizeText(icerik)),
        normalizeText(removeSeparators(icerik)),
        collapseRepeats(normalizeText(removeSeparators(icerik)))
    ];

    for (const versiyon of versiyonlar) {
        for (const { regex } of hakaretRegexler) {
            if (regex.test(versiyon)) return true;
        }
    }
    return false;
}

async function handleKufur(message, tur) {
    const member = message.member;
    if (!member) return;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    if (member.roles.cache.has(SUPPORT_ROLE)) return;

    try { await message.delete(); } catch {}

    let sureSaniye = 0;
    let mesaj = "";

    if (tur === "kufur") {
        sureSaniye = 10800;
        mesaj = `🤬 ${message.author} küfür ettiği için **3 saat** zaman aşımı aldı!`;
    } else {
        sureSaniye = 3600;
        mesaj = `⚠️ ${message.author} hakaret ettiği için **1 saat** zaman aşımı aldı!`;
    }

    try {
        await member.timeout(sureSaniye * 1000, `Otomatik: ${tur}`);
        await pool.query(
            `INSERT INTO mod_logs (user_id, islem, sebep, sure, yetkili_id, tarih) VALUES ($1, $2, $3, $4, $5, $6)`,
            [message.author.id, "Mute", `Otomatik: ${tur}`, `${sureSaniye} saniye`, client.user.id, Date.now()]
        );
        const uyari = await message.channel.send(mesaj);
        setTimeout(() => uyari.delete().catch(() => {}), 6000);
    } catch {}
}

/* ================= READY ================= */

client.once("ready", async () => {
    console.log(`${client.user.tag} aktif!`);
    await initDB();
    await initSonVideoId();
    youtubeKontrol();
    setInterval(youtubeKontrol, 3 * 60 * 1000);
});

/* ================= JOIN ================= */

client.on("guildMemberAdd", async (member) => {
    try {
        const role = member.guild.roles.cache.get(AUTO_ROLE);
        if (role) await member.roles.add(role);
        const ch = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
        if (ch) ch.send(`🎉 Sunucumuza hoş geldin ${member}! Kuralları okumayı unutma ❤️`);
    } catch (e) {
        console.error("guildMemberAdd hatası:", e);
    }
});

/* ================= MESSAGE ================= */

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (isSpam(message.author.id, message.content)) {
        await handleSpam(message);
        return;
    }

    // Küfür kontrolü
    if (kufurKontrol(message.content)) {
        await handleKufur(message, "kufur");
        return;
    }

    // Hakaret kontrolü
    if (hakaretKontrol(message.content)) {
        await handleKufur(message, "hakaret");
        return;
    }

    const args = message.content.trim().split(/\s+/);
    const cmd  = args[0].toLowerCase();
    const uid  = message.author.id;

    /* ---------- LEVEL ---------- */
    const levelData = await getLevelData(uid);
    const newXp = levelData.xp + Math.floor(Math.random() * 10) + 5;
    if (newXp >= levelData.level * 120) {
        await pool.query(`UPDATE levels SET xp = 0, level = level + 1 WHERE user_id = $1`, [uid]);
        const newLevel = levelData.level + 1;
        message.channel.send(`🎉 ${message.author} level atladı! Level: **${newLevel}**`);
    } else {
        await pool.query(`UPDATE levels SET xp = $1 WHERE user_id = $2`, [newXp, uid]);
    }

    /* ---------- CHAT REWARD ---------- */
    await getChatData(uid);
    await pool.query(`UPDATE chat_stats SET words = words + $1 WHERE user_id = $2`, [args.length, uid]);
    const chatData = await getChatData(uid);

    const rewards = [
        { words: 1000,   coins: 500,    col: "reward_10000"     },
        { words: 5000,   coins: 1500,   col: "reward_50000"     },
        { words: 10000,  coins: 3000,   col: "reward_80000"     },
        { words: 25000,  coins: 6000,   col: "reward_100000"    },
        { words: 50000,  coins: 12000,  col: "reward_200000"    },
        { words: 100000, coins: 25000,  col: "reward_500000"    },
        { words: 250000, coins: 60000,  col: "reward_1000000"   },
        { words: 500000, coins: 120000, col: "reward_2000000"   },
    ];

    // Döngü sistemi: toplam kelimeyi 500.000'e bölerek hangi turda olduğunu bul
    const dongu = Math.floor(chatData.words / 500000);
    const donguBasiKelime = dongu * 500000;
    const donguIciKelime = chatData.words - donguBasiKelime;
    const donguSonuKelime = donguBasiKelime - 500000 >= 0 ? (dongu - 1) * 500000 : 0;

    // O tur için hangi milestone'ların alınıp alınmadığını kontrol et
    // Her tur için flag'i sıfırlamak yerine, toplam kelime bazlı kontrol yapıyoruz
    for (const reward of rewards) {
        const hedef = donguBasiKelime + reward.words;
        const oncekiHedef = donguBasiKelime - 500000 + reward.words;

        // Bu milestona bu turda ulaşıldı mı?
        if (chatData.words >= hedef) {
            // Bir önceki mesajdan önce bu hedefe ulaşılmadıysa ödül ver
            const oncekiKelime = chatData.words - args.length;
            if (oncekiKelime < hedef) {
                const gercekOdul = await hasCoinBoost(uid) ? reward.coins * 2 : reward.coins;
                await pool.query(`UPDATE chat_stats SET coins = coins + $1 WHERE user_id = $2`, [gercekOdul, uid]);
                const boostNotu = await hasCoinBoost(uid) ? " 💰 (Coin Boost aktif, 2x!)" : "";
                const turNotu = dongu > 0 ? ` *(${dongu + 1}. tur)*` : "";
                message.channel.send(`🏆 Tebrikler ${message.author}, **${reward.words.toLocaleString()}** kelimeye ulaştın!${turNotu} **+${gercekOdul.toLocaleString()} coin**${boostNotu}`);
            }
        }
    }

    /* ---------- FUN ---------- */
    if (cmd === "!ping") return message.reply(`🏓 ${client.ws.ping}ms`);
    if (cmd === "!roll") return message.reply(`🎲 ${Math.floor(Math.random() * 100) + 1}`);
    if (cmd === "!coin") return message.reply(Math.random() < 0.5 ? "🪙 Yazı" : "🪙 Tura");

    /* ---------- CUSTOM ---------- */
    if (cmd === "!yt" || cmd === "!youtube") return message.reply("Youtube = @freaktsingmc");

    /* ---------- ECONOMY ---------- */
    if (cmd === "!balance" || cmd === "!bal") {
        const user = await getUser(uid);
        const chat = await getChatData(uid);
        return message.reply(`💰 Bakiyen: **${user.coins + chat.coins}** coin`);
    }

    if (cmd === "!hunt") {
        const vip = getVipLevel(message.member);
        let cooldownMs = 10000;
        if (vip === 1) cooldownMs = 5000;
        if (vip === 2) cooldownMs = 2500;
        if (hasCooldown(uid, "hunt", cooldownMs)) return message.reply(`⏳ Hunt için ${cooldownMs / 1000} saniye bekle!`);
        const user = await getUser(uid);
        if (user.coins < 10) return message.reply("❌ Hunt için 10 coin gerekiyor, yeterli paran yok!");

        // Ağırlıklı nadirlik sistemi (toplam %100)
        const hayvanlar = [
            { isim: "🐰 Tavşan",      sans: 20,   satis: 15,  nadir: "⬜ Yaygın"   },
            { isim: "🐺 Kurt",         sans: 17,   satis: 15,  nadir: "⬜ Yaygın"   },
            { isim: "🐻 Ayı",          sans: 18,   satis: 15,  nadir: "⬜ Yaygın"   },
            { isim: "🦊 Tilki",        sans: 17,   satis: 15,  nadir: "⬜ Yaygın"   },
            { isim: "🐸 Kurbağa",      sans: 12,   satis: 15,  nadir: "🟩 Az Nadir" },
            { isim: "🦅 Kartal",       sans: 5,    satis: 22,  nadir: "🟦 Nadir"    },
            { isim: "🦁 Aslan",        sans: 3,    satis: 25,  nadir: "🟦 Nadir"    },
            { isim: "🦄 Unicorn",      sans: 4,    satis: 25,  nadir: "🟪 Epik"     },
            { isim: "🐉 Ejderha",      sans: 3.5,  satis: 55,  nadir: "🟪 Epik"     },
            { isim: "🐠 Japon Balığı", sans: 0.5,  satis: 320, nadir: "🟡 Efsanevi" },
        ];

        function rastgeleHayvan(liste) {
            const toplam = liste.reduce((t, h) => t + h.sans, 0);
            let r = Math.random() * toplam;
            for (const h of liste) {
                r -= h.sans;
                if (r <= 0) return h;
            }
            return liste[liste.length - 1];
        }

        const sansVar = await hasSansArtirici(uid);
        let bulunan;

        if (sansVar) {
            // Şans artırıcı: nadir hayvanlara 3x ağırlık ver
            const guclendirilmis = hayvanlar.map(h => ({
                ...h,
                sans: h.satis >= 22 ? h.sans * 3 : h.sans
            }));
            bulunan = rastgeleHayvan(guclendirilmis);
            await pool.query(`UPDATE vip_boosts SET sans_artirici = sans_artirici - 1 WHERE user_id = $1`, [uid]);
            const kalan = await getVipBoost(uid).sans_artirici;
            await pool.query(`INSERT INTO animals (user_id, animal) VALUES ($1, $2)`, [uid, bulunan.isim]);
            await pool.query(`UPDATE users SET coins = coins - 10 WHERE id = $1`, [uid]);
            return message.reply(`🎯 **${bulunan.isim}** yakaladın! ${bulunan.nadir} — Satış değeri: **${bulunan.satis} coin** | **-10 coin** harcandı.\n✨ Şans artırıcı kullanıldı! (${kalan} kullanım kaldı)`);
        } else {
            bulunan = rastgeleHayvan(hayvanlar);
        }

        await pool.query(`INSERT INTO animals (user_id, animal) VALUES ($1, $2)`, [uid, bulunan.isim]);
        await pool.query(`UPDATE users SET coins = coins - 10 WHERE id = $1`, [uid]);
        return message.reply(`🎯 **${bulunan.isim}** yakaladın! ${bulunan.nadir} — Satış değeri: **${bulunan.satis} coin** | **-10 coin** harcandı.`);
    }

    if (cmd === "!zoo") {
        const res = await pool.query(`SELECT animal FROM animals WHERE user_id = $1`, [uid]);
        const rows = res.rows;
        if (rows.length === 0) return message.reply("📭 Henüz hiç hayvanın yok!");
        return message.reply(`🦁 Hayvanların (${rows.length}): ${rows.map(r => r.animal).join(", ")}`);
    }

    if (cmd === "!sell") {
        const res = await pool.query(`SELECT id, animal FROM animals WHERE user_id = $1`, [uid]);
        const rows = res.rows;
        if (rows.length < 5) return message.reply(`❌ Satış yapabilmek için en az **5 hayvanın** olması gerekiyor! Şu an: **${rows.length}**`);

        const satisFiyati = {
            "🐰 Tavşan": 15, "🐺 Kurt": 15, "🐻 Ayı": 15,
            "🦊 Tilki": 15, "🐸 Kurbağa": 15,
            "🦅 Kartal": 22, "🦁 Aslan": 25, "🦄 Unicorn": 25,
            "🐉 Ejderha": 55, "🐠 Japon Balığı": 320
        };

        function hesaplaKazanc(liste) {
            return liste.reduce((t, r) => t + (satisFiyati[r.animal] || 15), 0);
        }

        const miktar = parseInt(args[1]);

        if (!isNaN(miktar) && miktar > 0) {
            if (miktar > rows.length) return message.reply(`❌ Sadece **${rows.length}** hayvanın var, ${miktar} tane satamazsın!`);
            const satilacaklar = rows.slice(-miktar);
            const kazanc = hesaplaKazanc(satilacaklar);
            satilacaklar.forEach(r => pool.query(`DELETE FROM animals WHERE id = $1`, [r.id]));
            await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [kazanc, uid]);
            return message.reply(`💸 **${miktar}** hayvan sattın! **+${kazanc} coin**`);
        }

        const toplamKazanc = hesaplaKazanc(rows);
        const onayMesaj = await message.channel.send(
            `⚠️ ${message.author} **${rows.length} hayvanının tümünü** satmak istediğinden emin misin?\n` +
            `Kazanacağın: **${toplamKazanc} coin**\n\n` +
            `✅ Onaylamak için \`evet\` yaz\n❌ İptal için \`hayır\` yaz`
        );

        const filter = m => m.author.id === uid && ["evet", "hayır", "hayir"].includes(m.content.trim().toLowerCase());
        const collector = message.channel.createMessageCollector({ filter, time: 15000, max: 1 });

        collector.on("collect", async m => {
            try { await m.delete(); } catch {}
            try { await onayMesaj.delete(); } catch {}

            if (m.content.trim().toLowerCase() === "evet") {
                rows.forEach(r => pool.query(`DELETE FROM animals WHERE id = $1`, [r.id]));
                await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [toplamKazanc, uid]);
                message.channel.send(`💸 **${rows.length}** hayvanın satıldı! **+${toplamKazanc} coin**`);
            } else {
                message.channel.send(`↩️ Satış iptal edildi. Belirli sayıda satmak için \`!sell <miktar>\` kullanabilirsin.\nÖrn: \`!sell 3\``);
            }
        });

        collector.on("end", (_, reason) => {
            if (reason === "time") {
                try { onayMesaj.delete(); } catch {}
                message.channel.send("⏰ Süre doldu, satış iptal edildi.");
            }
        });

        return;
    }

    if (cmd === "!cf") {
        if (hasCooldown(uid, "cf", 5000)) return message.reply("⏳ Coinflip için 5 saniye bekle!");
        const amount = parseInt(args[1]);
        if (isNaN(amount) || amount <= 0) return message.reply("❌ Geçerli miktar yaz. Örn: `!cf 100`");
        const user = await getUser(uid);
        if (user.coins < amount) return message.reply("❌ Yeterli paran yok!");
        const win = Math.random() < 0.5;
        if (win) {
            await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [amount, uid]);
            return message.reply(`🎉 Kazandın! +${amount} coin`);
        } else {
            await pool.query(`UPDATE users SET coins = coins - $1 WHERE id = $2`, [amount, uid]);
            return message.reply(`💸 Kaybettin! -${amount} coin`);
        }
    }

    if (cmd === "!daily") {
        const user = await getUser(uid);
        const now = Date.now();
        if (now - user.last_daily < 86400000) return message.reply("⏳ Günlük ödülünü zaten aldın!");
        const vip = getVipLevel(message.member);
        let odul = 500;
        let etiket = "";
        if (vip === 2) { odul = 2000; etiket = " 👑 VIP+ bonusu!"; }
        else if (vip === 1) { odul = 1000; etiket = " ⭐ VIP bonusu!"; }
        await pool.query(`UPDATE users SET coins = coins + $1, last_daily = $2 WHERE id = $3`, [odul, now, uid]);
        return message.reply(`🎁 Günlük ödülünü aldın! **+${odul} coin**${etiket}`);
    }

    /* ---------- SUNUCU İSTATİSTİKLERİ ---------- */
    if (cmd === "!sunucu" || cmd === "!server") {
        const guild = message.guild;
        await guild.members.fetch();
        const toplamUye    = guild.memberCount;
        const botSayisi    = guild.members.cache.filter(m => m.user.bot).size;
        const insanSayisi  = toplamUye - botSayisi;
        const onlineSayisi = guild.members.cache.filter(m => m.presence?.status === "online").size;
        const kanalSayisi  = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size;
        const sesSayisi    = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
        const rolSayisi    = guild.roles.cache.size - 1;
        const kurucuDate   = `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`;

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${guild.name} — Sunucu İstatistikleri`)
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .addFields(
                { name: "👥 Toplam Üye",    value: `${toplamUye}`, inline: true },
                { name: "🧑 İnsan",          value: `${insanSayisi}`, inline: true },
                { name: "🤖 Bot",            value: `${botSayisi}`, inline: true },
                { name: "🟢 Çevrimiçi",      value: `${onlineSayisi}`, inline: true },
                { name: "💬 Metin Kanalı",   value: `${kanalSayisi}`, inline: true },
                { name: "🔊 Ses Kanalı",     value: `${sesSayisi}`, inline: true },
                { name: "🎭 Rol Sayısı",     value: `${rolSayisi}`, inline: true },
                { name: "📅 Kuruluş Tarihi", value: kurucuDate, inline: true }
            )
            .setColor(0x5865F2)
            .setFooter({ text: "Freaktsing • Sunucu Bilgisi" })
            .setTimestamp();

        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === "!profil") {
        const hedef = message.mentions.members.first() || message.member;
        const user  = await getUser(hedef.id);
        const chat  = await getChatData(hedef.id);
        const lvl   = await getLevelData(hedef.id);
        const hayvanlarRes = await pool.query(`SELECT COUNT(*) as sayi FROM animals WHERE user_id = $1`, [hedef.id]);
        const hayvanlar = hayvanlarRes.rows[0];
        const katilma = `<t:${Math.floor(hedef.joinedTimestamp / 1000)}:D>`;

        const embed = new EmbedBuilder()
            .setTitle(`👤 ${hedef.user.username} — Profil`)
            .setThumbnail(hedef.user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: "⭐ Level",        value: `${lvl.level}`, inline: true },
                { name: "✨ XP",           value: `${lvl.xp}`, inline: true },
                { name: "💰 Coin",         value: `${user.coins + chat.coins}`, inline: true },
                { name: "🦁 Hayvan",       value: `${hayvanlar.sayi}`, inline: true },
                { name: "💬 Kelime",       value: `${chat.words.toLocaleString()}`, inline: true },
                { name: "📅 Katılma",      value: katilma, inline: true }
            )
            .setColor(0x5865F2)
            .setFooter({ text: "Freaktsing • Profil" })
            .setTimestamp();

        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === "!sıralama" || cmd === "!lb") {
        const res = await pool.query(`SELECT id, coins FROM users ORDER BY coins DESC LIMIT 10`);
        const topUsers = res.rows;
        if (topUsers.length === 0) return message.reply("📭 Henüz veri yok.");

        const liste = await Promise.all(topUsers.map(async (u, i) => {
            const chat  = await getChatData(u.id);
            const toplam = parseInt(u.coins) + parseInt(chat.coins);
            try {
                const member = await message.guild.members.fetch(u.id).catch(() => null);
                const isim = member ? member.user.username : `Bilinmeyen (${u.id})`;
                const madalya = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i+1}.**`;
                return `${madalya} ${isim} — **${toplam.toLocaleString()}** coin`;
            } catch { return null; }
        }));

        const embed = new EmbedBuilder()
            .setTitle("🏆 Coin Sıralaması — Top 10")
            .setDescription(liste.filter(Boolean).join("\n"))
            .setColor(0xFFD700)
            .setFooter({ text: "Freaktsing • Sıralama" })
            .setTimestamp();

        return message.channel.send({ embeds: [embed] });
    }

    /* ---------- MİNİ OYUNLAR ---------- */

    if (cmd === "!ttt") {
        const rakip = message.mentions.members.first();
        if (!rakip || rakip.id === message.author.id)
            return message.reply("❌ Kullanım: `!ttt @rakip`");
        if (rakip.user.bot)
            return message.reply("❌ Botla oynayamazsın!");

        const user1 = await getUser(message.author.id);
        const user2 = await getUser(rakip.id);
        if (user1.coins < 15) return message.reply("❌ Oynamak için **15 coin** gerekiyor, yeterli paran yok!");
        if (user2.coins < 15) return message.reply(`❌ ${rakip} yeterli coini yok! (15 coin gerekli)`);

        await pool.query(`UPDATE users SET coins = coins - 15 WHERE id = $1`, [message.author.id]);
        await pool.query(`UPDATE users SET coins = coins - 15 WHERE id = $1`, [rakip.id]);

        const board  = ["1","2","3","4","5","6","7","8","9"];
        let siradaki = message.author.id;
        const oyuncular = { X: message.author.id, O: rakip.id };

        function boardGoster() {
            return `\`\`\`\n${board[0]} | ${board[1]} | ${board[2]}\n---------\n${board[3]} | ${board[4]} | ${board[5]}\n---------\n${board[6]} | ${board[7]} | ${board[8]}\n\`\`\``;
        }

        function kazananKontrol() {
            const k = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
            for (const [a,b,c] of k) {
                if (board[a] === board[b] && board[b] === board[c]) return board[a];
            }
            if (board.every(x => x === "X" || x === "O")) return "berabere";
            return null;
        }

        const ilkMesaj = await message.channel.send(
            `🎮 **Yazı Taşı** — ${message.author} (X) vs ${rakip} (O) | Giriş: -15 coin\n${boardGoster()}\n⏳ ${message.author} hamleni yap! (1-9 arası yaz)`
        );

        const filter = m => [message.author.id, rakip.id].includes(m.author.id) && /^[1-9]$/.test(m.content.trim());
        const collector = message.channel.createMessageCollector({ filter, time: 60000 });

        collector.on("collect", async m => {
            if (m.author.id !== siradaki) return;
            const idx = parseInt(m.content.trim()) - 1;
            const sembol = oyuncular.X === siradaki ? "X" : "O";
            if (board[idx] === "X" || board[idx] === "O") return m.reply("❌ O kare dolu!");
            board[idx] = sembol;
            try { await m.delete(); } catch {}

            const sonuc = kazananKontrol();
            if (sonuc) {
                collector.stop();
                if (sonuc === "berabere") {
                    await pool.query(`UPDATE users SET coins = coins + 15 WHERE id = $1`, [message.author.id]);
                    await pool.query(`UPDATE users SET coins = coins + 15 WHERE id = $1`, [rakip.id]);
                    return ilkMesaj.edit(`🎮 **Yazı Taşı**\n${boardGoster()}\n🤝 **Berabere! Coinler iade edildi.**`);
                }
                const kazanan = sonuc === "X" ? message.author : rakip;
                await pool.query(`UPDATE users SET coins = coins + 30 WHERE id = $1`, [kazanan.id]);
                return ilkMesaj.edit(`🎮 **Yazı Taşı**\n${boardGoster()}\n🏆 **${kazanan} kazandı! +30 coin**`);
            }

            siradaki = siradaki === message.author.id ? rakip.id : message.author.id;
            const siradakiMention = siradaki === message.author.id ? message.author : rakip;
            ilkMesaj.edit(`🎮 **Yazı Taşı** — ${message.author} (X) vs ${rakip} (O)\n${boardGoster()}\n⏳ ${siradakiMention} hamleni yap!`);
        });

        collector.on("end", async (_, reason) => {
            if (reason === "time") {
                await pool.query(`UPDATE users SET coins = coins + 15 WHERE id = $1`, [message.author.id]);
                await pool.query(`UPDATE users SET coins = coins + 15 WHERE id = $1`, [rakip.id]);
                ilkMesaj.edit(`🎮 **Yazı Taşı**\n${boardGoster()}\n⏰ Süre doldu, coinler iade edildi!`);
            }
        });

        return;
    }

    if (cmd === "!tahmin") {
        if (hasCooldown(uid, "tahmin", 30000)) return message.reply("⏳ 30 saniye bekle!");
        const user = await getUser(uid);
        if (user.coins < 15) return message.reply("❌ Oynamak için **15 coin** gerekiyor!");
        await pool.query(`UPDATE users SET coins = coins - 15 WHERE id = $1`, [uid]);

        const sayi = Math.floor(Math.random() * 100) + 1;
        let deneme = 0;

        const msg = await message.channel.send(`🎯 **Sayı Tahmin** — 1 ile 100 arasında bir sayı tuttum! (**-15 coin**)\n30 saniye içinde tahmin et, 7 hakkın var. Kazanırsan **+30 coin**!`);

        const filter = m => m.author.id === uid && !isNaN(m.content.trim()) && m.content.trim() !== "";
        const collector = message.channel.createMessageCollector({ filter, time: 30000, max: 7 });

        collector.on("collect", async m => {
            deneme++;
            const tahmin = parseInt(m.content.trim());
            try { await m.delete(); } catch {}

            if (tahmin === sayi) {
                await pool.query(`UPDATE users SET coins = coins + 30 WHERE id = $1`, [uid]);
                collector.stop("kazandi");
                return msg.edit(`🎯 **Sayı Tahmin**\n🏆 ${message.author} **${deneme}. denemede** buldu! Sayı: **${sayi}** — **+30 coin**`);
            }

            const ipucu = tahmin < sayi ? "📈 Daha büyük!" : "📉 Daha küçük!";
            const kalanHak = 7 - deneme;
            if (kalanHak === 0) {
                collector.stop("bitti");
                return msg.edit(`🎯 **Sayı Tahmin**\n💸 ${message.author} bulamadı! Sayı: **${sayi}** — **-15 coin**`);
            }
            msg.edit(`🎯 **Sayı Tahmin** — ${ipucu} (${kalanHak} hak kaldı)`);
        });

        collector.on("end", (_, reason) => {
            if (reason === "time") msg.edit(`🎯 **Sayı Tahmin**\n⏰ Süre doldu! Sayı: **${sayi}** — **-15 coin**`);
        });

        return;
    }

    if (cmd === "!kelime") {
        if (hasCooldown(uid, "kelime", 30000)) return message.reply("⏳ 30 saniye bekle!");
        const user = await getUser(uid);
        if (user.coins < 15) return message.reply("❌ Oynamak için **15 coin** gerekiyor!");
        await pool.query(`UPDATE users SET coins = coins - 15 WHERE id = $1`, [uid]);

        const kelimeListesi = {
            "Hayvan": ["at","ayı","balık","baykuş","boğa","bufalo","ceylan","çita","deve","domuz","eşek","fare","fil","fok","geyik","goril","hamster","inek","jaguar","kaplumbağa","kaplan","kartal","kedi","keçi","kertenkele","kırlangıç","kirpi","koyun","köpek","köpekbalığı","kurt","kuş","kurbağa","leopar","leylek","maymun","martı","papağan","penguen","puma","serçe","sincap","sırtlan","tavşan","tavuk","timsah","tilki","yılan","zebra","zürafa","aslan","arı","akrep","çekirge","karga","balina","yunus","ahtapot","denizatı","yengeç","istakoz","karides","ördek","horoz","hindi","güvercin","doğan","şahin","akbaba","flamingo","pelikan","kumru","çulluk","atmaca","karınca","böcek","kelebek","uğurböceği","sinek","sivrisinek","arıkuşu","deve","flamingo","ibis","anka"],
            "Ülke": ["almanya","arjantin","avustralya","avusturya","azerbaycan","belçika","brezilya","bulgaristan","cezayir","çin","danimarka","endonezya","ermenistan","etiyopya","fas","filipinler","finlandiya","fransa","gana","gürcistan","hindistan","hollanda","irak","iran","irlanda","ispanya","israil","italya","japonya","kamboçya","kanada","kazakistan","kenya","kıbrıs","kolombiya","kore","küba","libya","lübnan","macaristan","malezya","meksika","mısır","moğolistan","moldova","nepal","nijerya","norveç","özbekistan","pakistan","peru","polonya","portekiz","romanya","rusya","senegal","sırbistan","singapur","slovakya","slovenya","somali","sudan","suriye","şili","tayvan","tayland","tunus","türkiye","ukrayna","uruguay","venezüela","vietnam","yemen","yunanistan","zimbabwe","angola","bolivya","ekvador","guatemala","honduras","jamaika","nicaragua","panama","paraguay","bahreyn","katar","kuveyt","isviçre","isveç","islanda","danimarka","norveç","belçika","hollanda","avusturya","polonya","çekya","slovakya","macaristan","hırvatistan","arnavutluk","karadağ","kosova","makedonya","bosna","moldova","belarus","estonya","letonya","litvanya","gürcistan","ermenistan","azerbaycan","türkmenistan","özbekistan","kırgızistan","tacikistan","afganistan","myanmar","kamboçya","laos","brunei","timor","vanuatu","tonga","samoa","fiji","nauru","palau","kiribati","tuvalu","marshalladaları"],
            "Şehir": ["adana","adapazarı","afyon","ağrı","aksaray","amasya","ankara","antalya","ardahan","artvin","aydın","balıkesir","bartın","batman","bayburt","bilecik","bingöl","bitlis","bolu","burdur","bursa","çanakkale","çankırı","çorum","denizli","diyarbakır","düzce","edirne","elazığ","erzincan","erzurum","eskişehir","gaziantep","giresun","gümüşhane","hakkari","hatay","iğdır","isparta","istanbul","izmir","kahramanmaraş","karabük","karaman","kars","kastamonu","kayseri","kilis","kırıkkale","kırklareli","kırşehir","kocaeli","konya","kütahya","malatya","manisa","mardin","mersin","muğla","muş","nevşehir","niğde","ordu","osmaniye","rize","sakarya","samsun","siirt","sinop","sivas","şanlıurfa","şırnak","tekirdağ","tokat","trabzon","tunceli","uşak","van","yalova","yozgat","zonguldak","paris","londra","berlin","madrid","roma","amsterdam","viyana","brüksel","moskova","tokyo","pekin","dubai","sydney","toronto"],
            "Yiyecek": ["acıbadem","ayran","baklava","bamya","barbunya","börek","bulgur","cacık","ceviz","çiğköfte","çorba","dolma","döner","ekmek","enginar","fasulye","fındık","gözleme","güveç","hamsi","helva","humus","ıspanak","kadayıf","karnıyarık","kavurma","kayısı","kebap","kestane","kiraz","köfte","künefe","lahmacun","lokma","lokum","lüfer","mantı","mercimek","midye","muhallebi","mücver","nohut","patlıcan","pilav","pide","pizza","sarma","sütlaç","şeftali","şiş","tavuk","turşu","yoğurt","zeytin","çikolata","dondurma","kek","kurabiye","pasta","waffle","krep","omlet","sandviç","makarna","hamburger","patates","salata","falafel","humus","börek","simit","poğaça","açma","bagel","kruvasan","muffin","brownie","cheesecake","tiramisu","profiterol","ekler","sufle","panna","cotta","sorbet","dürüm","tantuni","ciğer","kokoreç","balık","karides","kalamar","ahtapot","midye","istiridye","levrek","çipura","palamut","uskumru","hamsi","sardalya","ton","somon","alabalık"],
            "Meslek": ["aşçı","avukat","bankacı","berber","biyolog","cerrah","çiftçi","dişçi","doktor","eczacı","ekonomist","elektrikçi","emlakçı","fotoğrafçı","gazeteci","hemşire","itfaiyeci","jeolog","kaptan","kasiyer","kimyager","mimar","muhasebeci","mühendis","müdür","müzisyen","öğretmen","polis","programcı","psikolog","rehber","ressam","sanatçı","sekreter","şef","şoför","tamirci","tarihçi","terzi","usta","veteriner","yargıç","yazılımcı","yönetici","astronot","pilot","hostes","denizci","asker","hakim","savcı","diplomat","politikacı","yazar","şair","oyuncu","yönetmen","senarist","kameraman","fotoğrafçı","grafiker","tasarımcı","mimar","peyzaj","iç","dış","inşaat","makine","kimya","elektrik","bilgisayar","yazılım","biyomedikal","çevre","gıda","tekstil","uçak","uzay","nükleer","petrol","maden","orman","ziraat","veteriner","eczacı","hemşire","ebe","fizyoterapist","diyetisyen","psikolog","sosyolog","antropolog","arkeolog","tarihçi","coğrafyacı","ekonomist","istatistikçi","matematikçi","fizikçi","kimyager","biyolog","zoolog","botanikçi","jeolog","meteoroloji"]
        };

        const kategoriler = Object.keys(kelimeListesi);
        const kategori = kategoriler[Math.floor(Math.random() * kategoriler.length)];
        const harfler = "ABCDEFGHIKLMNOPRSTYZ";

        let finalHarf = null;
        let denemeHarf = 0;
        while (!finalHarf && denemeHarf < 20) {
            const h = harfler[Math.floor(Math.random() * harfler.length)];
            if (kelimeListesi[kategori].some(k => k.startsWith(h.toLowerCase()))) finalHarf = h;
            denemeHarf++;
        }
        if (!finalHarf) finalHarf = "A";

        const msg = await message.channel.send(
            `🔤 **Kelime Oyunu** (**-15 coin**)\n**Kategori:** ${kategori}\n**Harf:** **${finalHarf}**\n\n⏳ 20 saniye içinde **${finalHarf}** harfiyle başlayan bir ${kategori.toLowerCase()} yaz! Kazanırsan **+30 coin**`
        );

        const filter = m => {
            if (m.author.id !== uid) return false;
            const kelime = m.content.trim().toLowerCase();
            return kelime.startsWith(finalHarf.toLowerCase()) && kelime.length >= 3;
        };

        const collector = message.channel.createMessageCollector({ filter, time: 20000, max: 3 });
        let yanlisSayisi = 0;

        collector.on("collect", async m => {
            const kelime = m.content.trim().toLowerCase();
            try { await m.delete(); } catch {}

            if (kelimeListesi[kategori].includes(kelime)) {
                await pool.query(`UPDATE users SET coins = coins + 30 WHERE id = $1`, [uid]);
                collector.stop("kazandi");
                return msg.edit(`🔤 **Kelime Oyunu**\n✅ ${message.author} **"${m.content.trim()}"** dedi! **+30 coin**`);
            }

            yanlisSayisi++;
            const kalanHak = 3 - yanlisSayisi;
            if (kalanHak <= 0) {
                collector.stop("bitti");
                return msg.edit(`🔤 **Kelime Oyunu**\n❌ **"${m.content.trim()}"** listede yok! Tüm haklarını kullandın. **-15 coin**`);
            }
            msg.edit(`🔤 **Kelime Oyunu** (**-15 coin**)\n**Kategori:** ${kategori} | **Harf:** **${finalHarf}**\n\n❌ **"${m.content.trim()}"** geçersiz! (${kalanHak} hak kaldı)`);
        });

        collector.on("end", (_, reason) => {
            if (reason === "time") msg.edit(`🔤 **Kelime Oyunu**\n⏰ Süre doldu! **${finalHarf}** harfiyle **${kategori}** bulamadın. **-15 coin**`);
        });

        return;
    }

    /* ---------- VIP KOMUTLARI ---------- */

    if (cmd === "!vipshop") {
        const vip = getVipLevel(message.member);
        if (vip === 0) return message.reply("❌ Bu komut sadece **VIP** ve **VIP+** üyelerine özeldir!");

        const boost = await getVipBoost(uid);
        const coinBoostAktif = boost.coin_boost_until > Date.now();
        const kalanSure = coinBoostAktif
            ? `<t:${Math.floor(boost.coin_boost_until / 1000)}:R> bitiyor`
            : "Aktif değil";

        const embed = new EmbedBuilder()
            .setTitle(vip === 2 ? "👑 VIP+ Mağaza" : "⭐ VIP Mağaza")
            .setDescription(
                `Merhaba ${message.author}! Özel mağazana hoş geldin.\n\n` +
                `**Mevcut Durumun:**\n` +
                `💰 Coin Boost: ${coinBoostAktif ? `✅ Aktif (${kalanSure})` : "❌ Aktif değil"}\n` +
                `✨ Şans Artırıcı: **${boost.sans_artirici}** kullanım\n\n` +
                `**Ürünler:**\n` +
                `\`1\` 💰 **Coin Boost** (1 saat 2x coin) — **${vip === 2 ? "3.000" : "5.000"} coin**\n` +
                `\`2\` 🎁 **Hayvan Paketi** (5 rastgele hayvan) — **${vip === 2 ? "1.500" : "2.500"} coin**\n` +
                `\`3\` ✨ **Şans Artırıcı** (5 hunt'ta %40 nadir şans) — **${vip === 2 ? "2.000" : "3.500"} coin**\n\n` +
                `Satın almak için \`!vipal <numara>\` yaz.\nÖrn: \`!vipal 1\``
            )
            .setColor(vip === 2 ? 0xFFD700 : 0xC0C0C0)
            .setFooter({ text: "Freaktsing • VIP Mağaza" })
            .setTimestamp();

        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === "!vipal") {
        const vip = getVipLevel(message.member);
        if (vip === 0) return message.reply("❌ Bu komut sadece **VIP** ve **VIP+** üyelerine özeldir!");

        const secim = parseInt(args[1]);
        if (isNaN(secim) || secim < 1 || secim > 3)
            return message.reply("❌ Geçerli ürün numarası gir. Kullanım: `!vipal <1/2/3>`\nÜrünleri görmek için `!vipshop` yaz.");

        const fiyatlar = {
            1: vip === 2 ? 3000 : 5000,
            2: vip === 2 ? 1500 : 2500,
            3: vip === 2 ? 2000 : 3500
        };

        const fiyat = fiyatlar[secim];
        const user  = await getUser(uid);

        if (user.coins < fiyat)
            return message.reply(`❌ Yeterli coin yok! Bu ürün **${fiyat.toLocaleString()} coin** ama bakiyen **${user.coins.toLocaleString()} coin**.`);

        await pool.query(`UPDATE users SET coins = coins - $1 WHERE id = $2`, [fiyat, uid]);
        await getVipBoost(uid);

        if (secim === 1) {
            // Coin boost — eğer zaten aktifse üzerine 1 saat ekle
            const boost = await getVipBoost(uid);
            const base  = Math.max(boost.coin_boost_until, Date.now());
            const yeni  = base + 3600000;
            await pool.query(`UPDATE vip_boosts SET coin_boost_until = $1 WHERE user_id = $2`, [yeni, uid]);
            return message.reply(`✅ 💰 **Coin Boost** satın aldın! **1 saat** boyunca 2x coin kazanacaksın. Bitiş: <t:${Math.floor(yeni / 1000)}:R>`);
        }

        if (secim === 2) {
            // Hayvan paketi — 5 rastgele hayvan ekle
            const hayvanlar = ["🐺 Kurt", "🐰 Tavşan", "🐻 Ayı", "🦊 Tilki", "🐸 Kurbağa", "🦁 Aslan", "🐉 Ejderha", "🦄 Unicorn", "🦅 Kartal"];
            const eklenenler = [];
            for (let i = 0; i < 5; i++) {
                const h = hayvanlar[Math.floor(Math.random() * hayvanlar.length)];
                await pool.query(`INSERT INTO animals (user_id, animal) VALUES ($1, $2)`, [uid, h]);
                eklenenler.push(h);
            }
            return message.reply(`✅ 🎁 **Hayvan Paketi** satın aldın! Envantere eklenen hayvanlar:\n${eklenenler.join(", ")}`);
        }

        if (secim === 3) {
            // Şans artırıcı — 5 kullanım ekle
            await pool.query(`UPDATE vip_boosts SET sans_artirici = sans_artirici + 5 WHERE user_id = $1`, [uid]);
            const yeni = await getVipBoost(uid).sans_artirici;
            return message.reply(`✅ ✨ **Şans Artırıcı** satın aldın! Artık **${yeni} hunt**'ta %40 nadir hayvan şansın var!`);
        }
    }

    if (cmd === "!hazine") {
        const vip = getVipLevel(message.member);
        if (vip === 0) return message.reply("❌ `!hazine` komutu sadece **VIP** ve **VIP+** üyelerine özeldir!");
        if (hasCooldown(uid, "hazine", vip === 2 ? 60000 : 120000))
            return message.reply(`⏳ Hazine avı için ${vip === 2 ? "1 dakika" : "2 dakika"} bekle!`);

        const odul = vip === 2
            ? Math.floor(Math.random() * 1500) + 500   // VIP+: 500–2000
            : Math.floor(Math.random() * 800) + 200;   // VIP:  200–1000

        // 3 ipucu üret, biri doğru
        const ipuclari = [
            "Kuzey yönünde bir ağacın altında...",
            "Güneyde taşların arasında...",
            "Doğuda nehir kenarında...",
            "Batıda eski bir kalıntının yanında...",
            "Ormanın tam ortasında...",
            "Dağın zirvesine yakın bir mağarada..."
        ];

        const dogru = ipuclari[Math.floor(Math.random() * ipuclari.length)];
        const yanlis1 = ipuclari.filter(i => i !== dogru)[Math.floor(Math.random() * (ipuclari.length - 1))];
        const yanlis2 = ipuclari.filter(i => i !== dogru && i !== yanlis1)[Math.floor(Math.random() * (ipuclari.length - 2))];

        const seçenekler = [dogru, yanlis1, yanlis2].sort(() => Math.random() - 0.5);
        const dogruIndex = seçenekler.indexOf(dogru) + 1;

        const embed = new EmbedBuilder()
            .setTitle("🗺️ Hazine Avı!")
            .setDescription(
                `${message.author} bir hazine haritası buldun!\n\n` +
                `Hazine şu ipuçlarından **birinde** gizli. Doğrusunu seç:\n\n` +
                `\`1\` ${seçenekler[0]}\n` +
                `\`2\` ${seçenekler[1]}\n` +
                `\`3\` ${seçenekler[2]}\n\n` +
                `⏳ **20 saniye** içinde \`1\`, \`2\` veya \`3\` yaz!\n` +
                `🏆 Kazanırsan: **+${odul.toLocaleString()} coin**`
            )
            .setColor(vip === 2 ? 0xFFD700 : 0xC0C0C0)
            .setFooter({ text: "Freaktsing • Hazine Avı" })
            .setTimestamp();

        const hazineMesaj = await message.channel.send({ embeds: [embed] });

        const filter = m => m.author.id === uid && ["1","2","3"].includes(m.content.trim());
        const collector = message.channel.createMessageCollector({ filter, time: 20000, max: 1 });

        collector.on("collect", async m => {
            try { await m.delete(); } catch {}
            const secim = parseInt(m.content.trim());

            if (secim === dogruIndex) {
                // Coin boost aktifse 2x ver
                const gercekOdul = await hasCoinBoost(uid) ? odul * 2 : odul;
                await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [gercekOdul, uid]);
                const boostNotu = await hasCoinBoost(uid) ? " 💰 (Coin Boost aktif, 2x!)" : "";
                hazineMesaj.edit({
                    embeds: [
                        EmbedBuilder.from(hazineMesaj.embeds[0])
                            .setDescription(
                                `🎉 **Doğru!** Hazineyi buldun!\n\n` +
                                `📍 Hazine **${dogru}** gizliydi.\n\n` +
                                `💰 **+${gercekOdul.toLocaleString()} coin** kazandın!${boostNotu}`
                            )
                            .setColor(0x00CC66)
                    ]
                });
            } else {
                hazineMesaj.edit({
                    embeds: [
                        EmbedBuilder.from(hazineMesaj.embeds[0])
                            .setDescription(
                                `❌ **Yanlış konum!** Hazine kaçtı...\n\n` +
                                `📍 Doğru konum: **${dogru}**\n\n` +
                                `Bir sonraki sefere daha şanslı olursun!`
                            )
                            .setColor(0xFF4444)
                    ]
                });
            }
        });

        collector.on("end", (_, reason) => {
            if (reason === "time") {
                hazineMesaj.edit({
                    embeds: [
                        EmbedBuilder.from(hazineMesaj.embeds[0])
                            .setDescription(`⏰ Süre doldu! Hazine kayboldu.\n\n📍 Doğru konum: **${dogru}**`)
                            .setColor(0xFF4444)
                    ]
                });
            }
        });

        return;
    }

    if (cmd === "!vipbilgi") {
        const vip = getVipLevel(message.member);
        if (vip === 0) return message.reply("❌ Bu komut sadece VIP üyelere özeldir!");
        const boost = await getVipBoost(uid);
        const coinBoostAktif = boost.coin_boost_until > Date.now();

        const embed = new EmbedBuilder()
            .setTitle(vip === 2 ? "👑 VIP+ Bilgilerin" : "⭐ VIP Bilgilerin")
            .addFields(
                { name: "💰 Günlük Ödül",    value: vip === 2 ? "2.000 coin" : "1.000 coin", inline: true },
                { name: "⏱️ Hunt Cooldown",   value: vip === 2 ? "2.5 saniye" : "5 saniye", inline: true },
                { name: "💰 Coin Boost",      value: coinBoostAktif ? `✅ Aktif — <t:${Math.floor(boost.coin_boost_until / 1000)}:R> bitiyor` : "❌ Aktif değil", inline: false },
                { name: "✨ Şans Artırıcı",   value: `${boost.sans_artirici} kullanım kaldı`, inline: true },
                { name: "🗺️ Hazine Avı",      value: vip === 2 ? "Her 1 dakikada bir" : "Her 2 dakikada bir", inline: true }
            )
            .setColor(vip === 2 ? 0xFFD700 : 0xC0C0C0)
            .setFooter({ text: "Freaktsing • VIP Bilgi" })
            .setTimestamp();

        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === "!gecmis") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) &&
            !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu kullanma yetkin yok.");

        const hedef = message.mentions.members.first();
        if (!hedef) return message.reply("❌ Kullanım: `!gecmis @kullanıcı`");

        const res = await pool.query(
            `SELECT * FROM mod_logs WHERE user_id = $1 ORDER BY tarih DESC LIMIT 20`,
            [hedef.id]
        );
        const kayitlar = res.rows;

        if (kayitlar.length === 0) {
            return message.reply(`📭 **${hedef.user.username}** adlı kullanıcının geçmişte hiç ceza kaydı yok.`);
        }

        const muteSayisi = kayitlar.filter(k => k.islem === "Mute").length;
        const banSayisi  = kayitlar.filter(k => k.islem === "Ban").length;

        const liste = kayitlar.map((k, i) => {
            const tarih   = `<t:${Math.floor(k.tarih / 1000)}:D>`;
            const yetkili = k.yetkili_id === client.user.id ? "🤖 Otomatik" : `<@${k.yetkili_id}>`;
            const islem   = k.islem === "Ban" ? "🔨 Ban" : "🔇 Mute";
            return `**${i + 1}.** ${islem} — ${tarih}\n> Süre: ${k.sure} | Sebep: ${k.sebep} | Yetkili: ${yetkili}`;
        }).join("\n\n");

        const embed = new EmbedBuilder()
            .setTitle(`📋 ${hedef.user.username} — Ceza Geçmişi`)
            .setThumbnail(hedef.user.displayAvatarURL({ dynamic: true }))
            .setDescription(
                `🔇 **Toplam Mute:** ${muteSayisi}\n🔨 **Toplam Ban:** ${banSayisi}\n\n${liste}`
            )
            .setColor(0xFF4444)
            .setFooter({ text: "Freaktsing • Moderasyon Geçmişi" })
            .setTimestamp();

        return message.channel.send({ embeds: [embed] });
    }

    /* ---------- ADMIN ---------- */
    if (cmd === "!addcoins") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const user = message.mentions.users.first();
        const amount = parseInt(args[2]);
        if (!user || isNaN(amount)) return message.reply("❌ Kullanım: !addcoins @user miktar");
        await getUser(user.id);
        await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [amount, user.id]);
        return message.reply(`✅ ${user.username} kullanıcısına ${amount} coin eklendi.`);
    }

    if (cmd === "!removecoins") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const user = message.mentions.users.first();
        const amount = parseInt(args[2]);
        if (!user || isNaN(amount)) return message.reply("❌ Kullanım: !removecoins @user miktar");
        await getUser(user.id);
        await pool.query(`UPDATE users SET coins = coins - $1 WHERE id = $2`, [amount, user.id]);
        return message.reply(`✅ ${user.username} kullanıcısından ${amount} coin silindi.`);
    }

    /* ---------- MODERİSYON ---------- */

    function parseSure(str) {
        if (!str) return null;
        const match = str.match(/^(\d+)(m|h|d)$/i);
        if (!match) return null;
        const val = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        if (val < 1) return null;
        if (unit === "m") { if (val > 300) return null; return val * 60 * 1000; }
        if (unit === "h") { if (val > 300) return null; return val * 60 * 60 * 1000; }
        if (unit === "d") { if (val > 300) return null; return val * 24 * 60 * 60 * 1000; }
        return null;
    }

    function sureMesvaji(ms) {
        if (!ms) return "**Kalıcı**";
        const d = Math.floor(ms / 86400000);
        const h = Math.floor((ms % 86400000) / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        if (d > 0) return `**${d} gün**`;
        if (h > 0) return `**${h} saat**`;
        return `**${m} dakika**`;
    }

    if (cmd === "!mute") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) &&
            !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu kullanma yetkin yok.");

        const hedef = message.mentions.members.first();
        if (!hedef) return message.reply("❌ Kullanım: `!mute @kullanıcı [süre] [sebep]`\nÖrn: `!mute @oyuncu 10m spam`");

        if (hedef.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Yöneticileri susturamazsın.");

        const surStr  = args[2] && /^\d+(m|h|d)$/i.test(args[2]) ? args[2] : null;
        const sureMs  = surStr ? parseSure(surStr) : null;
        const sebep   = (surStr ? args.slice(3) : args.slice(2)).join(" ") || "Sebep belirtilmedi";

        if (surStr && sureMs === null)
            return message.reply("❌ Geçersiz süre! Örn: `10m`, `2h`, `1d` (1-300 arası)");

        try {
            await hedef.timeout(sureMs || (28 * 24 * 60 * 60 * 1000), sebep);
            await pool.query(
                `INSERT INTO mod_logs (user_id, islem, sebep, sure, yetkili_id, tarih) VALUES ($1, $2, $3, $4, $5, $6)`,
                [hedef.id, "Mute", sebep, sureMesvaji(sureMs), message.author.id, Date.now()]
            );
            const embed = new EmbedBuilder()
                .setTitle("🔇 Kullanıcı Susturuldu")
                .addFields(
                    { name: "Kullanıcı",  value: `${hedef}`, inline: true },
                    { name: "Yetkili",    value: `${message.author}`, inline: true },
                    { name: "Süre",       value: sureMesvaji(sureMs), inline: true },
                    { name: "Sebep",      value: sebep }
                )
                .setColor(0xFFA500)
                .setTimestamp();

            return message.channel.send({ embeds: [embed] });
        } catch (e) {
            return message.reply("❌ Kullanıcı susturulamadı. Botun bu kişiden daha yüksek rolü olmalı.");
        }
    }

    if (cmd === "!unmute") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) &&
            !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu kullanma yetkin yok.");

        const hedef = message.mentions.members.first();
        if (!hedef) return message.reply("❌ Kullanım: `!unmute @kullanıcı`");

        try {
            await hedef.timeout(null);

            const embed = new EmbedBuilder()
                .setTitle("🔊 Kullanıcının Susturması Kaldırıldı")
                .addFields(
                    { name: "Kullanıcı", value: `${hedef}`, inline: true },
                    { name: "Yetkili",   value: `${message.author}`, inline: true }
                )
                .setColor(0x00CC66)
                .setTimestamp();

            return message.channel.send({ embeds: [embed] });
        } catch (e) {
            return message.reply("❌ Susturma kaldırılamadı. Botun bu kişiden daha yüksek rolü olmalı.");
        }
    }

    if (cmd === "!ban") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers) &&
            !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu kullanma yetkin yok.");

        const hedef = message.mentions.members.first();
        if (!hedef) return message.reply("❌ Kullanım: `!ban @kullanıcı [süre] [sebep]`\nÖrn: `!ban @oyuncu 1d kural ihlali`");

        if (hedef.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Yöneticileri banlayamazsın.");

        if (!hedef.bannable)
            return message.reply("❌ Bu kullanıcıyı banlayamam. Botun rolü yeterli değil.");

        const surStr = args[2] && /^\d+(m|h|d)$/i.test(args[2]) ? args[2] : null;
        const sureMs = surStr ? parseSure(surStr) : null;
        const sebep  = (surStr ? args.slice(3) : args.slice(2)).join(" ") || "Sebep belirtilmedi";

        if (surStr && sureMs === null)
            return message.reply("❌ Geçersiz süre! Örn: `10m`, `2h`, `1d` (1-300 arası)");

        try {
            await hedef.ban({ reason: sebep });
            await pool.query(
                `INSERT INTO mod_logs (user_id, islem, sebep, sure, yetkili_id, tarih) VALUES ($1, $2, $3, $4, $5, $6)`,
                [hedef.id, "Ban", sebep, sureMesvaji(sureMs), message.author.id, Date.now()]
            );

            const embed = new EmbedBuilder()
                .setTitle("🔨 Kullanıcı Banlandı")
                .addFields(
                    { name: "Kullanıcı", value: `${hedef.user.tag}`, inline: true },
                    { name: "Yetkili",   value: `${message.author}`, inline: true },
                    { name: "Süre",      value: sureMesvaji(sureMs), inline: true },
                    { name: "Sebep",     value: sebep }
                )
                .setColor(0xFF0000)
                .setTimestamp();

            message.channel.send({ embeds: [embed] });

            if (sureMs) {
                setTimeout(async () => {
                    try {
                        await message.guild.members.unban(hedef.id, "Geçici ban süresi doldu");
                        message.channel.send(`✅ **${hedef.user.tag}** kullanıcısının ban süresi doldu, sunucuya tekrar girebilir.`);
                    } catch {}
                }, sureMs);
            }

            return;
        } catch (e) {
            return message.reply("❌ Kullanıcı banlanamadı.");
        }
    }

    if (cmd === "!unban") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers) &&
            !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu kullanma yetkin yok.");

        const aranan = args.slice(1).join(" ");
        if (!aranan) return message.reply("❌ Kullanım: `!unban <kullanıcı adı veya ID>`");

        try {
            const banList = await message.guild.bans.fetch();

            let entry = banList.get(aranan) || banList.find(b =>
                b.user.username.toLowerCase().includes(aranan.toLowerCase()) ||
                b.user.tag.toLowerCase().includes(aranan.toLowerCase())
            );

            if (!entry) return message.reply(`❌ \`${aranan}\` adında banlı kullanıcı bulunamadı.`);

            await message.guild.members.unban(entry.user.id, `${message.author.tag} tarafından unban`);

            const embed = new EmbedBuilder()
                .setTitle("✅ Ban Kaldırıldı")
                .addFields(
                    { name: "Kullanıcı", value: `${entry.user.tag}`, inline: true },
                    { name: "ID",        value: entry.user.id, inline: true },
                    { name: "Yetkili",   value: `${message.author}`, inline: true }
                )
                .setColor(0x00CC66)
                .setTimestamp();

            return message.channel.send({ embeds: [embed] });
        } catch (e) {
            return message.reply("❌ Ban kaldırılamadı: " + e.message);
        }
    }

    if (cmd === "!seen") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) &&
            !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu kullanma yetkin yok.");

        const sub = args[1]?.toLowerCase();
        if (!sub || (sub !== "banli" && sub !== "muteli"))
            return message.reply("❌ Kullanım: `!seen banli` veya `!seen muteli`");

        if (sub === "banli") {
            const banList = await message.guild.bans.fetch();
            if (banList.size === 0) return message.reply("📭 Banlı kullanıcı yok.");

            const liste = banList.map((b, i) =>
                `\`${b.user.tag}\` — ID: \`${b.user.id}\`${b.reason ? ` — *${b.reason}*` : ""}`
            ).join("\n");

            const embed = new EmbedBuilder()
                .setTitle(`🔨 Banlı Kullanıcılar (${banList.size})`)
                .setDescription(liste.length > 4000 ? liste.slice(0, 4000) + "\n..." : liste)
                .setColor(0xFF0000)
                .setTimestamp();

            return message.channel.send({ embeds: [embed] });
        }

        if (sub === "muteli") {
            const muteli = message.guild.members.cache.filter(m => m.isCommunicationDisabled());
            if (muteli.size === 0) return message.reply("📭 Susturulmuş kullanıcı yok.");

            const liste = muteli.map(m => {
                const bitis = m.communicationDisabledUntil;
                const sure  = bitis ? `<t:${Math.floor(bitis.getTime() / 1000)}:R> açılır` : "Kalıcı";
                return `\`${m.user.tag}\` — ID: \`${m.user.id}\` — ${sure}`;
            }).join("\n");

            const embed = new EmbedBuilder()
                .setTitle(`🔇 Susturulmuş Kullanıcılar (${muteli.size})`)
                .setDescription(liste.length > 4000 ? liste.slice(0, 4000) + "\n..." : liste)
                .setColor(0xFFA500)
                .setTimestamp();

            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === "!msg") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const metin = message.content.slice("!msg".length).trim();
        if (!metin) return message.reply("❌ Kullanım: `!msg <mesaj>`");
        try { await message.delete(); } catch {}
        return message.channel.send(metin);
    }

    if (cmd === "!kapat") {
        const topic = message.channel.topic || "";
        if (!topic.includes("-")) return;
        const hasSupport = message.member.roles.cache.has(SUPPORT_ROLE);
        const isAdmin    = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
        if (!hasSupport && !isAdmin)
            return message.reply("❌ Ticketları sadece yöneticiler ve destek yetkilileri kapatabilir.");

        const closeEmbed = new EmbedBuilder()
            .setTitle("🔒 Ticket Kapatılıyor")
            .setDescription(`Bu ticket **${message.author.tag}** tarafından kapatıldı.\nKanal 5 saniye içinde silinecek.`)
            .setColor(0xFF4444)
            .setTimestamp();

        await message.channel.send({ embeds: [closeEmbed] });
        setTimeout(() => message.channel.delete().catch(() => {}), 5000);
        return;
    }

    /* ---------- TICKET PANEL ---------- */
    if (cmd === "!ticketpanel") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu sadece adminler kullanabilir.");

        const embed = new EmbedBuilder()
            .setTitle("🎫  Freaktsing Destek Merkezi")
            .setDescription(
                ">>> Merhaba! Destek ekibimize ulaşmak için aşağıdaki butonlardan uygun kategoriyi seçerek ticket açabilirsin.\n\n" +
                "📌 **Genel Destek** — Herhangi bir konuda yardım almak için\n" +
                "🎥 **Video Katılım** — Videolarımıza katılmak isteyenler için\n" +
                "⚙️ **Teknik Destek** — Teknik sorunların çözümü için\n" +
                "⚖️ **Oyuncu İtirazı** — Verilen cezalara itiraz etmek için\n\n" +
                "*Ticketlar yetkililer tarafından en kısa sürede yanıtlanacaktır.*"
            )
            .setColor(0x5865F2)
            .setFooter({ text: "Freaktsing • Destek Sistemi" })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("ticket_genel").setLabel("Genel Destek").setEmoji("📌").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("ticket_video").setLabel("Video Katılım").setEmoji("🎥").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("ticket_teknik").setLabel("Teknik Destek").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("ticket_itiraz").setLabel("Oyuncu İtirazı").setEmoji("⚖️").setStyle(ButtonStyle.Secondary)
        );

        return message.channel.send({ embeds: [embed], components: [row] });
    }

/* ================= TICKET CREATE ================= */

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("ticket_") && !interaction.customId.startsWith("cekilis_katil_")) return;

    /* ---------- ÇEKİLİŞ KATIL ---------- */
    if (interaction.customId.startsWith("cekilis_katil_")) {
        const cekilisId = interaction.customId.replace("cekilis_katil_", "");
        const cekilis = aktifCekilisler.get(cekilisId);
        if (!cekilis) return interaction.reply({ content: "❌ Bu çekiliş artık aktif değil.", ephemeral: true });
        if (cekilis.katilimcilar.has(interaction.user.id)) {
            cekilis.katilimcilar.delete(interaction.user.id);
            const embed = EmbedBuilder.from(cekilis.mesaj.embeds[0])
                .setDescription(
                    `**${cekilis.odul}**\n\n` +
                    `> 🎉 Katılmak için aşağıdaki butona tıkla!\n\n` +
                    `🏆 **Kazanan Sayısı:** ${cekilis.kazananSayisi}\n` +
                    `⏰ **Bitiş:** <t:${Math.floor(cekilis.bitisZamani / 1000)}:R>\n` +
                    `👥 **Katılımcı:** ${cekilis.katilimcilar.size}`
                );
            try { await cekilis.mesaj.edit({ embeds: [embed] }); } catch {}
            return interaction.reply({ content: "↩️ Çekilişten ayrıldın.", ephemeral: true });
        }
        cekilis.katilimcilar.add(interaction.user.id);

        const embed = EmbedBuilder.from(cekilis.mesaj.embeds[0])
            .setDescription(
                `**${cekilis.odul}**\n\n` +
                `> 🎉 Katılmak için aşağıdaki butona tıkla!\n\n` +
                `🏆 **Kazanan Sayısı:** ${cekilis.kazananSayisi}\n` +
                `⏰ **Bitiş:** <t:${Math.floor(cekilis.bitisZamani / 1000)}:R>\n` +
                `👥 **Katılımcı:** ${cekilis.katilimcilar.size}`
            );
        try { await cekilis.mesaj.edit({ embeds: [embed] }); } catch {}

        return interaction.reply({ content: `🎉 Çekilişe katıldın! Toplam **${cekilis.katilimcilar.size}** katılımcı var.\nTekrar tıklarsan ayrılırsın.`, ephemeral: true });
    }

    /* ---------- TİCKET ---------- */
    if (!interaction.customId.startsWith("ticket_")) return;

    const type = interaction.customId.replace("ticket_", "");
    if (!["genel","video","teknik","itiraz"].includes(type)) return;

    if (ticketCooldown.has(interaction.user.id))
        return interaction.reply({ content: "⏳ Lütfen biraz bekleyin.", ephemeral: true });

    const mevcutTicket = interaction.guild.channels.cache.find(c =>
        c.topic && c.topic.startsWith(interaction.user.id + "-")
    );
    if (mevcutTicket)
        return interaction.reply({ content: `❌ Zaten açık bir ticketin var: ${mevcutTicket}\nÖnce onu kapatman gerekiyor.`, ephemeral: true });

    ticketCooldown.add(interaction.user.id);
    setTimeout(() => ticketCooldown.delete(interaction.user.id), 5000);

    const id = getNextTicketId();

    let title = "";
    let color = 0x5865F2;
    let formText = "";

    if (type === "genel") {
        title    = "📌 Genel Destek";
        color    = 0x5865F2;
        formText =
            "**Lütfen aşağıdaki soruları yanıtlayarak destek talebini ilet:**\n\n" +
            "```\n1. Adınız / Kullanıcı adınız   :\n2. Konu başlığı                :\n3. Sorununuzu detaylı açıklayın:\n4. Daha önce destek aldınız mı? (Evet / Hayır)\n```";
    }
    if (type === "video") {
        title    = "🎥 Video Katılım Başvurusu";
        color    = 0xFF0000;
        formText =
            "**Video katılım başvurusu için lütfen formu doldurun:**\n\n" +
            "```\n1. Adınız / Soyadınız          :\n2. Oyuncu İsminiz (Nickname)   :\n3. Yaşınız                     :\n4. Hangi oyunu oynuyorsunuz?   :\n5. Rank / Seviyeniz            :\n6. Katılmak istediğiniz içerik :\n7. Discord & sosyal medya      :\n8. Kendinizi kısaca tanıtın    :\n```";
    }
    if (type === "teknik") {
        title    = "⚙️ Teknik Destek";
        color    = 0xFFA500;
        formText =
            "**Teknik sorununuzu bildirmek için lütfen formu doldurun:**\n\n" +
            "```\n1. Adınız / Kullanıcı adınız   :\n2. Karşılaştığınız sorun       :\n3. Sorun ne zaman başladı?     :\n4. Hata mesajı var mı?         :\n5. Platform / cihazınız        :\n6. Denediğiniz çözümler        :\n```";
    }
    if (type === "itiraz") {
        title    = "⚖️ Oyuncu İtirazı";
        color    = 0xFF4444;
        formText =
            "**Ceza itirazı için lütfen formu doldurun:**\n\n" +
            "```\n1. Adınız / Oyuncu isminiz     :\n2. Yaşınız                     :\n3. Hangi cezayı aldınız?       :\n4. Cezayı kim verdi?           :\n5. Ceza tarihi ve saati        :\n6. İtiraz sebebinizi açıklayın :\n7. Kanıt var mı?               :\n```";
    }

    try {
        const channel = await interaction.guild.channels.create({
            name: `ticket-${id}`,
            type: ChannelType.GuildText,
            topic: `${interaction.user.id}-${type}`,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: interaction.user.id,  allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: SUPPORT_ROLE,         allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
            ]
        });

        const embed = new EmbedBuilder()
            .setTitle(`${title} — #${id}`)
            .setDescription(
                `👤 **Ticket sahibi:** ${interaction.user}\n` +
                `🕐 **Açılış tarihi:** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
                formText + "\n\n" +
                `> Formu doldurduktan sonra yetkililer en kısa sürede ilgilenecektir.\n` +
                `> Ticketı kapatmak için \`!kapat\` yazın.`
            )
            .setColor(color)
            .setFooter({ text: "Freaktsing Destek Sistemi" })
            .setTimestamp();

        await channel.send({
            content: `${interaction.user} <@&${SUPPORT_ROLE}>`,
            embeds: [embed]
        });

        return interaction.reply({ content: `✅ Ticket açıldı: ${channel}`, ephemeral: true });
    } catch (e) {
        console.error("Ticket oluşturma hatası:", e);
        return interaction.reply({ content: "❌ Ticket oluşturulurken bir hata oluştu.", ephemeral: true });
    }
});

/* ================= ÇEKİLİŞ SİSTEMİ ================= */

const aktifCekilisler = new Map();
let sonBitenCekilis = null;

    if (cmd === "!cekilis") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu sadece adminler kullanabilir.");

        const surStr        = args[1];
        const kazananSayisi = parseInt(args[2]);
        const odul          = args.slice(3).join(" ");

        if (!surStr || isNaN(kazananSayisi) || kazananSayisi < 1 || !odul)
            return message.reply("❌ Kullanım: `!cekilis <süre> <kazanan> <ödül>`\nÖrn: `!cekilis 10m 2 1000 Coin`\nSüre: `30s`, `10m`, `1h`, `1d`");

        function parseCekilisSure(str) {
            const match = str.match(/^(\d+)(s|m|h|d)$/i);
            if (!match) return null;
            const val  = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            if (unit === "s") return val * 1000;
            if (unit === "m") return val * 60 * 1000;
            if (unit === "h") return val * 60 * 60 * 1000;
            if (unit === "d") return val * 24 * 60 * 60 * 1000;
            return null;
        }

        const sureMs = parseCekilisSure(surStr);
        if (!sureMs || sureMs < 5000)
            return message.reply("❌ Geçersiz süre! Örn: `30s`, `10m`, `1h`, `1d`");

        const cekilisId   = Date.now().toString();
        const bitisZamani = Date.now() + sureMs;

        const embed = new EmbedBuilder()
            .setTitle("🎉 ÇEKİLİŞ")
            .setDescription(
                `**${odul}**\n\n` +
                `> 🎉 Katılmak için aşağıdaki butona tıkla!\n\n` +
                `🏆 **Kazanan Sayısı:** ${kazananSayisi}\n` +
                `⏰ **Bitiş:** <t:${Math.floor(bitisZamani / 1000)}:R>\n` +
                `👥 **Katılımcı:** 0`
            )
            .setColor(0xFF73FA)
            .setFooter({ text: "Freaktsing • Çekiliş Sistemi" })
            .setTimestamp(new Date(bitisZamani));

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`cekilis_katil_${cekilisId}`)
                .setLabel("Katıl")
                .setEmoji("🎉")
                .setStyle(ButtonStyle.Primary)
        );

        const cekilisMsg = await message.channel.send({ embeds: [embed], components: [row] });

        aktifCekilisler.set(cekilisId, {
            odul,
            kazananSayisi,
            katilimcilar: new Set(),
            mesaj: cekilisMsg,
            kanalId: message.channel.id,
            bitisZamani
        });

        setTimeout(async () => {
            const cekilis = aktifCekilisler.get(cekilisId);
            if (!cekilis) return;
            await cekilisiBitir(cekilisId, cekilis, message.channel);
        }, sureMs);

        return;
    }

    if (cmd === "!cekilisbitir") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu sadece adminler kullanabilir.");

        if (aktifCekilisler.size === 0)
            return message.reply("❌ Aktif çekiliş yok.");

        const cekilisId = [...aktifCekilisler.keys()].pop();
        const cekilis   = aktifCekilisler.get(cekilisId);
        await cekilisiBitir(cekilisId, cekilis, message.channel);
        return;
    }

    if (cmd === "!cekilistekrar") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu sadece adminler kullanabilir.");

        if (!sonBitenCekilis)
            return message.reply("❌ Tekrar çekilecek çekiliş yok.");

        const { katilimcilar, kazananSayisi, odul } = sonBitenCekilis;
        if (katilimcilar.length === 0)
            return message.reply("❌ Katılımcı yoktu, tekrar çekilemiyor.");

        const karistirilmis = [...katilimcilar].sort(() => Math.random() - 0.5);
        const kazananlar    = karistirilmis.slice(0, Math.min(kazananSayisi, karistirilmis.length));
        const kazananMentions = kazananlar.map(id => `<@${id}>`).join(", ");

        const embed = new EmbedBuilder()
            .setTitle("🔄 Çekiliş Tekrar Yapıldı!")
            .setDescription(
                `**🎁 Ödül:** ${odul}\n` +
                `**👥 Katılımcı:** ${katilimcilar.length}\n\n` +
                `**🎉 Yeni Kazanan(lar):** ${kazananMentions}`
            )
            .setColor(0xFF73FA)
            .setFooter({ text: "Freaktsing • Çekiliş Sistemi" })
            .setTimestamp();

        return message.channel.send({ content: `🎊 ${kazananMentions} tebrikler!`, embeds: [embed] });
    }
});

async function cekilisiBitir(cekilisId, cekilis, kanal) {
    aktifCekilisler.delete(cekilisId);

    const katilimcilar = [...cekilis.katilimcilar];

    if (katilimcilar.length === 0) {
        const embed = new EmbedBuilder()
            .setTitle("🎉 ÇEKİLİŞ SONA ERDİ")
            .setDescription(`**${cekilis.odul}**\n\n> ❌ Kimse katılmadı, çekiliş iptal edildi.`)
            .setColor(0xFF4444)
            .setFooter({ text: "Freaktsing • Çekiliş Sistemi" })
            .setTimestamp();

        try { await cekilis.mesaj.edit({ embeds: [embed], components: [] }); } catch {}
        return;
    }

    const karistirilmis   = katilimcilar.sort(() => Math.random() - 0.5);
    const kazananlar      = karistirilmis.slice(0, Math.min(cekilis.kazananSayisi, katilimcilar.length));
    const kazananMentions = kazananlar.map(id => `<@${id}>`).join(", ");

    sonBitenCekilis = { katilimcilar, kazananSayisi: cekilis.kazananSayisi, odul: cekilis.odul };

    const sonucEmbed = new EmbedBuilder()
        .setTitle("🎉 ÇEKİLİŞ SONA ERDİ")
        .setDescription(
            `**${cekilis.odul}**\n\n` +
            `🏆 **Kazanan(lar):** ${kazananMentions}\n` +
            `👥 **Toplam Katılımcı:** ${katilimcilar.length}\n\n` +
            `> Tebrikler! Ödülünüzü almak için yetkili ile iletişime geçin.\n` +
            `> Yeni çekiliş için \`!cekilistekrar\` yazılabilir.`
        )
        .setColor(0xFF73FA)
        .setFooter({ text: "Freaktsing • Çekiliş Sistemi" })
        .setTimestamp();

    try { await cekilis.mesaj.edit({ embeds: [sonucEmbed], components: [] }); } catch {}

    const ch = kanal || await client.channels.fetch(cekilis.kanalId).catch(() => null);
    if (ch) await ch.send({ content: `🎊 Tebrikler ${kazananMentions}! **${cekilis.odul}** ödülünü kazandın!` });
}

/* ================= YOUTUBE BİLDİRİM ================= */

const YOUTUBE_API_KEY       = process.env.YOUTUBE_API_KEY;
const YOUTUBE_CHANNEL_ID    = process.env.YOUTUBE_CHANNEL_ID;
const DISCORD_VIDEO_CHANNEL = process.env.DISCORD_VIDEO_CHANNEL_ID;
const VIDEO_PING_ROLE       = process.env.VIDEO_PING_ROLE_ID;

let sonVideoId = null;

async function initSonVideoId() {
    const res = await pool.query(`SELECT last_video_id FROM youtube_state WHERE id = 1`);
    sonVideoId = res.rows[0]?.last_video_id || null;
}

async function youtubeKontrol() {
    try {
        const url = `https://www.googleapis.com/youtube/v3/search?key=${YOUTUBE_API_KEY}&channelId=${YOUTUBE_CHANNEL_ID}&part=snippet&order=date&maxResults=1&type=video`;
        const res  = await fetch(url);
        const data = await res.json();

        if (!data.items || data.items.length === 0) return;

        const video   = data.items[0];
        const videoId = video.id.videoId;
        if (!videoId || videoId === sonVideoId) return;

        sonVideoId = videoId;
        await pool.query(`UPDATE youtube_state SET last_video_id = $1 WHERE id = 1`, [videoId]);

        const title    = video.snippet.title;
        const thumb    = video.snippet.thumbnails.high.url;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const isShort  = title.toLowerCase().includes("#short") ||
                         video.snippet.description?.toLowerCase().includes("#short");

        const tur = isShort ? "🎬 Yeni Short" : "🎥 Yeni Video";

        const embed = new EmbedBuilder()
            .setTitle(`${tur}: ${title}`)
            .setURL(videoUrl)
            .setDescription(`**Freaktsing** yeni bir ${isShort ? "Short" : "video"} yükledi! Hemen izle 🔥`)
            .setImage(thumb)
            .setColor(0xFF0000)
            .setFooter({ text: "Freaktsing • YouTube" })
            .setTimestamp();

        const kanal = await client.channels.fetch(DISCORD_VIDEO_CHANNEL).catch(() => null);
        if (!kanal) return;

        await kanal.send({
            content: `<@&${VIDEO_PING_ROLE}> ${tur} çıktı!`,
            embeds: [embed]
        });

        console.log(`YouTube bildirimi gönderildi: ${title}`);
    } catch (e) {
        console.error("YouTube kontrol hatası:", e.message);
    }
}

/* ================= LOGIN ================= */
client.login(TOKEN);
