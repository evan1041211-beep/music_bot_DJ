const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

// ================= 設定區 =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// ================= 自動抓取 ID 函式 =================
async function refreshSoundCloudToken() {
    try {
        const client_id = await play.getFreeClientID();
        if (client_id) {
            await play.setToken({ soundcloud: { client_id: client_id } });
            console.log("✅ SoundCloud 自動獲取 ID 成功！");
        }
    } catch (err) {
        console.error("❌ 自動獲取 SoundCloud ID 失敗:", err.message);
    }
}

// ================= 指令註冊 =================
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂 (支援關鍵字選單或 SoundCloud 連結)").addStringOption(opt => opt.setName("song").setDescription("輸入歌名或連結").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過目前的歌曲"),
    new SlashCommandBuilder().setName("stop").setDescription("停止播放並清空清單"),
    new SlashCommandBuilder().setName("leave").setDescription("離開語音頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 指令同步成功");
    } catch (error) { console.error(error); }
})();

client.once("ready", async () => {
    console.log(`🤖 Bot ${client.user.tag} 已上線！`);
    await refreshSoundCloudToken();
});

// ================= 指令處理邏輯 (注意這裡必須有 async) =================
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member, options } = interaction;

    if (commandName === "play") {
        if (!member.voice.channel) return interaction.reply("❌ 你得先進入語音頻道！");
        
        // 1. 先進入等待狀態
        await interaction.deferReply();
        
        // 2. 刷新 Token 確保能搜尋
        await refreshSoundCloudToken();

        const query = options.getString("song");
        let serverQueue = queue.get(guild.id);

        // 判斷是否為 SoundCloud 連結
        const checkLink = await play.is_links(query);

        if (checkLink === 'so_track') {
            // --- 情況 A：連結模式 ---
            try {
                const songInfo = await play.soundcloud(query);
                if (!serverQueue) {
                    serverQueue = createQueue(interaction, member);
                    queue.set(guild.id, serverQueue);
                }
                serverQueue.songs.push(songInfo);
                await interaction.editReply(`✅ 已透過連結加入: **${songInfo.name || songInfo.title || "未知曲名"}**`);
                if (serverQueue.songs.length === 1) playSong(guild, serverQueue.songs[0]);
                return;
            } catch (err) {
                console.error(err);
                return interaction.editReply("❌ 無法解析此連結。");
            }
        }

        // --- 情況 B：關鍵字選單模式 ---
        try {
            const results = await play.search(query, { limit: 5, source: { soundcloud: "tracks" } });
            if (!results.length) return interaction.editReply("❌ 找不到音樂。");

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_song')
                .setPlaceholder('🎵 請選擇一首歌...')
                .addOptions(results.map(s => ({
                    label: (s.name || s.title || "未知曲名").toString().substring(0, 100),
                    description: `時長: ${s.durationRaw || '未知'}`,
                    value: s.url,
                })));

            const row = new ActionRowBuilder().addComponents(selectMenu);
            const msg = await interaction.editReply({ content: `🔍 找到結果：`, components: [row] });

            const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 30000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: "這不是你的選單", ephemeral: true });
                const selectedSong = results.find(s => s.url === i.values[0]);
                
                if (!serverQueue) {
                    serverQueue = createQueue(interaction, member);
                    queue.set(guild.id, serverQueue);
                }

                serverQueue.songs.push(selectedSong);
                await i.update({ content: `✅ 已加入隊列: **${selectedSong.name || selectedSong.title}**`, components: [] });
                if (serverQueue.songs.length === 1) playSong(guild, serverQueue.songs[0]);
            });
        } catch (err) {
            console.error(err);
            interaction.editReply("❌ 搜尋失敗。");
        }
    }

    // skip, stop, leave 指令處理
    const serverQueue = queue.get(guild.id);
    if (!serverQueue && ["skip", "stop", "leave"].includes(commandName)) return interaction.reply("❌ 目前沒音樂。");

    if (commandName === "skip") { serverQueue.player.stop(); interaction.reply("⏭ 已跳過"); }
    if (commandName === "stop") { serverQueue.songs = []; serverQueue.player.stop(); interaction.reply("⏹ 已清空隊列，保持連線。"); }
    if (commandName === "leave") { serverQueue.connection.destroy(); queue.delete(guild.id); interaction.reply("👋 掰掰！"); }
});

// ================= 輔助功能 =================

function createQueue(interaction, member) {
    const q = {
        textChannel: interaction.channel,
        connection: joinVoiceChannel({
            channelId: member.voice.channel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        }),
        player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
        songs: []
    };
    q.connection.subscribe(q.player);
    return q;
}

async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return console.log("🎶 播放清單結束，保持連線中...");

    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });
    } catch (err) {
        console.error(err);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

client.login(TOKEN);
