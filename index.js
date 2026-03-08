async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!song) return;

    try {
        console.log(`🎶 正在嘗試播放: ${song.title}`);

        let stream;
        try {
            // 優先嘗試從當前網址抓取 (如果是 Spotify 連結，play-dl 會自動轉音源)
            // 我們加入 { source: { soundcloud: "tracks" } } 強制避開 YouTube
            stream = await play.stream(song.url, { 
                discordPlayerCompatibility: true 
            });
        } catch (e) {
            console.warn("⚠️ YouTube 來源失效，正在自動切換至 SoundCloud...");
            // 如果失敗（通常是 YouTube 報錯），改用關鍵字在 SoundCloud 搜尋並播放
            const searchRes = await play.search(song.title, { 
                limit: 1, 
                source: { soundcloud: "tracks" } 
            });
            if (searchRes.length > 0) {
                stream = await play.stream(searchRes[0].url, { discordPlayerCompatibility: true });
            } else {
                throw new Error("所有平台都找不到這首歌");
            }
        }

        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            if (serverQueue.songs.length > 0) playMusic(guild, serverQueue.songs[0]);
        });

    } catch (e) {
        console.error("❌ 播放完全失敗:", e.message);
        // 回饋給 Discord 使用者
        const channel = client.channels.cache.get(serverQueue.connection.joinConfig.channelId);
        // 注意：這裡需要確保你有權限發話
        
        serverQueue.songs.shift();
        if (serverQueue.songs.length > 0) playMusic(guild, serverQueue.songs[0]);
    }
}
