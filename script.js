const queryInput = document.getElementById('queryInput');
const searchButton = document.getElementById('searchButton');
const resultsEl = document.getElementById('results');
const resultCount = document.getElementById('resultCount');
const previewPanel = document.getElementById('previewPanel');
const videoTitle = document.getElementById('videoTitle');
const videoChannel = document.getElementById('videoChannel');
const videoThumbnail = document.getElementById('videoThumbnail');
const durationTag = document.getElementById('durationTag');
const typeSelect = document.getElementById('typeSelect');
const qualitySelect = document.getElementById('qualitySelect');
const downloadButton = document.getElementById('downloadButton');
const addBatchButton = document.getElementById('addBatchButton');
const batchLinks = document.getElementById('batchLinks');
const addLinksButton = document.getElementById('addLinksButton');
const batchList = document.getElementById('batchList');
const batchCount = document.getElementById('batchCount');
const downloadBatchButton = document.getElementById('downloadBatchButton');
const clearBatchButton = document.getElementById('clearBatchButton');
const batchTypeSelect = document.getElementById('batchTypeSelect');
const batchQualitySelect = document.getElementById('batchQualitySelect');
const notification = document.getElementById('notification');

let currentVideo = null;
let currentInfo = null;
const batchItems = [];

searchButton.addEventListener('click', performSearch);
queryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        performSearch();
    }
});
typeSelect.addEventListener('change', () => updateQualityOptions(currentInfo));
addBatchButton.addEventListener('click', addCurrentVideoToBatch);
downloadButton.addEventListener('click', downloadSingleVideo);
addLinksButton.addEventListener('click', addLinksToBatch);
downloadBatchButton.addEventListener('click', downloadBatch);
clearBatchButton.addEventListener('click', clearBatch);

function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function showToast(message, type = 'info') {
    notification.textContent = message;
    notification.className = `toast ${type}`;
    notification.style.borderColor = type === 'success'
        ? 'rgba(50, 211, 158, 0.4)'
        : type === 'error'
        ? 'rgba(255, 95, 122, 0.4)'
        : 'rgba(255, 255, 255, 0.15)';
    notification.classList.remove('hidden');
    window.clearTimeout(notification.timeoutId);
    notification.timeoutId = window.setTimeout(() => {
        notification.classList.add('hidden');
    }, 3200);
}

function setLoadingState(isLoading) {
    searchButton.disabled = isLoading;
    downloadButton.disabled = isLoading;
    addBatchButton.disabled = isLoading;
    if (isLoading) {
        searchButton.textContent = 'Loading…';
    } else {
        searchButton.textContent = 'Search / Load';
    }
}

function isYouTubeUrl(text) {
    return /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i.test(text.trim());
}

async function performSearch() {
    const query = queryInput.value.trim();
    if (!query) {
        showToast('Type a search term or paste a YouTube link to continue.', 'error');
        return;
    }

    if (isYouTubeUrl(query)) {
        await loadVideoInfo(query);
    } else {
        await searchVideos(query);
    }
}

async function searchVideos(query) {
    resultsEl.innerHTML = '<div class="loading-card">Searching videos…</div>';
    resultCount.textContent = 'Searching...';
    previewPanel.classList.add('hidden');
    currentVideo = null;
    currentInfo = null;

    try {
        const response = await fetch(`/search?q=${encodeURIComponent(query)}`);
        if (!response.ok) {
            throw new Error('Search failed');
        }

        const videos = await response.json();
        resultsEl.innerHTML = '';

        if (!videos.length) {
            resultCount.textContent = 'No results found';
            resultsEl.innerHTML = '<div class="empty-card">No videos matched your search. Try another keyword.</div>';
            return;
        }

        resultCount.textContent = `${videos.length} videos found`;

        videos.forEach((video) => {
            const card = document.createElement('article');
            card.className = 'result-card';
            card.innerHTML = `
                <img src="${video.thumbnail}" alt="${video.title}" />
                <div class="result-meta">
                    <h3 title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
                    <p>${escapeHtml(video.author?.name || 'Unknown channel')} • ${escapeHtml(video.timestamp || '')}</p>
                    <small>${escapeHtml(video.views?.toLocaleString?.() || '0')} views</small>
                </div>
                <button class="select-button">Select</button>
            `;

            card.querySelector('button').addEventListener('click', () => {
                loadVideoInfo(video.url);
            });

            resultsEl.appendChild(card);
        });
    } catch (error) {
        resultsEl.innerHTML = '<div class="empty-card">Unable to fetch results at the moment.</div>';
        resultCount.textContent = 'Search failed';
        showToast(error.message || 'Search request failed.', 'error');
    }
}

async function loadVideoInfo(url) {
    try {
        setLoadingState(true);
        const response = await fetch(`/info?url=${encodeURIComponent(url)}`);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'Failed to load video info');
        }

        const info = await response.json();
        currentVideo = { url, title: info.title, thumbnail: info.thumbnail, duration: info.duration };
        currentInfo = info;

        videoTitle.textContent = info.title;
        videoChannel.textContent = info.channel || '';
        videoThumbnail.src = info.thumbnail;
        durationTag.textContent = formatDuration(info.duration);
        previewPanel.classList.remove('hidden');
        resultCount.textContent = 'Video loaded';
        updateQualityOptions(info);
        showToast('Video ready to download.', 'success');
    } catch (error) {
        showToast(error.message || 'Could not load video details.', 'error');
    } finally {
        setLoadingState(false);
    }
}

