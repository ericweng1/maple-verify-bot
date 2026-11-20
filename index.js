const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, MessageFlags } = require('discord.js');
const http = require('http');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const claimedCharacters = new Map();

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function detectJobRoleName(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    if (/\b(cleric|priest|bishop)\b/.test(lower)) return 'Cleric';
    if (/\b(magician|wizard|mage|fire\/poison|ice\/lightning|arch mage)\b/.test(lower)) return 'Mage';
    if (/\b(warrior|fighter|page|spearman|crusader|white knight|dragon knight|hero|paladin|dark knight)\b/.test(lower)) return 'Warrior';
    if (/\b(bowman|hunter|crossbowman|ranger|sniper|bowmaster|marksman)\b/.test(lower)) return 'Bowman';
    if (/\b(rogue|assassin|bandit|hermit|chief bandit|night lord|shadower)\b/.test(lower)) return 'Rogue';

    return null;
}

// 1. Check ClassicRank (handles 403 anti-bot challenge gracefully)
async function getClassicRankData(characterName) {
    const exact = encodeURIComponent(characterName);
    const candidateUrls = [
        `https://classicrank.com/user/windia/${exact}`,
        `https://classicrank.com/user/zenith/${exact}`,
        `https://classicrank.com/user/${exact}`
    ];

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
    };

    try {
        let saw403 = false;

        for (const url of candidateUrls) {
            const response = await fetchWithTimeout(url, { headers, redirect: 'follow' }, 8000);
            const html = await response.text();

            if (response.status === 403 || html.includes('Quick check')) {
                saw403 = true;
                continue;
            }

            if (response.status === 404 || !response.ok) continue;
            if (html.toLowerCase().includes('character not found')) continue;

            const charInfoIdx = html.indexOf('CHARACTER INFO');
            if (charInfoIdx !== -1) {
                const profileHtml = html.substring(charInfoIdx, charInfoIdx + 1200);
                const cleanProfile = profileHtml.replace(/<[^>]*>/g, ' ');
                const jobRole = detectJobRoleName(cleanProfile);
                if (jobRole) return { status: 'found', jobRole };
            }

            const cleanText = html.replace(/<[^>]*>/g, ' ');
            return { status: 'found', jobRole: detectJobRoleName(cleanText) };
        }

        if (saw403) {
            console.warn(`ClassicRank blocked request (403 Quick check) for ${characterName} — falling back to screenshot verification.`);
            return { status: 'blocked', jobRole: null };
        }

        return { status: 'not_found', jobRole: null };
    } catch (error) {
        console.error('ClassicRank Lookup Error:', error);
        return { status: 'blocked', jobRole: null };
    }
}

// 2. Cloud OCR via OCR.space (returns both parsed text & detected job)
async function parseScreenshot(imageUrl) {
    try {
        const apiKey = process.env.OCR_API_KEY || 'helloworld';
        const params = new URLSearchParams({
            apikey: apiKey,
            url: imageUrl,
            language: 'eng',
            isOverlayRequired: 'false',
            scale: 'true',
            OCREngine: '2'
        });

        const response = await fetchWithTimeout(
            `https://api.ocr.space/parse/imageurl?${params.toString()}`,
            {},
            10000
        );
        const data = await response.json();

        if (data.IsErroredOnProcessing || !data.ParsedResults?.[0]) {
            console.error('OCR.space API Error:', data.ErrorMessage || data);
            return { rawText: '', jobRole: null };
        }

        const rawText = data.ParsedResults[0].ParsedText || '';
        return { rawText, jobRole: detectJobRoleName(rawText) };
    } catch (error) {
        console.error('OCR Fetch Error:', error);
        return { rawText: '', jobRole: null };
    }
}

client.once('clientReady', async () => {
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

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('Defer Reply Timeout:', err);
        return;
    }

    try {
        const member = interaction.member;

        const jobRoleNames = ['cleric', 'mage', 'warrior', 'bowman', 'rogue'];
        const alreadyHasJob = member.roles.cache.some(r => jobRoleNames.includes(r.name.toLowerCase()));

        if (alreadyHasJob) {
            return interaction.editReply('❌ You are already verified and already possess a class role!');
        }

        const rawIgn = interaction.options.getString('character').trim();
        const ignKey = rawIgn.toLowerCase();
        const attachment = interaction.options.getAttachment('screenshot');

        if (!/^[a-zA-Z0-9]{4,12}$/.test(rawIgn)) {
            return interaction.editReply('❌ Invalid IGN. MapleStory names must be 4–12 letters or numbers with no spaces.');
        }

        if (claimedCharacters.has(ignKey) && claimedCharacters.get(ignKey) !== interaction.user.id) {
            return interaction.editReply(`❌ **${rawIgn}** has already been verified by another member in this server.`);
        }

        if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
            return interaction.editReply('❌ Please upload a valid image file (PNG or JPEG).');
        }

        // 1. Check ClassicRank (if not blocked by 403)
        console.log(`1. Checking ClassicRank for ${rawIgn}`);
        const trackerData = await getClassicRankData(rawIgn);

        if (trackerData.status === 'not_found') {
            return interaction.editReply(
                `❌ Could not find **${rawIgn}** on ClassicRank (\`classicrank.com/user/windia/${rawIgn}\`).\n` +
                `*Make sure your character has been scanned or uploaded to ClassicRank first!*`
            );
        }

        // 2. Read IGN & Job from screenshot via Cloud OCR
        console.log(`2. Running OCR on ${attachment.url}`);
        const ocrData = await parseScreenshot(attachment.url);

        // Verify the character name appears in the screenshot (prevents using someone else's screenshot)
        const normalizedOcr = ocrData.rawText.toLowerCase().replace(/\s+/g, '');
        if (!normalizedOcr.includes(ignKey)) {
            return interaction.editReply(
                `❌ **Name Mismatch:** Could not read **${rawIgn}** in your Character Info screenshot.\n` +
                `*Double-click your character in-game so the Character Info box clearly shows your name and job, then try again!*`
            );
        }

        // Strict Anti-Spoofing if ClassicRank returned a job
        if (trackerData.jobRole && ocrData.jobRole && trackerData.jobRole.toLowerCase() !== ocrData.jobRole.toLowerCase()) {
            return interaction.editReply(
                `❌ **Class Mismatch:** ClassicRank lists **${rawIgn}** as **${trackerData.jobRole}**, ` +
                `but your screenshot shows **${ocrData.jobRole}**.\n` +
                `*Please upload a screenshot matching your character's actual class.*`
            );
        }

        const detectedRoleName = trackerData.jobRole || ocrData.jobRole;
        const guild = interaction.guild;

        console.log(`3. Assigning roles/nickname for ${rawIgn} (Role: ${detectedRoleName || 'None'})`);
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
        console.error('Interaction Execution Error:', error);
        await interaction.editReply('❌ An unexpected error occurred while processing your verification.').catch(() => {});
    }
});

client.on('error', err => console.error('Discord Client Error:', err));
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('❌ Login Failed:', err));

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MapleStory Classic Verification Bot is online!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});
