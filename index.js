const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// --- 1. Spotify 授權 ---
(async () => {
    try {
        await play.setToken({
            spotify: {
                client_id: process.env.SPOTIFY_ID,
                client_secret: process.env.SPOTIFY_SECRET,
                market: 'TW'
            }
        });
        console.log("✅ Spotify 服務已啟動");
    } catch (e) {
        console.error("❌ Spotify 啟動失敗:", e.message);
    }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// --- 2. 指令註冊 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂 (支援 Spotify/SoundCloud)").addStringOption(o => o.setName("song").setDescription("歌名或連結").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過"),
    new SlashCommandBuilder().setName("leave").setDescription("離開")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 指令同步成功");
    } catch (e) { console.error("❌ 指令同步失敗:", e.message); }
})();

// --- 3. 核心邏輯 ---
client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;
    const { commandName, guild, member, options } = i;
    if (!member.voice.channel) return i.reply("❌ 你得先進入語音頻道！");

    let serverQueue = queue.get(guild.id);

    if (commandName === "play") {
        await i.reply("🔍 正在搜尋音樂...");
        if (!serverQueue) {
            serverQueue = {
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
            let songData;

            // 優先判斷是否為 Spotify
            if (play.sp_validate(query)) {
                const sp = await play.spotify(query);
                songData = { title: sp.name, url: query, isSp: true };
            } else {
                // 一般關鍵字：優先在 SoundCloud 搜尋以避開 YouTube 封鎖
                const res = await play.search(query, { limit: 1, source: { soundcloud: "tracks" } });
                if (!res.length) return i.editReply("❌ 找不到音樂");
                songData = { title: res[0].title, url: res[0].url };
            }

            serverQueue.songs.push(songData);
            i.editReply(`✅ 已加入隊列: **${songData.title}**`);
            if (serverQueue.songs.length === 1) playMusic(guild, serverQueue.songs[0]);
        } catch (e) { 
            console.error(e);
            i.editReply("❌ 搜尋發生錯誤"); 
        }
    }

    if (commandName === "skip") { serverQueue?.player.stop(); i.reply("⏭ 已跳過"); }
    if (commandName === "leave") { 
        serverQueue?.connection.destroy(); 
        queue.delete(guild.id); 
        i.reply("👋 掰掰"); 
    }
});

// --- 4. 播放函式 (具備備援機制) ---
async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return;

    try {
        console.log(`🎶 正在播放: ${song.title}`);
        let stream;

        // 嘗試播放。如果 YouTube 擋住，會跳到 catch
        try {
            stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        } catch (err) {
            console.warn("⚠️ 主要音源失效，嘗試使用 SoundCloud 備援...");
            const searchRes = await play.search(song.title, { limit: 1, source: { soundcloud: "tracks" } });
            if (searchRes.length > 0) {
                stream = await play.stream(searchRes[0].url, { discordPlayerCompatibility: true });
            } else {
                throw new Error("無法找到可用音源");
            }
        }

        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            playMusic(guild, serverQueue.songs[0]);
        });
    } catch (e) {
        console.error("❌ 播放完全失敗:", e.message);
        serverQueue.songs.shift();
        playMusic(guild, serverQueue.songs[0]);
    }
}

client.once("ready", () => console.log(`🎵 ${client.user.tag} 已上線！`));
client.login(TOKEN);
