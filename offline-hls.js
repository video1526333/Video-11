import { H as Hls } from './assets/player-B6lhAZ8n.js';
import {
  HLS_ERROR_CODES,
  buildLocalMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  rewriteMediaPlaylist,
} from './offline-hls-core.js';

(() => {
  const DB_NAME = 'video-offline-hls';
  const DB_VERSION = 3;
  const EPISODES = 'episodes';
  const ASSETS = 'assets';
  const DOWNLOADS = 'downloads';
  const LOCAL_PREFIX = '/offline-hls/';
  const PROXY_PATH = '/hls-proxy?url=';
  const MIME_BY_EXTENSION = {
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
    '.m4s': 'video/iso.segment',
    '.mp4': 'video/mp4',
    '.aac': 'audio/aac',
    '.key': 'application/octet-stream',
  };
  const ERROR_CODES = {
    ...HLS_ERROR_CODES,
    HOST_NOT_ALLOWED: 'HLS_HOST_NOT_ALLOWED',
    REDIRECT_HOST_NOT_ALLOWED: 'REDIRECT_HOST_NOT_ALLOWED',
    UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
    UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
    UPSTREAM_HTTP_ERROR: 'UPSTREAM_HTTP_ERROR',
    STORAGE_QUOTA: 'STORAGE_QUOTA',
    CANCELLED: 'DOWNLOAD_CANCELLED',
  };
  const ACTIVE_JOB_STATUSES = new Set(['queued', 'downloading', 'paused', 'failed']);
  let databasePromise;

  class OfflineHlsError extends Error {
    constructor(code, message, retryable = false, details = {}) {
      super(message);
      this.name = 'OfflineHlsError';
      this.code = code;
      this.retryable = retryable;
      Object.assign(this, details);
    }
  }

  const normalizeEpisode = (episode) => ({
    ...episode,
    status: episode.status === 'downloading' ? 'paused' : episode.status || 'paused',
    downloadedAssets: Number(episode.downloadedAssets || 0),
    totalAssets: Number(episode.totalAssets || 0),
    downloadedBytes: Number(episode.downloadedBytes || 0),
    totalBytes: episode.totalBytes == null ? null : Number(episode.totalBytes),
    downloadedDuration: Number(episode.downloadedDuration || 0),
    totalDuration: episode.totalDuration == null ? null : Number(episode.totalDuration),
    watchPosition: Number(episode.watchPosition || 0),
    lastWatchedAt: Number(episode.lastWatchedAt || 0),
    retryCount: Number(episode.retryCount || 0),
    lastAttemptAt: Number(episode.lastAttemptAt || 0),
    lastErrorCode: episode.lastErrorCode || null,
    lastErrorMessage: episode.lastErrorMessage || null,
  });

  const normalizeJob = (job) => ({
    ...job,
    episodeIds: [...new Set(Array.isArray(job.episodeIds) ? job.episodeIds : [])],
    episodeMeta: (Array.isArray(job.episodeMeta) ? job.episodeMeta : []).filter((item) => item?.id && item.sourceUrl),
    currentEpisodeId: job.currentEpisodeId || null,
    currentIndex: Number(job.currentIndex || 0),
    completedEpisodeIds: [...new Set(Array.isArray(job.completedEpisodeIds) ? job.completedEpisodeIds : [])],
    failedEpisodeIds: [...new Set(Array.isArray(job.failedEpisodeIds) ? job.failedEpisodeIds : [])],
  });

  const openDatabase = () => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const transaction = request.transaction;
        if (!database.objectStoreNames.contains(EPISODES)) database.createObjectStore(EPISODES, { keyPath: 'id' });
        if (!database.objectStoreNames.contains(ASSETS)) {
          const store = database.createObjectStore(ASSETS, { keyPath: 'id' });
          store.createIndex('episodeId', 'episodeId', { unique: false });
        }
        if (!database.objectStoreNames.contains(DOWNLOADS)) database.createObjectStore(DOWNLOADS, { keyPath: 'id' });
        const assetStore = transaction.objectStore(ASSETS);
        if (!assetStore.indexNames.contains('episodeId')) assetStore.createIndex('episodeId', 'episodeId', { unique: false });
        const downloadStore = transaction.objectStore(DOWNLOADS);
        if (!downloadStore.indexNames.contains('status')) downloadStore.createIndex('status', 'status', { unique: false });
        if (!downloadStore.indexNames.contains('updatedAt')) downloadStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        if (request.transaction?.objectStore(EPISODES)) {
          const cursorRequest = transaction.objectStore(EPISODES).openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const normalized = normalizeEpisode(cursor.value);
            cursor.update(normalized);
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(new OfflineHlsError(ERROR_CODES.STORAGE_QUOTA, '无法打开离线存储', true));
      request.onblocked = () => reject(new OfflineHlsError(ERROR_CODES.STORAGE_QUOTA, '离线存储正在被其他页面占用', true));
    });
    return databasePromise;
  };

  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('离线存储操作失败'));
  });
  const readRecord = async (storeName, key) => requestResult((await openDatabase()).transaction(storeName, 'readonly').objectStore(storeName).get(key));
  const readAll = async (storeName) => requestResult((await openDatabase()).transaction(storeName, 'readonly').objectStore(storeName).getAll());
  const writeRecord = async (storeName, value) => {
    try {
      return await requestResult((await openDatabase()).transaction(storeName, 'readwrite').objectStore(storeName).put(value));
    } catch (error) {
      if (error.name === 'QuotaExceededError') throw new OfflineHlsError(ERROR_CODES.STORAGE_QUOTA, '设备存储空间不足', false);
      throw error;
    }
  };
  const deleteRecord = async (storeName, key) => requestResult((await openDatabase()).transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
  const readEpisodeAssets = async (episodeId) => requestResult((await openDatabase()).transaction(ASSETS, 'readonly').objectStore(ASSETS).index('episodeId').getAll(episodeId));
  const hash = (value) => {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  };
  const episodeIdFor = (sourceUrl, title, seriesTitle) => `hls-${hash(`${seriesTitle}\u0000${title}\u0000${sourceUrl}`)}`;
  const localAssetUrl = (episodeId, assetPath) => `${LOCAL_PREFIX}${encodeURIComponent(episodeId)}/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
  const proxyUrl = (url) => `${PROXY_PATH}${encodeURIComponent(url)}`;
  const dispatchUpdate = (detail) => window.dispatchEvent(new CustomEvent('offline-hls-updated', { detail }));

  const parseErrorResponse = async (response, fallbackCode, fallbackMessage, retryable = true) => {
    const body = await response.text().catch(() => '');
    let payload = null;
    try { payload = body ? JSON.parse(body) : null; } catch { /* upstream may return plain text */ }
    if (payload?.code) return new OfflineHlsError(payload.code, payload.message || fallbackMessage, payload.retryable !== false, { upstreamStatus: payload.upstreamStatus });
    return new OfflineHlsError(fallbackCode, body || fallbackMessage, retryable, { upstreamStatus: response.status });
  };

  const fetchResource = async (url, signal, accept = '*/*', range = null) => {
    if (!/^https?:\/\//i.test(url)) throw new OfflineHlsError('INVALID_URL', 'HLS 地址无效', false);
    const headers = { Accept: accept };
    if (range) headers.Range = range;
    let response;
    try {
      response = await fetch(proxyUrl(url), { signal, headers, cache: 'no-store' });
    } catch (error) {
      if (error.name === 'AbortError') throw new OfflineHlsError(ERROR_CODES.CANCELLED, '下载已取消', true);
      throw new OfflineHlsError(ERROR_CODES.UPSTREAM_UNAVAILABLE, '无法访问视频服务器', true);
    }
    if (!response.ok) {
      throw await parseErrorResponse(
        response,
        response.status === 404 ? ERROR_CODES.UPSTREAM_HTTP_ERROR : ERROR_CODES.UPSTREAM_UNAVAILABLE,
        response.status === 404 ? '视频资源已失效' : '视频服务器暂时不可用',
        response.status >= 500,
      );
    }
    return response;
  };

  const extensionFor = (url) => {
    const match = String(url).match(/(\.m3u8|\.ts|\.m4s|\.mp4|\.aac|\.key)(?:$|[?#])/i);
    return match ? match[1].toLowerCase() : '.bin';
  };
  const contentTypeFor = (url, response) => {
    const header = response.headers.get('content-type')?.split(';')[0]?.trim();
    return header && header !== 'application/octet-stream' ? header : MIME_BY_EXTENSION[extensionFor(url)] || 'application/octet-stream';
  };
  const assetPathFor = (resource) => {
    const sequence = String(resource.sequence).padStart(resource.kind === 'key' ? 4 : 6, '0');
    const extension = resource.kind === 'key' ? '.key' : resource.kind === 'init' ? '.m4s' : extensionFor(resource.url);
    if (resource.kind === 'key') return `keys/${resource.trackId}-${sequence}${extension}`;
    if (resource.trackId === 'audio') return `audio/segments/${sequence}${extension}`;
    return `segments/${sequence}${extension}`;
  };
  const playlistPathFor = (trackId) => `playlists/${trackId}.m3u8`;
  const readAssetsMap = async (episodeId) => new Map((await readEpisodeAssets(episodeId)).map((asset) => [asset.path, asset]));
  const updateEpisode = async (episode, { emit = true } = {}) => {
    episode.updatedAt = Date.now();
    await writeRecord(EPISODES, episode);
    if (emit) dispatchUpdate(episode);
  };
  const storageSummary = async () => {
    const episodes = await readAll(EPISODES);
    const estimate = await navigator.storage?.estimate?.().catch(() => ({})) || {};
    const used = Number(estimate.usage || 0);
    const quota = Number(estimate.quota || 0);
    const downloadedBytes = episodes.reduce((sum, episode) => sum + Number(episode.downloadedBytes || 0), 0);
    const readyCount = episodes.filter((episode) => episode.status === 'ready').length;
    const failedCount = episodes.filter((episode) => episode.status === 'failed').length;
    const incompleteCount = episodes.length - readyCount;
    return {
      used,
      quota,
      available: Math.max(0, quota - used),
      downloadedBytes,
      readyCount,
      incompleteCount,
      failedCount,
      totalCount: episodes.length,
      episodeCount: readyCount,
      usageRatio: quota ? used / quota : 0,
    };
  };

  const assetIsComplete = (asset, resource) => {
    if (!asset?.body || !(asset.body instanceof Blob)) return false;
    if (Number(asset.size || 0) !== asset.body.size) return false;
    if (asset.sourceUrl !== resource.url) return false;
    if (String(asset.range || '') !== String(resource.range || '')) return false;
    return true;
  };
  const expectedSizeFor = (response) => {
    const header = response.headers.get('content-length');
    if (!header) return null;
    const value = Number(header);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const bodyForResource = async (response, resource) => {
    const body = await response.blob();
    if (!resource.range) return body;
    const match = resource.range.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) throw new OfflineHlsError(HLS_ERROR_CODES.CONTENT_INVALID, '视频分片范围无效', true);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const expectedLength = end - start + 1;
    if (body.size === expectedLength) return body;
    if (response.status === 200 && body.size >= end + 1) return body.slice(start, end + 1, body.type);
    throw new OfflineHlsError(HLS_ERROR_CODES.CONTENT_INVALID, '视频分片范围响应无效', true);
  };

  const saveEpisode = async ({ sourceUrl, title, seriesTitle, signal, onProgress, jobId }) => {
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) throw new OfflineHlsError('INVALID_URL', 'HLS 地址无效', false);
    const id = episodeIdFor(sourceUrl, title, seriesTitle);
    const existing = normalizeEpisode(await readRecord(EPISODES, id) || {});
    const oldAssets = await readAssetsMap(id);
    const episode = {
      id,
      title: title || '本集',
      seriesTitle: seriesTitle || '离线观看',
      sourceUrl,
      localUrl: `${LOCAL_PREFIX}${encodeURIComponent(id)}/master.m3u8`,
      status: 'downloading',
      downloadedAssets: 0,
      totalAssets: 0,
      downloadedBytes: 0,
      totalBytes: null,
      downloadedDuration: 0,
      totalDuration: null,
      watchPosition: existing.watchPosition || 0,
      lastWatchedAt: existing.lastWatchedAt || 0,
      retryCount: (existing.retryCount || 0) + 1,
      lastAttemptAt: Date.now(),
      lastErrorCode: null,
      lastErrorMessage: null,
      jobId: jobId || existing.jobId || null,
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await writeRecord(EPISODES, episode);
    let lastProgressAt = 0;
    let lastPersistedAt = 0;
    const report = async (progress) => {
      const now = performance.now();
      if (progress.phase === 'downloading' && lastProgressAt > 0 && now - lastProgressAt < 250) return;
      lastProgressAt = now;
      if (progress.phase === 'preparing') lastProgressAt = 0;
      const elapsed = Math.max(0.001, (Date.now() - episode.lastAttemptAt) / 1000);
      const speed = Number(progress.downloadedBytes || 0) / elapsed;
      const completedAssets = Number(progress.downloadedAssets ?? progress.currentAsset ?? episode.downloadedAssets) || 0;
      const payload = {
        ...progress,
        episodeId: id,
        episodeTitle: episode.title,
        downloadedAssets: completedAssets,
        speedBytesPerSecond: speed,
        etaSeconds: progress.totalBytes && speed ? Math.max(0, (progress.totalBytes - progress.downloadedBytes) / speed) : null,
      };
      onProgress?.(payload);
      if (now - lastPersistedAt >= 250 || progress.phase !== 'downloading') {
        lastPersistedAt = now;
        episode.downloadedAssets = completedAssets;
        episode.totalAssets = Number(progress.totalAssets || 0);
        episode.downloadedBytes = Number(progress.downloadedBytes || 0);
        episode.totalBytes = progress.totalBytes == null ? null : Number(progress.totalBytes);
        episode.downloadedDuration = Number(progress.downloadedDuration || 0);
        episode.totalDuration = progress.totalDuration == null ? null : Number(progress.totalDuration);
        await updateEpisode(episode);
      }
    };

    try {
      const masterResponse = await fetchResource(sourceUrl, signal, 'application/vnd.apple.mpegurl,*/*');
      const masterText = await masterResponse.text();
      const master = parseMasterPlaylist(masterText, sourceUrl);
      const selectedVariant = master.selectedVariant;
      const tracks = [];
      if (selectedVariant) tracks.push({ id: 'video', url: selectedVariant.url, response: null });
      else tracks.push({ id: 'video', url: sourceUrl, response: masterResponse, text: masterText });
      if (master.selectedAudio) tracks.push({ id: 'audio', url: master.selectedAudio.url, response: null });

      const parsedTracks = [];
      for (const track of tracks) {
        const response = track.response || await fetchResource(track.url, signal, 'application/vnd.apple.mpegurl,*/*');
        const text = track.text || await response.text();
        const playlist = parseMediaPlaylist(text, track.url, track.id);
        playlist.playlistPath = selectedVariant ? playlistPathFor(track.id) : 'master.m3u8';
        playlist.playlistSize = new Blob([text]).size;
        playlist.resources.forEach((resource) => {
          resource.path = assetPathFor(resource);
          resource.expectedSize = null;
        });
        parsedTracks.push(playlist);
      }

      const allResources = parsedTracks.flatMap((playlist) => playlist.resources);
      const playlistAssets = parsedTracks.map((playlist) => ({
        path: playlist.playlistPath,
        kind: 'manifest',
        trackId: playlist.trackId,
        size: playlist.playlistSize,
      }));
      const totalAssetCount = allResources.length + playlistAssets.length + (selectedVariant ? 1 : 0);
      const videoPlaylist = parsedTracks.find((playlist) => playlist.trackId === 'video');
      const totalDuration = Number(videoPlaylist?.totalDuration || 0) || null;
      const knownResources = allResources.filter((resource) => assetIsComplete(oldAssets.get(resource.path), resource));
      let downloadedBytes = knownResources.reduce((sum, resource) => sum + Number(oldAssets.get(resource.path).size || 0), 0);
      let downloadedDuration = parsedTracks.find((playlist) => playlist.trackId === 'video')?.resources
        .filter((resource) => assetIsComplete(oldAssets.get(resource.path), resource))
        .reduce((sum, resource) => sum + Number(resource.duration || 0), 0) || 0;
      let completedAssets = knownResources.length;
      const downloadedAssetMap = new Map();
      knownResources.forEach((resource) => downloadedAssetMap.set(resource.key, oldAssets.get(resource.path)));
      episode.totalAssets = totalAssetCount;
      episode.totalDuration = totalDuration;
      episode.downloadedAssets = completedAssets;
      episode.downloadedBytes = downloadedBytes;
      episode.downloadedDuration = downloadedDuration;
      await updateEpisode(episode);
      await report({ phase: 'preparing', currentAsset: completedAssets, downloadedAssets: completedAssets, totalAssets: totalAssetCount, downloadedBytes, totalBytes: null, downloadedDuration, totalDuration });

      for (const resource of allResources) {
        if (signal?.aborted) throw new OfflineHlsError(ERROR_CODES.CANCELLED, '下载已取消', true);
        let asset = oldAssets.get(resource.path);
        if (!assetIsComplete(asset, resource)) {
          const response = await fetchResource(resource.url, signal, '*/*', resource.range);
          resource.expectedSize = expectedSizeFor(response);
          const body = await bodyForResource(response, resource);
          resource.expectedSize = body.size;
          asset = {
            id: `${id}:${resource.path}`,
            episodeId: id,
            path: resource.path,
            assetKey: resource.key,
            kind: resource.kind,
            trackId: resource.trackId,
            range: resource.range,
            contentType: contentTypeFor(resource.url, response),
            body,
            size: body.size,
            sourceUrl: resource.url,
          };
          await writeRecord(ASSETS, asset);
          completedAssets += 1;
          downloadedBytes += body.size;
          if (resource.trackId === 'video' && resource.kind === 'segment') downloadedDuration += Number(resource.duration || 0);
        }
        downloadedAssetMap.set(resource.key, asset);
        episode.downloadedAssets = completedAssets;
        episode.downloadedBytes = downloadedBytes;
        episode.downloadedDuration = downloadedDuration;
        const sizes = allResources.map((item) => downloadedAssetMap.get(item.key)?.size ?? item.expectedSize);
        const totalBytes = sizes.every((size) => size != null && Number.isFinite(Number(size)))
          ? sizes.reduce((sum, size) => sum + Number(size), 0) + playlistAssets.reduce((sum, item) => sum + Number(item.size || 0), 0)
          : null;
        episode.totalAssets = totalAssetCount;
        episode.totalBytes = totalBytes;
        episode.totalDuration = totalDuration;
        await report({ phase: 'downloading', currentAsset: completedAssets, downloadedAssets: completedAssets, totalAssets: totalAssetCount, downloadedBytes, totalBytes, downloadedDuration, totalDuration, currentResource: resource.path });
        await updateEpisode(episode, { emit: false });
      }

      const localPathFor = (resource) => localAssetUrl(id, resource.path);
      for (const playlist of parsedTracks) {
        const rewritten = rewriteMediaPlaylist(playlist, localPathFor);
        const asset = {
          id: `${id}:${playlist.playlistPath}`,
          episodeId: id,
          path: playlist.playlistPath,
          assetKey: `manifest|${playlist.trackId}|${playlist.url}`,
          kind: 'manifest',
          trackId: playlist.trackId,
          contentType: 'application/vnd.apple.mpegurl',
          body: new Blob([rewritten], { type: 'application/vnd.apple.mpegurl' }),
          size: new Blob([rewritten]).size,
          sourceUrl: playlist.url,
        };
        await writeRecord(ASSETS, asset);
        completedAssets += 1;
        downloadedBytes += asset.size;
      }

      let masterPath = 'master.m3u8';
      if (selectedVariant) {
        const videoPath = localAssetUrl(id, playlistPathFor('video'));
        const audioPath = master.selectedAudio ? localAssetUrl(id, playlistPathFor('audio')) : null;
        const rewrittenMaster = buildLocalMasterPlaylist({ variant: selectedVariant, audio: master.selectedAudio, videoPath, audioPath });
        const masterAsset = {
          id: `${id}:master.m3u8`,
          episodeId: id,
          path: masterPath,
          assetKey: `manifest|master|${sourceUrl}`,
          kind: 'manifest',
          trackId: 'master',
          contentType: 'application/vnd.apple.mpegurl',
          body: new Blob([rewrittenMaster], { type: 'application/vnd.apple.mpegurl' }),
          size: new Blob([rewrittenMaster]).size,
          sourceUrl,
        };
        await writeRecord(ASSETS, masterAsset);
        completedAssets += 1;
        downloadedBytes += masterAsset.size;
      }

      episode.downloadedAssets = totalAssetCount;
      episode.totalAssets = totalAssetCount;
      episode.downloadedBytes = downloadedBytes;
      episode.totalBytes = downloadedBytes;
      episode.downloadedDuration = totalDuration || downloadedDuration;
      episode.status = 'ready';
      episode.lastErrorCode = null;
      episode.lastErrorMessage = null;
      await updateEpisode(episode);
      await report({ phase: 'completed', currentAsset: totalAssetCount, downloadedAssets: totalAssetCount, totalAssets: totalAssetCount, downloadedBytes, totalBytes: downloadedBytes, downloadedDuration: episode.downloadedDuration, totalDuration, currentResource: masterPath });
      return episode;
    } catch (error) {
      const normalized = error instanceof OfflineHlsError
        ? error
        : error.name === 'QuotaExceededError'
          ? new OfflineHlsError(ERROR_CODES.STORAGE_QUOTA, '设备存储空间不足', false)
          : new OfflineHlsError(ERROR_CODES.UPSTREAM_UNAVAILABLE, error.message || '保存失败', true);
      episode.status = normalized.code === ERROR_CODES.CANCELLED ? 'paused' : 'failed';
      episode.lastErrorCode = normalized.code;
      episode.lastErrorMessage = normalized.message;
      try {
        await updateEpisode(episode);
        await report({ phase: 'failed', currentAsset: episode.downloadedAssets, downloadedAssets: episode.downloadedAssets, totalAssets: episode.totalAssets, downloadedBytes: episode.downloadedBytes, totalBytes: episode.totalBytes, downloadedDuration: episode.downloadedDuration, totalDuration: episode.totalDuration, currentResource: normalized.message });
      } catch {
        // Preserve the original download error when storage is already unavailable.
      }
      throw normalized;
    }
  };

  const mergeEpisodeMeta = (current, additions) => {
    const byId = new Map((Array.isArray(current) ? current : []).map((item) => [item.id, item]));
    (Array.isArray(additions) ? additions : []).forEach((item) => {
      if (item?.id && item.sourceUrl) byId.set(item.id, { id: item.id, sourceUrl: item.sourceUrl, title: item.title || '本集', seriesTitle: item.seriesTitle || '离线观看' });
    });
    return [...byId.values()];
  };
  const createDownloadJob = async (episodeIds, episodeItems = []) => {
    const ids = [...new Set(episodeIds.filter(Boolean))];
    const jobs = (await readAll(DOWNLOADS)).map(normalizeJob).filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
    const matchingJobs = jobs.filter((job) => job.episodeIds.some((id) => ids.includes(id)));
    const existing = matchingJobs.sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (existing) {
      const duplicates = matchingJobs.filter((job) => job.id !== existing.id);
      existing.episodeIds = [...new Set([...existing.episodeIds, ...ids, ...duplicates.flatMap((job) => job.episodeIds)])];
      existing.episodeMeta = mergeEpisodeMeta(existing.episodeMeta, [...episodeItems, ...duplicates.flatMap((job) => job.episodeMeta || [])]);
      existing.completedEpisodeIds = [...new Set([...(existing.completedEpisodeIds || []), ...duplicates.flatMap((job) => job.completedEpisodeIds || [])])];
      existing.failedEpisodeIds = [...new Set([...(existing.failedEpisodeIds || []), ...duplicates.flatMap((job) => job.failedEpisodeIds || [])])];
      existing.status = 'queued';
      existing.failedEpisodeIds = existing.failedEpisodeIds.filter((id) => !ids.includes(id));
      for (const duplicate of duplicates) await deleteRecord(DOWNLOADS, duplicate.id);
      await writeRecord(DOWNLOADS, existing);
      return existing;
    }
    const job = normalizeJob({
      id: `job-${Date.now().toString(36)}-${hash(ids.join('|'))}`,
      episodeIds: ids,
      episodeMeta: mergeEpisodeMeta([], episodeItems),
      currentEpisodeId: null,
      currentIndex: 0,
      completedEpisodeIds: [],
      failedEpisodeIds: [],
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await writeRecord(DOWNLOADS, job);
    return job;
  };
  const updateDownloadJob = async (job) => {
    const normalized = normalizeJob(job);
    normalized.updatedAt = Date.now();
    await writeRecord(DOWNLOADS, normalized);
    dispatchUpdate({ job: normalized });
    return normalized;
  };
  const listDownloadJobs = async () => (await readAll(DOWNLOADS)).map(normalizeJob);
  const getDownloadJob = async (id) => normalizeJob(await readRecord(DOWNLOADS, id) || { id, episodeIds: [] });
  const cancelDownloadJob = async (id) => {
    const current = await readRecord(DOWNLOADS, id);
    if (!current) throw new OfflineHlsError('DOWNLOAD_JOB_NOT_FOUND', '找不到下载任务', false);
    const job = normalizeJob(current);
    job.status = 'cancelled';
    job.currentEpisodeId = null;
    return updateDownloadJob(job);
  };
  const recoverDownloadJobs = async () => {
    const episodes = await readAll(EPISODES);
    for (const rawEpisode of episodes) {
      if (rawEpisode.status !== 'downloading') continue;
      const episode = normalizeEpisode(rawEpisode);
      episode.status = 'paused';
      episode.lastErrorCode = 'DOWNLOAD_INTERRUPTED';
      episode.lastErrorMessage = '页面刷新后可以继续下载';
      await updateEpisode(episode);
    }
    const jobs = await listDownloadJobs();
    const recovered = [];
    for (const job of jobs) {
      if (job.status === 'downloading') {
        job.status = 'paused';
        await updateDownloadJob(job);
      }
      if (ACTIVE_JOB_STATUSES.has(job.status)) recovered.push(job);
    }
    return recovered.sort((left, right) => right.updatedAt - left.updatedAt);
  };
  const getEpisode = async (id) => {
    const episode = await readRecord(EPISODES, id);
    return episode ? normalizeEpisode(episode) : null;
  };
  const listEpisodes = async () => (await readAll(EPISODES)).map(normalizeEpisode);
  const updatePosition = async (id, watchPosition) => {
    const episode = await getEpisode(id);
    if (!episode) return;
    episode.watchPosition = Number(watchPosition) || 0;
    episode.lastWatchedAt = Date.now();
    await writeRecord(EPISODES, episode);
  };
  const removeEpisode = async (id) => {
    const assets = await readEpisodeAssets(id);
    for (const asset of assets) await deleteRecord(ASSETS, asset.id);
    await deleteRecord(EPISODES, id);
    dispatchUpdate({ id, removed: true });
  };

  const createViewer = async (episode) => {
    document.querySelector('.offline-hls-viewer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'offline-hls-viewer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    const panel = document.createElement('div');
    panel.className = 'offline-hls-viewer__panel';
    const header = document.createElement('div');
    header.className = 'offline-hls-viewer__header';
    const title = document.createElement('h2');
    title.className = 'offline-hls-viewer__title';
    title.textContent = `${episode.seriesTitle} · ${episode.title}`;
    const badge = document.createElement('span');
    badge.className = 'offline-hls-viewer__badge';
    badge.textContent = '离线播放';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'offline-hls-viewer__close';
    close.setAttribute('aria-label', '关闭离线播放器');
    close.textContent = '×';
    const error = document.createElement('p');
    error.className = 'offline-hls-viewer__error';
    error.hidden = true;
    error.setAttribute('role', 'alert');
    header.append(title, badge, close);
    const video = document.createElement('video');
    video.className = 'offline-hls-viewer__video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    panel.append(header, error, video);
    layer.append(panel);
    document.body.append(layer);
    let hls;
    const showError = () => {
      error.textContent = '离线视频资源无法读取，请重新保存本集';
      error.hidden = false;
    };
    const closeViewer = () => {
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      layer.remove();
    };
    close.addEventListener('click', closeViewer);
    layer.addEventListener('click', (event) => { if (event.target === layer) closeViewer(); });
    video.addEventListener('error', showError);
    let lastSaved = 0;
    video.addEventListener('timeupdate', () => {
      if (video.currentTime - lastSaved >= 1) {
        lastSaved = video.currentTime;
        updatePosition(episode.id, video.currentTime).catch(() => {});
      }
    });
    const restorePosition = () => {
      try { video.currentTime = episode.watchPosition || 0; } catch { /* metadata may not be ready */ }
    };
    video.addEventListener('loadedmetadata', restorePosition, { once: true });
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = episode.localUrl;
    } else if (Hls?.isSupported?.()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.attachMedia(video);
      const errorEvent = Hls.Events?.ERROR;
      if (errorEvent) hls.on(errorEvent, (_event, data) => { if (data?.fatal) showError(); });
      hls.loadSource(episode.localUrl);
    } else {
      showError();
    }
    requestAnimationFrame(() => close.focus());
    return { close: closeViewer };
  };

  window.OfflineHls = {
    ERROR_CODES,
    OfflineHlsError,
    saveEpisode,
    createDownloadJob,
    updateDownloadJob,
    listDownloadJobs,
    getDownloadJob,
    cancelDownloadJob,
    recoverDownloadJobs,
    listEpisodes,
    getEpisode,
    removeEpisode,
    updatePosition,
    storageSummary,
    createViewer,
    episodeIdFor,
    localAssetUrl,
  };
  window.dispatchEvent(new Event('offline-hls-ready'));
})();
