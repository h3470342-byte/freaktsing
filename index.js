require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot aktif"));
app.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("Web server açık"));

const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require("discord.js");

/* ================= JSON VERİTABANI ================= */

const db = require("./db");

async function connectDB() {
    db = new JSONDatabase();
    console.log("JSON veritabanı hazır! (database.json dosyasına kaydediliyor)");
}

// Bot kapanırken bekleyen yazma işlemlerini diske kaydet, veri kaybını önle
process.on("SIGINT", () => { flushDatabase(); process.exit(0); });
process.on("SIGTERM", () => { flushDatabase(); process.exit(0); });

/* ================= VERİTABANI YARDIMCI FONKSİYONLARI ================= */

async function getUser(id) {
    const col = db.collection("users");
    let user = await col.findOne({ id });
    if (!user) { await col.insertOne({ id, coins: 0, last_daily: 0 }); user = await col.findOne({ id }); }
    return user;
}

async function getChatData(id) {
    const col = db.collection("chat_stats");
    let data = await col.findOne({ user_id: id });
    if (!data) { await col.insertOne({ user_id: id, words: 0, coins: 0 }); data = await col.findOne({ user_id: id }); }
    return data;
}

async function getLevelData(id) {
    const col = db.collection("levels");
    let data = await col.findOne({ user_id: id });
    if (!data) { await col.insertOne({ user_id: id, xp: 0, level: 1 }); data = await col.findOne({ user_id: id }); }
    return data;
}

async function getNextTicketId() {
    const col = db.collection("tickets");
    const res = await col.findOneAndUpdate({ id: 1 }, { $inc: { count: 1 } }, { upsert: true, returnDocument: "before" });
    const current = res?.count || 1;
    return String(current).padStart(4, "0");
}

async function getVipBoost(userId) {
    const col = db.collection("vip_boosts");
    let data = await col.findOne({ user_id: userId });
    if (!data) { await col.insertOne({ user_id: userId, coin_boost_until: 0, sans_artirici: 0 }); data = await col.findOne({ user_id: userId }); }
    return data;
}

async function hasCoinBoost(userId) {
    const data = await getVipBoost(userId);
    return data.coin_boost_until > Date.now();
}

async function hasSansArtirici(userId) {
    const data = await getVipBoost(userId);
    return data.sans_artirici > 0;
}

/* ================= CONFIG ================= */

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});

const TOKEN              = process.env.TOKEN;
const SUPPORT_ROLE       = "1516389895457996850";
const AUTO_ROLE          = "1516220513595162744";
const WELCOME_CHANNEL_ID = "1516790940440985681";
const VIP_ROLE           = "1517595427577266316";
const VIP_PLUS_ROLE      = "1517592377106104371";

function getVipLevel(member) {
    if (member.roles.cache.has(VIP_PLUS_ROLE)) return 2;
    if (member.roles.cache.has(VIP_ROLE)) return 1;
    return 0;
}

/* ================= ANTI SPAM ================= */

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
        const spamMesajlar = mesajlar.filter(m => m.author.id === message.author.id && Date.now() - m.createdTimestamp < 10000);
        for (const m of spamMesajlar.values()) { try { await m.delete(); } catch {} }
    } catch {}
    const now = Date.now();
    if (!spamWarn.has(message.author.id)) spamWarn.set(message.author.id, { count: 0, lastReset: now });
    const warn = spamWarn.get(message.author.id);
    if (now - warn.lastReset > 3600000) { warn.count = 0; warn.lastReset = now; }
    warn.count++;
    spamWarn.set(message.author.id, warn);
    let sureSaniye = 0, mesaj = "";
    if (warn.count === 1) { sureSaniye = 30; mesaj = `🛑 ${message.author} spam yaptığın için **30 saniye** zaman aşımı aldın!`; }
    else if (warn.count === 2) { sureSaniye = 300; mesaj = `🛑 ${message.author} tekrar spam! **5 dakika** zaman aşımı aldın!`; }
    else { sureSaniye = 3600; mesaj = `🛑 ${message.author} spam devam ediyor! **1 saat** zaman aşımı aldın!`; }
    try {
        await member.timeout(sureSaniye * 1000, "Otomatik spam koruması");
        await db.collection("mod_logs").insertOne({ user_id: message.author.id, islem: "Mute", sebep: "Otomatik spam koruması", sure: `${sureSaniye} saniye`, yetkili_id: client.user.id, tarih: Date.now() });
        const uyari = await message.channel.send(mesaj);
        setTimeout(() => uyari.delete().catch(() => {}), 5000);
    } catch {}
}

function hasCooldown(userId, cmd, ms) {
    const now = Date.now();
    if (!cooldowns.has(userId)) cooldowns.set(userId, {});
    const userCd = cooldowns.get(userId);
    if (!userCd[cmd] || now - userCd[cmd] > ms) { userCd[cmd] = now; return false; }
    return true;
}

/* ================= GELİŞMİŞ KÜFÜR KONTROL SİSTEMİ ================= */

function normalizeText(text) {
    return text.toLowerCase()
        .replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'e').replace(/4/g,'a')
        .replace(/5/g,'s').replace(/6/g,'g').replace(/7/g,'t').replace(/8/g,'b').replace(/9/g,'g')
        .replace(/ş/g,'s').replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ö/g,'o').replace(/ç/g,'c').replace(/ı/g,'i')
        .replace(/İ/g,'i').replace(/Ş/g,'s').replace(/Ğ/g,'g').replace(/Ü/g,'u').replace(/Ö/g,'o').replace(/Ç/g,'c')
        .replace(/@/g,'a').replace(/\$/g,'s').replace(/!/g,'i').replace(/\+/g,'t')
        .replace(/[\s\.\-\_\*\,\;\:\'\"\`\~\^\|\\\/#%&\(\)\[\]\{\}<>]/g,'')
        .replace(/[^a-z0-9]/g,'');
}

function collapseRepeats(text) { return text.replace(/(.)\1+/g,'$1'); }
function removeSeparators(text) { return text.replace(/[.\-_\s*]+/g,''); }

const kufurListesi = [
    "orospu","orospucocugu","orosbucocugu","oc","got","sik","yarrak","amk","bok","pic","piclik","ibne","kahpe","kaltak","surtuk",
    "fahise","haysiyetsiz","serefsiz","namussuz","alcak","rezil","asagilik","soysuz","adi","oe","or","siktir","it",
    "sikik","sikiyor","sikeyim","siksin","sikerim","gotlek","gote","gotur","gotunu","yaragi","yarragi","amcik","amina","aminakoyim",
    "piclerin","picler","picin","ibnelik","ibneler","siktiret","siktirin","oruspu","orusbucocugu","ocunu","ocunun","kahpeler",
    "kahpenin","kaltaklar","fuck","fucker","fucking","fck","fuk","shit","sht","bitch","btch","asshole","ass","cunt","dick","dck",
    "cock","nigga","niger","nigger","bastard","whore","slut","pussy","motherfucker","mf","retard","retarded"
];

const hakaretListesi = [
    "defol","gitburdan","cekil","lanet","kahrolsun","geber","ol","kahret","lanetli","haysiyetsiz","serefsiz","namussuz",
    "rezalet","utanmaz","yuzsuz","arsiz","gerizerali","gerizekalili","mal","yavsak","dangalak","senin","anneni","bacini","karini",
    "ezik","pislik","serseri","zibidi","hergele","lavuk","ocun","ocunu"
];

function buildFlexRegex(word) {
    const escaped = word.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g,'\$&')).join('[^a-z]*');
    return new RegExp(escaped, 'i');
}

const kufurRegexler  = kufurListesi.map(k  => ({ kelime: k,  regex: buildFlexRegex(normalizeText(k))  }));
const hakaretRegexler = hakaretListesi.map(h => ({ kelime: h, regex: buildFlexRegex(normalizeText(h)) }));

