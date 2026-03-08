const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// --- 工具：進度條與時間格式化 ---
function createProgressBar(current, total) {
    const size = 15;
    const progress = Math.min(size, Math.round((size * current) / total));
    return `\`${'█'.repeat(progress)}${'—'.repeat(size - progress)}\` [${Math.round((current / total) * 100)}%]`;
}

function formatTime(s) {
    return new Date(s * 1000).toISOString().substr(11, 8).replace(/^00:/, '');
}

// --- 自動抓取 Token ---
async function refreshSoundCloudToken() {
    try {
        const id = await play.getFreeClientID();
        if (id) await play.setToken({ soundcloud: { client_id: id } });
    } catch (e) { console.error("Token 刷新失敗"); }
}

// --- 指令註冊 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂 (選單/連結)").addStringOption(o => o.setName("song").setDescription("關鍵字或連結").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過歌曲"),
    new SlashCommandBuilder().setName("nowplaying").setDescription("顯示進度與面板"),
    new SlashCommandBuilder().setName("leave").setDescription("離開頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands }); } catch (e) { console.error(e); }
})();

client.once("ready", async () => {
    console.log(`🤖 ${client.user.tag} 已上線！`);
    await refreshSoundCloudToken();
});

// --- 指令與互動處理 ---
client.on("interactionCreate", async (interaction) => {
    const serverQueue = queue.get(interaction.guildId);

    // 1. 處理按鈕
    if (interaction.isButton()) {
        if (!serverQueue) return interaction.reply({ content: "沒音樂在播", ephemeral: true });
        if (interaction.customId === 'p_r') {
            serverQueue.player.state.status === AudioPlayerStatus.Paused ? serverQueue.player.unpause() : serverQueue.player.pause();
            await interaction.reply({ content: "🔄 已切換暫停/恢復", ephemeral: true });
        } else if (interaction.customId === 's_k') {
            serverQueue.player.stop();
            await interaction.reply({ content: "⏭ 已跳過", ephemeral: true });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, options } = interaction;

    if (commandName === "play") {
        if (!member.voice.channel) return interaction.reply("❌ 請先入語音");
        await interaction.deferReply();
        await refreshSoundCloudToken();

        const query = options.getString("song");
        const type = await play.validate(query);

        // 如果是連結，直接播
        if (type === 'so_track') {
            const song = await play.soundcloud(query);
            handleSong(interaction, song);
        } else {
            // 如果是關鍵字，顯示 5 選 1
            const results = await play.search(query, { limit: 5, source: { soundcloud: "tracks" } });
            if (!results.length) return interaction.editReply("❌ 找不到結果");

            const menu = new StringSelectMenuBuilder()
                .setCustomId('sel')
                .setPlaceholder('🎵 選擇歌曲...')
                .addOptions(results.map(s => ({
                    label: (s.name || s.title || "未知").substring(0, 100),
                    description: `時長: ${s.durationRaw}`,
                    value: s.url
                })));

            const row = new ActionRowBuilder().addComponents(menu);
            const msg = await interaction.editReply({ content: "🔍 搜尋結果：", components: [row] });

            const coll = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 30000 });
            coll.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: "非本人", ephemeral: true });
                const song = results.find(s => s.url === i.values[0]);
                handleSong(i, song, true);
            });
        }
    }

    if (commandName === "skip") {
        if (!serverQueue) return interaction.reply("沒歌可跳");
        serverQueue.player.stop();
        interaction.reply("⏭ 已跳過歌曲");
    }

    if (commandName === "nowplaying") {
        if (!serverQueue || !serverQueue.curRes) return interaction.reply("沒在播");
        showNowPlaying(interaction, serverQueue);
    }

    if (commandName === "leave") {
        serverQueue?.connection.destroy();
        queue.delete(guild.id);
        interaction.reply("👋 掰掰");
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
    if (q.songs.length === 1) playSong(guild, q.songs[0]);
}

async function playSong(guild, song) {
    const q = queue.get(guild.id);
    if (!song) return;
    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const res = createAudioResource(stream.stream, { inputType: stream.type });
        q.curRes = res;
        q.player.play(res);
        q.player.once(AudioPlayerStatus.Idle, () => { q.songs.shift(); playSong(guild, q.songs[0]); });
    } catch (e) { q.songs.shift(); playSong(guild, q.songs[0]); }
}

function showNowPlaying(interaction, q) {
    const song = q.songs[0];
    const cur = Math.floor(q.curRes.playbackDuration / 1000);
    const total = song.durationInSec || (song.durationInMs / 1000) || 1;
    const emb = new EmbedBuilder().setColor('#ff5500').setTitle(`🎶 播放中: ${song.name || song.title}`)
        .setDescription(`${createProgressBar(cur, total)}\n\`${formatTime(cur)} / ${formatTime(total)}\``);
    const btn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('p_r').setLabel('暫停/恢復').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('s_k').setLabel('跳過').setStyle(ButtonStyle.Danger)
    );
    interaction.reply({ embeds: [emb], components: [btn] });
}

client.login(TOKEN);
