// ─── UPDATED MESSAGE HANDLER ───────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const username = message.author.username;
  const content = message.content.trim();
  const lower = content.toLowerCase();
  const args = content.split(/\s+/);

  // --- 1. PERMISSION CHECK ---
  const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);

  // --- 2. CONSTRUCTION ZONE COMMANDS (Admin Only) ---
  if (isAdmin) {
    // !cancelshutdown
    if (lower === '!cancelshutdown') {
      let cancelled = [];
      if (_scheduledStart) { 
        clearTimeout(_scheduledStart); 
        _scheduledStart = null; 
        cancelled.push('scheduled shutdown'); 
      }
      if (_scheduledEnd) { 
        clearTimeout(_scheduledEnd); 
        _scheduledEnd = null; 
        cancelled.push('scheduled restore'); 
      }
      
      if (cancelled.length) return await message.reply(`✅ Cancelled: **${cancelled.join(' and ')}**.`);
      else return await message.reply('Nothing was scheduled.');
    }

    // !constructionstatus
    if (lower === '!constructionstatus') {
      const lines = [
        `**Construction mode:** ${_constructionActive ? '🚧 ACTIVE' : '✅ Off'}`,
        `**Scheduled shutdown:** ${_scheduledStart ? '⏳ Pending' : 'None'}`,
        `**Scheduled restore:** ${_scheduledEnd ? '⏳ Pending' : 'None'}`,
      ];
      return await message.reply(lines.join('\n'));
    }

    // !stopconstruction (Immediate Restore)
    if (lower === '!stopconstruction') {
      await endConstruction(message.guild);
      return await message.reply('✅ Construction mode deactivated. Server restored.');
    }
  }

  // --- 3. STANDARD COMMANDS (!balance, !shop, etc.) ---
  // (Your existing code for !balance, !checkin, !shop, etc. goes here)
  if (lower === '!balance') {
    const u = getUser(userId, username);
    // ... existing balance code ...
  }
  
  // ... rest of your command logic ...
});