const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

// ================= 設定區 =================
// 把原本寫死字串的地方，改成 process.env 讀取
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();

const commands = [
    new SlashCommandBuilder().setName("play").setDescription("播放音樂 (SoundCloud)").addStringOption(opt => opt.setName("song").setDescription("歌名").setRequired(true)),
    new SlashCommandBuilder().setName("skip").setDescription("跳過歌曲"),
    new SlashCommandBuilder().setName("stop").setDescription("停止播放"),
    new SlashCommandBuilder().setName("leave").setDescription("離開語音頻道")
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands }); } catch (error) { console.error(error); }
})();

client.once("ready", async () => {
    console.log(`🤖 Bot ${client.user.tag} 已上線！`);
    try {
        const client_id = await play.getFreeClientID();
        play.setToken({ soundcloud: { client_id: client_id } });
        console.log("✅ SoundCloud 通行證就緒！");
    } catch (err) { console.error(err); }
});

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
                textChannel: interaction.channel, connection: null,
                player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
                songs: []
            };
            queue.set(guild.id, serverQueue);
            serverQueue.connection = joinVoiceChannel({
                channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator
            });
            // 監聽網路狀態 (除錯用)
            serverQueue.connection.on('stateChange', (oldState, newState) => console.log(`[網路] ${oldState.status} -> ${newState.status}`));
        }

        try {
            const query = options.getString("song");
            const results = await play.search(query, { limit: 1, source: { soundcloud: "tracks" } });
            if (!results.length) return interaction.editReply("❌ 找不到該歌曲");
            
            const song = { title: results[0].name, url: results[0].url };
            serverQueue.songs.push(song);
            interaction.editReply(`✅ 已加入隊列: **${song.title}**`);

            if (serverQueue.songs.length === 1) playSong(guild, serverQueue.songs[0]);
        } catch (err) {
            console.error(err);
            interaction.editReply("❌ 搜尋失敗");
        }
        return;
    }

    const serverQueue = queue.get(guild.id);
    if (!serverQueue) return interaction.reply("❌ 目前沒有音樂");

    if (commandName === "skip") { serverQueue.player.stop(); interaction.reply("⏭ 已跳過"); }
    if (commandName === "stop") { serverQueue.songs = []; serverQueue.player.stop(); interaction.reply("⏹ 已停止"); }
    if (commandName === "leave") { serverQueue.connection.destroy(); queue.delete(guild.id); interaction.reply("👋 再見！"); }
});

async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) { serverQueue.connection.destroy(); queue.delete(guild.id); return; }

    try {
        const stream = await play.stream(song.url);
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.connection.subscribe(serverQueue.player);
        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift(); playSong(guild, serverQueue.songs[0]);
        });
    } catch (err) {
        console.error(`串流失敗: ${err.message}`);
        serverQueue.textChannel.send(`⚠️ 無法播放: **${song.title}**`);
        serverQueue.songs.shift(); playSong(guild, serverQueue.songs[0]);
    }
}
client.login(TOKEN);