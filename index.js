const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// --- 輔助工具：製作進度條 ---
function createProgressBar(current, total) {
    const size = 15; // 進度條長度
    const progress = Math.round((size * current) / total);
    const emptyProgress = size - progress;
    const progressText = '▇'.repeat(progress);
    const emptyProgressText = '—'.repeat(emptyProgress);
    const percentage = Math.round((current / total) * 100);
    return `\`${progressText}${emptyProgressText}\` [${percentage}%]`;
}

// --- 自動抓取 Token ---
async function refreshSoundCloudToken() {
    try {
        const client_id = await play.getFreeClientID();
        if (client_id) {
            await play.setToken({ soundcloud: { client_id: client_id } });
            console.log("✅ SoundCloud Token 自動刷新成功");
        }
    } catch (err) { console.error("❌ Token 刷新失敗:", err.message); }
}

// --- 指令註冊 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂").addStringOption(o => o.setName("song").setDescription("關鍵字或連結").setRequired(true)),
    new SlashCommandBuilder().setName("nowplaying").setDescription("顯示目前進度"),
    new SlashCommandBuilder().setName("leave").setDescription("離開頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    } catch (e) { console.error(e); }
})();

client.once("ready", async () => {
    console.log(`🤖 ${client.user.tag} 播放器已準備就緒！`);
    await refreshSoundCloudToken();
});

// --- 指令與按鈕處理 ---
client.on("interactionCreate", async (interaction) => {
    const serverQueue = queue.get(interaction.guildId);

    // 處理按鈕點擊
    if (interaction.isButton()) {
        if (!serverQueue) return interaction.reply({ content: "目前沒有音樂在播放", ephemeral: true });
        
        switch (interaction.customId) {
            case 'pause_resume':
                if (serverQueue.player.state.status === AudioPlayerStatus.Paused) {
                    serverQueue.player.unpause();
                    await interaction.reply({ content: "▶️ 恢復播放", ephemeral: true });
                } else {
                    serverQueue.player.pause();
                    await interaction.reply({ content: "⏸ 暫停播放", ephemeral: true });
                }
                break;
            case 'skip':
                serverQueue.player.stop();
                await interaction.reply({ content: "⏭ 已跳過", ephemeral: true });
                break;
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, options } = interaction;

    if (commandName === "play") {
        if (!member.voice.channel) return interaction.reply("❌ 你得先在語音頻道");
        await interaction.deferReply();
        await refreshSoundCloudToken();

        const query = options.getString("song");
        const checkType = await play.validate(query);

        try {
            let songInfo;
            if (checkType === 'so_track') {
                songInfo = await play.soundcloud(query);
            } else {
                const results = await play.search(query, { limit: 1, source: { soundcloud: "tracks" } });
                if (!results.length) return interaction.editReply("❌ 找不到音樂");
                songInfo = results[0];
            }

            let q = queue.get(guild.id);
            if (!q) {
                q = {
                    connection: joinVoiceChannel({
                        channelId: member.voice.channel.id,
                        guildId: guild.id,
                        adapterCreator: guild.voiceAdapterCreator,
                    }),
                    player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
                    songs: [],
                    currentResource: null
                };
                q.connection.subscribe(q.player);
                queue.set(guild.id, q);
            }

            q.songs.push(songInfo);
            if (q.songs.length === 1) {
                playSong(guild, q.songs[0]);
                await interaction.editReply(`🎵 開始播放: **${songInfo.name || songInfo.title}**`);
            } else {
                await interaction.editReply(`✅ 已加入隊列: **${songInfo.name || songInfo.title}**`);
            }
        } catch (e) {
            console.error(e);
            interaction.editReply("❌ 發生錯誤");
        }
    }

    if (commandName === "nowplaying") {
        if (!serverQueue || !serverQueue.currentResource) return interaction.reply("目前沒有音樂在播放");
        
        const song = serverQueue.songs[0];
        const cur = Math.floor(serverQueue.currentResource.playbackDuration / 1000); // 秒
        const total = song.durationInSec || (song.durationInMs / 1000) || 0;
        
        const embed = new EmbedBuilder()
            .setColor('#ff5500')
            .setTitle(`🎶 正在播放: ${song.name || song.title}`)
            .setDescription(`${createProgressBar(cur, total)}\n\`${formatTime(cur)} / ${formatTime(total)}\``);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pause_resume').setLabel('暫停/恢復').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('skip').setLabel('跳過').setStyle(ButtonStyle.Danger)
        );

        interaction.reply({ embeds: [embed], components: [row] });
    }

    if (commandName === "leave") {
        serverQueue?.connection.destroy();
        queue.delete(guild.id);
        interaction.reply("👋 掰掰！");
    }
});

// --- 核心播放邏輯 ---
async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return;

    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.currentResource = resource;
        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });
    } catch (e) {
        console.error(e);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [h, m, s].map(v => v.toString().padStart(2, '0')).filter((v, i) => v !== '00' || i > 0).join(':');
}

client.login(TOKEN);
