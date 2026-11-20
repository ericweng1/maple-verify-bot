const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, MessageFlags } = require('discord.js');
const http = require('http');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const claimedCharacters = new Map();

// Helper to prevent hanging requests on slow external APIs
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Maps MapleStory jobs/advancements to exact Discord role names
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

// 1. Fetch ClassicRank page across Windia/Zenith routes and extract job class
async function getClassicRankData(characterName) {
    const exact = encodeURIComponent(characterName);
    const lower = encodeURIComponent(characterName.toLowerCase());

    const candidateUrls = [
        `https://classicrank.com/user/windia/${exact}`,
        `https://classicrank.com/user/windia/${lower}`,
        `https://classicrank.com/user/zenith/${exact}`,
        `https://classicrank.com/user/${exact}`
    ];

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json'
    };

    try {
        let lastStatus = null;
        let lastUrl = '';
        let lastSnippet = '';

        for (const url of candidateUrls) {
            const response = await fetchWithTimeout(url, { headers, redirect: 'follow' }, 8000);
            const html = await response.text();
            lastStatus = response.status;
            lastUrl = response.url || url;
            lastSnippet = html.replace(/\s+/g, ' ').slice(0, 300);

            if (!response.ok || response.status === 404) {
                continue;
            }

            const lowerHtml = html.toLowerCase();
            if (lowerHtml.includes('character not found') || lowerHtml.includes('user not found')) {
                continue;
            }

            // Confirm the character's name actually appears in the response
            if (!lowerHtml.includes(characterName.toLowerCase())) {
                continue;
            }

            // 1) Try CHARACTER INFO section if server-rendered
            const charInfoIdx = html.toUpperCase().indexOf('CHARACTER INFO');
            if (charInfoIdx !== -1) {
                const profileHtml = html.substring(charInfoIdx, charInfoIdx + 1500);
                const cleanProfile = profileHtml.replace(/<[^>]*>/g, ' ');
                const jobRole = detectJobRoleName(cleanProfile);
                if (jobRole) return { exists: true, jobRole, profileUrl: lastUrl };
            }

            // 2) Try Next.js / embedded JSON payload around the character's name
            const nameIdx = lowerHtml.indexOf(characterName.toLowerCase());
            if (nameIdx !== -1) {
                const start = Math.max(0, nameIdx - 400);
                const windowText = html.substring(start, nameIdx + 800).replace(/<[^>]*>/g, ' ');
                const jobRole = detectJobRoleName(windowText);
                if (jobRole) return { exists: true, jobRole, profileUrl: lastUrl };
            }

            // 3) Fallback: strip scripts/styles so navbar links don't false-match, then scan visible text
            const visibleText = html
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]*>/g, ' ');
            const jobRole = detectJobRoleName(visibleText);

            return { exists: true, jobRole, profileUrl: lastUrl };
        }

        console.warn(`ClassicRank miss for ${characterName} (lastUrl: ${lastUrl}, status: ${lastStatus}):`, lastSnippet);
        return { exists: false, jobRole: null };
    } catch (error) {
        console.error('ClassicRank Lookup Error:', error);
        return { exists: true, jobRole: null };
    }
}

// 2. Cloud OCR via OCR.space (Uses 0 MB local RAM)
async function verifyScreenshotJob(imageUrl) {
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
            return null;
        }

        const parsedText = data.ParsedResults[0].ParsedText;
        return detectJobRoleName(parsedText);
    } catch (error) {
        console.error('OCR Fetch Error:', error);
        return null;
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

        // Block if user already has a class role
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

        // 1. Check ClassicRank profile & job
        console.log(`1. Checking ClassicRank for ${rawIgn}`);
        const trackerData = await getClassicRankData(rawIgn);
        if (!trackerData.exists) {
            return interaction.editReply(
                `❌ Could not find **${rawIgn}** on ClassicRank (\`classicrank.com/user/windia/${rawIgn}\`).\n` +
                `*Make sure your character has been scanned or uploaded to ClassicRank first!*`
            );
        }

        if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
            return interaction.editReply('❌ Please upload a valid image file (PNG or JPEG).');
        }

        // 2. Read job from screenshot via Cloud OCR
        console.log(`2. Running OCR on ${attachment.url}`);
        const screenshotJob = await verifyScreenshotJob(attachment.url);

        // 3. Strict Anti-Spoofing
        if (trackerData.jobRole && screenshotJob && trackerData.jobRole.toLowerCase() !== screenshotJob.toLowerCase()) {
            return interaction.editReply(
                `❌ **Class Mismatch:** ClassicRank lists **${rawIgn}** as **${trackerData.jobRole}**, ` +
                `but your screenshot shows **${screenshotJob}**.\n` +
                `*Please upload a screenshot matching your character's actual class.*`
            );
        }

        const detectedRoleName = trackerData.jobRole || screenshotJob;
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