function kufurKontrol(icerik) {
    const v = [normalizeText(icerik), collapseRepeats(normalizeText(icerik)), normalizeText(removeSeparators(icerik)), collapseRepeats(normalizeText(removeSeparators(icerik)))];
    for (const ver of v) for (const { regex } of kufurRegexler) if (regex.test(ver)) return true;
    return false;
}

function hakaretKontrol(icerik) {
    const v = [normalizeText(icerik), collapseRepeats(normalizeText(icerik)), normalizeText(removeSeparators(icerik)), collapseRepeats(normalizeText(removeSeparators(icerik)))];
    for (const ver of v) for (const { regex } of hakaretRegexler) if (regex.test(ver)) return true;
    return false;
}

async function handleKufur(message, tur) {
    const member = message.member;
    if (!member) return;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    if (member.roles.cache.has(SUPPORT_ROLE)) return;
    try { await message.delete(); } catch {}
    let sureSaniye = 0, mesaj = "";
    if (tur === "kufur") { sureSaniye = 10800; mesaj = `🤬 ${message.author} küfür ettiği için **3 saat** zaman aşımı aldı!`; }
    else { sureSaniye = 3600; mesaj = `⚠️ ${message.author} hakaret ettiği için **1 saat** zaman aşımı aldı!`; }
    try {
        await member.timeout(sureSaniye * 1000, `Otomatik: ${tur}`);
        await db.collection("mod_logs").insertOne({ user_id: message.author.id, islem: "Mute", sebep: `Otomatik: ${tur}`, sure: `${sureSaniye} saniye`, yetkili_id: "bot", tarih: Date.now() });
        const uyari = await message.channel.send(mesaj);
        setTimeout(() => uyari.delete().catch(() => {}), 6000);
    } catch {}
}

/* ================= READY ================= */

client.once("ready", async () => {
    console.log(`${client.user.tag} aktif!`);
    await connectDB();
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
    } catch (e) { console.error("guildMemberAdd hatası:", e); }
});

