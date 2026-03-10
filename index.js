const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// --- 初始化 YouTube & SoundCloud 認證 ---
async function authServices() {
    try {
        // 載入 YouTube Cookie 偽裝成真人
        if (process.env.YT_COOKIE) {
            await play.setToken({
                youtube: { cookie: process.env.YT_COOKIE }
            });
            console.log("✅ YouTube Cookie 認證成功");
        }
        
        // 自動獲取 SoundCloud ID 作為備援
        const sc_id = await play.getFreeClientID();
        if (sc_id) await play.setToken({ soundcloud: { client_id: sc_id } });
        console.log("✅ SoundCloud 備援系統就緒");
    } catch (e) { console.error("❌ 認證初始化失敗:", e.message); }
}

// --- 指令註冊 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂 (YouTube/SC)").addStringOption(o => o.setName("song").setDescription("關鍵字或網址").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過歌曲"),
    new SlashCommandBuilder().setName("nowplaying").setDescription("查看進度與控制面板"),
    new SlashCommandBuilder().setName("leave").setDescription("離開頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands }); } catch (e) { console.error(e); }
})();

client.once("ready", async () => {
    await authServices();
    console.log(`🎵 ${client.user.tag} 聯網版已啟動！`);
});

// --- 核心邏輯處理 ---
client.on("interactionCreate", async (interaction) => {
    const serverQueue = queue.get(interaction.guildId);

    // 按鈕控制邏輯
    if (interaction.isButton()) {
        if (!serverQueue) return interaction.reply({ content: "沒音樂在播", ephemeral: true });
        if (interaction.customId === 'p_r') {
            serverQueue.player.state.status === AudioPlayerStatus.Paused ? serverQueue.player.unpause() : serverQueue.player.pause();
            await interaction.reply({ content: "⏯ 已切換播放狀態", ephemeral: true });
        } else if (interaction.customId === 's_k') {
            serverQueue.player.stop();
            await interaction.reply({ content: "⏭ 已跳過", ephemeral: true });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, options } = interaction;

    if (commandName === "play") {
        if (!member.voice.channel) return interaction.reply("❌ 請先進入語音頻道");
        await interaction.deferReply();

        const query = options.getString("song");
        const type = await play.validate(query);

        // 如果是直接連結 (YT 或 SC)
        if (type && type !== 'search') {
            try {
                const info = await play.video_info(query).catch(() => play.soundcloud(query));
                const song = info.video_details || info;
                return handleSong(interaction, song);
            } catch (e) { return interaction.editReply("❌ 無法解析連結"); }
        }

        // 關鍵字搜尋 (優先搜 YT)
        try {
            const results = await play.search(query, { limit: 5 });
            if (!results.length) return interaction.editReply("❌ 找不到結果");

            const menu = new StringSelectMenuBuilder()
                .setCustomId('sel')
                .setPlaceholder('🎵 選擇你要播放的音樂...')
                .addOptions(results.map(s => ({
                    label: (s.title || s.name).substring(0, 100),
                    description: `頻道: ${s.channel?.name || s.user?.name || '未知'} | 時長: ${s.durationRaw}`,
                    value: s.url
                })));

            const row = new ActionRowBuilder().addComponents(menu);
            const msg = await interaction.editReply({ content: "🔍 搜尋結果 (YouTube/SC)：", components: [row] });

            const coll = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 30000 });
            coll.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: "這不是你的選單", ephemeral: true });
                const song = results.find(s => s.url === i.values[0]);
                handleSong(i, song, true);
            });
        } catch (e) { interaction.editReply("❌ 搜尋出錯"); }
    }

    if (commandName === "skip") {
        if (!serverQueue) return interaction.reply("沒音樂在播");
        serverQueue.player.stop();
        interaction.reply("⏭ 已跳過");
    }

    if (commandName === "nowplaying") {
        if (!serverQueue || !serverQueue.curRes) return interaction.reply("沒在播");
        showNowPlaying(interaction, serverQueue);
    }

    if (commandName === "leave") {
        serverQueue?.connection.destroy();
        queue.delete(guild.id);
        interaction.reply("👋 掰掰！");
    }
});

// --- 播放管理函式 ---
async function handleSong(interaction, song, isUpdate = false) {
    const guild = interaction.guild;
    let q = queue.get(guild.id);
    if (!q) {
        q = {
            connection: joinVoiceChannel({ 
                channelId: interaction.member.voice.channel.id, 
                guildId: guild.id, 
                adapterCreator: guild.voiceAdapterCreator 
            }),
            player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
            songs: [], curRes: null
        };
        q.connection.subscribe(q.player);
        queue.set(guild.id, q);
    }
    q.songs.push(song);
    const txt = `✅ 已加入: **${song.title || song.name}**`;
    isUpdate ? await interaction.update({ content: txt, components: [] }) : await interaction.editReply(txt);
    if (q.songs.length === 1) playMusic(guild, q.songs[0]);
}

async function playMusic(guild, song) {
    const q = queue.get(guild.id);
    if (!song) return;
    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const res = createAudioResource(stream.stream, { inputType: stream.type });
        q.curRes = res;
        q.player.play(res);
        q.player.once(AudioPlayerStatus.Idle, () => { q.songs.shift(); playMusic(guild, q.songs[0]); });
    } catch (e) { 
        console.error("播放出錯:", e.message);
        q.songs.shift(); playMusic(guild, q.songs[0]); 
    }
}

function showNowPlaying(interaction, q) {
    const song = q.songs[0];
    const cur = Math.floor(q.curRes.playbackDuration / 1000);
    const total = song.durationInSec || (song.durationInMs / 1000) || 1;
    const emb = new EmbedBuilder()
        .setColor('#FF0000') // YouTube 紅
        .setTitle(`🎶 播放中: ${song.title || song.name}`)
        .setDescription(`${createProgressBar(cur, total)}\n\`${formatTime(cur)} / ${formatTime(total)}\``);
    const btn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('p_r').setLabel('暫停/恢復').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('s_k').setLabel('跳過').setStyle(ButtonStyle.Danger)
    );
    interaction.reply({ embeds: [emb], components: [btn] });
}

function createProgressBar(current, total) {
    const size = 15;
    const progress = Math.min(size, Math.round((size * current) / total));
    return `\`${'█'.repeat(progress)}${'—'.repeat(size - progress)}\` [${Math.round((current / total) * 100)}%]`;
}

function formatTime(s) { return new Date(s * 1000).toISOString().substr(11, 8).replace(/^00:/, ''); }

client.login(TOKEN);
