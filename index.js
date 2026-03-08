const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

// ================= 設定區 =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// ================= 核心：自動抓取 Token 函式 =================
async function refreshSoundCloudToken() {
    try {
        // 強制要求 play-dl 去爬取最新的匿名 Client ID
        const client_id = await play.getFreeClientID();
        if (client_id) {
            await play.setToken({ soundcloud: { client_id: client_id } });
            console.log("✅ SoundCloud 自動獲取 ID 成功！");
            return true;
        }
    } catch (err) {
        console.error("❌ 自動獲取 SoundCloud ID 失敗 (Railway IP 可能被暫時封鎖):", err.message);
        return false;
    }
    return false;
}

// ================= 啟動事件 =================
client.once("ready", async () => {
    console.log(`🤖 Bot ${client.user.tag} 已上線！`);
    await refreshSoundCloudToken(); // 啟動時先抓一次
});

// ================= 指令定義 =================
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("搜尋音樂並選擇").addStringOption(opt => opt.setName("song").setDescription("輸入歌名").setRequired(true)),
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

// ================= 指令處理 =================
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, options } = interaction;

    if (commandName === "play") {
        if (!member.voice.channel) return interaction.reply("❌ 你得先進入語音頻道！");
        await interaction.deferReply();

        // 搜尋前再次確保有 ID
        await refreshSoundCloudToken();

        let serverQueue = queue.get(guild.id);
        if (!serverQueue) {
            serverQueue = {
                textChannel: interaction.channel,
                connection: joinVoiceChannel({
                    channelId: member.voice.channel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                }),
                player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
                songs: []
            };
            serverQueue.connection.subscribe(serverQueue.player);
            queue.set(guild.id, serverQueue);
        }

        try {
            const query = options.getString("song");
            // 使用 SoundCloud 搜尋
            const results = await play.search(query, { limit: 5, source: { soundcloud: "tracks" } });
            
            if (!results.length) return interaction.editReply("❌ 找不到相關音樂 (可能需要更新 ID)");

            // --- 修正後的選單代碼 ---
            // 修正點：多重備援抓取曲名
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_song')
                .setPlaceholder('🎵 請選擇歌曲播放...')
                .addOptions(results.map(s => {
                    // 印出搜尋結果物件，方便你在 Railway 日誌查看結構
                    // console.log("SoundCloud 搜尋結果結構:", s); 

                    // 備援順序：s.title -> s.name -> s.id -> "未知曲名"
                    const safeTitle = (s.title || s.name || `音軌 ID: ${s.id}` || "未知曲名").toString();
                    
                    return {
                        label: safeTitle.substring(0, 100),
                        description: `時長: ${s.durationRaw || '未知'} | 上傳者: ${s.user?.name || '匿名'}`,
                        value: s.url,
                    };
                }));

            const row = new ActionRowBuilder().addComponents(selectMenu);
            const msg = await interaction.editReply({ content: `🔍 找到結果：`, components: [row] });

            const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 30000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: "這不是你的選單", ephemeral: true });
                const selectedSong = results.find(s => s.url === i.values[0]);
                serverQueue.songs.push(selectedSong);
                await i.update({ content: `✅ 已加入隊列: **${selectedSong.title}**`, components: [] });
                if (serverQueue.songs.length === 1) playSong(guild, serverQueue.songs[0]);
            });

        } catch (err) {
            console.error(err);
            interaction.editReply("❌ 搜尋出錯 (401 或 IP 封鎖)。如果持續發生，建議手動填入 ID。");
        }
    }

    const serverQueue = queue.get(guild.id);
    if (!serverQueue) return;

    if (commandName === "skip") { serverQueue.player.stop(); interaction.reply("⏭ 已跳過"); }
    if (commandName === "stop") { serverQueue.songs = []; serverQueue.player.stop(); interaction.reply("⏹ 已清空，待命中。"); }
    if (commandName === "leave") { serverQueue.connection.destroy(); queue.delete(guild.id); interaction.reply("👋 掰掰！"); }
});

// ================= 播放函數 (不自動退出) =================
async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) {
        console.log("🎶 音樂播完，維持連線...");
        return; 
    }

    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift(); 
            playSong(guild, serverQueue.songs[0]);
        });
    } catch (err) {
        console.error("播放失敗:", err.message);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

client.login(TOKEN);
