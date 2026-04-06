export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    const query = req.query.query;
    
    if (!query || query.trim() === '') {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameter query diperlukan' 
        });
    }
    
    // AMAN - ambil dari environment variable
    const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
    
    if (!YOUTUBE_API_KEY) {
        return res.status(500).json({ 
            status: 'error', 
            message: 'API Key not configured' 
        });
    }
    
    try {
        const response = await fetch(
            `https://www.googleapis.com/youtube/v3/search?` +
            `part=snippet&maxResults=50&q=${encodeURIComponent(query)}&type=video&key=${YOUTUBE_API_KEY}`
        );
        
        const data = await response.json();
        
        if (data.error) {
            return res.status(500).json({ 
                status: 'error', 
                message: data.error.message 
            });
        }
        
        const formattedData = (data.items || []).map(item => ({
            videoId: item.id.videoId,
            title: item.snippet.title,
            artist: item.snippet.channelTitle,
            thumbnail: item.snippet.thumbnails.medium.url,
            img: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium.url
        }));
        
        return res.status(200).json({ 
            status: 'success', 
            data: formattedData 
        });
        
    } catch (error) {
        return res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
          }