/* ================= MESSAGE ================= */

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (isSpam(message.author.id, message.content)) { await handleSpam(message); return; }
    if (kufurKontrol(message.content)) { await handleKufur(message, "kufur"); return; }
    if (hakaretKontrol(message.content)) { await handleKufur(message, "hakaret"); return; }

    const args = message.content.trim().split(/\s+/);
    const cmd  = args[0].toLowerCase();
    const uid  = message.author.id;

    /* ---------- LEVEL ---------- */
    const levelData = await getLevelData(uid);
    const newXp = levelData.xp + Math.floor(Math.random() * 10) + 5;
    if (newXp >= levelData.level * 120) {
        await db.collection("levels").updateOne({ user_id: uid }, { $set: { xp: 0 }, $inc: { level: 1 } });
        message.channel.send(`🎉 ${message.author} level atladı! Level: **${levelData.level + 1}**`);
    } else {
        await db.collection("levels").updateOne({ user_id: uid }, { $set: { xp: newXp } });
    }

    /* ---------- CHAT REWARD ---------- */
    await db.collection("chat_stats").updateOne({ user_id: uid }, { $inc: { words: args.length } }, { upsert: true });
    const chatData = await getChatData(uid);

    const rewards = [
        { words: 1000,   coins: 500    },
        { words: 5000,   coins: 1500   },
        { words: 10000,  coins: 3000   },
        { words: 25000,  coins: 6000   },
        { words: 50000,  coins: 12000  },
        { words: 100000, coins: 25000  },
        { words: 250000, coins: 60000  },
        { words: 500000, coins: 120000 },
    ];

    const dongu = Math.floor(chatData.words / 500000);
    const donguBasiKelime = dongu * 500000;

    for (const reward of rewards) {
        const hedef = donguBasiKelime + reward.words;
        const oncekiKelime = chatData.words - args.length;
        if (chatData.words >= hedef && oncekiKelime < hedef) {
            const coinBoostAktif = await hasCoinBoost(uid);
            const gercekOdul = coinBoostAktif ? reward.coins * 2 : reward.coins;
            await db.collection("users").updateOne({ id: uid }, { $inc: { coins: gercekOdul } }, { upsert: true });
            const boostNotu = coinBoostAktif ? " 💰 (Coin Boost aktif, 2x!)" : "";
            const turNotu = dongu > 0 ? ` *(${dongu + 1}. tur)*` : "";
            message.channel.send(`🏆 Tebrikler ${message.author}, **${reward.words.toLocaleString()}** kelimeye ulaştın!${turNotu} **+${gercekOdul.toLocaleString()} coin**${boostNotu}`);
        }
    }

    /* ---------- FUN ---------- */
    if (cmd === "!ping") return message.reply(`🏓 ${client.ws.ping}ms`);
    if (cmd === "!roll") return message.reply(`🎲 ${Math.floor(Math.random() * 100) + 1}`);
    if (cmd === "!coin") return message.reply(Math.random() < 0.5 ? "🪙 Yazı" : "🪙 Tura");
    if (cmd === "!yt" || cmd === "!youtube") return message.reply("Youtube = @freaktsingmc");

    /* ---------- ECONOMY ---------- */
    if (cmd === "!balance" || cmd === "!bal") {
        const user = await getUser(uid);
        const chat = await getChatData(uid);
        return message.reply(`💰 Bakiyen: **${(user.coins + chat.coins).toLocaleString()}** coin`);
    }

    if (cmd === "!hunt") {
        const vip = getVipLevel(message.member);
        let cooldownMs = 10000;
        if (vip === 1) cooldownMs = 5000;
        if (vip === 2) cooldownMs = 2500;
        if (hasCooldown(uid, "hunt", cooldownMs)) return message.reply(`⏳ Hunt için ${cooldownMs / 1000} saniye bekle!`);
        const user = await getUser(uid);
        if (user.coins < 10) return message.reply("❌ Hunt için 10 coin gerekiyor, yeterli paran yok!");

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
            for (const h of liste) { r -= h.sans; if (r <= 0) return h; }
            return liste[liste.length - 1];
        }

        const sansVar = await hasSansArtirici(uid);
        let bulunan;
        if (sansVar) {
            const guclendirilmis = hayvanlar.map(h => ({ ...h, sans: h.satis >= 22 ? h.sans * 3 : h.sans }));
            bulunan = rastgeleHayvan(guclendirilmis);
            await db.collection("vip_boosts").updateOne({ user_id: uid }, { $inc: { sans_artirici: -1 } });
            const vipData = await getVipBoost(uid);
            await db.collection("animals").insertOne({ user_id: uid, animal: bulunan.isim });
            await db.collection("users").updateOne({ id: uid }, { $inc: { coins: -10 } });
            return message.reply(`🎯 **${bulunan.isim}** yakaladın! ${bulunan.nadir} — Satış: **${bulunan.satis} coin** | **-10 coin**\n✨ Şans artırıcı kullanıldı! (${vipData.sans_artirici} kaldı)`);
        } else {
            bulunan = rastgeleHayvan(hayvanlar);
        }
        await db.collection("animals").insertOne({ user_id: uid, animal: bulunan.isim });
        await db.collection("users").updateOne({ id: uid }, { $inc: { coins: -10 } });
        return message.reply(`🎯 **${bulunan.isim}** yakaladın! ${bulunan.nadir} — Satış: **${bulunan.satis} coin** | **-10 coin**`);
    }

    if (cmd === "!zoo") {
        const rows = await db.collection("animals").find({ user_id: uid }).toArray();
        if (rows.length === 0) return message.reply("📭 Henüz hiç hayvanın yok!");
        return message.reply(`🦁 Hayvanların (${rows.length}): ${rows.map(r => r.animal).join(", ")}`);
    }

    if (cmd === "!sell") {
        const rows = await db.collection("animals").find({ user_id: uid }).toArray();
        if (rows.length < 5) return message.reply(`❌ En az **5 hayvanın** olması gerekiyor! Şu an: **${rows.length}**`);

        const satisFiyati = {
            "🐰 Tavşan": 15, "🐺 Kurt": 15, "🐻 Ayı": 15, "🦊 Tilki": 15, "🐸 Kurbağa": 15,
            "🦅 Kartal": 22, "🦁 Aslan": 25, "🦄 Unicorn": 25, "🐉 Ejderha": 55, "🐠 Japon Balığı": 320
        };
        function hesaplaKazanc(liste) { return liste.reduce((t, r) => t + (satisFiyati[r.animal] || 15), 0); }

        const miktar = parseInt(args[1]);
        if (!isNaN(miktar) && miktar > 0) {
            if (miktar > rows.length) return message.reply(`❌ Sadece **${rows.length}** hayvanın var!`);
            const satilacaklar = rows.slice(-miktar);
            const kazanc = hesaplaKazanc(satilacaklar);
            const ids = satilacaklar.map(r => r._id);
            await db.collection("animals").deleteMany({ _id: { $in: ids } });
            await db.collection("users").updateOne({ id: uid }, { $inc: { coins: kazanc } });
            return message.reply(`💸 **${miktar}** hayvan sattın! **+${kazanc} coin**`);
        }

        const toplamKazanc = hesaplaKazanc(rows);
        const onayMesaj = await message.channel.send(`⚠️ ${message.author} **${rows.length} hayvanının tümünü** satmak istiyor musun?\nKazanacağın: **${toplamKazanc} coin**\n\n✅ \`evet\` yaz | ❌ \`hayır\` yaz`);
        const filter = m => m.author.id === uid && ["evet","hayır","hayir"].includes(m.content.trim().toLowerCase());
        const collector = message.channel.createMessageCollector({ filter, time: 15000, max: 1 });
        collector.on("collect", async m => {
            try { await m.delete(); } catch {}
            try { await onayMesaj.delete(); } catch {}
            if (m.content.trim().toLowerCase() === "evet") {
                await db.collection("animals").deleteMany({ user_id: uid });
                await db.collection("users").updateOne({ id: uid }, { $inc: { coins: toplamKazanc } });
                message.channel.send(`💸 **${rows.length}** hayvanın satıldı! **+${toplamKazanc} coin**`);
            } else {
                message.channel.send(`↩️ Satış iptal. Belirli sayıda için \`!sell <miktar>\` kullan.`);
            }
        });
        collector.on("end", (_, reason) => { if (reason === "time") { try { onayMesaj.delete(); } catch {} message.channel.send("⏰ Süre doldu."); } });
        return;
    }

    if (cmd === "!cf") {
        if (hasCooldown(uid, "cf", 5000)) return message.reply("⏳ 5 saniye bekle!");
        const amount = parseInt(args[1]);
        if (isNaN(amount) || amount <= 0) return message.reply("❌ Kullanım: `!cf 100`");
        const user = await getUser(uid);
        if (user.coins < amount) return message.reply("❌ Yeterli paran yok!");
        const win = Math.random() < 0.5;
        await db.collection("users").updateOne({ id: uid }, { $inc: { coins: win ? amount : -amount } });
        return message.reply(win ? `🎉 Kazandın! +${amount} coin` : `💸 Kaybettin! -${amount} coin`);
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
        await db.collection("users").updateOne({ id: uid }, { $inc: { coins: odul }, $set: { last_daily: now } });
        return message.reply(`🎁 Günlük ödülünü aldın! **+${odul} coin**${etiket}`);
    }

    /* ---------- SUNUCU ---------- */
    if (cmd === "!sunucu" || cmd === "!server") {
        const guild = message.guild;
        await guild.members.fetch();
        const toplamUye = guild.memberCount;
        const botSayisi = guild.members.cache.filter(m => m.user.bot).size;
        const embed = new EmbedBuilder()
            .setTitle(`📊 ${guild.name} — Sunucu İstatistikleri`)
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .addFields(
                { name: "👥 Toplam Üye",  value: `${toplamUye}`, inline: true },
                { name: "🧑 İnsan",        value: `${toplamUye - botSayisi}`, inline: true },
                { name: "🤖 Bot",          value: `${botSayisi}`, inline: true },
                { name: "💬 Metin Kanalı", value: `${guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size}`, inline: true },
                { name: "🔊 Ses Kanalı",   value: `${guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size}`, inline: true },
                { name: "🎭 Rol Sayısı",   value: `${guild.roles.cache.size - 1}`, inline: true },
                { name: "📅 Kuruluş",      value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true }
            )
            .setColor(0x5865F2).setFooter({ text: "Freaktsing • Sunucu Bilgisi" }).setTimestamp();
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === "!profil") {
        const hedef = message.mentions.members.first() || message.member;
        const user  = await getUser(hedef.id);
        const chat  = await getChatData(hedef.id);
        const lvl   = await getLevelData(hedef.id);
        const hayvanSayisi = await db.collection("animals").countDocuments({ user_id: hedef.id });
        const embed = new EmbedBuilder()
            .setTitle(`👤 ${hedef.user.username} — Profil`)
            .setThumbnail(hedef.user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: "⭐ Level",  value: `${lvl.level}`, inline: true },
                { name: "✨ XP",     value: `${lvl.xp}`, inline: true },
                { name: "💰 Coin",   value: `${(user.coins + chat.coins).toLocaleString()}`, inline: true },
                { name: "🦁 Hayvan", value: `${hayvanSayisi}`, inline: true },
                { name: "💬 Kelime", value: `${chat.words.toLocaleString()}`, inline: true },
                { name: "📅 Katılma",value: `<t:${Math.floor(hedef.joinedTimestamp / 1000)}:D>`, inline: true }
            )
            .setColor(0x5865F2).setFooter({ text: "Freaktsing • Profil" }).setTimestamp();
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === "!sıralama" || cmd === "!lb") {
        const topUsers = await db.collection("users").find().sort({ coins: -1 }).limit(10).toArray();
        if (topUsers.length === 0) return message.reply("📭 Henüz veri yok.");
        const liste = await Promise.all(topUsers.map(async (u, i) => {
            const chat = await getChatData(u.id);
            const toplam = u.coins + chat.coins;
            const member = await message.guild.members.fetch(u.id).catch(() => null);
            const isim = member ? member.user.username : `Bilinmeyen`;
            const madalya = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i+1}.**`;
            return `${madalya} ${isim} — **${toplam.toLocaleString()}** coin`;
        }));
        const embed = new EmbedBuilder()
            .setTitle("🏆 Coin Sıralaması — Top 10")
            .setDescription(liste.join("\n"))
            .setColor(0xFFD700).setFooter({ text: "Freaktsing • Sıralama" }).setTimestamp();
        return message.channel.send({ embeds: [embed] });
    }

    /* ---------- MİNİ OYUNLAR ---------- */

    if (cmd === "!ttt") {
        const rakip = message.mentions.members.first();
        if (!rakip || rakip.id === message.author.id) return message.reply("❌ Kullanım: `!ttt @rakip`");
        if (rakip.user.bot) return message.reply("❌ Botla oynayamazsın!");
        const user1 = await getUser(message.author.id);
        const user2 = await getUser(rakip.id);
        if (user1.coins < 15) return message.reply("❌ **15 coin** gerekiyor!");
        if (user2.coins < 15) return message.reply(`❌ ${rakip} yeterli coini yok!`);
        await db.collection("users").updateOne({ id: message.author.id }, { $inc: { coins: -15 } });
        await db.collection("users").updateOne({ id: rakip.id }, { $inc: { coins: -15 } });
        const board = ["1","2","3","4","5","6","7","8","9"];
        let siradaki = message.author.id;
        const oyuncular = { X: message.author.id, O: rakip.id };
        function boardGoster() { return `\`\`\`\n${board[0]} | ${board[1]} | ${board[2]}\n---------\n${board[3]} | ${board[4]} | ${board[5]}\n---------\n${board[6]} | ${board[7]} | ${board[8]}\n\`\`\``; }
        function kazananKontrol() {
            const k = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
            for (const [a,b,c] of k) if (board[a] === board[b] && board[b] === board[c]) return board[a];
            if (board.every(x => x === "X" || x === "O")) return "berabere";
            return null;
        }
        const ilkMesaj = await message.channel.send(`🎮 **Yazı Taşı** — ${message.author} (X) vs ${rakip} (O)\n${boardGoster()}\n⏳ ${message.author} hamleni yap! (1-9)`);
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
                    await db.collection("users").updateOne({ id: message.author.id }, { $inc: { coins: 15 } });
                    await db.collection("users").updateOne({ id: rakip.id }, { $inc: { coins: 15 } });
                    return ilkMesaj.edit(`🎮 **Yazı Taşı**\n${boardGoster()}\n🤝 **Berabere! Coinler iade edildi.**`);
                }
                const kazanan = sonuc === "X" ? message.author : rakip;
                await db.collection("users").updateOne({ id: kazanan.id }, { $inc: { coins: 30 } });
                return ilkMesaj.edit(`🎮 **Yazı Taşı**\n${boardGoster()}\n🏆 **${kazanan} kazandı! +30 coin**`);
            }
            siradaki = siradaki === message.author.id ? rakip.id : message.author.id;
            const siradakiMention = siradaki === message.author.id ? message.author : rakip;
            ilkMesaj.edit(`🎮 **Yazı Taşı** — ${message.author} (X) vs ${rakip} (O)\n${boardGoster()}\n⏳ ${siradakiMention} hamleni yap!`);
        });
        collector.on("end", async (_, reason) => {
            if (reason === "time") {
                await db.collection("users").updateOne({ id: message.author.id }, { $inc: { coins: 15 } });
                await db.collection("users").updateOne({ id: rakip.id }, { $inc: { coins: 15 } });
                ilkMesaj.edit(`🎮 **Yazı Taşı**\n${boardGoster()}\n⏰ Süre doldu, coinler iade edildi!`);
            }
        });
        return;
    }

    if (cmd === "!tahmin") {
        if (hasCooldown(uid, "tahmin", 30000)) return message.reply("⏳ 30 saniye bekle!");
        const user = await getUser(uid);
        if (user.coins < 15) return message.reply("❌ **15 coin** gerekiyor!");
        await db.collection("users").updateOne({ id: uid }, { $inc: { coins: -15 } });
        const sayi = Math.floor(Math.random() * 100) + 1;
        let deneme = 0;
        const msg = await message.channel.send(`🎯 **Sayı Tahmin** — 1-100 arası! **-15 coin** | 7 hakkın, kazanırsan **+30 coin**`);
        const filter = m => m.author.id === uid && !isNaN(m.content.trim()) && m.content.trim() !== "";
        const collector = message.channel.createMessageCollector({ filter, time: 30000, max: 7 });
        collector.on("collect", async m => {
            deneme++;
            const tahmin = parseInt(m.content.trim());
            try { await m.delete(); } catch {}
            if (tahmin === sayi) {
                await db.collection("users").updateOne({ id: uid }, { $inc: { coins: 30 } });
                collector.stop("kazandi");
                return msg.edit(`🎯 **Sayı Tahmin**\n🏆 ${message.author} **${deneme}. denemede** buldu! Sayı: **${sayi}** — **+30 coin**`);
            }
            const ipucu = tahmin < sayi ? "📈 Daha büyük!" : "📉 Daha küçük!";
            const kalanHak = 7 - deneme;
            if (kalanHak === 0) { collector.stop("bitti"); return msg.edit(`🎯 **Sayı Tahmin**\n💸 Bulamadın! Sayı: **${sayi}**`); }
            msg.edit(`🎯 **Sayı Tahmin** — ${ipucu} (${kalanHak} hak kaldı)`);
        });
        collector.on("end", (_, reason) => { if (reason === "time") msg.edit(`🎯 **Sayı Tahmin**\n⏰ Süre doldu! Sayı: **${sayi}**`); });
        return;
    }

    if (cmd === "!kelime") {
        if (hasCooldown(uid, "kelime", 30000)) return message.reply("⏳ 30 saniye bekle!");
        const user = await getUser(uid);
        if (user.coins < 15) return message.reply("❌ **15 coin** gerekiyor!");
        await db.collection("users").updateOne({ id: uid }, { $inc: { coins: -15 } });
        const kelimeListesi = {
            "Hayvan": ["at","ayı","balık","baykuş","boğa","ceylan","çita","deve","domuz","eşek","fare","fil","fok","geyik","goril","hamster","inek","jaguar","kaplumbağa","kaplan","kartal","kedi","keçi","kertenkele","kirpi","koyun","köpek","köpekbalığı","kurt","kuş","kurbağa","leopar","leylek","maymun","martı","papağan","penguen","puma","serçe","sincap","tavşan","tavuk","timsah","tilki","yılan","zebra","zürafa","aslan","arı","akrep","karga","balina","yunus","ahtapot","yengeç","ördek","horoz","hindi","güvercin","flamingo","pelikan","karınca","kelebek","uğurböceği","sinek"],
            "Ülke": ["almanya","arjantin","avustralya","avusturya","azerbaycan","belçika","brezilya","bulgaristan","çin","danimarka","endonezya","fransa","hindistan","hollanda","irak","iran","ispanya","italya","japonya","kanada","kazakistan","kenya","kolombiya","kore","meksika","mısır","norveç","özbekistan","pakistan","polonya","portekiz","romanya","rusya","singapur","türkiye","ukrayna","vietnam","yunanistan"],
            "Şehir": ["adana","ankara","antalya","bursa","çanakkale","denizli","diyarbakır","edirne","erzurum","eskişehir","gaziantep","istanbul","izmir","kahramanmaraş","kayseri","konya","malatya","mersin","samsun","trabzon","paris","londra","berlin","madrid","roma","tokyo","pekin","dubai","sydney"],
            "Yiyecek": ["ayran","baklava","börek","çiğköfte","çorba","dolma","döner","ekmek","fasulye","gözleme","hamsi","helva","kebap","köfte","künefe","lahmacun","mantı","mercimek","pilav","pide","pizza","sarma","sütlaç","tavuk","turşu","yoğurt","zeytin","çikolata","dondurma","kek","pasta","waffle","makarna","hamburger","salata","simit","dürüm"],
            "Meslek": ["aşçı","avukat","berber","cerrah","çiftçi","doktor","eczacı","elektrikçi","fotoğrafçı","gazeteci","hemşire","itfaiyeci","kaptan","kimyager","mimar","mühendis","müzisyen","öğretmen","polis","programcı","psikolog","ressam","şef","şoför","veteriner","yargıç","yazılımcı","pilot","asker","yazar","oyuncu"]
        };
        const kategoriler = Object.keys(kelimeListesi);
        const kategori = kategoriler[Math.floor(Math.random() * kategoriler.length)];
        const harfler = "ABCDEFGHIKLMNOPRSTYZ";
        let finalHarf = null, denemeHarf = 0;
        while (!finalHarf && denemeHarf < 20) {
            const h = harfler[Math.floor(Math.random() * harfler.length)];
            if (kelimeListesi[kategori].some(k => k.startsWith(h.toLowerCase()))) finalHarf = h;
            denemeHarf++;
        }
        if (!finalHarf) finalHarf = "A";
        const msg = await message.channel.send(`🔤 **Kelime Oyunu** (**-15 coin**)\n**Kategori:** ${kategori} | **Harf:** **${finalHarf}**\n\n⏳ 20 saniyede yaz! Kazanırsan **+30 coin**`);
        const filter = m => { if (m.author.id !== uid) return false; const k = m.content.trim().toLowerCase(); return k.startsWith(finalHarf.toLowerCase()) && k.length >= 3; };
        const collector = message.channel.createMessageCollector({ filter, time: 20000, max: 3 });
        let yanlisSayisi = 0;
        collector.on("collect", async m => {
            const kelime = m.content.trim().toLowerCase();
            try { await m.delete(); } catch {}
            if (kelimeListesi[kategori].includes(kelime)) {
                await db.collection("users").updateOne({ id: uid }, { $inc: { coins: 30 } });
                collector.stop("kazandi");
                return msg.edit(`🔤 **Kelime Oyunu**\n✅ **"${m.content.trim()}"** doğru! **+30 coin**`);
            }
            yanlisSayisi++;
            const kalanHak = 3 - yanlisSayisi;
            if (kalanHak <= 0) { collector.stop("bitti"); return msg.edit(`🔤 **Kelime Oyunu**\n❌ **"${m.content.trim()}"** geçersiz! Tüm haklar bitti.`); }
            msg.edit(`🔤 **Kelime Oyunu** | **${kategori}** — **${finalHarf}**\n❌ **"${m.content.trim()}"** geçersiz! (${kalanHak} hak kaldı)`);
        });
        collector.on("end", (_, reason) => { if (reason === "time") msg.edit(`🔤 **Kelime Oyunu**\n⏰ Süre doldu!`); });
        return;
    }

    /* ---------- VIP KOMUTLARI ---------- */

    if (cmd === "!vipshop") {
        const vip = getVipLevel(message.member);
        if (vip === 0) return message.reply("❌ Bu komut sadece **VIP** ve **VIP+** üyelerine özeldir!");
        const boost = await getVipBoost(uid);
        const coinBoostAktif = boost.coin_boost_until > Date.now();
        const embed = new EmbedBuilder()
            .setTitle(vip === 2 ? "👑 VIP+ Mağaza" : "⭐ VIP Mağaza")
            .setDescription(
                `**Mevcut Durumun:**\n💰 Coin Boost: ${coinBoostAktif ? `✅ <t:${Math.floor(boost.coin_boost_until/1000)}:R> bitiyor` : "❌ Aktif değil"}\n✨ Şans Artırıcı: **${boost.sans_artirici}** kullanım\n\n` +
                `**Ürünler:**\n\`1\` 💰 Coin Boost (1 saat 2x) — **${vip===2?"3.000":"5.000"} coin**\n\`2\` 🎁 Hayvan Paketi (5 hayvan) — **${vip===2?"1.500":"2.500"} coin**\n\`3\` ✨ Şans Artırıcı (5 kullanım) — **${vip===2?"2.000":"3.500"} coin**\n\nSatın almak için \`!vipal <numara>\``
            )
            .setColor(vip === 2 ? 0xFFD700 : 0xC0C0C0).setFooter({ text: "Freaktsing • VIP Mağaza" }).setTimestamp();
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === "!vipal") {
        const vip = getVipLevel(message.member);
        if (vip === 0) return message.reply("❌ Bu komut sadece **VIP** ve **VIP+** üyelerine özeldir!");
        const secim = parseInt(args[1]);
        if (isNaN(secim) || secim < 1 || secim > 3) return message.reply("❌ Kullanım: `!vipal <1/2/3>`");
        const fiyatlar = { 1: vip===2?3000:5000, 2: vip===2?1500:2500, 3: vip===2?2000:3500 };
        const fiyat = fiyatlar[secim];
        const user = await getUser(uid);
        if (user.coins < fiyat) return message.reply(`❌ Yeterli coin yok! Gerekli: **${fiyat.toLocaleString()} coin**`);
        await db.collection("users").updateOne({ id: uid }, { $inc: { coins: -fiyat } });
        await getVipBoost(uid);
        if (secim === 1) {
            const boost = await getVipBoost(uid);
            const base = Math.max(boost.coin_boost_until, Date.now());
            const yeni = base + 3600000;
            await db.collection("vip_boosts").updateOne({ user_id: uid }, { $set: { coin_boost_until: yeni } });
            return message.reply(`✅ 💰 **Coin Boost** aktif! <t:${Math.floor(yeni/1000)}:R> bitiyor.`);
        }
        if (secim === 2) {
            const hayvanlar = ["🐰 Tavşan","🐺 Kurt","🐻 Ayı","🦊 Tilki","🐸 Kurbağa","🦁 Aslan","🐉 Ejderha","🦄 Unicorn","🦅 Kartal"];
            const eklenenler = [];
            for (let i = 0; i < 5; i++) { const h = hayvanlar[Math.floor(Math.random()*hayvanlar.length)]; await db.collection("animals").insertOne({ user_id: uid, animal: h }); eklenenler.push(h); }
            return message.reply(`✅ 🎁 **Hayvan Paketi** alındı!\n${eklenenler.join(", ")}`);
        }
        if (secim === 3) {
            await db.collection("vip_boosts").updateOne({ user_id: uid }, { $inc: { sans_artirici: 5 } });
            const yeni = await getVipBoost(uid);
            return message.reply(`✅ ✨ **Şans Artırıcı** alındı! Toplam **${yeni.sans_artirici}** kullanımın var.`);
        }
    }

    if (cmd === "!hazine") {
        const vip = getVipLevel(message.member);
        if (vip === 0) return message.reply("❌ `!hazine` sadece **VIP** ve **VIP+** üyelerine özel!");
        if (hasCooldown(uid, "hazine", vip===2?60000:120000)) return message.reply(`⏳ ${vip===2?"1 dakika":"2 dakika"} bekle!`);
        const odul = vip===2 ? Math.floor(Math.random()*1500)+500 : Math.floor(Math.random()*800)+200;
        const ipuclari = ["Kuzey yönünde bir ağacın altında...","Güneyde taşların arasında...","Doğuda nehir kenarında...","Batıda eski bir kalıntının yanında...","Ormanın tam ortasında...","Dağın zirvesine yakın bir mağarada..."];
        const dogru = ipuclari[Math.floor(Math.random()*ipuclari.length)];
        const diger = ipuclari.filter(i => i !== dogru);
        const secenekler = [dogru, diger[Math.floor(Math.random()*(diger.length-1))], diger[Math.floor(Math.random()*(diger.length-1))+1]].sort(() => Math.random()-0.5);
        const dogruIndex = secenekler.indexOf(dogru) + 1;
        const embed = new EmbedBuilder()
            .setTitle("🗺️ Hazine Avı!")
            .setDescription(`${message.author} hazine haritası buldun!\n\n\`1\` ${secenekler[0]}\n\`2\` ${secenekler[1]}\n\`3\` ${secenekler[2]}\n\n⏳ **20 saniye** içinde yaz! 🏆 **+${odul.toLocaleString()} coin**`)
            .setColor(vip===2?0xFFD700:0xC0C0C0).setFooter({ text: "Freaktsing • Hazine Avı" }).setTimestamp();
        const hazineMesaj = await message.channel.send({ embeds: [embed] });
        const filter = m => m.author.id === uid && ["1","2","3"].includes(m.content.trim());
        const collector = message.channel.createMessageCollector({ filter, time: 20000, max: 1 });
        collector.on("collect", async m => {
            try { await m.delete(); } catch {}
            if (parseInt(m.content.trim()) === dogruIndex) {
                const coinBoostAktif = await hasCoinBoost(uid);
                const gercekOdul = coinBoostAktif ? odul * 2 : odul;
                await db.collection("users").updateOne({ id: uid }, { $inc: { coins: gercekOdul } });
                hazineMesaj.edit({ embeds: [EmbedBuilder.from(hazineMesaj.embeds[0]).setDescription(`🎉 **Doğru!** 📍 ${dogru}\n\n💰 **+${gercekOdul.toLocaleString()} coin**${coinBoostAktif?" 💰 (2x Boost!)":""}`).setColor(0x00CC66)] });
            } else {
                hazineMesaj.edit({ embeds: [EmbedBuilder.from(hazineMesaj.embeds[0]).setDescription(`❌ **Yanlış!** 📍 Doğru: **${dogru}**`).setColor(0xFF4444)] });
            }
        });
        collector.on("end", (_, reason) => { if (reason==="time") hazineMesaj.edit({ embeds: [EmbedBuilder.from(hazineMesaj.embeds[0]).setDescription(`⏰ Süre doldu! 📍 Doğru: **${dogru}**`).setColor(0xFF4444)] }); });
        return;
    }

    if (cmd === "!vipbilgi") {
        const vip = getVipLevel(message.member);
        if (vip === 0) return message.reply("❌ Bu komut sadece VIP üyelere özeldir!");
        const boost = await getVipBoost(uid);
        const coinBoostAktif = boost.coin_boost_until > Date.now();
        const embed = new EmbedBuilder()
            .setTitle(vip===2?"👑 VIP+ Bilgilerin":"⭐ VIP Bilgilerin")
            .addFields(
                { name: "💰 Günlük Ödül",  value: vip===2?"2.000 coin":"1.000 coin", inline: true },
                { name: "⏱️ Hunt Cooldown", value: vip===2?"2.5 saniye":"5 saniye", inline: true },
                { name: "💰 Coin Boost",    value: coinBoostAktif?`✅ <t:${Math.floor(boost.coin_boost_until/1000)}:R>`:"❌ Aktif değil", inline: false },
                { name: "✨ Şans Artırıcı", value: `${boost.sans_artirici} kullanım`, inline: true },
                { name: "🗺️ Hazine Avı",    value: vip===2?"1 dk":"2 dk", inline: true }
            )
            .setColor(vip===2?0xFFD700:0xC0C0C0).setFooter({ text: "Freaktsing • VIP Bilgi" }).setTimestamp();
        return message.channel.send({ embeds: [embed] });
    }

    /* ---------- GEÇMİŞ ---------- */

    if (cmd === "!gecmis") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Bu komutu kullanma yetkin yok.");
        const hedef = message.mentions.members.first();
        if (!hedef) return message.reply("❌ Kullanım: `!gecmis @kullanıcı`");
        const kayitlar = await db.collection("mod_logs").find({ user_id: hedef.id }).sort({ tarih: -1 }).limit(20).toArray();
        if (kayitlar.length === 0) return message.reply(`📭 **${hedef.user.username}** adlı kullanıcının ceza kaydı yok.`);
        const muteSayisi = kayitlar.filter(k => k.islem === "Mute").length;
        const banSayisi  = kayitlar.filter(k => k.islem === "Ban").length;
        const liste = kayitlar.map((k, i) => {
            const tarih   = `<t:${Math.floor(k.tarih/1000)}:D>`;
            const yetkili = k.yetkili_id === "bot" || k.yetkili_id === client.user?.id ? "🤖 Otomatik" : `<@${k.yetkili_id}>`;
            const islem   = k.islem === "Ban" ? "🔨 Ban" : "🔇 Mute";
            return `**${i+1}.** ${islem} — ${tarih}\n> Süre: ${k.sure} | Sebep: ${k.sebep} | Yetkili: ${yetkili}`;
        }).join("\n\n");
        const embed = new EmbedBuilder()
            .setTitle(`📋 ${hedef.user.username} — Ceza Geçmişi`)
            .setThumbnail(hedef.user.displayAvatarURL({ dynamic: true }))
            .setDescription(`🔇 **Toplam Mute:** ${muteSayisi}\n🔨 **Toplam Ban:** ${banSayisi}\n\n${liste}`)
            .setColor(0xFF4444).setFooter({ text: "Freaktsing • Moderasyon Geçmişi" }).setTimestamp();
        return message.channel.send({ embeds: [embed] });
    }

    /* ---------- ADMIN ---------- */

    if (cmd === "!addcoins") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const user = message.mentions.users.first();
        const amount = parseInt(args[2]);
        if (!user || isNaN(amount)) return message.reply("❌ Kullanım: `!addcoins @user miktar`");
        await getUser(user.id);
        await db.collection("users").updateOne({ id: user.id }, { $inc: { coins: amount } });
        return message.reply(`✅ ${user.username} kullanıcısına ${amount} coin eklendi.`);
    }

    if (cmd === "!removecoins") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const user = message.mentions.users.first();
        const amount = parseInt(args[2]);
        if (!user || isNaN(amount)) return message.reply("❌ Kullanım: `!removecoins @user miktar`");
        await getUser(user.id);
        await db.collection("users").updateOne({ id: user.id }, { $inc: { coins: -amount } });
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
        if (!ms) return "Kalıcı";
        const d = Math.floor(ms/86400000), h = Math.floor((ms%86400000)/3600000), m = Math.floor((ms%3600000)/60000);
        if (d > 0) return `${d} gün`; if (h > 0) return `${h} saat`; return `${m} dakika`;
    }

    if (cmd === "!mute") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Yetkin yok.");
        const hedef = message.mentions.members.first();
        if (!hedef) return message.reply("❌ Kullanım: `!mute @kullanıcı [süre] [sebep]`");
        if (hedef.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Yöneticileri susturamazsın.");
        const surStr = args[2] && /^\d+(m|h|d)$/i.test(args[2]) ? args[2] : null;
        const sureMs = surStr ? parseSure(surStr) : null;
        const sebep  = (surStr ? args.slice(3) : args.slice(2)).join(" ") || "Sebep belirtilmedi";
        try {
            await hedef.timeout(sureMs || (28*24*60*60*1000), sebep);
            await db.collection("mod_logs").insertOne({ user_id: hedef.id, islem: "Mute", sebep, sure: sureMesvaji(sureMs), yetkili_id: message.author.id, tarih: Date.now() });
            const embed = new EmbedBuilder().setTitle("🔇 Kullanıcı Susturuldu")
                .addFields({ name: "Kullanıcı", value: `${hedef}`, inline: true }, { name: "Yetkili", value: `${message.author}`, inline: true }, { name: "Süre", value: sureMesvaji(sureMs), inline: true }, { name: "Sebep", value: sebep })
                .setColor(0xFFA500).setTimestamp();
            return message.channel.send({ embeds: [embed] });
        } catch { return message.reply("❌ Susturulamadı."); }
    }

    if (cmd === "!unmute") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Yetkin yok.");
        const hedef = message.mentions.members.first();
        if (!hedef) return message.reply("❌ Kullanım: `!unmute @kullanıcı`");
        try {
            await hedef.timeout(null);
            const embed = new EmbedBuilder().setTitle("🔊 Susturma Kaldırıldı")
                .addFields({ name: "Kullanıcı", value: `${hedef}`, inline: true }, { name: "Yetkili", value: `${message.author}`, inline: true })
                .setColor(0x00CC66).setTimestamp();
            return message.channel.send({ embeds: [embed] });
        } catch { return message.reply("❌ Kaldırılamadı."); }
    }

    if (cmd === "!ban") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Yetkin yok.");
        const hedef = message.mentions.members.first();
        if (!hedef) return message.reply("❌ Kullanım: `!ban @kullanıcı [süre] [sebep]`");
        if (hedef.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Yöneticileri banlayamazsın.");
        if (!hedef.bannable) return message.reply("❌ Bu kullanıcıyı banlayamam.");
        const surStr = args[2] && /^\d+(m|h|d)$/i.test(args[2]) ? args[2] : null;
        const sureMs = surStr ? parseSure(surStr) : null;
        const sebep  = (surStr ? args.slice(3) : args.slice(2)).join(" ") || "Sebep belirtilmedi";
        try {
            await hedef.ban({ reason: sebep });
            await db.collection("mod_logs").insertOne({ user_id: hedef.id, islem: "Ban", sebep, sure: sureMesvaji(sureMs), yetkili_id: message.author.id, tarih: Date.now() });
            const embed = new EmbedBuilder().setTitle("🔨 Kullanıcı Banlandı")
                .addFields({ name: "Kullanıcı", value: `${hedef.user.tag}`, inline: true }, { name: "Yetkili", value: `${message.author}`, inline: true }, { name: "Süre", value: sureMesvaji(sureMs), inline: true }, { name: "Sebep", value: sebep })
                .setColor(0xFF0000).setTimestamp();
            message.channel.send({ embeds: [embed] });
            if (sureMs) setTimeout(async () => { try { await message.guild.members.unban(hedef.id, "Ban süresi doldu"); message.channel.send(`✅ **${hedef.user.tag}** ban süresi doldu.`); } catch {} }, sureMs);
            return;
        } catch { return message.reply("❌ Banlanamadı."); }
    }

    if (cmd === "!unban") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Yetkin yok.");
        const aranan = args.slice(1).join(" ");
        if (!aranan) return message.reply("❌ Kullanım: `!unban <ID veya kullanıcı adı>`");
        try {
            const banList = await message.guild.bans.fetch();
            let entry = banList.get(aranan) || banList.find(b => b.user.username.toLowerCase().includes(aranan.toLowerCase()));
            if (!entry) return message.reply(`❌ \`${aranan}\` banlı değil.`);
            await message.guild.members.unban(entry.user.id);
            const embed = new EmbedBuilder().setTitle("✅ Ban Kaldırıldı")
                .addFields({ name: "Kullanıcı", value: `${entry.user.tag}`, inline: true }, { name: "Yetkili", value: `${message.author}`, inline: true })
                .setColor(0x00CC66).setTimestamp();
            return message.channel.send({ embeds: [embed] });
        } catch (e) { return message.reply("❌ Ban kaldırılamadı: " + e.message); }
    }

    if (cmd === "!seen") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
            return message.reply("❌ Yetkin yok.");
        const sub = args[1]?.toLowerCase();
        if (!sub || (sub !== "banli" && sub !== "muteli")) return message.reply("❌ `!seen banli` veya `!seen muteli`");
        if (sub === "banli") {
            const banList = await message.guild.bans.fetch();
            if (banList.size === 0) return message.reply("📭 Banlı yok.");
            const liste = banList.map(b => `\`${b.user.tag}\` — \`${b.user.id}\`${b.reason?` — *${b.reason}*`:""}`).join("\n");
            return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`🔨 Banlı (${banList.size})`).setDescription(liste.slice(0,4000)).setColor(0xFF0000).setTimestamp()] });
        }
        if (sub === "muteli") {
            const muteli = message.guild.members.cache.filter(m => m.isCommunicationDisabled());
            if (muteli.size === 0) return message.reply("📭 Susturulmuş yok.");
            const liste = muteli.map(m => `\`${m.user.tag}\` — <t:${Math.floor(m.communicationDisabledUntil?.getTime()/1000)}:R>`).join("\n");
            return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`🔇 Susturulmuş (${muteli.size})`).setDescription(liste.slice(0,4000)).setColor(0xFFA500).setTimestamp()] });
        }
    }

    if (cmd === "!msg") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        const metin = message.content.slice("!msg".length).trim();
        if (!metin) return message.reply("❌ `!msg <mesaj>`");
        try { await message.delete(); } catch {}
        return message.channel.send(metin);
    }

    if (cmd === "!kapat") {
        const topic = message.channel.topic || "";
        if (!topic.includes("-")) return;
        const hasSupport = message.member.roles.cache.has(SUPPORT_ROLE);
        const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
        if (!hasSupport && !isAdmin) return message.reply("❌ Yetkisiz.");
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle("🔒 Ticket Kapatılıyor").setDescription(`**${message.author.tag}** tarafından kapatıldı. 5 saniye içinde silinecek.`).setColor(0xFF4444).setTimestamp()] });
        setTimeout(() => message.channel.delete().catch(() => {}), 5000);
        return;
    }

    if (cmd === "!ticketpanel") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Sadece adminler.");
        const embed = new EmbedBuilder()
            .setTitle("🎫 Freaktsing Destek Merkezi")
            .setDescription(">>> Destek ekibimize ulaşmak için uygun kategoriyi seçerek ticket açabilirsin.\n\n📌 **Genel Destek** — Herhangi bir konuda yardım\n🎥 **Video Katılım** — Videolarımıza katılmak isteyenler\n⚙️ **Teknik Destek** — Teknik sorunlar\n⚖️ **Oyuncu İtirazı** — Verilen cezalara itiraz")
            .setColor(0x5865F2).setFooter({ text: "Freaktsing • Destek Sistemi" }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("ticket_genel").setLabel("Genel Destek").setEmoji("📌").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("ticket_video").setLabel("Video Katılım").setEmoji("🎥").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("ticket_teknik").setLabel("Teknik Destek").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("ticket_itiraz").setLabel("Oyuncu İtirazı").setEmoji("⚖️").setStyle(ButtonStyle.Secondary)
        );
        return message.channel.send({ embeds: [embed], components: [row] });
    }

    /* ---------- ÇEKİLİŞ KOMUTLARI ---------- */

    if (cmd === "!cekilis") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Sadece adminler.");
        const surStr = args[1], kazananSayisi = parseInt(args[2]), odul = args.slice(3).join(" ");
        if (!surStr || isNaN(kazananSayisi) || kazananSayisi < 1 || !odul) return message.reply("❌ `!cekilis <süre> <kazanan> <ödül>`");
        function parseCekilisSure(str) {
            const match = str.match(/^(\d+)(s|m|h|d)$/i); if (!match) return null;
            const val = parseInt(match[1]), unit = match[2].toLowerCase();
            if (unit==="s") return val*1000; if (unit==="m") return val*60000; if (unit==="h") return val*3600000; if (unit==="d") return val*86400000; return null;
        }
        const sureMs = parseCekilisSure(surStr);
        if (!sureMs || sureMs < 5000) return message.reply("❌ Geçersiz süre!");
        const cekilisId = Date.now().toString(), bitisZamani = Date.now() + sureMs;
        const cekilisEmbed = new EmbedBuilder().setTitle("🎉 ÇEKİLİŞ")
            .setDescription(`**${odul}**\n\n> 🎉 Katılmak için butona tıkla!\n\n🏆 **Kazanan:** ${kazananSayisi}\n⏰ **Bitiş:** <t:${Math.floor(bitisZamani/1000)}:R>\n👥 **Katılımcı:** 0`)
            .setColor(0xFF73FA).setFooter({ text: "Freaktsing • Çekiliş" }).setTimestamp(new Date(bitisZamani));
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`cekilis_katil_${cekilisId}`).setLabel("Katıl").setEmoji("🎉").setStyle(ButtonStyle.Primary));
        const cekilisMsg = await message.channel.send({ embeds: [cekilisEmbed], components: [row] });
        aktifCekilisler.set(cekilisId, { odul, kazananSayisi, katilimcilar: new Set(), mesaj: cekilisMsg, kanalId: message.channel.id, bitisZamani });
        setTimeout(async () => { const c = aktifCekilisler.get(cekilisId); if (c) await cekilisiBitir(cekilisId, c, message.channel); }, sureMs);
        return;
    }

    if (cmd === "!cekilisbitir") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Sadece adminler.");
        if (aktifCekilisler.size === 0) return message.reply("❌ Aktif çekiliş yok.");
        const cekilisId = [...aktifCekilisler.keys()].pop();
        await cekilisiBitir(cekilisId, aktifCekilisler.get(cekilisId), message.channel);
        return;
    }

    if (cmd === "!cekilistekrar") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Sadece adminler.");
        if (!sonBitenCekilis) return message.reply("❌ Tekrar çekilecek çekiliş yok.");
        const { katilimcilar, kazananSayisi, odul } = sonBitenCekilis;
        if (katilimcilar.length === 0) return message.reply("❌ Katılımcı yoktu.");
        const kazananlar = [...katilimcilar].sort(() => Math.random()-0.5).slice(0, Math.min(kazananSayisi, katilimcilar.length));
        const mentions = kazananlar.map(id => `<@${id}>`).join(", ");
        const embed = new EmbedBuilder().setTitle("🔄 Çekiliş Tekrar!").setDescription(`**🎁 Ödül:** ${odul}\n**🎉 Kazananlar:** ${mentions}`).setColor(0xFF73FA).setTimestamp();
        return message.channel.send({ content: `🎊 ${mentions} tebrikler!`, embeds: [embed] });
    }
});