function updateQualityOptions(info) {
    qualitySelect.innerHTML = '';
    if (!info) {
        return;
    }

    const type = typeSelect.value;
    const list = type === 'audio' ? info.audioQualities : info.videoQualities;

    if (!list || !list.length) {
        qualitySelect.innerHTML = '<option value="highest">Best available</option>';
        return;
    }

    const defaultOption = document.createElement('option');
    defaultOption.value = 'highest';
    defaultOption.textContent = type === 'audio' ? 'Best audio available' : 'Highest video available';
    qualitySelect.appendChild(defaultOption);

    list.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.itag;
        option.textContent = `${item.quality} · ${item.container || ''}`.trim();
        qualitySelect.appendChild(option);
    });
}

function addCurrentVideoToBatch() {
    if (!currentVideo) {
        showToast('Select a video first.', 'error');
        return;
    }

    if (batchItems.some((item) => item.url === currentVideo.url)) {
        showToast('This video is already in the batch.', 'error');
        return;
    }

    batchItems.push({
        url: currentVideo.url,
        title: currentVideo.title,
        duration: currentVideo.duration,
    });

    queryInput.value = '';
    updateBatchList();
    showToast('Added video to batch.', 'success');
}

function addLinksToBatch() {
    const rawValue = batchLinks.value.trim();
    if (!rawValue) {
        showToast('Paste at least one YouTube link.', 'error');
        return;
    }

    const urls = rawValue
        .split(/\r?\n|,|;/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

    if (!urls.length) {
        showToast('No valid links were found.', 'error');
        return;
    }

    let added = 0;
    let skipped = 0;

    urls.forEach((url) => {
        if (!isYouTubeUrl(url)) {
            skipped += 1;
            return;
        }

        if (batchItems.some((item) => item.url === url)) {
            skipped += 1;
            return;
        }

        batchItems.push({
            url,
            title: url,
            duration: null,
        });
        added += 1;
    });

    batchLinks.value = '';
    updateBatchList();

    if (added) {
        showToast(`${added} link${added > 1 ? 's' : ''} added to batch.`, 'success');
    }
    if (skipped) {
        showToast(`${skipped} duplicate or invalid link${skipped > 1 ? 's' : ''} skipped.`, 'error');
    }
}

function updateBatchList() {
    batchList.innerHTML = '';
    batchCount.textContent = `${batchItems.length} item${batchItems.length === 1 ? '' : 's'}`;
    downloadBatchButton.disabled = batchItems.length === 0;

    if (!batchItems.length) {
        batchList.innerHTML = '<div class="empty-card">Your batch is empty. Add videos from search or paste links above.</div>';
        return;
    }

    batchItems.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = 'batch-item';
        card.innerHTML = `
            <div>
                <p title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</p>
                <small>${item.duration ? formatDuration(item.duration) : 'Link added'}</small>
            </div>
            <button type="button">Remove</button>
        `;

        card.querySelector('button').addEventListener('click', () => {
            batchItems.splice(index, 1);
            updateBatchList();
        });

        batchList.appendChild(card);
    });
}

function clearBatch() {
    batchItems.splice(0, batchItems.length);
    updateBatchList();
    showToast('Batch cleared.', 'info');
}

async function downloadSingleVideo() {
    if (!currentVideo) {
        showToast('Choose a video before downloading.', 'error');
        return;
    }

    const type = typeSelect.value;
    const quality = qualitySelect.value;
    const url = `/download/single?url=${encodeURIComponent(currentVideo.url)}&type=${encodeURIComponent(type)}&quality=${encodeURIComponent(quality)}`;
    window.location.assign(url);
}

async function downloadBatch() {
    if (!batchItems.length) {
        showToast('Add videos to your batch first.', 'error');
        return;
    }

    const payload = {
        urls: batchItems.map((item) => item.url),
        type: batchTypeSelect.value,
        quality: batchQualitySelect.value,
    };

    downloadBatchButton.disabled = true;
    downloadBatchButton.textContent = 'Preparing ZIP…';

    try {
        const response = await fetch('/download/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            throw new Error(errorBody.error || 'Batch download failed');
        }

        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const match = /filename="?([^";]*)"?/.exec(disposition);
        const filename = match ? match[1] : 'youtube_batch.zip';
        const downloadBlob = new Blob([blob], { type: 'application/zip' });
        const objectUrl = URL.createObjectURL(downloadBlob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        showToast('Batch download created.', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to create batch download.', 'error');
    } finally {
        downloadBatchButton.disabled = batchItems.length === 0;
        downloadBatchButton.textContent = 'Download ZIP';
    }
}

function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return 'Unknown';
    const secs = Number(seconds);
    const minutes = Math.floor(secs / 60);
    const remainder = secs % 60;
    return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function escapeHtml(input) {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

updateBatchList();
