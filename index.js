if (commandName === "play") {
        if (!member.voice.channel) return interaction.reply("❌ 你得先進入語音頻道！");
        await interaction.deferReply();

        await refreshSoundCloudToken();

        let serverQueue = queue.get(guild.id);
        const query = options.getString("song");

        // 檢查是否為 SoundCloud 連結
        const isUrl = play.is_links(query) === 'so_track';

        if (isUrl) {
            // --- 情況 A：使用者貼的是連結 ---
            try {
                const songInfo = await play.soundcloud(query);
                
                // 初始化播放器 (如果尚未建立)
                if (!serverQueue) {
                    serverQueue = createQueue(interaction, member);
                    queue.set(guild.id, serverQueue);
                }

                serverQueue.songs.push(songInfo);
                await interaction.editReply(`✅ 已透過連結加入: **${songInfo.name || songInfo.title || "未知曲名"}**`);
                
                if (serverQueue.songs.length === 1) playSong(guild, serverQueue.songs[0]);
                return;
            } catch (err) {
                console.error("連結解析失敗:", err);
                return interaction.editReply("❌ 無法讀取該 SoundCloud 連結。");
            }
        }

        // --- 情況 B：使用者輸入關鍵字 (維持選單模式) ---
        try {
            const results = await play.search(query, { limit: 5, source: { soundcloud: "tracks" } });
            
            if (!results || results.length === 0) return interaction.editReply("❌ 找不到相關音樂。");

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_song')
                .setPlaceholder('🎵 請選擇歌曲播放...')
                .addOptions(results.map(s => {
                    // SoundCloud 歌曲物件在連結模式與搜尋模式下的屬性可能不同
                    const safeTitle = (s.name || s.title || `Track ${s.id}`).toString();
                    return {
                        label: safeTitle.substring(0, 100),
                        description: `時長: ${s.durationRaw || '未知'} | 上傳者: ${s.user?.name || '匿名'}`,
                        value: s.url,
                    };
                }));

            const row = new ActionRowBuilder().addComponents(selectMenu);
            const msg = await interaction.editReply({ content: `🔍 找到「${query}」的結果：`, components: [row] });

            const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 30000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: "這不是你的選單", ephemeral: true });
                
                const selectedSong = results.find(s => s.url === i.values[0]);
                
                if (!serverQueue) {
                    serverQueue = createQueue(interaction, member);
                    queue.set(guild.id, serverQueue);
                }

                serverQueue.songs.push(selectedSong);
                await i.update({ content: `✅ 已加入隊列: **${selectedSong.name || selectedSong.title}**`, components: [] });
                
                if (serverQueue.songs.length === 1) playSong(guild, serverQueue.songs[0]);
            });

        } catch (err) {
            console.error("搜尋出錯:", err);
            interaction.editReply("❌ 搜尋失敗。");
        }
    }

// --- 輔助函式：建立隊列物件 (避免重複代碼) ---
function createQueue(interaction, member) {
    const guild = interaction.guild;
    const q = {
        textChannel: interaction.channel,
        connection: joinVoiceChannel({
            channelId: member.voice.channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
        }),
        player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
        songs: []
    };
    q.connection.subscribe(q.player);
    return q;
}
