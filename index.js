const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const SUPPORT_ROLE = '1516389895457996850';

// ticket sistem değişkenleri
let ticketCooldown = new Set();
let ticketNumber = 1;

client.once('ready', () => {
    console.log(`${client.user.tag} aktif!`);
});

/* ================= KOMUTLAR ================= */

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.split(' ');
    const cmd = args[0].toLowerCase();

    // 📺 YOUTUBE
    if (cmd === '!yt' || cmd === '!youtube') {
        return message.channel.send('📺 Youtube = @Freaktsingmc');
    }

    // 🔇 MUTE
    if (cmd === '!mute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
            return message.reply('❌ Yetkin yok.');

        const user = message.mentions.members.first();
        const time = parseInt(args[2]);

        if (!user || !time)
            return message.reply('Kullanım: !mute @kullanıcı 10');

        await user.timeout(time * 60000);
        return message.channel.send(`🔇 ${user} ${time} dakika susturuldu.`);
    }

    // 🔊 UNMUTE
    if (cmd === '!unmute') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers))
            return message.reply('❌ Yetkin yok.');

        const user = message.mentions.members.first();
        if (!user)
            return message.reply('Kullanım: !unmute @kullanıcı');

        await user.timeout(null);
        return message.channel.send(`🔊 ${user} susturması kaldırıldı.`);
    }

    // 🚫 BAN
    if (cmd === '!ban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers))
            return message.reply('❌ Yetkin yok.');

        const user = message.mentions.members.first();
        if (!user)
            return message.reply('Kullanım: !ban @kullanıcı');

        await user.ban();
        return message.channel.send(`🚫 ${user.user.tag} banlandı.`);
    }

    // ✅ UNBAN
    if (cmd === '!unban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers))
            return message.reply('❌ Yetkin yok.');

        const id = args[1];
        if (!id)
            return message.reply('Kullanım: !unban ID');

        await message.guild.members.unban(id);
        return message.channel.send(`✅ Ban açıldı: ${id}`);
    }

    // 🎫 TICKET PANEL
    if (cmd === '!ticketpanel') {

        const channel = message.guild.channels.cache.find(c => c.name === '🛡️-destek');

        if (!channel)
            return message.reply('❌ 🛡️-destek kanalı yok.');

        const embed = new EmbedBuilder()
            .setTitle('🎫 DESTEK SİSTEMİ')
            .setDescription(`
📌 Yardıma mı ihtiyacın var?

Aşağıdaki butona tıklayarak destek talebi oluşturabilirsin.

🛡️ Yetkili ekip en kısa sürede ilgilenecektir.
            `)
            .setColor('Blue')
            .setFooter({ text: 'Freaktsing Ticket System' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ticket_open')
                .setLabel('🎫 Destek Aç')
                .setStyle(ButtonStyle.Primary)
        );

        return channel.send({ embeds: [embed], components: [row] });
    }
});

/* ================= TICKET SYSTEM ================= */

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    // 🎫 TICKET AÇ
    if (interaction.customId === 'ticket_open') {

        // ⏳ spam koruma
        if (ticketCooldown.has(interaction.user.id)) {
            return interaction.reply({
                content: '⏳ 3 saniye bekle.',
                ephemeral: true
            });
        }

        ticketCooldown.add(interaction.user.id);
        setTimeout(() => ticketCooldown.delete(interaction.user.id), 3000);

        await interaction.deferReply({ ephemeral: true });

        // 🔥 TEK TICKET KONTROL (topic üzerinden)
        const existing = interaction.guild.channels.cache.find(c =>
            c.topic === `ticket-${interaction.user.id}`
        );

        if (existing)
            return interaction.editReply('❌ Zaten açık ticketın var.');

        // 🎫 ticket numarası
        const id = String(ticketNumber).padStart(4, '0');
        ticketNumber++;

        const channel = await interaction.guild.channels.create({
            name: `ticket-${id}`,
            type: ChannelType.GuildText,
            topic: `ticket-${interaction.user.id}`,
            permissionOverwrites: [
                {
                    id: interaction.guild.id,
                    deny: ['ViewChannel']
                },
                {
                    id: interaction.user.id,
                    allow: ['ViewChannel', 'SendMessages']
                },
                {
                    id: SUPPORT_ROLE,
                    allow: ['ViewChannel', 'SendMessages']
                }
            ]
        });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ticket_close')
                .setLabel('🔒 Kapat')
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({
            content: `🎫 **DESTEK TALEBİ #${id}**

👤 Kullanıcı: ${interaction.user}

📌 Sorununuzu detaylı şekilde yazın.
🛡️ Yetkili ekip en kısa sürede ilgilenecektir.

💬 Lütfen sabırlı olun.`,
            components: [row]
        });

        return interaction.editReply(`✅ Ticket açıldı: #${id}`);
    }

    // 🔒 TICKET KAPAT
    if (interaction.customId === 'ticket_close') {

        await interaction.reply('🔒 Ticket kapanıyor...');

        setTimeout(() => {
            interaction.channel.delete().catch(() => {});
        }, 3000);
    }
});

client.login(process.env.TOKEN);