const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] 
});

const queue = new Map();

// --- 💡 修正：直接還原 Base64 並傳入 ---
(async () => {
    if (process.env.cookies) {
        try {
            // 1. 解碼 Base64
            const decodedCookie = Buffer.from(process.env.cookies, 'base64').toString('utf-8');

            // 2. 測試是否為有效的 JSON，並直接傳入
            // 注意：這裡我們直接傳入 string，play-dl 會處理剩下的事
            await play.setToken({
                youtube: {
                    cookie: decodedCookie.trim() 
                }
            });
            console.log("✅ YouTube Cookie 載入成功");
        } catch (e) {
            console.error("❌ Cookie 設定失敗:", e.message);
        }
    }
})();
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放 YouTube 音樂").addStringOption(o => o.setName("song").setDescription("歌名或網址").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過"),
    new SlashCommandBuilder().setName("leave").setDescription("離開")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 音樂指令已同步");
    } catch (e) { console.error(e); }
})();

client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;
    const { commandName, guild, member, options } = i;

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) return i.reply("❌ 你必須先進入語音頻道！");

    let serverQueue = queue.get(guild.id);

    if (commandName === "play") {
        await i.reply("🔍 正在搜尋...");
        
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
            const res = await play.search(query, { limit: 1, source: { youtube: "video" } });
            
            if (!res || res.length === 0) return i.editReply("❌ 找不到音樂。");

            // 💡 修正 2: 確保 song 物件完整
            const song = { title: res[0].title, url: res[0].url };
            serverQueue.songs.push(song);

            i.editReply(`✅ 已加入：**${song.title}**`);
            if (serverQueue.songs.length === 1) playMusic(guild, serverQueue.songs[0]);

        } catch (e) {
            console.error(e);
            i.editReply("❌ 搜尋發生錯誤。");
        }
    }

    if (commandName === "skip") {
        serverQueue?.player.stop();
        i.reply("⏭ 已跳過");
    }

    if (commandName === "leave") {
        serverQueue?.connection.destroy();
        queue.delete(guild.id);
        i.reply("👋 下次見");
    }
});

// --- 💡 修正 3: 加入網址檢查與播放邏輯 ---
async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song || !song.url) {
        console.log("🎵 隊列已空或網址無效");
        return;
    }

    try {
        console.log(`🎶 正在播放: ${song.title}`);
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        
        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            if (serverQueue.songs.length > 0) {
                playMusic(guild, serverQueue.songs[0]);
            }
        });
    } catch (e) {
        console.error("播放發生錯誤:", e.message);
        serverQueue.songs.shift();
        playMusic(guild, serverQueue.songs[0]);
    }
}

// 💡 修正 4: 按照警告建議使用 clientReady
client.once("clientReady", () => console.log(`🎵 ${client.user.tag} 已準備就緒！`));
client.login(TOKEN);
