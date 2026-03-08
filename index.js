const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] 
});

const queue = new Map();

// --- 💡 核心修正：將 Base64 JSON 轉為 YouTube 標頭格式 ---
let globalCookieString = "";
(async () => {
    if (process.env.cookies) {
        try {
            const decoded = Buffer.from(process.env.cookies, 'base64').toString('utf-8');
            const cookieJar = JSON.parse(decoded);
            // 將 JSON 陣列轉換為 name=value; 格式
            globalCookieString = cookieJar.map(c => `${c.name}=${c.value}`).join('; ');
            console.log("✅ YouTube Cookie 已成功解析並轉換為字串格式");
        } catch (e) {
            console.error("❌ Cookie 處理失敗:", e.message);
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
        console.log("✅ 指令同步成功");
    } catch (e) { console.error(e); }
})();

client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;
    const { commandName, guild, member, options } = i;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) return i.reply("❌ 你得進語音房！");

    let serverQueue = queue.get(guild.id);
    if (commandName === "play") {
        await i.reply("🔍 正在搜尋 YouTube...");
        if (!serverQueue) {
            serverQueue = {
                connection: joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator }),
                player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
                songs: []
            };
            serverQueue.connection.subscribe(serverQueue.player);
            queue.set(guild.id, serverQueue);
        }
        try {
            const query = options.getString("song");
            const res = await play.search(query, { limit: 1 });
            if (!res.length) return i.editReply("❌ 找不到音樂");
            const song = { title: res[0].title, url: res[0].url };
            serverQueue.songs.push(song);
            i.editReply(`✅ 已加入：**${song.title}**`);
            if (serverQueue.songs.length === 1) playMusic(guild, serverQueue.songs[0]);
        } catch (e) { i.editReply("❌ 搜尋失敗"); }
    }
    if (commandName === "skip") { serverQueue?.player.stop(); i.reply("⏭ 已跳過"); }
    if (commandName === "leave") { serverQueue?.connection.destroy(); queue.delete(guild.id); i.reply("👋 掰掰"); }
});

async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return;
    try {
        // 💡 關鍵：手動注入清洗過的 Cookie 字串
        const stream = await play.stream(song.url, { 
            discordPlayerCompatibility: true,
            htth: { // 注意 play-dl 有時會檢查這個欄位
                cookie: globalCookieString.replace(/[^\x20-\x7E]/g, "") 
            }
        });
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);
        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            playMusic(guild, serverQueue.songs[0]);
        });
    } catch (e) {
        console.error("播放出錯:", e.message);
        serverQueue.songs.shift();
        playMusic(guild, serverQueue.songs[0]);
    }
}

client.once("clientReady", () => console.log(`🎵 ${client.user.tag} 準備就緒！`));
client.login(TOKEN);