/* ================= TICKET & ÇEKİLİŞ INTERACTION ================= */

const aktifCekilisler = new Map();
let sonBitenCekilis = null;

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith("cekilis_katil_")) {
        const cekilisId = interaction.customId.replace("cekilis_katil_", "");
        const cekilis = aktifCekilisler.get(cekilisId);
        if (!cekilis) return interaction.reply({ content: "❌ Bu çekiliş aktif değil.", ephemeral: true });
        if (cekilis.katilimcilar.has(interaction.user.id)) {
            cekilis.katilimcilar.delete(interaction.user.id);
        } else {
            cekilis.katilimcilar.add(interaction.user.id);
        }
        const embed = EmbedBuilder.from(cekilis.mesaj.embeds[0]).setDescription(`**${cekilis.odul}**\n\n> 🎉 Katılmak için butona tıkla!\n\n🏆 **Kazanan:** ${cekilis.kazananSayisi}\n⏰ **Bitiş:** <t:${Math.floor(cekilis.bitisZamani/1000)}:R>\n👥 **Katılımcı:** ${cekilis.katilimcilar.size}`);
        try { await cekilis.mesaj.edit({ embeds: [embed] }); } catch {}
        const katiliyor = cekilis.katilimcilar.has(interaction.user.id);
        return interaction.reply({ content: katiliyor ? `🎉 Çekilişe katıldın! (${cekilis.katilimcilar.size} katılımcı)` : "↩️ Çekilişten ayrıldın.", ephemeral: true });
    }

    if (interaction.customId.startsWith("ticket_")) {
        const type = interaction.customId.replace("ticket_", "");
        if (!["genel","video","teknik","itiraz"].includes(type)) return;
        if (ticketCooldown.has(interaction.user.id)) return interaction.reply({ content: "⏳ Bekleyin.", ephemeral: true });
        const mevcutTicket = interaction.guild.channels.cache.find(c => c.topic && c.topic.startsWith(interaction.user.id + "-"));
        if (mevcutTicket) return interaction.reply({ content: `❌ Açık ticketin var: ${mevcutTicket}`, ephemeral: true });
        ticketCooldown.add(interaction.user.id);
        setTimeout(() => ticketCooldown.delete(interaction.user.id), 5000);
        const id = await getNextTicketId();
        const titles = { genel: "📌 Genel Destek", video: "🎥 Video Katılım", teknik: "⚙️ Teknik Destek", itiraz: "⚖️ Oyuncu İtirazı" };
        const colors = { genel: 0x5865F2, video: 0xFF0000, teknik: 0xFFA500, itiraz: 0xFF4444 };
        const forms = {
            genel: "```\n1. Adınız:\n2. Konu:\n3. Açıklama:\n4. Daha önce destek aldınız mı?\n```",
            video: "```\n1. Ad Soyad:\n2. Nickname:\n3. Yaş:\n4. Oyun:\n5. Rank:\n6. İçerik türü:\n7. Sosyal medya:\n```",
            teknik: "```\n1. Adınız:\n2. Sorun:\n3. Ne zaman başladı?\n4. Hata mesajı:\n5. Platform:\n```",
            itiraz: "```\n1. Adınız:\n2. Ceza türü:\n3. Cezayı veren:\n4. Tarih:\n5. İtiraz sebebi:\n6. Kanıt:\n```"
        };
        try {
            const channel = await interaction.guild.channels.create({
                name: `ticket-${id}`, type: ChannelType.GuildText, topic: `${interaction.user.id}-${type}`,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                    { id: SUPPORT_ROLE, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
                ]
            });
            const embed = new EmbedBuilder().setTitle(`${titles[type]} — #${id}`)
                .setDescription(`👤 **Ticket sahibi:** ${interaction.user}\n🕐 **Açılış:** <t:${Math.floor(Date.now()/1000)}:F>\n\n${forms[type]}\n\n> Ticketı kapatmak için \`!kapat\` yazın.`)
                .setColor(colors[type]).setFooter({ text: "Freaktsing Destek Sistemi" }).setTimestamp();
            await channel.send({ content: `${interaction.user} <@&${SUPPORT_ROLE}>`, embeds: [embed] });
            return interaction.reply({ content: `✅ Ticket açıldı: ${channel}`, ephemeral: true });
        } catch (e) { console.error(e); return interaction.reply({ content: "❌ Hata oluştu.", ephemeral: true }); }
    }
});

