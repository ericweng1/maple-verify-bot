const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');
const Tesseract = require('tesseract.js');
const Jimp = require('jimp');
const http = require('http');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const claimedCharacters = new Map();

// Improved image preprocessing for game fonts
async function preprocessFullImage(imageUrl) {
    try {
        const image = await Jimp.read(imageUrl);
        image.scale(2)
             .greyscale()
             .normalize()
             .contrast(0.4);
        return await image.getBufferAsync(Jimp.MIME_PNG);
    } catch (error) {
        console.error('Image processing error:', error);
        return null;
    }
}

// Maps MapleStory jobs/advancements to exact Discord role names
function detectJobRoleName(text) {
    const lower = text.toLowerCase();

    if (/\b(cleric|priest|bishop)\b/.test(lower)) return 'Cleric';
    if (/\b(magician|wizard|mage|fire\/poison|ice\/lightning|arch mage)\b/.test(lower)) return 'Mage';
    if (/\b(warrior|fighter|page|spearman|crusader|white knight|dragon knight|hero|paladin|dark knight)\b/.test(lower)) return 'Warrior';
    if (/\b(bowman|hunter|crossbowman|ranger|sniper|bowmaster|marksman)\b/.test(lower)) return 'Bowman';
    if (/\b(rogue|assassin|bandit|hermit|chief bandit|night lord|shadower)\b/.test(lower)) return 'Rogue';

    return null;
}

// 1. Fetch ClassicRank page and robustly extract the job
async function getClassicRankData(characterName) {
    try {
        const response = await fetch(`https://classicrank.com/user/${encodeURIComponent(characterName)}`);
        if (response.status === 404 || !response.ok) return { exists: false, jobRole: null };

        const html = await response.text();
        if (html.toLowerCase().includes('character not found')) {
            return { exists: false, jobRole: null };
        }

        // Clean HTML tags into a readable text flow to easily find the job label
        const cleanText = html.replace(/<[^>]*>/g, ' ');
        const jobRole = detectJobRoleName(cleanText);

        return { exists: true, jobRole };
    } catch (error) {
        console.error('ClassicRank Lookup Error:', error);
        return { exists: true, jobRole: null };
    }
}

// 2. Read job from screenshot OCR
async function verifyScreenshotJob(imageUrl) {
    try {
        const processedBuffer = await preprocessFullImage(imageUrl);
        if (!processedBuffer) return null;

        const { data: { text } } = await Tesseract.recognize(processedBuffer, 'eng');
        return detectJobRoleName(text);
    } catch (error) {
        console.error('OCR Error:', error);
        return null;
    }
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
        return interaction.editReply(`❌ **${rawIgn}** has already been verified by another member in this server.`);
    }

    // 1. Check ClassicRank profile & job
    const trackerData = await getClassicRankData(rawIgn);
    if (!trackerData.exists) {
        return interaction.editReply(
            `❌ Could not find **${rawIgn}** on ClassicRank (\`classicrank.com/user/${rawIgn}\`).\n` +
            `*Make sure your character has been scanned or uploaded to ClassicRank first!*`
        );
    }

    if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
        return interaction.editReply('❌ Please upload a valid image file (PNG or JPEG).');
    }

    // 2. Read job from screenshot via OCR
    const screenshotJob = await verifyScreenshotJob(attachment.url);

    // 3. Strict Anti-Spoofing: If the screenshot contains a detectable job and it doesn't match ClassicRank, block it
    if (trackerData.jobRole && screenshotJob && trackerData.jobRole.toLowerCase() !== screenshotJob.toLowerCase()) {
        return interaction.editReply(
            `❌ **Class Mismatch:** ClassicRank lists **${rawIgn}** as **${trackerData.jobRole}**, ` +
            `but your screenshot shows **${screenshotJob}**.\n` +
            `*Please upload a screenshot matching your character's actual class.*`
        );
    }

    // Use ClassicRank's verified job class
    const detectedRoleName = trackerData.jobRole || screenshotJob;

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
            .setDescription(
                `Welcome, **${rawIgn}**!\n` +
                `• **Nickname:** Locked to \`${rawIgn}\`\n` +
                `• **Class Role:** ${assignedJobText}`
            )
            .setColor(0x00FF00);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Permission/Hierarchy Error:', error);
        await interaction.editReply('❌ Verification passed, but I lacked permission to set your nickname or role. Make sure the bot\'s role is dragged **above** Cleric, Warrior, Mage, Bowman, and Rogue in Server Settings.');
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
