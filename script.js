// --- 0. NAVIGASI BACK, SPLASH SCREEN & PWA AUTO-UPDATE ---
window.addEventListener('load', () => {
    history.replaceState({ view: 'home' }, '', '#home');

    if (!sessionStorage.getItem('splashShown')) {
        setTimeout(() => {
            const splash = document.getElementById('splash-screen');
            if(splash) {
                splash.style.opacity = '0';
                setTimeout(() => { 
                    splash.style.display = 'none'; 
                    splash.remove(); 
                }, 500);
            }
        }, 7500);
        sessionStorage.setItem('splashShown', 'true');
    } else {
        const splash = document.getElementById('splash-screen');
        if(splash) {
            splash.style.display = 'none';
            splash.remove();
        }
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(reg => {
            reg.update();
        }).catch(err => console.log('PWA error:', err));

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
                refreshing = true;
                window.location.reload(); 
            }
        });
    }
    
    loadHomeData();
    renderSearchCategories();
});

let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); 
    deferredPrompt = e;
    
    const installBtn = document.getElementById('installAppBtn');
    if(installBtn) {
        installBtn.style.display = 'flex'; 
        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if(outcome === 'accepted') installBtn.style.display = 'none'; 
                deferredPrompt = null;
            }
        });
    }
});

window.addEventListener('appinstalled', () => {
    document.getElementById('installAppBtn').style.display = 'none';
    deferredPrompt = null;
});

window.addEventListener('popstate', (e) => {
    if (e.state && e.state.view) {
        switchView(e.state.view, false);
    } else {
        switchView('home', false);
    }
});

