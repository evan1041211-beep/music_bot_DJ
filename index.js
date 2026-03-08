const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// --- 1. 自動初始化服務 ---
async function initializeServices() {
    try {
        // 強制 play-dl 去抓取匿名 SoundCloud ID
        await play.getFreeClientID();
        
        // 設定 Spotify (這部分仍需 Railway 變數)
        await play.setToken({
            spotify: {
                client_id: process.env.SPOTIFY_ID,
                client_secret: process.env.SPOTIFY_SECRET,
                market: 'TW'
            }
        });
        console.log("✅ 服務自動初始化成功");
    } catch (e) {
        console.warn("⚠️ 自動獲取 ID 失敗，將在搜尋時再次嘗試:", e.message);
    }
}
initializeServices();

// --- 2. 指令註冊 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("搜尋歌曲並選擇").addStringOption(o => o.setName("song").setDescription("輸入歌名").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過歌曲"),
    new SlashCommandBuilder().setName("leave").setDescription("讓機器人離開")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 指令同步成功");
    } catch (e) { console.error(e); }
})();

// --- 3. 核心邏輯 ---
client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand()) return;
    const { commandName, guild, member, options } = i;
    if (!member.voice.channel) return i.reply("❌ 你得先進入語音頻道！");

    if (commandName === "play") {
        const query = options.getString("song");
        await i.deferReply();

        try {
            // --- 修正點：改用更安全的初始化 ---
            try {
                // 如果 play-dl 還沒準備好，這行會嘗試抓取必要的匿名 ID
                await play.getFreeClientID(); 
            } catch (err) {
                console.warn("自動獲取 ID 失敗，嘗試直接搜尋...");
            }

            // 搜尋 SoundCloud 前 5 名
            const results = await play.search(query, { limit: 5, source: { soundcloud: "tracks" } });
            
            if (!results || !results.length) {
                return i.editReply("❌ 找不到相關音樂，可能是服務暫時不可用。");
            }

            // 建立選單 (這部分保持不變)
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_song')
                .setPlaceholder('🎵 請從下方選一首歌播放...')
                .addOptions(results.map((song) => ({
                    label: song.title.substring(0, 100),
                    description: `時長: ${song.durationRaw || '未知'}`,
                    value: song.url,
                })));

            const row = new ActionRowBuilder().addComponents(selectMenu);
            await i.editReply({ 
                content: `🔍 幫你找到了這些「${query}」的結果：`, 
                components: [row] 
            });

            // ... 後續的 Collector 代碼保持不變 ...

            // 收集玩家的選擇
            const collector = response.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                time: 30000 // 30 秒後過期
            });

            collector.on('collect', async interaction => {
                if (interaction.user.id !== i.user.id) {
                    return interaction.reply({ content: "這不是你的選單！", ephemeral: true });
                }
                
                const selectedUrl = interaction.values[0];
                const selectedSong = results.find(s => s.url === selectedUrl);

                await interaction.update({ content: `✅ 準備播放: **${selectedSong.title}**`, components: [] });
                
                startPlaying(guild, member, selectedSong);
            });

        } catch (e) {
            console.error("搜尋錯誤:", e);
            i.editReply("❌ 搜尋失敗。這通常是伺服器 IP 被暫時阻擋，請稍後再試。");
        }
    }

    if (commandName === "skip") {
        queue.get(guild.id)?.player.stop();
        i.reply("⏭ 已跳過目前的歌曲");
    }

    if (commandName === "leave") {
        queue.get(guild.id)?.connection.destroy();
        queue.delete(guild.id);
        i.reply("👋 掰掰！下次見。");
    }
});

// --- 4. 播放機制 ---
async function startPlaying(guild, member, songData) {
    let serverQueue = queue.get(guild.id);

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

    serverQueue.songs.push(songData);
    if (serverQueue.songs.length === 1) playMusic(guild, serverQueue.songs[0]);
}

async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return;

    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
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

client.once("ready", () => console.log(`🎵 ${client.user.tag} 已就緒！`));
client.login(TOKEN);
