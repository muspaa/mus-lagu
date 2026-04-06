// api/search.js
// Menggunakan YouTube's Internal (Innertube) API - Tanpa Kuota & Tanpa API Key
// Versi ini TIDAK mengandung API Key apapun

export default async function handler(req, res) {
    // Set header untuk mengizinkan akses dari berbagai sumber
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const query = req.query.query;
    if (!query || query.trim() === '') {
        return res.status(400).json({ status: 'error', message: 'Parameter "query" diperlukan.' });
    }

    try {
        // Kirim POST request ke endpoint internal YouTube (TANPA API Key)
        const response = await fetch('https://www.youtube.com/youtubei/v1/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: 'WEB',
                        clientVersion: '2.20240101',
                        hl: 'id'
                    }
                },
                query: query,
                part: 'snippet'
            })
        });

        const data = await response.json();

        // Parsing dan format data dari response Innertube
        if (data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents) {
            const rawContents = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
            const videos = [];

            for (const content of rawContents) {
                const videoRenderer = content.itemSectionRenderer?.contents?.[0]?.videoRenderer;
                if (videoRenderer && videoRenderer.videoId) {
                    videos.push({
                        videoId: videoRenderer.videoId,
                        title: videoRenderer.title?.runs?.[0]?.text || 'No Title',
                        artist: videoRenderer.ownerText?.runs?.[0]?.text || 'Unknown Artist',
                        thumbnail: videoRenderer.thumbnail?.thumbnails?.[0]?.url || '',
                        img: videoRenderer.thumbnail?.thumbnails?.pop()?.url || videoRenderer.thumbnail?.thumbnails?.[0]?.url || '',
                    });
                }
            }

            if (videos.length > 0) {
                return res.status(200).json({ status: 'success', data: videos });
            }
        }
        
        return res.status(404).json({ status: 'error', message: 'Tidak ada video ditemukan.' });

    } catch (error) {
        console.error('Innertube API Error:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Terjadi kesalahan pada server.' });
    }
                }
