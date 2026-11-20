async function getClassicRankData(characterName) {
    const encoded = encodeURIComponent(characterName);
    const candidateUrls = [
        `https://classicrank.com/user/windia/${encoded}`,
        `https://classicrank.com/user/zenith/${encoded}`,
        `https://classicrank.com/user/${encoded}`
    ];

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
    };

    try {
        let lastStatus = null;
        let lastSnippet = '';

        for (const url of candidateUrls) {
            const response = await fetchWithTimeout(url, { headers, redirect: 'follow' }, 8000);
            const html = await response.text();
            lastStatus = response.status;
            lastSnippet = html.slice(0, 250);

            if (!response.ok || response.status === 404) {
                continue;
            }

            if (html.toLowerCase().includes('character not found')) {
                continue;
            }

            const charInfoIdx = html.indexOf('CHARACTER INFO');
            if (charInfoIdx !== -1) {
                const profileHtml = html.substring(charInfoIdx, charInfoIdx + 1200);
                const cleanProfile = profileHtml.replace(/<[^>]*>/g, ' ');
                const jobRole = detectJobRoleName(cleanProfile);
                if (jobRole) return { exists: true, jobRole };
            }

            const cleanText = html.replace(/<[^>]*>/g, ' ');
            const jobRole = detectJobRoleName(cleanText);
            return { exists: true, jobRole };
        }

        console.warn(`ClassicRank miss for ${characterName} (last status: ${lastStatus}):`, lastSnippet);
        return { exists: false, jobRole: null };
    } catch (error) {
        console.error('ClassicRank Lookup Error:', error);
        return { exists: true, jobRole: null };
    }
}
