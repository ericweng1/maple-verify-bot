const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');
const Tesseract = require('tesseract.js');
const Jimp = require('jimp');
const http = require('http');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const claimedCharacters = new Map();

// Preprocess full screenshot for reading JOB / LEVEL
async function preprocessFullImage(imageUrl) {
    try {
        const image = await Jimp.read(imageUrl);
        image.scale(2)
             .greyscale()
             .normalize()
             .contrast(0.4);
        return await image.getBufferAsync(Jimp.MIME_PNG);
    } catch (error) {
        console.error('Full image processing error:', error);
        return null;
    }
}

// Preprocess cropped left-side nameplate box (white text on dark pill) for IGN check
async function preprocessNameArea(imageUrl) {
    try {
        const image = await Jimp.read(imageUrl);
        const w = image.bitmap.width;
        const h = image.bitmap.height;

        // Crop the left ~42% width and bottom ~45% height where the character name pill sits
        image.crop(0, Math.floor(h * 0.55), Math.floor(w * 0.42), Math.floor(h * 0.45))
             .scale(3)
             .greyscale()
             .contrast(0.7)
             .invert(); // Turns white text on dark background into black text on white background
        return await image.getBufferAsync(Jimp.MIME_PNG);
    } catch (error) {
        console.error('Name crop processing error:', error);
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

// 1. Fetch ClassicRank page and extract job specifically from the character info table
async function getClassicRankData(characterName) {
    try {
        const response = await fetch(`https://classicrank.com/user/${encodeURIComponent(characterName)}`);
        if (response.status === 404 || !response.ok) return { exists: false, jobRole: null };

        const html = await response.text();
        if (html.toLowerCase().includes('character not found')) {
            return { exists: false, jobRole: null };
        }

        const jobMatch = html.match(/JOB<\/div>[\s\S]*?<div[^>]*>([^<]+)<\/div>/i);
        let jobRole = null;

        if (jobMatch && jobMatch[1]) {
            jobRole = detectJobRoleName(jobMatch[1]);
        }

        if (!jobRole) {
            const cleanText = html.replace(/<[^>]*>/g, ' ');
            jobRole = detectJobRoleName(cleanText);
        }

        return { exists: true, jobRole };
    } catch (error) {
        console.error('ClassicRank Lookup Error:', error);
        return { exists: true, jobRole: null };
    }
}

// 2. Read both the cropped Name box and full Character Info window
async function verifyScreenshot(imageUrl, targetIgn) {
    try {
        const [fullBuffer, nameBuffer] = await Promise.all([
            preprocessFullImage(imageUrl),
            preprocessNameArea(imageUrl)
        ]);

        if (!fullBuffer) return { hasIgn: false, screenshotJobRole: null };

        const [fullOcr, nameOcr] = await Promise.all([
            Tesseract.recognize(fullBuffer, 'eng'),
            nameBuffer ? Tesseract.recognize(nameBuffer, 'eng') : Promise.resolve({ data: { text: '' } })
        ]);

        const combinedText = `${fullOcr.data.text} ${nameOcr.data.text}`;
        // Strip spaces/punctuation to avoid minor OCR spacing glitches on names
        const normalizedText = combinedText.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normalizedIgn = targetIgn.toLowerCase().replace(/[^a-z0-9]/g, '');

        const hasIgn = normalizedText.includes(normalizedIgn);
        const screenshotJobRole = detectJobRoleName(fullOcr.data.text);

        return { hasIgn, screenshotJobRole };
    } catch (error) {
        console.error('OCR Error:', error);
        return { hasIgn: false, screenshotJobRole: null };
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

    // 2. Verify screenshot name & job
    const ocrResult = await verifyScreenshot(attachment.url, rawIgn);

    if (!ocrResult.hasIgn) {
        return interaction.editReply(
            `❌ **Name Mismatch:** Could not find **"${rawIgn}"** in your screenshot.\n` +
            `*Make sure you uploaded the Character Info screenshot for **${rawIgn}** (cropped cleanly around the Character Info window).*`
        );
    }

    // 3. Reject if ClassicRank and Screenshot show conflicting classes
    if (trackerData.jobRole && ocrResult.screenshotJobRole && trackerData.jobRole !== ocrResult.screenshotJobRole) {
        return interaction.editReply(
            `❌ **Class Mismatch:** ClassicRank lists **${rawIgn}** as **${trackerData.jobRole}**, ` +
            `but your screenshot shows **${ocrResult.screenshotJobRole}**.\n` +
            `*Please upload an up-to-date screenshot matching your character!*`
        );
    }

    const detectedRoleName = ocrResult.screenshotJobRole || trackerData.jobRole;

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