// --- 1. INDEXEDDB SETUP ---
let db;
const request = indexedDB.open("SannMusicDB", 2);
request.onupgradeneeded = function(e) {
    db = e.target.result;
    if(!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    if(!db.objectStoreNames.contains('liked_songs')) db.createObjectStore('liked_songs', { keyPath: 'videoId' });
    if(!db.objectStoreNames.contains('favorite_songs')) db.createObjectStore('favorite_songs', { keyPath: 'videoId' });
    if(!db.objectStoreNames.contains('history_songs')) db.createObjectStore('history_songs', { keyPath: 'timestamp' });
    if(!db.objectStoreNames.contains('offline_songs')) db.createObjectStore('offline_songs', { keyPath: 'videoId' });
};
request.onsuccess = function(e) { db = e.target.result; renderLibraryUI(); };

// --- 2. GLOBAL VARIABLES ---
let ytPlayer;
let isPlaying = false;
let currentTrack = null;
let progressInterval;

let isShuffle = false;
let repeatState = 0; 
let currentRepeatCount = 0;
let currentPlayContext = null; 
let sleepTimerTimeout = null;

let isEditMode = false;
let selectedTracksForDelete = new Set();

// --- 3. YOUTUBE PLAYER ---
function onYouTubeIframeAPIReady() {
    ytPlayer = new YT.Player('youtube-player', {
        height: '0', width: '0',
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) { console.log("Player Ready"); }

function onPlayerStateChange(event) {
    const mainPlayBtn = document.getElementById('mainPlayBtn');
    const miniPlayBtn = document.getElementById('miniPlayBtn');
    const playIconPath = "M8 5v14l11-7z";
    const pauseIconPath = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";

    if (event.data == YT.PlayerState.PLAYING) {
        isPlaying = true;
        mainPlayBtn.innerHTML = `<path d="${pauseIconPath}"></path>`;
        miniPlayBtn.innerHTML = `<path d="${pauseIconPath}"></path>`;
        startProgressBar();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    } else if (event.data == YT.PlayerState.PAUSED) {
        isPlaying = false;
        mainPlayBtn.innerHTML = `<path d="${playIconPath}"></path>`;
        miniPlayBtn.innerHTML = `<path d="${playIconPath}"></path>`;
        stopProgressBar();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    } else if (event.data == YT.PlayerState.ENDED) {
        isPlaying = false;
        mainPlayBtn.innerHTML = `<path d="${playIconPath}"></path>`;
        miniPlayBtn.innerHTML = `<path d="${playIconPath}"></path>`;
        stopProgressBar();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
        handleTrackEnded();
    }
}

function handleTrackEnded() {
    if (repeatState === 1) {
        if (currentRepeatCount < 1) { currentRepeatCount++; ytPlayer.seekTo(0); ytPlayer.playVideo(); return; }
        else { currentRepeatCount = 0; }
    } else if (repeatState === 2) {
        if (currentRepeatCount < 3) { currentRepeatCount++; ytPlayer.seekTo(0); ytPlayer.playVideo(); return; }
        else { currentRepeatCount = 0; }
    } else if (repeatState === 3) {
        ytPlayer.seekTo(0); ytPlayer.playVideo(); return;
    }
    playNextTrack(false);
}

function playNextTrack(isManualClick = true) {
    if(isManualClick) currentRepeatCount = 0;

    if (currentPlayContext && currentPlayContext.data && currentPlayContext.data.length > 0) {
        if (isShuffle) {
            const randomTrack = currentPlayContext.data[Math.floor(Math.random() * currentPlayContext.data.length)];
            const trackData = encodeURIComponent(JSON.stringify(randomTrack)).replace(/'/g, "%27");
            playMusic(randomTrack.videoId, trackData, currentPlayContext);
        } else {
            let currentIndex = currentPlayContext.data.findIndex(t => t.videoId === currentTrack.videoId);
            if (currentIndex !== -1 && currentIndex + 1 < currentPlayContext.data.length) {
                const nextTrack = currentPlayContext.data[currentIndex + 1];
                const trackData = encodeURIComponent(JSON.stringify(nextTrack)).replace(/'/g, "%27");
                playMusic(nextTrack.videoId, trackData, currentPlayContext);
            } else {
                playNextSimilarSong(); 
            }
        }
    } else {
        playNextSimilarSong();
    }
}

async function playNextSimilarSong() {
    if (!currentTrack) return;
    try {
        const response = await fetch(`/api/search?query=${encodeURIComponent(currentTrack.artist + " official audio")}`);
        const result = await response.json();
        if (result.status === 'success' && result.data && result.data.length > 0) {
            const relatedSongs = result.data.filter(t => t.videoId !== currentTrack.videoId);
            if (relatedSongs.length > 0) {
                const nextTrack = relatedSongs[Math.floor(Math.random() * relatedSongs.length)];
                let img = nextTrack.thumbnail || nextTrack.img || 'https://placehold.co/140x140/282828/FFFFFF?text=Music';
                img = getHighResImage(img);
                const artist = nextTrack.artist || 'Unknown';
                const trackData = encodeURIComponent(JSON.stringify({videoId: nextTrack.videoId, title: nextTrack.title, artist: artist, img: img})).replace(/'/g, "%27");
                playMusic(nextTrack.videoId, trackData, null); 
            }
        }
    } catch (error) {}
}

function addToHistory(track) {
    if(!db) return;
    const tx = db.transaction("history_songs", "readwrite");
    const store = tx.objectStore("history_songs");
    const newTrack = { ...track, timestamp: Date.now() };
    store.put(newTrack);
    
    const countReq = store.count();
    countReq.onsuccess = function() {
        if(countReq.result > 50) {
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = function(e) {
                const cursor = e.target.result;
                if(cursor) { cursor.delete(); }
            }
        }
    }
}

function playMusic(videoId, encodedTrackData, contextData = null) {
    if(currentTrack && currentTrack.videoId !== videoId) currentRepeatCount = 0;
    
    currentTrack = JSON.parse(decodeURIComponent(encodedTrackData));
    currentPlayContext = contextData; 
    
    addToHistory(currentTrack);
    checkIfLiked(currentTrack.videoId);

    const miniPlayer = document.getElementById('miniPlayer');
    if(miniPlayer) miniPlayer.style.display = 'flex';
    const miniPlayerImg = document.getElementById('miniPlayerImg');
    if(miniPlayerImg) miniPlayerImg.src = currentTrack.img;
    const miniPlayerTitle = document.getElementById('miniPlayerTitle');
    if(miniPlayerTitle) miniPlayerTitle.innerText = currentTrack.title;
    const miniPlayerArtist = document.getElementById('miniPlayerArtist');
    if(miniPlayerArtist) miniPlayerArtist.innerText = currentTrack.artist;

    const playerArt = document.getElementById('playerArt');
    if(playerArt) playerArt.src = currentTrack.img;
    const playerTitle = document.getElementById('playerTitle');
    if(playerTitle) playerTitle.innerText = currentTrack.title;
    const playerArtist = document.getElementById('playerArtist');
    if(playerArtist) playerArtist.innerText = currentTrack.artist;
    const playerBg = document.getElementById('playerBg');
    if(playerBg) playerBg.style.backgroundImage = `url('${currentTrack.img}')`;

    updateMediaSession();

    if (ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(videoId);
    
    const progressBar = document.getElementById('progressBar');
    if(progressBar) progressBar.value = 0;
    const miniProgressBar = document.getElementById('miniProgressBar');
    if(miniProgressBar) miniProgressBar.style.width = '0%';
    const currentTime = document.getElementById('currentTime');
    if(currentTime) currentTime.innerText = "0:00";
    const totalTime = document.getElementById('totalTime');
    if(totalTime) totalTime.innerText = "0:00";
}

function togglePlay() {
    if (!ytPlayer) return;
    if (isPlaying) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
}

function expandPlayer() { 
    const modal = document.getElementById('playerModal');
    if(modal) modal.style.display = 'flex'; 
}
function minimizePlayer() { 
    const modal = document.getElementById('playerModal');
    if(modal) modal.style.display = 'none'; 
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function startProgressBar() {
    stopProgressBar();
    progressInterval = setInterval(() => {
        if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getDuration) {
            const current = ytPlayer.getCurrentTime();
            const duration = ytPlayer.getDuration();
            if (duration > 0) {
                const percent = (current / duration) * 100;
                
                const progressBar = document.getElementById('progressBar');
                if(progressBar) {
                    progressBar.value = percent;
                    progressBar.style.background = `linear-gradient(to right, white ${percent}%, rgba(255,255,255,0.2) ${percent}%)`;
                }
                
                const miniProgressBar = document.getElementById('miniProgressBar');
                if(miniProgressBar) miniProgressBar.style.width = `${percent}%`;

                const currentTime = document.getElementById('currentTime');
                if(currentTime) currentTime.innerText = formatTime(current);
                const totalTime = document.getElementById('totalTime');
                if(totalTime) totalTime.innerText = formatTime(duration);
            }
        }
    }, 1000);
}

function stopProgressBar() { clearInterval(progressInterval); }

function seekTo(value) {
    if (ytPlayer && ytPlayer.getDuration) {
        const duration = ytPlayer.getDuration();
        const seekTime = (value / 100) * duration;
        ytPlayer.seekTo(seekTime, true);
        const percent = value;
        const progressBar = document.getElementById('progressBar');
        if(progressBar) {
            progressBar.style.background = `linear-gradient(to right, white ${percent}%, rgba(255,255,255,0.2) ${percent}%)`;
        }
        const miniProgressBar = document.getElementById('miniProgressBar');
        if(miniProgressBar) miniProgressBar.style.width = `${percent}%`;
    }
}

// --- SHUFFLE & REPEAT ---
function toggleShuffle() {
    isShuffle = !isShuffle;
    const btn1 = document.getElementById('btnShuffle');
    const btn2 = document.getElementById('btnPlaylistShuffle');
    const color = isShuffle ? 'var(--spotify-green)' : 'var(--text-sub)';
    if (btn1) btn1.style.fill = color;
    if (btn2) btn2.style.fill = color;
    showToast(isShuffle ? "Acak dihidupkan" : "Acak dimatikan");
}

function toggleRepeat() {
    repeatState = (repeatState + 1) % 4;
    const btn = document.getElementById('btnRepeat');
    const badge = document.getElementById('repeatBadge');
    
    if (repeatState === 0) {
        if(btn) btn.style.fill = 'var(--text-sub)';
        if(badge) badge.style.display = 'none';
        showToast("Ulangi dimatikan");
    } else {
        if(btn) btn.style.fill = 'var(--spotify-green)';
        if(badge) {
            badge.style.display = 'block';
            if (repeatState === 1) { badge.innerText = "1x"; showToast("Ulangi 1 kali"); }
            if (repeatState === 2) { badge.innerText = "3x"; showToast("Ulangi 3 kali"); }
            if (repeatState === 3) { badge.innerText = "∞"; showToast("Ulangi terus"); }
        }
    }
}

// --- DOWNLOAD OFFLINE LOGIC ---
function downloadCurrentTrack() {
    if(!currentTrack) return;
    showToast("Menyiapkan metadata lagu untuk offline...");
    const tx = db.transaction("offline_songs", "readwrite");
    tx.objectStore("offline_songs").put(currentTrack);
    setTimeout(() => { showToast("Selesai! Tersedia di Unduhan"); renderLibraryUI(); }, 2000);
    closePlayerMenuModal();
}

function downloadCurrentPlaylist() {
    if(!currentPlaylistTracks || currentPlaylistTracks.length === 0) return;
    showToast(`Menyiapkan ${currentPlaylistTracks.length} lagu untuk offline...`);
    const tx = db.transaction("offline_songs", "readwrite");
    const store = tx.objectStore("offline_songs");
    currentPlaylistTracks.forEach(t => store.put(t));
    setTimeout(() => { showToast("Selesai! Tersedia di Unduhan"); renderLibraryUI(); }, 3000);
}

// --- MENU TITIK TIGA ---
function openPlayerMenuModal() {
    if(!currentTrack) return;
    const menuArt = document.getElementById('menuArt');
    if(menuArt) menuArt.src = currentTrack.img;
    const menuTitle = document.getElementById('menuTitle');
    if(menuTitle) menuTitle.innerText = currentTrack.title;
    const menuArtist = document.getElementById('menuArtist');
    if(menuArtist) menuArtist.innerText = currentTrack.artist;
    const modal = document.getElementById('playerMenuModal');
    if(modal) modal.style.display = 'flex';
}

function closePlayerMenuModal() { 
    const modal = document.getElementById('playerMenuModal');
    if(modal) modal.style.display = 'none'; 
}

function setSleepTimer() {
    const minutes = prompt("Matikan musik otomatis dalam berapa menit?", "15");
    if(minutes != null && !isNaN(minutes) && minutes > 0) {
        if(sleepTimerTimeout) clearTimeout(sleepTimerTimeout);
        sleepTimerTimeout = setTimeout(() => {
            if(ytPlayer && isPlaying) ytPlayer.pauseVideo();
            showToast("Musik dimatikan (Sleep Timer)");
        }, minutes * 60000);
        showToast(`Timer diatur ${minutes} menit`);
    }
    closePlayerMenuModal();
}

function toggleFavoritLagu() {
    if(!currentTrack) return;
    const tx = db.transaction("favorite_songs", "readwrite");
    const store = tx.objectStore("favorite_songs");
    const getReq = store.get(currentTrack.videoId);
    getReq.onsuccess = function() {
        if(getReq.result) { store.delete(currentTrack.videoId); showToast("Dihapus dari Favorit"); } 
        else { store.put(currentTrack); showToast("Ditambahkan ke Favorit"); }
        renderLibraryUI();
        closePlayerMenuModal();
    };
}

function shareLagu() {
    if(navigator.share && currentTrack) {
        navigator.share({
            title: currentTrack.title,
            text: `Dengarkan ${currentTrack.title} oleh ${currentTrack.artist} di Soundify!`,
            url: window.location.href
        }).catch(err => console.log('Share gagal', err));
    } else {
        showToast("Fitur bagi tidak didukung di browser ini");
    }
    closePlayerMenuModal();
}

// --- LIKE SYSTEM ---
function checkIfLiked(videoId) {
    if(!db) return;
    const tx = db.transaction("liked_songs", "readonly");
    const request = tx.objectStore("liked_songs").get(videoId);
    request.onsuccess = function() {
        const btnSvg = document.getElementById('btnLikeSong');
        if(btnSvg) {
            if(request.result) {
                btnSvg.style.fill = '#1db954';
                btnSvg.style.stroke = '#1db954';
            } else {
                btnSvg.style.fill = 'transparent';
                btnSvg.style.stroke = 'white';
            }
        }
    };
}

function toggleLike() {
    if(!currentTrack) return;
    const tx = db.transaction("liked_songs", "readwrite");
    const store = tx.objectStore("liked_songs");
    const getReq = store.get(currentTrack.videoId);

    getReq.onsuccess = function() {
        const btnSvg = document.getElementById('btnLikeSong');
        if(getReq.result) {
            store.delete(currentTrack.videoId);
            if(btnSvg) {
                btnSvg.style.fill = 'transparent';
                btnSvg.style.stroke = 'white';
            }
            showToast("Dihapus dari Suka");
        } else {
            store.put(currentTrack);
            if(btnSvg) {
                btnSvg.style.fill = '#1db954';
                btnSvg.style.stroke = '#1db954';
            }
            showToast("Ditambahkan ke Suka");
        }
        renderLibraryUI();
    };
}

// --- UTILS & TOAST ---
let toastTimeout;
function showToast(message) {
    const toast = document.getElementById('customToast');
    if(!toast) return;
    toast.innerText = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

function updateMediaSession() {
    if ('mediaSession' in navigator && currentTrack) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: currentTrack.title,
            artist: currentTrack.artist,
            artwork: [{ src: currentTrack.img, sizes: '512x512', type: 'image/png' }]
        });
        navigator.mediaSession.setActionHandler('play', function() { togglePlay(); });
        navigator.mediaSession.setActionHandler('pause', function() { togglePlay(); });
        navigator.mediaSession.setActionHandler('nexttrack', function() { playNextTrack(true); });
    }
}

// Switch View dengan PUSH STATE
function switchView(viewName, pushState = true) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    const activeView = document.getElementById('view-' + viewName);
    if(activeView) activeView.classList.add('active');
    
    const navItems = document.querySelectorAll('.bottom-nav .nav-item');
    navItems.forEach(nav => nav.classList.remove('active'));
    if(viewName === 'home') navItems[0]?.classList.add('active');
    else if (viewName === 'search') navItems[1]?.classList.add('active');
    else if (viewName === 'library') { navItems[2]?.classList.add('active'); renderLibraryUI(); }
    else if (viewName === 'developer') navItems[3]?.classList.add('active'); 
    
    window.scrollTo(0,0);

    if (pushState) {
        history.pushState({ view: viewName }, '', `#${viewName}`);
    }
}

const dotsSvg = '<svg class="dots-icon" viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path></svg>';

function getHighResImage(url) {
    if (!url) return url;
    if (url.match(/=w\d+-h\d+/)) return url.replace(/=w\d+-h\d+[^&]*/g, '=w512-h512-l90-rj');
    return url;
}

function createListHTML(track, context = null) {
    let img = track.thumbnail || track.img || 'https://placehold.co/48x48/282828/FFFFFF?text=Music';
    img = getHighResImage(img); 
    const artist = track.artist || 'Unknown';
    const trackData = encodeURIComponent(JSON.stringify({videoId: track.videoId, title: track.title, artist: artist, img: img})).replace(/'/g, "%27");
    const ctxString = context ? encodeURIComponent(JSON.stringify(context)).replace(/'/g, "%27") : 'null';
    
    return `
        <div class="v-item" id="item-${track.videoId}">
            <input type="checkbox" class="v-checkbox" onchange="handleCheckDelete('${track.videoId}', this.checked)">
            <img src="${img}" class="v-img" onclick="playMusic('${track.videoId}', '${trackData}', ${ctxString !== 'null' ? `JSON.parse(decodeURIComponent('${ctxString}'))` : 'null'})" onerror="this.src='https://placehold.co/48x48/282828/FFFFFF?text=Music'">
            <div class="v-info" onclick="playMusic('${track.videoId}', '${trackData}', ${ctxString !== 'null' ? `JSON.parse(decodeURIComponent('${ctxString}'))` : 'null'})">
                <div class="v-title">${escapeHtml(track.title)}</div>
                <div class="v-sub">${escapeHtml(artist)}</div>
            </div>
            <div class="dots-container" onclick="playMusic('${track.videoId}', '${trackData}', ${ctxString !== 'null' ? `JSON.parse(decodeURIComponent('${ctxString}'))` : 'null'}); setTimeout(openPlayerMenuModal, 500)">
                ${dotsSvg}
            </div>
        </div>
    `;
}

function createCardHTML(track, isArtist = false) {
    let img = track.thumbnail || track.img || 'https://placehold.co/140x140/282828/FFFFFF?text=Music';
    img = getHighResImage(img); 
    const artist = track.artist || 'Unknown';
    const trackData = encodeURIComponent(JSON.stringify({videoId: track.videoId, title: track.title, artist: artist, img: img})).replace(/'/g, "%27");
    const clickAction = isArtist ? `openArtistView('${escapeHtml(track.title).replace(/'/g, "\\'")}')` : `playMusic('${track.videoId}', '${trackData}', null)`;
    const imgClass = isArtist ? 'h-img artist-img' : 'h-img';

    return `
        <div class="h-card" onclick="${clickAction}">
            <img src="${img}" class="${imgClass}" onerror="this.src='https://placehold.co/140x140/282828/FFFFFF?text=Music'">
            <div class="h-title">${escapeHtml(track.title)}</div>
            <div class="h-sub">${isArtist ? 'Artis' : escapeHtml(artist)}</div>
        </div>
    `;
}

// Fungsi helper untuk mengamankan HTML
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// --- DATA FETCHING YANG SUDAH DIPERBAIKI ---
let homeDisplayedVideoIds = new Set();

// Fungsi fetch yang aman (tidak merusak yang lain jika gagal)
async function fetchAndRenderSafe(query, containerId, formatType, isArtist = false) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // Tampilkan loading
    container.innerHTML = '<div style="color:var(--text-sub); font-size: 13px;">⏳ Memuat musik...</div>';
    
    try {
        const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
        const result = await response.json();
        
        if (result.status === 'success' && result.data && result.data.length > 0) {
            // Ambil 6 lagu saja
            const limit = 6;
            const limitedData = result.data.slice(0, limit);
            
            let html = '';
            for (const track of limitedData) {
                // Hindari duplikasi di home (kecuali untuk list)
                if (formatType === 'list' || !homeDisplayedVideoIds.has(track.videoId)) {
                    if (formatType !== 'list') {
                        homeDisplayedVideoIds.add(track.videoId);
                    }
                    html += formatType === 'list' ? createListHTML(track) : createCardHTML(track, isArtist);
                }
            }
            
            if (html) {
                container.innerHTML = html;
            } else {
                container.innerHTML = '<div style="color:var(--text-sub); font-size: 13px;">🎵 Tidak ada lagu</div>';
            }
        } else {
            container.innerHTML = '<div style="color:var(--text-sub); font-size: 13px;">🎵 Tidak ada lagu</div>';
        }
    } catch (error) {
        console.error(`Error loading ${query}:`, error);
        container.innerHTML = '<div style="color:var(--text-sub); font-size: 13px;">⚠️ Gagal memuat</div>';
    }
}

// Fungsi untuk memuat semua data home
async function loadHomeData() {
    homeDisplayedVideoIds.clear();
    
    // Daftar kategori yang akan dimuat
    const categories = [
        { query: 'lagu indonesia hits terbaru', containerId: 'recentList', formatType: 'list', isArtist: false },
        { query: 'lagu pop indonesia rilis terbaru', containerId: 'rowAnyar', formatType: 'card', isArtist: false },
        { query: 'lagu ceria gembira semangat', containerId: 'rowGembira', formatType: 'card', isArtist: false },
        { query: 'top 50 indonesia', containerId: 'rowCharts', formatType: 'card', isArtist: false },
        { query: 'lagu galau sedih indonesia', containerId: 'rowGalau', formatType: 'card', isArtist: false },
        { query: 'lagu viral terbaru 2026', containerId: 'rowBaru', formatType: 'card', isArtist: false },
        { query: 'lagu tiktok viral', containerId: 'rowTiktok', formatType: 'card', isArtist: false },
        { query: 'penyanyi pop indonesia', containerId: 'rowArtists', formatType: 'card', isArtist: true }
    ];
    
    // Muat semua kategori secara paralel
    const promises = categories.map(cat => 
        fetchAndRenderSafe(cat.query, cat.containerId, cat.formatType, cat.isArtist)
    );
    
    await Promise.allSettled(promises);
    console.log('Home data loading completed');
}

function renderSearchCategories() {
    const categories = [
        { title: 'Dibuat Untuk Kamu', color: '#8d67ab', img: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=100&q=80' },
        { title: 'Rilis Mendatang', color: '#188653', img: 'https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=100&q=80' },
        { title: 'Pop', color: '#477d95', img: 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=100&q=80' },
        { title: 'Musik Indonesia', color: '#e8115b', img: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=100&q=80' }
    ];
    let html = '';
    categories.forEach(cat => { 
        html += `<div class="category-card" style="background-color: ${cat.color};">
                    <div class="category-title">${cat.title}</div>
                    <img src="${cat.img}" class="category-img" onerror="this.src='https://placehold.co/100x100/333/white?text=Music'">
                </div>`; 
    });
    const categoryGrid = document.getElementById('categoryGrid');
    if(categoryGrid) categoryGrid.innerHTML = html;
}

let searchTimeout;
const searchInput = document.getElementById('searchInput');
if(searchInput) {
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        if (query.length === 0) {
            const searchCategoriesUI = document.getElementById('searchCategoriesUI');
            const searchResultsUI = document.getElementById('searchResultsUI');
            if(searchCategoriesUI) searchCategoriesUI.style.display = 'block';
            if(searchResultsUI) searchResultsUI.style.display = 'none';
            return;
        }
        const searchCategoriesUI = document.getElementById('searchCategoriesUI');
        const searchResultsUI = document.getElementById('searchResultsUI');
        if(searchCategoriesUI) searchCategoriesUI.style.display = 'none';
        if(searchResultsUI) searchResultsUI.style.display = 'block';

        searchTimeout = setTimeout(async () => {
            const searchResults = document.getElementById('searchResults');
            if(searchResults) searchResults.innerHTML = '<div style="color:var(--text-sub); text-align:center;">🔍 Mencari musik...</div>';
            try {
                const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
                const result = await response.json();
                if (result.status === 'success' && result.data) {
                    let html = '';
                    result.data.forEach(t => html += createListHTML(t));
                    if(searchResults) searchResults.innerHTML = html;
                } else {
                    if(searchResults) searchResults.innerHTML = '<div style="color:var(--text-sub); text-align:center;">🎵 Tidak ada lagu ditemukan</div>';
                }
            } catch (error) {
                if(searchResults) searchResults.innerHTML = '<div style="color:var(--text-sub); text-align:center;">⚠️ Gagal mencari. Coba lagi.</div>';
            }
        }, 600);
    });
}

async function openArtistView(artistName) {
    const artistNameDisplay = document.getElementById('artistNameDisplay');
    if(artistNameDisplay) artistNameDisplay.innerText = artistName;
    const artistTracksContainer = document.getElementById('artistTracksContainer');
    if(artistTracksContainer) artistTracksContainer.innerHTML = '<div style="color:var(--text-sub); text-align:center;">Memuat lagu artis...</div>';
    switchView('artist');
    try {
        const response = await fetch(`/api/search?query=${encodeURIComponent(artistName + " official audio")}`);
        const result = await response.json();
        if (result.status === 'success' && result.data) {
            let html = '';
            let ctx = { type: 'artist', data: result.data };
            result.data.forEach(track => { html += createListHTML(track, ctx); });
            if(artistTracksContainer) artistTracksContainer.innerHTML = html;
            
            if(result.data.length > 0) {
                const firstTrack = result.data[0];
                let img = firstTrack.thumbnail || firstTrack.img || 'https://placehold.co/48x48/282828/FFFFFF?text=Music';
                img = getHighResImage(img);
                const trackData = encodeURIComponent(JSON.stringify({videoId: firstTrack.videoId, title: firstTrack.title, artist: firstTrack.artist || 'Unknown', img: img})).replace(/'/g, "%27");
                const ctxString = encodeURIComponent(JSON.stringify(ctx)).replace(/'/g, "%27");
                const artistPlayBtn = document.querySelector('.artist-play-btn');
                if(artistPlayBtn) {
                    artistPlayBtn.setAttribute('onclick', `playMusic('${firstTrack.videoId}', '${trackData}', JSON.parse(decodeURIComponent('${ctxString}')))`);
                }
            }
        }
    } catch(e) {
        console.error('Artist view error:', e);
    }
}

function renderLibraryUI() {
    if(!db) return;
    const container = document.getElementById('libraryContainer');
    if(!container) return;
    let html = '';

    const txL = db.transaction("liked_songs", "readonly");
    const reqL = txL.objectStore("liked_songs").getAll();
    reqL.onsuccess = function() {
        const likedCount = reqL.result.length;
        html += `
            <div class="lib-item" onclick="openPlaylistView('liked')">
                <div class="lib-item-img liked">
                    <svg viewBox="0 0 24 24" style="fill:white; width:28px; height:28px;"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path></svg>
                </div>
                <div class="lib-item-info">
                    <div class="lib-item-title">Suka</div>
                    <div class="lib-item-sub">Koleksi • ${likedCount} lagu</div>
                </div>
            </div>
        `;
        
        const txF = db.transaction("favorite_songs", "readonly");
        const reqF = txF.objectStore("favorite_songs").getAll();
        reqF.onsuccess = function() {
            const favCount = reqF.result.length;
            html += `
                <div class="lib-item" onclick="openPlaylistView('favorite')">
                    <div class="lib-item-img fav">
                        <svg viewBox="0 0 24 24" style="fill:white; width:28px; height:28px;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"></path></svg>
                    </div>
                    <div class="lib-item-info">
                        <div class="lib-item-title">Favorit</div>
                        <div class="lib-item-sub">Koleksi • ${favCount} lagu</div>
                    </div>
                </div>
            `;

            const txH = db.transaction("history_songs", "readonly");
            const reqH = txH.objectStore("history_songs").getAll();
            reqH.onsuccess = function() {
                const historyData = reqH.result.sort((a,b) => b.timestamp - a.timestamp);
                const histCount = historyData.length;
                html += `
                    <div class="lib-item" onclick="openPlaylistView('history')">
                        <div class="lib-item-img hist">
                            <svg viewBox="0 0 24 24" style="fill:white; width:28px; height:28px;"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"></path></svg>
                        </div>
                        <div class="lib-item-info">
                            <div class="lib-item-title">Histori Putar</div>
                            <div class="lib-item-sub">Otomatis • ${histCount} lagu</div>
                        </div>
                    </div>
                `;

                const txO = db.transaction("offline_songs", "readonly");
                const reqO = txO.objectStore("offline_songs").getAll();
                reqO.onsuccess = function() {
                    const offCount = reqO.result.length;
                    html += `
                        <div class="lib-item" onclick="openPlaylistView('offline')">
                            <div class="lib-item-img off">
                                <svg viewBox="0 0 24 24" style="fill:white; width:28px; height:28px;"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>
                            </div>
                            <div class="lib-item-info">
                                <div class="lib-item-title">Unduhan (Offline)</div>
                                <div class="lib-item-sub">Memori Perangkat • ${offCount} lagu</div>
                            </div>
                        </div>
                    `;

                    const txP = db.transaction("playlists", "readonly");
                    const reqP = txP.objectStore("playlists").getAll();
                    reqP.onsuccess = function() {
                        const playlists = reqP.result;
                        playlists.forEach(p => {
                            html += `
                                <div class="lib-item" onclick="openPlaylistView('${p.id}')">
                                    <img src="${p.img || 'https://via.placeholder.com/120?text=+'}" class="lib-item-img" onerror="this.src='https://via.placeholder.com/120?text=+'">
                                    <div class="lib-item-info">
                                        <div class="lib-item-title">${escapeHtml(p.name)}</div>
                                        <div class="lib-item-sub">Playlist • Kamu</div>
                                    </div>
                                </div>
                            `;
                        });
                        container.innerHTML = html;
                    };
                };
            };
        };
    };
}

let currentPlaylistTracks = [];
let activePlaylistId = null;

const pathHeart = "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
const pathStar = "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";
const pathClock = "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z";
const pathDownload = "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z";

function setPlaylistCover(gradient, svgPath) {
    const box = document.getElementById('playlistImageContainer');
    const img = document.getElementById('playlistImageDisplay');
    const svg = document.getElementById('playlistSvgDisplay');
    if(!box) return;
    
    box.style.background = gradient;
    if(img) img.style.display = 'none';
    if(svg) {
        svg.style.display = 'block';
        svg.innerHTML = `<path d="${svgPath}"></path>`;
    }
}

function openPlaylistView(id) {
    activePlaylistId = id;
    isEditMode = false;
    const bulkBar = document.getElementById('bulkActionBar');
    if(bulkBar) bulkBar.style.display = 'none';
    switchView('playlist');
    const container = document.getElementById('playlistTracksContainer');
    if(container) container.innerHTML = '<div style="color:var(--text-sub); text-align:center;">Memuat daftar lagu...</div>';

    const playlistNameDisplay = document.getElementById('playlistNameDisplay');
    if(!playlistNameDisplay) return;

    if (id === 'liked') {
        playlistNameDisplay.innerText = "Suka";
        setPlaylistCover('linear-gradient(135deg, #450af5, #c4efd9)', pathHeart);
        const tx = db.transaction("liked_songs", "readonly");
        const req = tx.objectStore("liked_songs").getAll();
        req.onsuccess = () => { processPlaylistData(req.result, 'liked'); };
    } 
    else if (id === 'favorite') {
        playlistNameDisplay.innerText = "Favorit";
        setPlaylistCover('linear-gradient(135deg, #e1118c, #f5a623)', pathStar);
        const tx = db.transaction("favorite_songs", "readonly");
        const req = tx.objectStore("favorite_songs").getAll();
        req.onsuccess = () => { processPlaylistData(req.result, 'favorite'); };
    }
    else if (id === 'history') {
        playlistNameDisplay.innerText = "Histori Putar";
        setPlaylistCover('linear-gradient(135deg, #1e3264, #477d95)', pathClock);
        const tx = db.transaction("history_songs", "readonly");
        const req = tx.objectStore("history_songs").getAll();
        req.onsuccess = () => { 
            const histData = req.result.sort((a,b) => b.timestamp - a.timestamp);
            processPlaylistData(histData, 'history'); 
        };
    }
    else if (id === 'offline') {
        playlistNameDisplay.innerText = "Lagu Unduhan (Offline)";
        setPlaylistCover('linear-gradient(135deg, #2a2a2a, #535353)', pathDownload);
        const tx = db.transaction("offline_songs", "readonly");
        const req = tx.objectStore("offline_songs").getAll();
        req.onsuccess = () => { processPlaylistData(req.result, 'offline'); };
    }
    else {
        const tx = db.transaction("playlists", "readonly");
        const req = tx.objectStore("playlists").get(id);
        req.onsuccess = () => {
            const p = req.result;
            if(p) {
                playlistNameDisplay.innerText = p.name;
                const box = document.getElementById('playlistImageContainer');
                if(box) box.style.background = 'transparent';
                const svg = document.getElementById('playlistSvgDisplay');
                if(svg) svg.style.display = 'none';
                const img = document.getElementById('playlistImageDisplay');
                if(img) {
                    img.style.display = 'block';
                    img.src = p.img || 'https://via.placeholder.com/240/282828/ffffff?text=+';
                }
                processPlaylistData(p.tracks || [], 'playlist');
            }
        };
    }
}

function processPlaylistData(dataArr, typeId) {
    currentPlaylistTracks = dataArr || [];
    const statsDisplay = document.getElementById('playlistStatsDisplay');
    if(statsDisplay) statsDisplay.innerText = `${currentPlaylistTracks.length} lagu disimpan`;
    const container = document.getElementById('playlistTracksContainer');
    if(!container) return;
    
    if (currentPlaylistTracks.length === 0) {
        container.innerHTML = '<div style="color:var(--text-sub); text-align:center;">Daftar ini masih kosong.</div>';
        return;
    }
    let html = '';
    let ctx = { type: typeId, data: currentPlaylistTracks };
    currentPlaylistTracks.forEach(t => html += createListHTML(t, ctx));
    container.innerHTML = html;
}

function playFirstPlaylistTrack() {
    if(currentPlaylistTracks && currentPlaylistTracks.length > 0) {
        const firstTrack = currentPlaylistTracks[0];
        const trackData = encodeURIComponent(JSON.stringify(firstTrack)).replace(/'/g, "%27");
        const ctxString = encodeURIComponent(JSON.stringify({ type: 'auto', data: currentPlaylistTracks })).replace(/'/g, "%27");
        playMusic(firstTrack.videoId, trackData, JSON.parse(decodeURIComponent(ctxString)));
    }
}

// --- LOGIC HAPUS BANYAK (MULTI-DELETE) ---
function toggleEditMode() {
    isEditMode = !isEditMode;
    selectedTracksForDelete.clear();
    
    document.querySelectorAll('#playlistTracksContainer .v-item').forEach(item => {
        if(isEditMode) {
            item.classList.add('editing');
        } else {
            item.classList.remove('editing');
            const checkbox = item.querySelector('.v-checkbox');
            if(checkbox) checkbox.checked = false;
        }
    });

    const bar = document.getElementById('bulkActionBar');
    if(bar) {
        if(isEditMode) {
            bar.style.display = 'flex';
            updateDeleteCount();
        } else {
            bar.style.display = 'none';
        }
    }
}

function handleCheckDelete(videoId, isChecked) {
    if(isChecked) selectedTracksForDelete.add(videoId);
    else selectedTracksForDelete.delete(videoId);
    updateDeleteCount();
}

function updateDeleteCount() {
    const countText = document.getElementById('selCountText');
    if(countText) countText.innerText = `${selectedTracksForDelete.size} lagu dipilih`;
}

function deleteSelectedTracks() {
    if(selectedTracksForDelete.size === 0) {
        showToast("Pilih minimal satu lagu untuk dihapus");
        return;
    }
    
    let storeName = "";
    if(activePlaylistId === 'liked') storeName = "liked_songs";
    else if(activePlaylistId === 'favorite') storeName = "favorite_songs";
    else if(activePlaylistId === 'history') storeName = "history_songs";
    else if(activePlaylistId === 'offline') storeName = "offline_songs";

    if(storeName) {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        selectedTracksForDelete.forEach(id => {
            if(activePlaylistId === 'history') {
                const req = store.openCursor();
                req.onsuccess = function(e) {
                    const cursor = e.target.result;
                    if(cursor) {
                        if(cursor.value.videoId === id) cursor.delete();
                        cursor.continue();
                    }
                }
            } else {
                store.delete(id);
            }
        });
        tx.oncomplete = () => {
            showToast(`${selectedTracksForDelete.size} lagu dihapus`);
            openPlaylistView(activePlaylistId); 
        }
    } else {
        const tx = db.transaction("playlists", "readwrite");
        const store = tx.objectStore("playlists");
        const req = store.get(activePlaylistId);
        req.onsuccess = () => {
            const p = req.result;
            if(p) {
                p.tracks = p.tracks.filter(t => !selectedTracksForDelete.has(t.videoId));
                store.put(p);
                showToast(`${selectedTracksForDelete.size} lagu dihapus dari Playlist`);
                openPlaylistView(activePlaylistId);
            }
        };
    }
}

let base64PlaylistImage = '';
function openCreatePlaylist() { 
    const modal = document.getElementById('createPlaylistModal');
    if(modal) modal.style.display = 'block'; 
}
function closeCreatePlaylist() {
    const modal = document.getElementById('createPlaylistModal');
    if(modal) modal.style.display = 'none';
    const cpName = document.getElementById('cpName');
    if(cpName) cpName.value = '';
    const cpPreview = document.getElementById('cpPreview');
    if(cpPreview) cpPreview.src = 'https://via.placeholder.com/120x120?text=+';
    base64PlaylistImage = '';
}
function previewImage(event) {
    const file = event.target.files[0];
    const reader = new FileReader();
    reader.onloadend = () => {
        const cpPreview = document.getElementById('cpPreview');
        if(cpPreview) cpPreview.src = reader.result;
        base64PlaylistImage = reader.result;
    };
    if(file) reader.readAsDataURL(file);
}
function saveNewPlaylist() {
    const cpName = document.getElementById('cpName');
    const name = (cpName ? cpName.value : "") || "Playlist baruku";
    const newPlaylist = { id: Date.now().toString(), name: name, img: base64PlaylistImage, tracks: [] };
    const tx = db.transaction("playlists", "readwrite");
    tx.objectStore("playlists").put(newPlaylist);
    tx.oncomplete = function() { closeCreatePlaylist(); renderLibraryUI(); };
}

function openAddToPlaylistModal() {
    if(!currentTrack) return;
    const tx = db.transaction("playlists", "readonly");
    const req = tx.objectStore("playlists").getAll();
    req.onsuccess = () => {
        let html = '';
        req.result.forEach(p => {
            html += `
                <div class="lib-item" onclick="addTrackToPlaylist('${p.id}')" style="margin-bottom: 12px; cursor: pointer;">
                    <img src="${p.img || 'https://via.placeholder.com/50'}" style="width:50px; height:50px; object-fit:cover; border-radius:4px;" onerror="this.src='https://via.placeholder.com/50'">
                    <div style="color:white; font-size:16px;">${escapeHtml(p.name)}</div>
                </div>`;
        });
        if(req.result.length === 0) html = '<div style="color:#a7a7a7; text-align:center;">Belum ada playlist. Buat dulu di Koleksi Kamu.</div>';
        const listContainer = document.getElementById('addToPlaylistList');
        if(listContainer) listContainer.innerHTML = html;
        const modal = document.getElementById('addToPlaylistModal');
        if(modal) modal.style.display = 'flex';
    };
}
function closeAddToPlaylistModal() { 
    const modal = document.getElementById('addToPlaylistModal');
    if(modal) modal.style.display = 'none'; 
}
function addTrackToPlaylist(playlistId) {
    const tx = db.transaction("playlists", "readwrite");
    const store = tx.objectStore("playlists");
    const req = store.get(playlistId);
    req.onsuccess = () => {
        const p = req.result;
        if(p) {
            if(!p.tracks) p.tracks = [];
            if(!p.tracks.find(t => t.videoId === currentTrack.videoId)) {
                p.tracks.push(currentTrack);
                store.put(p);
                showToast('Ditambahkan ke ' + p.name); 
            } else {
                showToast('Sudah ada di ' + p.name); 
            }
        }
        closeAddToPlaylistModal();
    };
                  }
