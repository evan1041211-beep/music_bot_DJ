const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// --- 自動獲取 SoundCloud ID ---
async function refreshSoundCloudToken() {
    try {
        const id = await play.getFreeClientID();
        if (id) {
            await play.setToken({ soundcloud: { client_id: id } });
            console.log("✅ SoundCloud 系統已就緒");
        }
    } catch (e) { console.error("❌ SoundCloud 初始化失敗:", e.message); }
}

// --- 指令註冊 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂 (選單/連結)").addStringOption(o => o.setName("song").setDescription("歌名或網址").setRequired(true)),
    new SlashCommandBuilder().setName("pause").setDescription("暫停音樂"),
    new SlashCommandBuilder().setName("resume").setDescription("繼續播放"),
    new SlashCommandBuilder().setName("skip").setDescription("跳過歌曲"),
    new SlashCommandBuilder().setName("nowplaying").setDescription("顯示面板"),
    new SlashCommandBuilder().setName("leave").setDescription("離開頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands }); } catch (e) { console.error(e); }
})();

client.once("ready", async () => {
    await refreshSoundCloudToken();
    console.log(`🎵 波波DJ (純 SoundCloud 旗艦版) 已啟動！`);
});

// --- 互動處理 ---
client.on("interactionCreate", async (interaction) => {
    const serverQueue = queue.get(interaction.guildId);

    // 處理按鈕
    if (interaction.isButton()) {
        if (!serverQueue) return interaction.reply({ content: "目前沒音樂", ephemeral: true });
        if (interaction.customId === 'p_r') {
            const isPaused = serverQueue.player.state.status === AudioPlayerStatus.Paused;
            isPaused ? serverQueue.player.unpause() : serverQueue.player.pause();
            await interaction.reply({ content: isPaused ? "▶️ 恢復播放" : "⏸ 已暫停", ephemeral: true });
        } else if (interaction.customId === 's_k') {
            serverQueue.player.stop();
            await interaction.reply({ content: "⏭ 已跳過", ephemeral: true });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, options } = interaction;

    // --- 播放指令 ---
    if (commandName === "play") {
        if (!member.voice.channel) return interaction.reply("❌ 你得先進入語音頻道");
        await interaction.deferReply();
        await refreshSoundCloudToken();

        const query = options.getString("song");
        const type = await play.validate(query);

        if (type === 'so_track') {
            const song = await play.soundcloud(query);
            return handleSong(interaction, song);
        }

        const results = await play.search(query, { limit: 5, source: { soundcloud: "tracks" } });
        if (!results.length) return interaction.editReply("❌ 找不到結果");

        const menu = new StringSelectMenuBuilder()
            .setCustomId('sel').setPlaceholder('🎵 選擇歌曲...')
            .addOptions(results.map(s => ({
                label: (s.name || s.title).substring(0, 100),
                description: `時長: ${s.durationRaw}`,
                value: s.url
            })));

        const row = new ActionRowBuilder().addComponents(menu);
        const msg = await interaction.editReply({ content: "🔍 搜尋結果：", components: [row] });

        const coll = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 30000 });
        coll.on('collect', async i => {
            if (i.user.id !== interaction.user.id) return i.reply({ content: "非本人操作", ephemeral: true });
            const song = results.find(s => s.url === i.values[0]);
            handleSong(i, song, true);
        });
    }

    // --- 暫停/繼續指令 ---
    if (commandName === "pause") {
        if (!serverQueue) return interaction.reply("沒歌在播");
        if (serverQueue.player.state.status === AudioPlayerStatus.Paused) return interaction.reply("已經暫停了");
        serverQueue.player.pause();
        interaction.reply("⏸ 音樂已暫停");
    }

    if (commandName === "resume") {
        if (!serverQueue) return interaction.reply("沒歌在播");
        if (serverQueue.player.state.status !== AudioPlayerStatus.Paused) return interaction.reply("音樂正在播放中");
        serverQueue.player.unpause();
        interaction.reply("▶️ 音樂繼續播放");
    }

    if (commandName === "skip") {
        if (!serverQueue) return interaction.reply("沒歌可跳");
        serverQueue.player.stop();
        interaction.reply("⏭ 已跳過");
    }

    if (commandName === "nowplaying") {
        if (!serverQueue || !serverQueue.curRes) return interaction.reply("目前沒在播歌");
        showNowPlaying(interaction, serverQueue);
    }

    if (commandName === "leave") {
        serverQueue?.connection.destroy();
        queue.delete(guild.id);
        interaction.reply("👋 離開頻道，下次見！");
    }
});

// --- 輔助函式 ---
async function handleSong(interaction, song, isUpdate = false) {
    const guild = interaction.guild;
    let q = queue.get(guild.id);
    if (!q) {
        q = {
            connection: joinVoiceChannel({ channelId: interaction.member.voice.channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator }),
            player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
            songs: [], curRes: null
        };
        q.connection.subscribe(q.player);
        queue.set(guild.id, q);
    }
    q.songs.push(song);
    const txt = `✅ 已加入: **${song.name || song.title}**`;
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
    } catch (e) { q.songs.shift(); playMusic(guild, q.songs[0]); }
}

function showNowPlaying(interaction, q) {
    const song = q.songs[0];
    const cur = Math.floor(q.curRes.playbackDuration / 1000);
    const total = song.durationInSec || 1;
    const emb = new EmbedBuilder().setColor('#ff5500').setTitle(`🎶 播放中: ${song.name || song.title}`)
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
