const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');
const Tesseract = require('tesseract.js');
const http = require('http');

// Added dependency for image preprocessing
const Jimp = require('jimp');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// In-memory store
const claimedCharacters = new Map();

// --- NEW PREPROCESSING FUNCTION ---
// Makes the image greyscale and high-contrast to make the font clearer
async function preprocessImage(imageUrl) {
    try {
        const image = await Jimp.read(imageUrl);
        image.greyscale().contrast(0.6).invert(); // Convert to high-contrast B&W
        return await image.getBufferAsync(Jimp.MIME_PNG);
    } catch (error) {
        console.error('Image processing error:', error);
        return null;
    }
}
// -----------------------------------

// 1. Fetch ClassicRank data
async function getClassicRankData(characterName) {
    try {
        const response = await fetch(`https://classicrank.com/user/${encodeURIComponent(characterName)}`);
        if (response.status === 404 || !response.ok) return { exists: false, jobRole: null };

        const html = await response.text();
        if (html.toLowerCase().includes('character not found')) {
            return { exists: false, jobRole: null };
        }

        // Clean HTML to read text (e.g., "Lv. 40 · Assassin")
        const cleanText = html.replace(/<[^>]*>/g, ' ');
        const jobRole = detectJobRoleName(cleanText);

        return { exists: true, jobRole };
    } catch (error) {
        console.error('ClassicRank Lookup Error:', error);
        return { exists: true, jobRole: null };
    }
}

// 2. Read text from preprocessed screenshot
async function verifyScreenshot(imageUrl, targetIgn) {
    try {
        // Preprocess the image first!
        const processedImageBuffer = await preprocessImage(imageUrl);
        if (!processedImageBuffer) {
            console.error('Preprocessing failed.');
            return { hasIgn: false, screenshotJobRole: null };
        }

        const { data: { text } } = await Tesseract.recognize(processedImageBuffer, 'eng');
        const hasIgn = text.toLowerCase().includes(targetIgn.toLowerCase());
        const screenshotJobRole = detectJobRoleName(text);
        return { hasIgn, screenshotJobRole };
    } catch (error) {
        console.error('OCR Error:', error);
        return { hasIgn: false, screenshotJobRole: null };
    }
}

// Map jobs to Discord roles
function detectJobRoleName(text) {
    const lower = text.toLowerCase();
    if (/\b(cleric|priest|bishop)\b/.test(lower)) return 'Cleric';
    if (/\b(magician|wizard|mage|f\/p|i\/l|fire\/poison|ice\/lightning|arch mage)\b/.test(lower)) return 'Mage';
    if (/\b(warrior|fighter|page|spearman|crusader|white knight|dragon knight|hero|paladin|dark knight)\b/.test(lower)) return 'Warrior';
    if (/\b(bowman|hunter|crossbowman|ranger|sniper|bowmaster|marksman)\b/.test(lower)) return 'Bowman';
    if (/\b(rogue|assassin|bandit|hermit|chief bandit|night lord|shadower)\b/.test(lower)) return 'Rogue';
    return null;
}

client.once('ready', async () => {
    console.log(`✅ Bot Logged in as ${client.user.tag}!`);

    const command = new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Verify your MapleStory Classic character, job role, and nickname.')
        .addStringOption(option =>
            option.setName('character')
                .setDescription('Your exact in-game character name')
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName('screenshot')
                .setDescription('Screenshot of your Character Info window in-game')
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

    if (!/^[a-zA-Z0-9]{4,12}$/.test(rawIgn)) {
        return interaction.editReply('❌ Invalid IGN. MapleStory names must be 4–12 letters or numbers with no spaces.');
    }

    if (claimedCharacters.has(ignKey) && claimedCharacters.get(ignKey) !== interaction.user.id) {
        return interaction.editReply(`❌ **${rawIgn}** has already been verified by another member.`);
    }

    const trackerData = await getClassicRankData(rawIgn);
    if (!trackerData.exists) {
        return interaction.editReply(
            `❌ Could not find **${rawIgn}** on ClassicRank.\n` +
            `*Make sure your character is public on classicrank.com/user/${rawIgn}*`
        );
    }

    if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
        return interaction.editReply('❌ Please upload a valid image file (PNG or JPEG).');
    }

    // Pass original image URL; the function will preprocess it
    const ocrResult = await verifyScreenshot(attachment.url, rawIgn);
    
    // Check ClassicRank's job first, fallback to OCR. That screenshot lists "Assassin", which maps to "Rogue".
    const detectedRoleName = trackerData.jobRole || ocrResult.screenshotJobRole;

    if (!ocrResult.hasIgn) {
        return interaction.editReply(
            `❌ **Screenshot Check Failed:** Could not read **"${rawIgn}"** in your screenshot.\n` +
            `*Tip: Try turning off any in-game transparency effects or post-processing.*`
        );
    }

    try {
        const member = interaction.member;
        const guild = interaction.guild;
        
        await member.setNickname(rawIgn, 'Verified MapleStory Classic IGN');
        
        if (process.env.VERIFIED_ROLE_ID) {
            await member.roles.add(process.env.VERIFIED_ROLE_ID);
        }

        let assignedJobText = 'None detected (Beginner)';
        if (detectedRoleName) {
            const jobRole = guild.roles.cache.find(r => r.name.toLowerCase() === detectedRoleName.toLowerCase());
            if (jobRole) {
                await member.roles.add(jobRole);
                assignedJobText = `**${jobRole.name}**`;
            }
        }

        claimedCharacters.set(ignKey, interaction.user.id);

        const embed = new EmbedBuilder()
            .setTitle('✅ Character Verified!')
            .setDescription(`Welcome, **${rawIgn}**!\n• **Class Role:** ${assignedJobText}`)
            .setColor(0x00FF00);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Permission Error:', error);
        await interaction.editReply('❌ Verification passed, but I failed to set your role/nickname. Check role hierarchy.');
    }
});

client.login(process.env.DISCORD_TOKEN);

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MapleStory Classic Verification Bot is online!\n');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});
