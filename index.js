const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');
const Tesseract = require('tesseract.js');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// In-memory store for claimed characters (use SQLite/PostgreSQL for long-term production persistence)
const claimedCharacters = new Map();

// 1. Function to check character existence against rankings
async function checkCharacterRankings(characterName) {
    try {
        const response = await fetch(`https://api.classicrank.net/character/${encodeURIComponent(characterName)}`);
        if (!response.ok) return true; // Fallback gracefully if API is down
        const data = await response.json();
        return data && data.exists === true;
    } catch (error) {
        console.error('Rankings API Error:', error);
        return true; // Fallback to allow verification if API network drops
    }
}

// 2. Function to perform OCR on the attached screenshot
async function verifyScreenshotText(imageUrl, targetIgn) {
    try {
        const { data: { text } } = await Tesseract.recognize(imageUrl, 'eng');
        const cleanedText = text.toLowerCase();
        return { success: cleanedText.includes(targetIgn.toLowerCase()), rawText: text };
    } catch (error) {
        console.error('OCR Error:', error);
        return { success: false, rawText: '' };
    }
}

client.once('ready', async () => {
    console.log(`Bot Logged in as ${client.user.tag}!`);

    const command = new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Verify your MapleStory Classic character via screenshot and rankings check.')
        .addStringOption(option =>
            option.setName('character')
                .setDescription('Your exact in-game character name')
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName('screenshot')
                .setDescription('Screenshot showing your character name clearly')
                .setRequired(true)
        );

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
            body: [command.toJSON()]
        });
        console.log('Successfully registered global slash commands.');
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

    // Validate 4-12 alphanumeric characters
    if (!/^[a-zA-Z0-9]{4,12}$/.test(rawIgn)) {
        return interaction.editReply('❌ Invalid IGN format. MapleStory names must be 4–12 alphanumeric characters with no spaces.');
    }

    // Prevent duplicate claims
    if (claimedCharacters.has(ignKey) && claimedCharacters.get(ignKey) !== interaction.user.id) {
        return interaction.editReply(`❌ The character **${rawIgn}** has already been claimed by another user.`);
    }

    // Check rankings
    const existsInGame = await checkCharacterRankings(rawIgn);
    if (!existsInGame) {
        return interaction.editReply(`❌ Could not find **${rawIgn}** on the MapleStory Classic rankings database.`);
    }

    // Validate image upload
    if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
        return interaction.editReply('❌ Please upload a valid image file (PNG or JPEG) for your screenshot.');
    }

    // Perform OCR
    const ocrResult = await verifyScreenshotText(attachment.url, rawIgn);
    if (!ocrResult.success) {
        return interaction.editReply(`❌ **OCR Verification Failed:** We could not find the name **"${rawIgn}"** inside your screenshot.`);
    }

    // Success: Set Nickname and Assign Role
    try {
        const member = interaction.member;
        await member.setNickname(rawIgn, 'Automated OCR Character Verification');
        await member.roles.add(process.env.VERIFIED_ROLE_ID);

        claimedCharacters.set(ignKey, interaction.user.id);

        const successEmbed = new EmbedBuilder()
            .setTitle('✅ Verification Successful!')
            .setDescription(`Your character **${rawIgn}** has been verified, your nickname has been locked, and your role has been assigned.`)
            .setColor(0x00FF00);

        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('Role/Nickname Assignment Error:', error);
        await interaction.editReply('❌ Verification passed, but I failed to update your nickname or roles. Check my bot role hierarchy position.');
    }
});

client.login(process.env.DISCORD_TOKEN);