async function cekilisiBitir(cekilisId, cekilis, kanal) {
    aktifCekilisler.delete(cekilisId);
    const katilimcilar = [...cekilis.katilimcilar];
    if (katilimcilar.length === 0) {
        const embed = new EmbedBuilder().setTitle("🎉 ÇEKİLİŞ SONA ERDİ").setDescription(`**${cekilis.odul}**\n\n❌ Kimse katılmadı.`).setColor(0xFF4444).setTimestamp();
        try { await cekilis.mesaj.edit({ embeds: [embed], components: [] }); } catch {}
        return;
    }
    const kazananlar = katilimcilar.sort(() => Math.random()-0.5).slice(0, Math.min(cekilis.kazananSayisi, katilimcilar.length));
    const mentions = kazananlar.map(id => `<@${id}>`).join(", ");
    sonBitenCekilis = { katilimcilar, kazananSayisi: cekilis.kazananSayisi, odul: cekilis.odul };
    const embed = new EmbedBuilder().setTitle("🎉 ÇEKİLİŞ SONA ERDİ")
        .setDescription(`**${cekilis.odul}**\n\n🏆 **Kazanan(lar):** ${mentions}\n👥 **Katılımcı:** ${katilimcilar.length}`)
        .setColor(0xFF73FA).setTimestamp();
    try { await cekilis.mesaj.edit({ embeds: [embed], components: [] }); } catch {}
    const ch = kanal || await client.channels.fetch(cekilis.kanalId).catch(() => null);
    if (ch) await ch.send({ content: `🎊 Tebrikler ${mentions}! **${cekilis.odul}** ödülünü kazandın!` });
}

