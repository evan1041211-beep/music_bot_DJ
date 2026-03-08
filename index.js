const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

// --- 1. 環境變數與 Cookie 處理 ---
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

let globalCookieString = "";

// 啟動時立即解析 Cookie
(async () => {
    if (process.env.cookies) {
        try {
            const decoded = Buffer.from(process.env.cookies, 'base64').toString('utf-8');
            const cookieJar = JSON.parse(decoded);
            // 將 JSON 轉為標準 name=value; 格式並過濾非法字元
            globalCookieString = cookieJar
                .map(c => `${c.name}=${c.value}`)
                .join('; ')
                .replace(/[^\x20-\x7E]/g, ""); 
            
            await play.setToken({
                youtube: { cookie: globalCookieString }
            });
            console.log("✅ YouTube Cookie 已成功解析並過濾非法字元");
        } catch (e) {
            console.error("❌ Cookie 處理失敗:", e.message);
        }
    }
})();

// --- 2. 機器人初始化 ---
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] 
});

const queue = new Map();

// --- 3. 註冊指令 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放 YouTube 音樂")
        .addStringOption(o => o.setName("song").setDescription("歌名或網址").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過目前的歌曲"),
    new SlashCommandBuilder().setName("leave").setDescription("讓機器人離開語音頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 指令同步成功");
    } catch (e) { console.error(e); }
})();

// --- 4. 指令監聽 ---
client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;
    const { commandName, guild, member, options } = i;

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) return i.reply("❌ 你必須先進入語音頻道！");

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
            const res = await play.search(query, { limit: 1 });
            if (!res.length) return i.editReply("❌ 找不到音樂。");

            const song = { title: res[0].title, url: res[0].url };
            serverQueue.songs.push(song);

            i.editReply(`✅ 已加入隊列：**${song.title}**`);
            if (serverQueue.songs.length === 1) playMusic(guild, serverQueue.songs[0]);
        } catch (e) {
            console.error(e);
            i.editReply("❌ 搜尋出錯");
        }
    }

    if (commandName === "skip") {
        serverQueue?.player.stop();
        i.reply("⏭ 已跳過歌曲");
    }

    if (commandName === "leave") {
        serverQueue?.connection.destroy();
        queue.delete(guild.id);
        i.reply("👋 機器人已離開");
    }
});

// --- 5. 核心播放函數 ---
async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return;

    try {
        console.log(`🎶 正在播放: ${song.title}`);

        // 嘗試播放
        const stream = await play.stream(song.url, { 
            discordPlayerCompatibility: true,
            // 雙重注入 Cookie 以確保穩定性
            htmll: {
                cookie: globalCookieString
            }
        });

        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            if (serverQueue.songs.length > 0) playMusic(guild, serverQueue.songs[0]);
        });

    } catch (e) {
        console.error("播放出錯:", e.message);

        // 如果是因為 Bot 偵測失敗，嘗試不帶 Cookie 播放最後一次
        if (e.message.includes("confirm you’re not a bot")) {
            console.log("⚠️ 嘗試無 Cookie 模式播放...");
            try {
                const retryStream = await play.stream(song.url, { discordPlayerCompatibility: true });
                const resource = createAudioResource(retryStream.stream, { inputType: retryStream.type });
                serverQueue.player.play(resource);
                return; 
            } catch (err) { console.error("❌ 無 Cookie 模式亦失敗"); }
        }

        serverQueue.songs.shift();
        if (serverQueue.songs.length > 0) playMusic(guild, serverQueue.songs[0]);
    }
}

client.once("clientReady", () => console.log(`🎵 ${client.user.tag} 準備就緒！`));
client.login(TOKEN);
