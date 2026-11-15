const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');
const Tesseract = require('tesseract.js');
const http = require('http');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// In-memory store to prevent two Discord users from claiming the same IGN
const claimedCharacters = new Map();

// 1. Check if character exists on ClassicRank (e.g., https://classicrank.com/user/DoughNut)
async function checkClassicRank(characterName) {
    try {
        const response = await fetch(`https://classicrank.com/user/${encodeURIComponent(characterName)}`);
        if (response.status === 404) return false;
        
        const html = await response.text();
        // Verify the profile actually loaded and isn't a generic "not found" page
        return response.ok && !html.toLowerCase().includes('character not found');
    } catch (error) {
        console.error('ClassicRank Lookup Error:', error);
        return true; // Fallback so users aren't blocked if ClassicRank goes down temporarily
    }
}

// 2. Read text from the uploaded screenshot using Tesseract OCR
async function verifyScreenshotText(imageUrl, targetIgn) {
    try {
        const { data: { text } } = await Tesseract.recognize(imageUrl, 'eng');
        return text.toLowerCase().includes(targetIgn.toLowerCase());
    } catch (error) {
        console.error('OCR Error:', error);
        return false;
    }
}

client.once('ready', async () => {
    console.log(`✅ Bot Logged in as ${client.user.tag}!`);

    const command = new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Verify your MapleStory Classic character and lock your nickname.')
        .addStringOption(option =>
            option.setName('character')
                .setDescription('Your exact in-game character name')
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName('screenshot')
                .setDescription('Screenshot of your Character Info window or character name in-game')
                .setRequired(true)
        );

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
            body: [command.toJSON()]
        });
        console.log('✅ Slash command /verify registered.');
    } catch (error) {
        console.error('Command Registration Error:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'verify') return;

    await interaction.deferReply({ ephemeral: true });

    const rawIgn = interaction.options.getString('character').trim();
    const ignKey = rawIgn.toLowerCase();
    const attachment = interaction.options.getAttachment('screenshot');

    // Validate MapleStory IGN format (4-12 alphanumeric characters)
    if (!/^[a-zA-Z0-9]{4,12}$/.test(rawIgn)) {
        return interaction.editReply('❌ Invalid IGN. MapleStory names must be 4–12 letters or numbers with no spaces.');
    }

    // Check if another Discord member already claimed this IGN
    if (claimedCharacters.has(ignKey) && claimedCharacters.get(ignKey) !== interaction.user.id) {
        return interaction.editReply(`❌ **${rawIgn}** has already been verified by another member in this server.`);
    }

    // Check ClassicRank profile
    const existsOnTracker = await checkClassicRank(rawIgn);
    if (!existsOnTracker) {
        return interaction.editReply(
            `❌ Could not find **${rawIgn}** on ClassicRank (\`classicrank.com/user/${rawIgn}\`).\n` +
            `*Make sure your character has been scanned or uploaded to ClassicRank first!*`
        );
    }

    // Validate image file type
    if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
        return interaction.editReply('❌ Please upload a valid image file (PNG or JPEG).');
    }

    // Run OCR on the screenshot
    const ocrPassed = await verifyScreenshotText(attachment.url, rawIgn);
    if (!ocrPassed) {
        return interaction.editReply(
            `❌ **Screenshot Check Failed:** Could not read **"${rawIgn}"** in your screenshot.\n` +
            `*Tip: Open your Character Info window in-game so your name is clearly visible and uncropped.*`
        );
    }

    // Assign Role & Lock Nickname
    try {
        const member = interaction.member;
        await member.setNickname(rawIgn, 'Verified MapleStory Classic IGN');
        await member.roles.add(process.env.VERIFIED_ROLE_ID);

        claimedCharacters.set(ignKey, interaction.user.id);

        const embed = new EmbedBuilder()
            .setTitle('✅ Character Verified!')
            .setDescription(`Welcome, **${rawIgn}**! Your verified role has been assigned and your server nickname is now locked.`)
            .setColor(0x00FF00);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Permission/Hierarchy Error:', error);
        await interaction.editReply('❌ Verification passed, but I could not change your nickname or role. (Check that my bot role is above yours in Server Settings).');
    }
});

client.login(process.env.DISCORD_TOKEN);

// Keep-alive HTTP server required for Render's Free Web Service
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MapleStory Classic Verification Bot is online!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});
