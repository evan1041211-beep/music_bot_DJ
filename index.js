const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

// --- 1. 授權初始化 (僅 SoundCloud 手動模式) ---
(async () => {
    try {
        await play.setToken({
            soundcloud: {
                client_id: process.env.SOUNDCLOUD_ID 
            }
        });
        console.log("✅ SoundCloud 服務授權成功 (純 SoundCloud 模式)");
    } catch (e) {
        console.error("❌ 授權初始化失敗，請檢查 SOUNDCLOUD_ID:", e.message);
    }
})();

// --- 2. 指令註冊 ---
const commands = [
    new SlashCommandBuilder().setName("play").setDescription("搜尋 SoundCloud 音樂").addStringOption(o => o.setName("song").setDescription("輸入歌名或歌手").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過目前的歌曲"),
    new SlashCommandBuilder().setName("leave").setDescription("讓機器人離開")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ 指令同步成功");
    } catch (e) { console.error("❌ 指令同步失敗:", e); }
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
            // 直接從 SoundCloud 搜尋前 5 名
            const results = await play.search(query, { limit: 5, source: { soundcloud: "tracks" } });
            
            if (!results || results.length === 0) {
                return i.editReply("❌ 在 SoundCloud 上找不到相關音樂，請更換關鍵字。");
            }

            // 建立選單
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_song')
                .setPlaceholder('🎵 請點擊此處選擇一首歌播放...')
                .addOptions(results.map((song) => ({
                    label: song.title.substring(0, 100),
                    description: `歌手: ${song.user?.name || '未知'} | 時長: ${song.durationRaw}`,
                    value: song.url,
                })));

            const row = new ActionRowBuilder().addComponents(selectMenu);
            const response = await i.editReply({ 
                content: `🔍 幫你找到了這些「${query}」的結果：`, 
                components: [row] 
            });

            // 收集選擇
            const collector = response.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                time: 30000 
            });

            collector.on('collect', async interaction => {
                if (interaction.user.id !== i.user.id) return interaction.reply({ content: "這不是你的選單！", ephemeral: true });
                
                const selectedUrl = interaction.values[0];
                const selectedSong = results.find(s => s.url === selectedUrl);

                await interaction.update({ content: `✅ 正在準備播放: **${selectedSong.title}**`, components: [] });
                
                addToQueue(guild, member, selectedSong);
            });

        } catch (e) {
            console.error("搜尋錯誤:", e);
            i.editReply("❌ 搜尋失敗。這通常是 SOUNDCLOUD_ID 無效，請更新變數。");
        }
    }

    if (commandName === "skip") {
        const q = queue.get(guild.id);
        if (q) { q.player.stop(); i.reply("⏭ 已跳過！"); }
        else { i.reply("❌ 目前沒有正在播放的音樂。"); }
    }

    if (commandName === "leave") {
        const q = queue.get(guild.id);
        if (q) { q.connection.destroy(); queue.delete(guild.id); i.reply("👋 掰掰！"); }
    }
});

// --- 4. 播放管理 ---
async function addToQueue(guild, member, songData) {
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
        console.error("播放失敗:", e.message);
        serverQueue.songs.shift();
        playMusic(guild, serverQueue.songs[0]);
    }
}

client.once("ready", () => console.log(`🎵 ${client.user.tag} (純音質版) 已上線！`));
client.login(TOKEN);
