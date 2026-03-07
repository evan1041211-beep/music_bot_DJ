const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

// ================= 設定區 (Railway 變數) =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// ================= 指令定義 =================
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂").addStringOption(opt => opt.setName("song").setDescription("歌名").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過歌曲"),
    new SlashCommandBuilder().setName("stop").setDescription("停止播放"),
    new SlashCommandBuilder().setName("leave").setDescription("離開語音頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands }); } catch (error) { console.error(error); }
})();

// ================= 啟動事件 =================
client.once("ready", async () => {
    console.log(`🤖 Bot ${client.user.tag} 已上線！`);
    try {
        const client_id = await play.getFreeClientID();
        play.setToken({ soundcloud: { client_id: client_id } });
        console.log("✅ SoundCloud 通行證就緒！");
    } catch (err) { console.error("SoundCloud Token 取得失敗:", err); }
});

// ================= 指令處理 =================
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, options } = interaction;
    const voiceChannel = member.voice.channel;

    if (commandName === "play") {
        if (!voiceChannel) return interaction.reply("❌ 請先加入語音頻道！");
        await interaction.reply("🔍 搜尋中...");
        
        let serverQueue = queue.get(guild.id);
        if (!serverQueue) {
            serverQueue = {
                textChannel: interaction.channel, 
                connection: null,
                player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
                songs: []
            };
            queue.set(guild.id, serverQueue);
            serverQueue.connection = joinVoiceChannel({
                channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator
            });
        }

        try {
            const query = options.getString("song");
            const results = await play.search(query, { limit: 1, source: { soundcloud: "tracks" } });
            if (!results.length) return interaction.editReply("❌ 找不到該歌曲");
            
            const song = { title: results[0].name, url: results[0].url };
            serverQueue.songs.push(song);
            interaction.editReply(`✅ 已加入隊列: **${song.title}**`);

            if (serverQueue.songs.length === 1) {
                // 💡 呼叫播放函數
                playSong(guild, serverQueue.songs[0]);
            }
        } catch (err) {
            console.error(err);
            interaction.editReply("❌ 搜尋失敗");
        }
        return;
    }

    const serverQueue = queue.get(guild.id);
    if (!serverQueue) return interaction.reply("❌ 目前沒有音樂在播放");

    if (commandName === "skip") { 
        serverQueue.player.stop(); 
        interaction.reply("⏭ 已跳過歌曲"); 
    }
    if (commandName === "stop") { 
        serverQueue.songs = []; 
        serverQueue.player.stop(); 
        interaction.reply("⏹ 已清空清單，我會留在頻道待命。"); 
    }
    if (commandName === "leave") { 
        serverQueue.connection.destroy(); 
        queue.delete(guild.id); 
        interaction.reply("👋 再見！"); 
    }
});

// ================= 核心播放函數 (已修正 async 標籤) =================
async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!serverQueue) return;

    // 💡 這裡就是讓它「不退出」的關鍵：沒歌了就 Return，不執行 destroy()
    if (!song) {
        console.log("🎶 音樂播完了，保持連線中...");
        return; 
    }

    try {
        const stream = await play.stream(song.url);
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.connection.subscribe(serverQueue.player);
        serverQueue.player.play(resource);

        // 監聽播放器進入閒置 (播完了)
        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift(); 
            playSong(guild, serverQueue.songs[0]); 
        });

        // 監聽錯誤以免當機
        serverQueue.player.once('error', error => {
            console.error(`播放錯誤: ${error.message}`);
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });
    } catch (err) {
        console.error(`串流失敗: ${err.message}`);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

client.login(TOKEN);