/* ================= YOUTUBE ================= */

const YOUTUBE_API_KEY       = process.env.YOUTUBE_API_KEY;
const YOUTUBE_CHANNEL_ID    = process.env.YOUTUBE_CHANNEL_ID;
const DISCORD_VIDEO_CHANNEL = process.env.DISCORD_VIDEO_CHANNEL_ID;
const VIDEO_PING_ROLE       = process.env.VIDEO_PING_ROLE_ID;
let sonVideoId = null;

async function youtubeKontrol() {
    try {
        const col = db.collection("youtube_state");
        const state = await col.findOne({ id: 1 });
        sonVideoId = state?.last_video_id || null;
        const url = `https://www.googleapis.com/youtube/v3/search?key=${YOUTUBE_API_KEY}&channelId=${YOUTUBE_CHANNEL_ID}&part=snippet&order=date&maxResults=1&type=video`;
        const res  = await fetch(url);
        const data = await res.json();
        if (!data.items || data.items.length === 0) return;
        const video = data.items[0];
        const videoId = video.id.videoId;
        if (!videoId || videoId === sonVideoId) return;
        sonVideoId = videoId;
        await col.updateOne({ id: 1 }, { $set: { last_video_id: videoId } }, { upsert: true });
        const title = video.snippet.title;
        const thumb = video.snippet.thumbnails.high.url;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const isShort = title.toLowerCase().includes("#short");
        const tur = isShort ? "🎬 Yeni Short" : "🎥 Yeni Video";
        const embed = new EmbedBuilder().setTitle(`${tur}: ${title}`).setURL(videoUrl)
            .setDescription(`**Freaktsing** yeni bir ${isShort?"Short":"video"} yükledi! 🔥`)
            .setImage(thumb).setColor(0xFF0000).setFooter({ text: "Freaktsing • YouTube" }).setTimestamp();
        const kanal = await client.channels.fetch(DISCORD_VIDEO_CHANNEL).catch(() => null);
        if (!kanal) return;
        await kanal.send({ content: `<@&${VIDEO_PING_ROLE}> ${tur} çıktı!`, embeds: [embed] });
    } catch (e) { console.error("YouTube hatası:", e.message); }
}

/* ================= LOGIN ================= */
client.login(TOKEN);
