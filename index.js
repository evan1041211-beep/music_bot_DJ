const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

// ================= 設定區 =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const SOUNDCLOUD_ID = process.env.SOUNDCLOUD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// ================= 啟動與授權 =================
client.once("ready", async () => {
    console.log(`🤖 Bot ${client.user.tag} 已上線！`);
    try {
        await play.setToken({ soundcloud: { client_id: SOUNDCLOUD_ID } });
        console.log("✅ SoundCloud 通行證就緒！");
    } catch (err) {
        console.error("❌ SoundCloud Token 設定失敗:", err.message);
    }
});

// ================= 指令定義 =================
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("搜尋音樂並從選單選擇").addStringOption(opt => opt.setName("song").setDescription("輸入歌名").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過目前的歌曲"),
    new SlashCommandBuilder().setName("stop").setDescription("清空清單並停止播放 (保持連線)"),
    new SlashCommandBuilder().setName("leave").setDescription("離開語音頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 指令同步完成");
    } catch (error) { console.error(error); }
})();

// ================= 指令處理邏輯 =================
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, options } = interaction;

    if (commandName === "play") {
        if (!member.voice.channel) return interaction.reply("❌ 你得先進入語音頻道！");
        await interaction.deferReply();

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
            const results = await play.search(query, { limit: 5, source: { soundcloud: "tracks" } });
            
            if (!results.length) return interaction.editReply("❌ 找不到相關音樂。");

            // 建立選單 (Select Menu)
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_song')
                .setPlaceholder('🎵 請從選單選擇一首歌播放...')
                .addOptions(results.map(s => ({
                    label: s.title.substring(0, 100),
                    description: `時長: ${s.durationRaw}`,
                    value: s.url,
                })));

            const row = new ActionRowBuilder().addComponents(selectMenu);
            const msg = await interaction.editReply({ content: `🔍 幫你找到了關於「${query}」的結果：`, components: [row] });

            // 建立 Collector 監聽選單點擊
            const collector = msg.createMessageComponentCollector({ 
                componentType: ComponentType.StringSelect, 
                time: 30000 
            });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: "這不是你的選單", ephemeral: true });
                
                const selectedSong = results.find(s => s.url === i.values[0]);
                serverQueue.songs.push(selectedSong);

                await i.update({ content: `✅ 已加入隊列: **${selectedSong.title}**`, components: [] });
                
                // 如果是第一首，立即播放
                if (serverQueue.songs.length === 1) playSong(guild, serverQueue.songs[0]);
            });

        } catch (err) {
            console.error(err);
            interaction.editReply("❌ 搜尋失敗，請檢查 SOUNDCLOUD_ID 是否正確。");
        }
    }

    const serverQueue = queue.get(guild.id);
    if (!serverQueue && ["skip", "stop", "leave"].includes(commandName)) {
        return interaction.reply("❌ 目前沒有正在運作中的播放器。");
    }

    if (commandName === "skip") {
        serverQueue.player.stop();
        interaction.reply("⏭ 已跳過歌曲");
    }
    if (commandName === "stop") {
        serverQueue.songs = []; // 清空清單
        serverQueue.player.stop(); // 停止播放
        interaction.reply("⏹ 已清空所有待播歌曲，但我會留在頻道裡。");
    }
    if (commandName === "leave") {
        serverQueue.connection.destroy();
        queue.delete(guild.id);
        interaction.reply("👋 收到，波波DJ 下線囉！");
    }
});

// ================= 播放核心 (待命模式優化) =================
async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    
    // 💡 關鍵：如果沒歌了，只印出 Log 並結束，不執行 destroy()
    if (!song) {
        console.log("🎶 音樂播完了，保持連線中...");
        return; 
    }

    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);

        // 播放完畢後移動到下一首
        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift(); 
            playSong(guild, serverQueue.songs[0]);
        });

        // 錯誤處理
        serverQueue.player.once('error', error => {
            console.error(`播放錯誤: ${error.message}`);
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });

    } catch (err) {
        console.error(`串流失敗: ${err.message}`);
        serverQueue.textChannel.send(`⚠️ 串流錯誤: **${song.title}**`);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

client.login(TOKEN);
