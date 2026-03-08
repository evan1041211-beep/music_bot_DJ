const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
// ... 其他 require ...
const play = require('play-dl');

// 💡 加入這段：讓機器人偽裝成已登入的使用者
(async () => {
    await play.setToken({
        youtube: {
            cookie: `這裡貼上你剛剛匯出的所有內容`
        }
    });
    console.log("✅ YouTube Cookie 載入成功");
})();

// ... 剩下的代碼 ...

// --- 1. 設定區 (從 Railway 或 .env 讀取) ---
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates,
    ] 
});

const queue = new Map();

// --- 2. 註冊音樂指令 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放 YouTube 音樂")
        .addStringOption(o => o.setName("song").setDescription("輸入歌名或 YouTube 網址").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過目前的歌曲"),
    new SlashCommandBuilder().setName("stop").setDescription("停止播放並清空隊列"),
    new SlashCommandBuilder().setName("leave").setDescription("讓機器人離開語音頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 音樂指令已更新");
    } catch (e) { console.error(e); }
})();

// --- 3. 指令處理器 ---
client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;
    const { commandName, guild, member, options } = i;

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) return i.reply("❌ 你必須先進入語音頻道才能點歌！");

    let serverQueue = queue.get(guild.id);

    if (commandName === "play") {
        await i.reply("🔍 正在搜尋 YouTube...");
        
        if (!serverQueue) {
            serverQueue = {
                connection: joinVoiceChannel({
                    channelId: voiceChannel.id,
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
            // 搜尋 YouTube
            const res = await play.search(query, { limit: 1, source: { youtube: "video" } });
            if (!res.length) return i.editReply("❌ 找不到音樂。");

            const song = { title: res[0].title, url: res[0].url };
            serverQueue.songs.push(song);

            i.editReply(`✅ 已加入：**${song.title}**`);
            if (serverQueue.songs.length === 1) playMusic(guild, serverQueue.songs[0]);

        } catch (e) {
            console.error(e);
            i.editReply("❌ 播放出錯，請再試一次。");
        }
    }

    if (commandName === "skip") {
        if (!serverQueue) return i.reply("❌ 目前沒有正在播放的歌曲。");
        serverQueue.player.stop();
        i.reply("⏭ 已跳過！");
    }

    if (commandName === "stop") {
        if (!serverQueue) return i.reply("❌ 目前沒有正在播放的歌曲。");
        serverQueue.songs = [];
        serverQueue.player.stop();
        i.reply("⏹ 播放已停止。");
    }

    if (commandName === "leave") {
        if (!serverQueue) return i.reply("❌ 我不在語音頻道中。");
        serverQueue.connection.destroy();
        queue.delete(guild.id);
        i.reply("👋 下次見！");
    }
});

// --- 4. 播放函數 ---
async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return; // 播完後留在頻道內不離開

    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);

        // 當這首歌播完，自動播下一首
        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            playMusic(guild, serverQueue.songs[0]);
        });
    } catch (e) {
        console.error("播放發生錯誤:", e);
        serverQueue.songs.shift();
        playMusic(guild, serverQueue.songs[0]);
    }
}

client.once("ready", () => console.log(`🎵 音樂機器人 ${client.user.tag} 在線！`));
client.login(TOKEN);
