const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// --- 1. 核心 Cookie 處理 (修正 Invalid URL 問題) ---
(async () => {
    if (process.env.cookies) {
        try {
            // 1. 解碼 Base64
            const decoded = Buffer.from(process.env.cookies, 'base64').toString('utf-8');
            
            // 2. 直接將 JSON 字串傳給 setToken (play-dl 會自己處理過濾)
            // 不需要再手動轉為 name=value 字串，避免格式錯誤導致 Invalid URL
            await play.setToken({
                youtube: {
                    cookie: decoded.trim()
                }
            });
            console.log("✅ YouTube Cookie 已通過官方授權模式載入");
        } catch (e) {
            console.error("❌ Cookie 載入失敗:", e.message);
        }
    }
})();

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] 
});

const queue = new Map();

// --- 2. 指令註冊 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂").addStringOption(o => o.setName("song").setDescription("歌名或網址").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過"),
    new SlashCommandBuilder().setName("leave").setDescription("離開")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 指令已更新");
    } catch (e) { console.error(e); }
})();

// --- 3. 播放邏輯 ---
client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;
    const { commandName, guild, member, options } = i;

    if (!member.voice.channel) return i.reply("❌ 請先進入語音頻道");

    let serverQueue = queue.get(guild.id);

    if (commandName === "play") {
        await i.reply("🔍 搜尋中...");
        
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
            const res = await play.search(query, { limit: 1 });
            if (!res.length) return i.editReply("❌ 找不到音樂");

            serverQueue.songs.push({ title: res[0].title, url: res[0].url });
            i.editReply(`✅ 已加入: **${res[0].title}**`);

            if (serverQueue.songs.length === 1) playMusic(guild, serverQueue.songs[0]);
        } catch (e) {
            i.editReply("❌ 發生錯誤");
        }
    }

    if (commandName === "skip") {
        serverQueue?.player.stop();
        i.reply("⏭ 已跳過");
    }

    if (commandName === "leave") {
        serverQueue?.connection.destroy();
        queue.delete(guild.id);
        i.reply("👋 掰掰");
    }
});

async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return;

    try {
        console.log(`🎶 正在播放: ${song.title}`);
        
        // 💡 修正：不再手動傳入任何 header，讓已設定的 setToken 自動生效
        const stream = await play.stream(song.url, { 
            discordPlayerCompatibility: true 
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

client.once("clientReady", () => console.log(`🎵 ${client.user.tag} 上線！`));
client.login(TOKEN);
