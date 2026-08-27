(() => {
  const states = { idle: 'idle', selecting: 'selecting', saving: 'saving' };
  let toast;
  let lockLayer;
  let libraryLayer;
  let libraryList;
  let libraryBody;
  let libraryFooter;
  let libraryReturnFocus;
  let librarySort = 'recent';
  let libraryMediaQuery;
  let libraryMediaHandler;
  let libraryRenderVersion = 0;
  let activeQueue;
  let lastQueueResult;
  let recoverableJobs = [];
  const expandedGroups = new Set();
  const selectedEpisodeIds = new Set();
  const libraryState = {
    mode: 'browse',
    surface: 'desktop-dialog',
    expansionInitialized: false,
  };

  const getHeader = () => [...document.querySelectorAll('.dmodal__episodes-drawer-header, .dmodal__ep-header')]
    .find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

  const getModal = (header) => header?.closest('.dmodal');
  const getEpisodes = (header) => [...getModal(header)?.querySelectorAll('.dmodal__ep-btn[data-download-url]') || []];
  const seriesTitle = (header) => getModal(header)?.querySelector('.dmodal__title')?.textContent?.trim() || '离线观看';
  const detailsFor = (episode, header) => ({
    sourceUrl: episode.dataset.downloadUrl,
    title: episode.textContent.trim(),
    seriesTitle: seriesTitle(header),
  });
  const episodeIdForItem = (item) => OfflineHls.episodeIdFor(item.sourceUrl, item.title, item.seriesTitle);

  const getCurrentEpisode = (header) => {
    const episodes = getEpisodes(header);
    const remembered = window.__offlineCurrentEpisode;
    if (remembered && episodes.some((episode) => episode.dataset.downloadUrl === remembered.sourceUrl)) return remembered;
    const episode = episodes.find((item) => item.classList.contains('dmodal__ep-btn--resume')) || episodes[0];
    return episode ? detailsFor(episode, header) : null;
  };

  const formatBytes = (value) => {
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let amount = Number(value) || 0;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
  };

  const formatDuration = (value) => {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  const message = (text, tone = 'normal') => {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'episode-download-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.append(toast);
    }
    toast.dataset.tone = tone;
    toast.textContent = text;
    toast.hidden = false;
  };

  const errorText = (error) => {
    const code = error?.code || '';
    const map = {
      INVALID_URL: 'HLS 地址无效',
      HLS_HOST_NOT_ALLOWED: '服务器尚未允许此视频 CDN',
      REDIRECT_HOST_NOT_ALLOWED: '视频 CDN 重定向到未允许的域名',
      UPSTREAM_TIMEOUT: '视频服务器响应超时，可以重试',
      UPSTREAM_UNAVAILABLE: '无法访问视频服务器，可以重试',
      UPSTREAM_HTTP_ERROR: '视频资源已失效',
      HLS_CONTENT_INVALID: '视频格式暂不支持',
      HLS_LIVE_UNSUPPORTED: '直播流不能保存，只支持完整剧集',
      HLS_PARSE_ERROR: '播放列表解析失败',
      HLS_DRM_UNSUPPORTED: '受保护视频无法离线保存',
      STORAGE_QUOTA: '设备空间不足，请删除部分离线视频',
      DOWNLOAD_CANCELLED: '下载已暂停',
      DOWNLOAD_INTERRUPTED: '下载被中断，可以继续保存',
    };
    return map[code] || error?.message || '保存失败';
  };

  const ensureLock = () => {
    if (lockLayer) return lockLayer;
    lockLayer = document.createElement('div');
    lockLayer.className = 'episode-download-lock';
    lockLayer.hidden = true;
    lockLayer.setAttribute('role', 'dialog');
    lockLayer.setAttribute('aria-modal', 'true');
    lockLayer.setAttribute('aria-labelledby', 'episode-download-lock-title');
    lockLayer.innerHTML = '<div class="episode-download-lock__panel"><div class="episode-download-lock__icon" aria-hidden="true">↓</div><h2 id="episode-download-lock-title" class="episode-download-lock__title">正在保存视频</h2><p class="episode-download-lock__progress" data-download-progress>准备开始…</p><p class="episode-download-lock__hint" data-download-hint>保存期间不能播放或切换集数</p><div class="episode-download-lock__queue" data-download-queue></div><div class="episode-download-lock__actions"><button type="button" class="episode-download-lock__pause">暂停队列</button><button type="button" class="episode-download-lock__cancel">取消队列</button><button type="button" class="episode-download-lock__finish" hidden>完成</button></div></div>';
    lockLayer.querySelector('.episode-download-lock__pause').addEventListener('click', () => {
      if (activeQueue) {
        activeQueue.action = 'pause';
        activeQueue.controller?.abort();
      }
    });
    lockLayer.querySelector('.episode-download-lock__cancel').addEventListener('click', () => {
      if (activeQueue) {
        activeQueue.action = 'cancel';
        activeQueue.controller?.abort();
      } else {
        finishQueue();
      }
    });
    lockLayer.querySelector('.episode-download-lock__finish').addEventListener('click', finishQueue);
    document.body.append(lockLayer);
    return lockLayer;
  };

  const setInert = (locked) => {
    document.documentElement.dataset.downloadLock = locked ? 'true' : 'false';
    document.querySelectorAll('body > *:not(.episode-download-lock)').forEach((element) => {
      if (locked) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
    });
  };

  const lockVisible = (visible, progress = '') => {
    const layer = ensureLock();
    layer.hidden = !visible;
    setInert(visible);
    if (visible) {
      layer.querySelector('[data-download-progress]').textContent = progress;
      requestAnimationFrame(() => layer.querySelector('.episode-download-lock__pause')?.focus());
    }
  };

  const formatSeconds = (value) => {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? `${seconds.toFixed(1)}s` : '计算中';
  };

  const updateLock = (progress = {}) => {
    const layer = ensureLock();
    const current = progress.currentResource ? ` · ${progress.currentResource}` : '';
    const downloadedAssets = Number(progress.downloadedAssets ?? progress.currentAsset) || 0;
    const totalAssets = Number(progress.totalAssets) || 0;
    const percentage = totalAssets ? Math.min(100, Math.round(downloadedAssets / totalAssets * 100)) : 0;
    const speed = Number(progress.speedBytesPerSecond) > 0
      ? ` · ${formatBytes(progress.speedBytesPerSecond)}/s`
      : '';
    const eta = Number(progress.etaSeconds) > 0 ? ` · 剩余约 ${Math.ceil(progress.etaSeconds)} 秒` : '';
    const totalBytes = Number.isFinite(Number(progress.totalBytes)) && Number(progress.totalBytes) > 0
      ? ` · 总计 ${formatBytes(progress.totalBytes)}`
      : ' · 总大小计算中';
    const timer = Number(progress.totalDuration) > 0
      ? ` · ${formatSeconds(progress.downloadedDuration)} / ${formatSeconds(progress.totalDuration)}`
      : '';
    layer.querySelector('[data-download-progress]').textContent = `${percentage}% · ${downloadedAssets}/${totalAssets || '?'} 个资源${timer} · ${formatBytes(Number(progress.downloadedBytes) || 0)}${totalBytes}${speed}${eta}${current}`;
  };

  const setQueueRows = (queue) => {
    const host = ensureLock().querySelector('[data-download-queue]');
    host.replaceChildren();
    const completedIds = new Set(queue.completed.map((item) => episodeIdForItem(item)));
    const failedIds = new Set(queue.failed.map((item) => episodeIdForItem(item)));
    queue.items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'episode-download-lock__row';
      const id = episodeIdForItem(item);
      const status = failedIds.has(id) ? 'failed' : completedIds.has(id) ? 'completed' : index === queue.index ? 'active' : 'queued';
      row.dataset.status = status;
      row.textContent = `${status === 'failed' ? '!' : status === 'completed' ? '✓' : status === 'active' ? '↓' : '○'} ${item.title}`;
      host.append(row);
    });
  };

  const resetSelection = (header) => {
    getEpisodes(header).forEach((episode) => {
      episode.querySelector('input[type="checkbox"]')?.remove();
      episode.removeAttribute('aria-pressed');
    });
    header.dataset.downloadState = states.idle;
    header.closest('.dmodal__episodes, .dmodal__episodes-drawer')?.querySelector('.episode-download-actions')?.remove();
    const multi = header.querySelector('.episode-download-multi');
    if (multi) {
      multi.hidden = false;
      multi.setAttribute('aria-expanded', 'false');
    }
  };

  const currentSelected = (header) => getEpisodes(header)
    .filter((episode) => episode.querySelector('input[type="checkbox"]')?.checked)
    .map((episode) => detailsFor(episode, header));

  const updateSelection = async (header) => {
    const selected = currentSelected(header);
    const drawer = header.closest('.dmodal__episodes, .dmodal__episodes-drawer');
    const summary = drawer?.querySelector('.episode-download-summary');
    const start = drawer?.querySelector('.episode-download-start');
    if (summary) summary.textContent = `已选择 ${selected.length} 集${selected.length ? ' · 正在计算大小…' : ''}`;
    if (start) {
      start.disabled = !selected.length;
      start.textContent = selected.length ? `开始下载（${selected.length}）` : '开始下载';
    }
    if (selected.length && summary && window.OfflineHls) {
      const saved = await Promise.all(selected.map((item) => OfflineHls.getEpisode(OfflineHls.episodeIdFor(item.sourceUrl, item.title, item.seriesTitle))));
      const bytes = saved.reduce((sum, episode) => sum + Number(episode?.downloadedBytes || 0), 0);
      summary.textContent = `已选择 ${selected.length} 集 · 已占用 ${formatBytes(bytes)}，新增大小下载后计算`;
    }
  };

  const enterSelection = (header) => {
    header.dataset.downloadState = states.selecting;
    const drawer = header.closest('.dmodal__episodes, .dmodal__episodes-drawer');
    const multi = header.querySelector('.episode-download-multi');
    if (multi) {
      multi.hidden = true;
      multi.setAttribute('aria-expanded', 'true');
    }
    getEpisodes(header).forEach((episode) => {
      if (episode.querySelector('input[type="checkbox"]')) return;
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'episode-download-check';
      check.setAttribute('aria-label', `选择${episode.textContent.trim()}`);
      check.addEventListener('click', (event) => event.stopPropagation());
      check.addEventListener('change', () => {
        episode.setAttribute('aria-pressed', check.checked ? 'true' : 'false');
        updateSelection(header);
      });
      episode.append(check);
    });
    if (drawer && !drawer.querySelector('.episode-download-actions')) {
      const actions = document.createElement('div');
      actions.className = 'episode-download-actions';
      const summary = document.createElement('span');
      summary.className = 'episode-download-summary';
      summary.setAttribute('aria-live', 'polite');
      summary.textContent = '已选择 0 集';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'episode-download-cancel';
      cancel.textContent = '取消选择';
      cancel.addEventListener('click', () => resetSelection(header));
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'episode-download-start';
      start.disabled = true;
      start.textContent = '开始下载';
      start.addEventListener('click', () => startQueue(currentSelected(header), header));
      actions.append(summary, cancel, start);
      drawer.append(actions);
    }
    updateSelection(header);
  };

  const itemsForJob = async (job) => {
    const saved = await OfflineHls.listEpisodes();
    const savedById = new Map(saved.map((episode) => [episode.id, episode]));
    const metadataById = new Map((job.episodeMeta || []).map((item) => [item.id, item]));
    return job.episodeIds.map((id) => {
      const metadata = metadataById.get(id);
      const episode = savedById.get(id);
      if (metadata) return { sourceUrl: metadata.sourceUrl, title: metadata.title, seriesTitle: metadata.seriesTitle };
      if (episode?.sourceUrl) return { sourceUrl: episode.sourceUrl, title: episode.title, seriesTitle: episode.seriesTitle };
      return null;
    }).filter(Boolean);
  };

  const persistJob = async (job) => {
    const normalized = await OfflineHls.updateDownloadJob(job);
    Object.assign(job, normalized);
  };

  const startQueue = async (items, header, existingJob = null) => {
    if (activeQueue) {
      message('已有下载队列正在运行', 'error');
      return;
    }
    if (!items.length || !window.OfflineHls) {
      message('请先选择要下载的集数', 'error');
      return;
    }
    try {
      let queueItems = items;
      if (existingJob) {
        const recoveredItems = await itemsForJob(existingJob);
        if (recoveredItems.length) queueItems = recoveredItems;
      }
      const storage = await OfflineHls.storageSummary();
      if (storage.usageRatio >= .95 && !window.confirm('设备存储空间已接近上限，继续下载可能失败。仍要继续吗？')) return;
      if (storage.usageRatio >= .8) message('设备存储空间已使用超过 80%，建议先清理离线视频', 'error');
      const ids = queueItems.map(episodeIdForItem);
      const job = existingJob || await OfflineHls.createDownloadJob(ids, queueItems);
      if (!existingJob) {
        const mergedItems = await itemsForJob(job);
        if (mergedItems.length) queueItems = mergedItems;
      }
      const savedEpisodes = await OfflineHls.listEpisodes();
      const readyIds = new Set(savedEpisodes.filter((episode) => episode.status === 'ready').map((episode) => episode.id));
      const completed = queueItems.filter((item) => readyIds.has(episodeIdForItem(item)));
      const firstPendingIndex = queueItems.findIndex((item) => !readyIds.has(episodeIdForItem(item)));
      const queue = { job, items: queueItems, index: firstPendingIndex < 0 ? queueItems.length : firstPendingIndex, completed, failed: [], controller: null, action: null };
      const metadataById = new Map((job.episodeMeta || []).map((item) => [item.id, item]));
      queueItems.forEach((item) => metadataById.set(episodeIdForItem(item), { id: episodeIdForItem(item), ...item }));
      job.episodeIds = [...new Set(queueItems.map(episodeIdForItem))];
      job.episodeMeta = [...metadataById.values()];
      job.completedEpisodeIds = [...new Set([...(job.completedEpisodeIds || []), ...completed.map(episodeIdForItem)])];
      job.failedEpisodeIds = [];
      job.status = 'downloading';
      await persistJob(job);
      activeQueue = queue;
      lockVisible(true, `准备下载 ${queueItems.length} 集…`);
      setQueueRows(queue);
      const pauseButton = ensureLock().querySelector('.episode-download-lock__pause');
      const cancelButton = ensureLock().querySelector('.episode-download-lock__cancel');
      pauseButton.hidden = false;
      cancelButton.hidden = false;
      ensureLock().querySelector('.episode-download-lock__finish').hidden = true;

      for (; queue.index < queue.items.length;) {
        const index = queue.index;
        const item = queue.items[index];
        const episodeId = episodeIdForItem(item);
        if (readyIds.has(episodeId)) {
          if (!queue.completed.some((completedItem) => episodeIdForItem(completedItem) === episodeId)) queue.completed.push(item);
          queue.index += 1;
          job.currentIndex = queue.index;
          job.completedEpisodeIds = [...new Set([...job.completedEpisodeIds, episodeId])];
          await persistJob(job);
          setQueueRows(queue);
          continue;
        }
        job.currentEpisodeId = episodeId;
        job.currentIndex = index;
        await persistJob(job);
        setQueueRows(queue);
        queue.controller = new AbortController();
        queue.action = null;
        try {
          await OfflineHls.saveEpisode({ ...item, signal: queue.controller.signal, jobId: job.id, onProgress: updateLock });
          queue.completed.push(item);
          job.completedEpisodeIds = [...new Set([...job.completedEpisodeIds, episodeId])];
          job.failedEpisodeIds = job.failedEpisodeIds.filter((id) => id !== episodeId);
          queue.index += 1;
          job.currentIndex = queue.index;
          await persistJob(job);
        } catch (error) {
          if (queue.action === 'pause' || error.code === 'DOWNLOAD_CANCELLED') break;
          if (queue.action === 'cancel') break;
          queue.failed.push({ ...item, error });
          job.failedEpisodeIds = [...new Set([...job.failedEpisodeIds, episodeId])];
          queue.index += 1;
          job.currentIndex = queue.index;
          await persistJob(job);
        }
        setQueueRows(queue);
      }

      const paused = queue.action === 'pause' || (queue.index < queue.items.length && queue.action !== 'cancel' && queue.failed.length === 0);
      const cancelled = queue.action === 'cancel';
      const complete = queue.completed.length >= queue.items.length;
      job.status = paused || cancelled ? 'paused' : queue.failed.length ? 'failed' : complete ? 'completed' : 'paused';
      job.currentIndex = queue.index;
      job.currentEpisodeId = paused && queue.index < queue.items.length
        ? episodeIdForItem(queue.items[queue.index])
        : queue.failed.length
          ? episodeIdForItem(queue.failed[0])
          : null;
      await persistJob(job);
      const resumable = paused || (!complete && !cancelled && queue.failed.length === 0);
      lastQueueResult = { queue, paused: resumable, cancelled };
      activeQueue = null;
      ensureLock().querySelector('.episode-download-lock__pause').hidden = true;
      cancelButton.hidden = false;
      ensureLock().querySelector('.episode-download-lock__finish').hidden = false;
      cancelButton.textContent = paused ? '继续下载' : queue.failed.length ? '重试失败项目' : '完成';
      cancelButton.dataset.queueAction = paused ? 'resume' : queue.failed.length ? 'retry' : 'finish';
      ensureLock().querySelector('.episode-download-lock__finish').hidden = !(paused || queue.failed.length);
      ensureLock().querySelector('.episode-download-lock__title').textContent = paused
        ? '下载已暂停'
        : cancelled
          ? '队列已取消'
          : queue.failed.length
            ? '部分下载失败'
            : '下载完成';
      ensureLock().querySelector('[data-download-progress]').textContent = `${queue.completed.length}/${queue.items.length} 集完成${queue.failed.length ? ` · ${queue.failed.length} 集失败` : ''}`;
      ensureLock().querySelector('[data-download-hint]').textContent = paused
        ? '已完成资源会保留，可以继续下载'
        : queue.failed.length
          ? '已完成资源会保留，可以重试失败项目'
          : '已完成的剧集可以在离线观看中播放';
      await refreshRecoverableJobs();
    } catch (error) {
      activeQueue = null;
      lockVisible(false);
      message(errorText(error), 'error');
    }
  };

  const finishQueue = () => {
    const result = lastQueueResult;
    lockVisible(false);
    lastQueueResult = null;
    const header = getHeader();
    if (header) resetSelection(header);
    refreshRecoverableJobs().catch(() => {});
  };

  const handleQueueAction = async (action) => {
    const result = lastQueueResult;
    if (!result) return;
    if (action === 'retry') {
      const items = result.queue.failed.map((item) => {
        const copy = { ...item };
        delete copy.error;
        return copy;
      });
      const failedIds = new Set(items.map(episodeIdForItem));
      const firstIndex = Math.min(...items.map((item) => result.queue.job.episodeIds.indexOf(episodeIdForItem(item))).filter((index) => index >= 0));
      result.queue.job.currentIndex = Number.isFinite(firstIndex) ? firstIndex : result.queue.job.currentIndex;
      result.queue.job.failedEpisodeIds = [...(result.queue.job.failedEpisodeIds || [])].filter((id) => !failedIds.has(id));
      setQueueRows({ items, index: 0 });
      lastQueueResult = null;
      await startQueue(items, getHeader(), result.queue.job);
    } else if (action === 'resume') {
      lastQueueResult = null;
      await startQueue(result.queue.items, getHeader(), result.queue.job);
    } else {
      finishQueue();
    }
  };

  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const makeOfflineIcon = () => {
    const icon = make('span', 'mobile-tab__icon offline-library-trigger__icon');
    icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M12 3v11m0 0 4-4m-4 4-4-4');
    const tray = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tray.setAttribute('d', 'M5 18.5h14');
    svg.append(arrow, tray);
    icon.append(svg);
    return icon;
  };

  const currentRecoverableJob = () => recoverableJobs
    .find((candidate) => candidate.episodeIds.some((id) => !candidate.completedEpisodeIds.includes(id)));

  const renderStorageSummary = (summary) => {
    const card = libraryLayer?.querySelector('.offline-hls-library__storage');
    if (!card) return;
    const ratio = Math.max(0, Math.min(1, Number(summary.usageRatio || 0)));
    const warning = ratio >= .95 ? 'critical' : ratio >= .8 ? 'warning' : 'normal';
    card.dataset.warning = warning;
    card.querySelector('[data-storage-offline]').textContent = `离线内容 ${formatBytes(summary.downloadedBytes)}`;
    card.querySelector('[data-storage-available]').textContent = summary.quota
      ? `设备可用约 ${formatBytes(summary.available)}`
      : '设备可用空间暂时无法估算';
    card.querySelector('[data-storage-counts]').textContent = `已保存 ${summary.readyCount} 集 · 未完成 ${summary.incompleteCount} 集`;
    const meter = card.querySelector('[data-storage-meter]');
    meter.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    meter.querySelector('span').style.width = `${Math.max(2, ratio * 100)}%`;
    const warningText = card.querySelector('[data-storage-warning]');
    warningText.hidden = warning === 'normal';
    warningText.textContent = warning === 'critical'
      ? '设备空间接近上限，请先管理离线内容'
      : '设备空间使用较高，请留意剩余容量';
  };

  const updateQueueNotice = (displayedEpisodeIds = null) => {
    const notice = libraryLayer?.querySelector('.offline-hls-library__queue-notice');
    if (!notice) return;
    const job = currentRecoverableJob();
    if (!job || (displayedEpisodeIds && job.episodeIds.every((id) => displayedEpisodeIds.has(id)))) {
      notice.hidden = true;
      return;
    }
    const pendingIds = job.episodeIds.filter((id) => !job.completedEpisodeIds.includes(id));
    const current = job.currentEpisodeId ? (job.episodeMeta || []).find((item) => item.id === job.currentEpisodeId) : null;
    const failed = (job.episodeMeta || []).find((item) => job.failedEpisodeIds?.includes(item.id));
    notice.hidden = false;
    notice.querySelector('.offline-hls-library__queue-title').textContent = `未完成下载 · ${pendingIds.length} 集待处理`;
    notice.querySelector('.offline-hls-library__queue-text').textContent = current
      ? `当前：${current.seriesTitle || '离线观看'} · ${current.title}`
      : failed
        ? `最近失败：${failed.seriesTitle || '离线观看'} · ${failed.title}`
        : '已保留完成的分片，可从断点继续';
    const resume = notice.querySelector('.offline-hls-library__queue-resume');
    resume.disabled = Boolean(activeQueue);
    resume.onclick = async () => {
      try {
        const items = await itemsForJob(job);
        if (!items.length) {
          message('找不到未完成下载的剧集信息', 'error');
          return;
        }
        await startQueue(items, getHeader(), job);
      } catch (error) {
        message(errorText(error), 'error');
      }
    };
    const cancel = notice.querySelector('.offline-hls-library__queue-cancel');
    cancel.disabled = Boolean(activeQueue);
    cancel.onclick = async () => {
      try {
        await OfflineHls.cancelDownloadJob(job.id);
        recoverableJobs = recoverableJobs.filter((candidate) => candidate.id !== job.id);
        await renderLibrary();
        message('下载任务已移除，已下载分片仍会保留', 'success');
      } catch (error) {
        message(errorText(error), 'error');
      }
    };
  };

  const refreshRecoverableJobs = async () => {
    if (!window.OfflineHls) return;
    recoverableJobs = await OfflineHls.recoverDownloadJobs();
    updateQueueNotice();
    if (libraryLayer) await renderLibrary();
  };

  const sortEpisodes = (episodes) => episodes.sort((left, right) => librarySort === 'size'
    ? Number(right.downloadedBytes || 0) - Number(left.downloadedBytes || 0)
    : Number(right.lastWatchedAt || right.updatedAt || 0) - Number(left.lastWatchedAt || left.updatedAt || 0));

  const groupEpisodes = (episodes) => {
    const groups = new Map();
    episodes.forEach((episode) => {
      const title = episode.seriesTitle?.trim() || '未命名视频';
      if (!groups.has(title)) groups.set(title, { title, episodes: [] });
      groups.get(title).episodes.push(episode);
    });
    return [...groups.values()]
      .map((group) => {
        sortEpisodes(group.episodes);
        group.totalBytes = group.episodes.reduce((sum, episode) => sum + Number(episode.downloadedBytes || 0), 0);
        group.readyCount = group.episodes.filter((episode) => episode.status === 'ready').length;
        group.updatedAt = Math.max(...group.episodes.map((episode) => Number(episode.lastWatchedAt || episode.updatedAt || 0)));
        return group;
      })
      .sort((left, right) => librarySort === 'size'
        ? right.totalBytes - left.totalBytes
        : right.updatedAt - left.updatedAt);
  };

  const updateManagementFooter = () => {
    if (!libraryFooter) return;
    const count = selectedEpisodeIds.size;
    libraryFooter.querySelector('[data-selected-count]').textContent = `已选择 ${count} 集`;
    const remove = libraryFooter.querySelector('.offline-hls-library__manage-remove');
    remove.disabled = count === 0;
    remove.textContent = `删除已选（${count}）`;
  };

  const syncGroupSelection = (groupElement, episodeIds) => {
    const selected = episodeIds.filter((id) => selectedEpisodeIds.has(id)).length;
    const groupCheck = groupElement.querySelector('.offline-hls-library__group-check');
    if (!groupCheck) return;
    groupCheck.checked = episodeIds.length > 0 && selected === episodeIds.length;
    groupCheck.indeterminate = selected > 0 && selected < episodeIds.length;
  };

  const setEpisodeSelected = (episodeId, selected, groupElement, groupEpisodeIds) => {
    if (selected) selectedEpisodeIds.add(episodeId);
    else selectedEpisodeIds.delete(episodeId);
    const check = groupElement.querySelector(`.offline-hls-library__check[value="${CSS.escape(episodeId)}"]`);
    if (check) check.checked = selected;
    syncGroupSelection(groupElement, groupEpisodeIds);
    updateManagementFooter();
  };

  const episodeStatus = (episode) => {
    if (episode.status === 'ready') return { badge: '已保存', detail: formatBytes(episode.downloadedBytes) };
    if (episode.status === 'failed') return {
      badge: '保存失败',
      detail: errorText({ code: episode.lastErrorCode, message: episode.lastErrorMessage }),
    };
    const assets = episode.totalAssets > 0 ? `${episode.downloadedAssets}/${episode.totalAssets} 个资源 · ` : '';
    return { badge: '未完成', detail: `${assets}${formatBytes(episode.downloadedBytes)}` };
  };

  const renderEpisodeCard = (episode, groupElement, groupEpisodeIds) => {
    const item = make('article', 'offline-hls-library__item');
    item.dataset.status = episode.status || 'paused';
    if (libraryState.mode === 'manage') {
      item.dataset.selectable = 'true';
      const selection = make('label', 'offline-hls-library__selection-hit');
      const check = make('input', 'offline-hls-library__check');
      check.type = 'checkbox';
      check.value = episode.id;
      check.checked = selectedEpisodeIds.has(episode.id);
      check.setAttribute('aria-label', `选择${episode.title}`);
      check.addEventListener('change', () => setEpisodeSelected(episode.id, check.checked, groupElement, groupEpisodeIds));
      selection.append(check);
      item.append(selection);
      item.addEventListener('click', (event) => {
        if (event.target.closest('input, label, button, a')) return;
        setEpisodeSelected(episode.id, !selectedEpisodeIds.has(episode.id), groupElement, groupEpisodeIds);
      });
    }

    const info = make('div', 'offline-hls-library__info');
    const heading = make('div', 'offline-hls-library__episode-heading');
    heading.append(make('strong', 'offline-hls-library__name', episode.title || '本集'));
    const status = episodeStatus(episode);
    const badge = make('span', 'offline-hls-library__badge', status.badge);
    badge.dataset.status = episode.status || 'paused';
    heading.append(badge);
    info.append(heading);
    const watched = episode.watchPosition ? ` · 继续观看 ${formatDuration(episode.watchPosition)}` : '';
    info.append(make('span', 'offline-hls-library__status', `${status.detail}${watched}`));

    item.append(info);
    if (libraryState.mode === 'browse') {
      const actions = make('div', 'offline-hls-library__actions');
      if (episode.status === 'ready') {
        const play = make('button', 'offline-hls-library__play', episode.watchPosition ? '继续观看' : '播放');
        play.type = 'button';
        play.addEventListener('click', () => OfflineHls.createViewer(episode).catch((error) => message(errorText(error), 'error')));
        actions.append(play);
      } else {
        const resume = make('button', 'offline-hls-library__play', '继续下载');
        resume.type = 'button';
        resume.addEventListener('click', () => startQueue([{
          sourceUrl: episode.sourceUrl,
          title: episode.title,
          seriesTitle: episode.seriesTitle,
        }], getHeader()));
        actions.append(resume);
      }
      const remove = make('button', 'offline-hls-library__remove', '删除');
      remove.type = 'button';
      remove.setAttribute('aria-label', `删除${episode.title}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm(`确定删除“${episode.title}”的离线文件吗？`)) return;
        await OfflineHls.removeEpisode(episode.id);
        selectedEpisodeIds.delete(episode.id);
        await renderLibrary();
        message('已删除离线文件', 'success');
      });
      actions.append(remove);
      item.append(actions);
    }
    return item;
  };

  const removeEpisodeIds = async (ids) => {
    for (const id of [...new Set(ids)]) await OfflineHls.removeEpisode(id);
  };

  const renderLibrary = async () => {
    if (!libraryLayer || !window.OfflineHls) return;
    const renderVersion = ++libraryRenderVersion;
    const layer = libraryLayer;
    const list = libraryList;
    try {
      const [summary, episodes] = await Promise.all([
        OfflineHls.storageSummary(),
        OfflineHls.listEpisodes(),
      ]);
      if (renderVersion !== libraryRenderVersion || libraryLayer !== layer || libraryList !== list) return;
      list.replaceChildren();
      renderStorageSummary(summary);
      const groups = groupEpisodes(episodes);
      updateQueueNotice(new Set(episodes.map((episode) => episode.id)));
      const pendingEpisodeIds = new Set(currentRecoverableJob()?.episodeIds || []);
      groups.sort((left, right) => {
        const leftPending = left.episodes.some((episode) => pendingEpisodeIds.has(episode.id));
        const rightPending = right.episodes.some((episode) => pendingEpisodeIds.has(episode.id));
        return Number(rightPending) - Number(leftPending);
      });
      const existingIds = new Set(episodes.map((episode) => episode.id));
      [...selectedEpisodeIds].forEach((id) => { if (!existingIds.has(id)) selectedEpisodeIds.delete(id); });
      const manage = libraryLayer.querySelector('.offline-hls-library__manage');
      manage.setAttribute('aria-pressed', String(libraryState.mode === 'manage'));
      manage.textContent = libraryState.mode === 'manage' ? '完成' : '管理';
      libraryLayer.dataset.mode = libraryState.mode;
      libraryFooter.hidden = libraryState.mode !== 'manage';
      libraryLayer.querySelectorAll('.offline-hls-library__sort').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.sort === librarySort));
      });
      if (!groups.length) {
        const empty = make('div', 'offline-hls-library__empty');
        empty.append(
          make('strong', '', '暂无离线内容'),
          make('span', '', '保存剧集后，可在断网时从这里播放'),
        );
        list.append(empty);
        manage.disabled = true;
        updateManagementFooter();
        return;
      }
      manage.disabled = false;

      if (!libraryState.expansionInitialized || !groups.some((group) => expandedGroups.has(group.title))) {
        const target = groups.find((group) => group.episodes.some((episode) => pendingEpisodeIds.has(episode.id))) || groups[0];
        expandedGroups.clear();
        if (target) expandedGroups.add(target.title);
        libraryState.expansionInitialized = true;
      }

      groups.forEach((group, groupIndex) => {
        const groupId = `offline-group-${groupIndex + 1}`;
        const groupElement = make('article', 'offline-hls-library__group');
        const groupHeader = make('div', 'offline-hls-library__group-header');
        const groupEpisodeIds = group.episodes.map((episode) => episode.id);
        if (libraryState.mode === 'manage') {
          const selection = make('label', 'offline-hls-library__selection-hit offline-hls-library__group-selection');
          const groupCheck = make('input', 'offline-hls-library__group-check');
          groupCheck.type = 'checkbox';
          groupCheck.setAttribute('aria-label', `选择${group.title}的全部集数`);
          groupCheck.addEventListener('change', () => {
            groupEpisodeIds.forEach((id) => {
              if (groupCheck.checked) selectedEpisodeIds.add(id);
              else selectedEpisodeIds.delete(id);
            });
            renderLibrary();
          });
          selection.append(groupCheck);
          groupHeader.append(selection);
        }
        const toggle = make('button', 'offline-hls-library__group-toggle');
        const expanded = expandedGroups.has(group.title);
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-controls', groupId);
        const heading = make('span', 'offline-hls-library__group-heading');
        heading.append(
          make('strong', 'offline-hls-library__group-title', group.title),
          make('span', 'offline-hls-library__group-meta', `${group.episodes.length} 集 · ${group.readyCount} 集已保存 · ${formatBytes(group.totalBytes)}`),
        );
        const chevron = make('span', 'offline-hls-library__group-chevron', expanded ? '⌃' : '⌄');
        chevron.setAttribute('aria-hidden', 'true');
        toggle.append(heading, chevron);
        toggle.addEventListener('click', () => {
          const nextExpanded = toggle.getAttribute('aria-expanded') !== 'true';
          toggle.setAttribute('aria-expanded', String(nextExpanded));
          chevron.textContent = nextExpanded ? '⌃' : '⌄';
          episodesElement.hidden = !nextExpanded;
          if (nextExpanded) expandedGroups.add(group.title);
          else expandedGroups.delete(group.title);
        });
        groupHeader.append(toggle);

        const episodesElement = make('div', 'offline-hls-library__group-episodes');
        episodesElement.id = groupId;
        episodesElement.hidden = !expanded;
        group.episodes.forEach((episode) => episodesElement.append(renderEpisodeCard(episode, groupElement, groupEpisodeIds)));
        groupElement.append(groupHeader, episodesElement);
        list.append(groupElement);
        syncGroupSelection(groupElement, groupEpisodeIds);
      });
      updateManagementFooter();
    } catch (error) {
      if (renderVersion !== libraryRenderVersion || libraryLayer !== layer || libraryList !== list) return;
      list.replaceChildren();
      const storage = libraryLayer.querySelector('.offline-hls-library__storage');
      storage.dataset.warning = 'critical';
      storage.querySelector('[data-storage-offline]').textContent = '存储信息暂时无法读取';
      list.append(make('p', 'offline-hls-library__empty', errorText(error)));
    }
  };

  const applyLibrarySurface = () => {
    if (!libraryLayer) return;
    const mobile = libraryMediaQuery?.matches ?? window.matchMedia('(max-width: 600px)').matches;
    libraryState.surface = mobile ? 'mobile-page' : 'desktop-dialog';
    libraryLayer.dataset.surface = libraryState.surface;
    libraryLayer.classList.toggle('offline-hls-library--mobile-page', mobile);
    const close = libraryLayer.querySelector('.offline-hls-library__close');
    if (mobile) {
      libraryLayer.setAttribute('role', 'region');
      libraryLayer.removeAttribute('aria-modal');
      close.hidden = true;
    } else {
      libraryLayer.setAttribute('role', 'dialog');
      libraryLayer.setAttribute('aria-modal', 'true');
      close.hidden = false;
    }
  };

  const setMobileOfflineState = (open) => {
    const trigger = document.querySelector('nav.mobile-tab .mobile-offline-trigger');
    if (!trigger) return;
    trigger.classList.toggle('mobile-tab__btn--active', open);
    trigger.setAttribute('aria-expanded', String(open));
  };

  const closeLibrary = ({ restoreFocus = true } = {}) => {
    if (!libraryLayer) {
      setMobileOfflineState(false);
      return;
    }
    const focusTarget = libraryReturnFocus;
    libraryRenderVersion += 1;
    libraryLayer.remove();
    if (libraryMediaQuery && libraryMediaHandler) libraryMediaQuery.removeEventListener('change', libraryMediaHandler);
    libraryLayer = null;
    libraryList = null;
    libraryBody = null;
    libraryFooter = null;
    libraryReturnFocus = null;
    libraryMediaQuery = null;
    libraryMediaHandler = null;
    libraryState.mode = 'browse';
    selectedEpisodeIds.clear();
    setMobileOfflineState(false);
    if (restoreFocus && focusTarget?.isConnected) requestAnimationFrame(() => focusTarget.focus());
  };

  const openLibrary = async () => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeLibrary({ restoreFocus: false });
    libraryReturnFocus = returnFocus;
    libraryLayer = make('div', 'offline-hls-library');
    libraryLayer.id = 'offline-library-dialog';
    libraryLayer.setAttribute('aria-labelledby', 'offline-library-title');
    const panel = make('div', 'offline-hls-library__panel');
    const header = make('div', 'offline-hls-library__header');
    const title = make('h2', 'offline-hls-library__title', '离线观看');
    title.id = 'offline-library-title';
    header.append(title);
    const close = make('button', 'offline-hls-library__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭离线观看');
    close.addEventListener('click', () => closeLibrary());
    header.append(close);
    libraryBody = make('div', 'offline-hls-library__body');
    const storage = make('section', 'offline-hls-library__storage');
    storage.setAttribute('aria-label', '离线存储摘要');
    const storageTop = make('div', 'offline-hls-library__storage-top');
    const storageOffline = make('strong', '', '正在读取存储空间…');
    storageOffline.dataset.storageOffline = '';
    const storageAvailable = make('span', '', '');
    storageAvailable.dataset.storageAvailable = '';
    storageTop.append(storageOffline, storageAvailable);
    const storageCounts = make('span', 'offline-hls-library__storage-counts', '');
    storageCounts.dataset.storageCounts = '';
    const meter = make('div', 'offline-hls-library__storage-meter');
    meter.dataset.storageMeter = '';
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', '设备存储使用率');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.append(make('span', ''));
    const storageWarning = make('span', 'offline-hls-library__storage-warning', '');
    storageWarning.dataset.storageWarning = '';
    storageWarning.hidden = true;
    storage.append(storageTop, storageCounts, meter, storageWarning);
    const queueNotice = make('div', 'offline-hls-library__queue-notice');
    queueNotice.hidden = true;
    queueNotice.setAttribute('role', 'status');
    const queueCopy = make('div', 'offline-hls-library__queue-copy');
    queueCopy.append(
      make('strong', 'offline-hls-library__queue-title', ''),
      make('span', 'offline-hls-library__queue-text', ''),
    );
    const queueActions = make('div', 'offline-hls-library__queue-actions');
    const queueResume = make('button', 'offline-hls-library__queue-resume', '继续下载');
    queueResume.type = 'button';
    const queueCancel = make('button', 'offline-hls-library__queue-cancel', '移除任务');
    queueCancel.type = 'button';
    queueActions.append(queueResume, queueCancel);
    queueNotice.append(
      queueCopy,
      queueActions,
    );
    const toolbar = make('div', 'offline-hls-library__toolbar');
    const sortGroup = make('div', 'offline-hls-library__sort-group');
    sortGroup.setAttribute('aria-label', '离线内容排序');
    const recent = make('button', 'offline-hls-library__sort', '最近观看');
    recent.type = 'button';
    recent.dataset.sort = 'recent';
    const size = make('button', 'offline-hls-library__sort', '文件大小');
    size.type = 'button';
    size.dataset.sort = 'size';
    sortGroup.append(recent, size);
    const manage = make('button', 'offline-hls-library__manage', '管理');
    manage.type = 'button';
    manage.setAttribute('aria-pressed', 'false');
    recent.addEventListener('click', () => {
      librarySort = 'recent';
      renderLibrary();
    });
    size.addEventListener('click', () => {
      librarySort = 'size';
      renderLibrary();
    });
    manage.addEventListener('click', () => {
      libraryState.mode = libraryState.mode === 'browse' ? 'manage' : 'browse';
      if (libraryState.mode === 'browse') selectedEpisodeIds.clear();
      renderLibrary();
    });
    toolbar.append(sortGroup, manage);
    libraryList = make('div', 'offline-hls-library__list offline-hls-library__groups');
    libraryFooter = make('div', 'offline-hls-library__manage-footer');
    libraryFooter.hidden = true;
    const selectedCount = make('strong', '', '已选择 0 集');
    selectedCount.dataset.selectedCount = '';
    const manageCancel = make('button', 'offline-hls-library__manage-cancel', '取消');
    manageCancel.type = 'button';
    manageCancel.addEventListener('click', () => {
      libraryState.mode = 'browse';
      selectedEpisodeIds.clear();
      renderLibrary();
    });
    const manageRemove = make('button', 'offline-hls-library__manage-remove', '删除已选（0）');
    manageRemove.type = 'button';
    manageRemove.disabled = true;
    manageRemove.addEventListener('click', async () => {
      const ids = [...selectedEpisodeIds];
      if (!ids.length) return;
      if (!window.confirm(`确定删除已选的 ${ids.length} 集离线文件吗？`)) return;
      await removeEpisodeIds(ids);
      selectedEpisodeIds.clear();
      libraryState.mode = 'browse';
      await renderLibrary();
      message('已删除选中的离线文件', 'success');
    });
    libraryFooter.append(selectedCount, manageCancel, manageRemove);
    libraryBody.append(storage, queueNotice, toolbar, libraryList);
    panel.append(header, libraryBody, libraryFooter);
    libraryLayer.append(panel);
    libraryLayer.addEventListener('click', (event) => {
      if (event.target === libraryLayer && libraryState.surface === 'desktop-dialog') closeLibrary();
    });
    libraryLayer.addEventListener('keydown', (event) => {
      if (libraryState.surface !== 'desktop-dialog') return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLibrary();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...libraryLayer.querySelectorAll('button:not([disabled]):not([hidden]),input:not([disabled]):not([hidden]),a[href]')]
        .filter((element) => element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.body.append(libraryLayer);
    libraryMediaQuery = window.matchMedia('(max-width: 600px)');
    libraryMediaHandler = () => {
      applyLibrarySurface();
      requestAnimationFrame(() => {
        const target = libraryState.surface === 'desktop-dialog' ? close : title;
        target.focus();
      });
    };
    libraryMediaQuery.addEventListener('change', libraryMediaHandler);
    title.tabIndex = -1;
    applyLibrarySurface();
    setMobileOfflineState(true);
    recoverableJobs = await OfflineHls.recoverDownloadJobs();
    await renderLibrary();
    requestAnimationFrame(() => (libraryState.surface === 'desktop-dialog' ? close : title).focus());
  };

  const ensureTrigger = () => {
    const navItem = [...document.querySelectorAll('button, a')]
      .find((element) => element.textContent.trim() === '我的列表' && !element.closest('nav.mobile-tab'));
    if (navItem && !navItem.parentElement?.querySelector('.offline-library-trigger:not(.mobile-offline-trigger)')) {
      const button = make('button', 'offline-library-trigger', '离线观看');
      button.type = 'button';
      button.setAttribute('aria-label', '打开离线观看列表');
      button.addEventListener('click', openLibrary);
      navItem.parentElement.append(button);
    }
    const mobileNav = document.querySelector('nav.mobile-tab');
    const mobileList = mobileNav?.querySelector('.mobile-tab__list');
    if (mobileNav && mobileList && !mobileNav.querySelector('.mobile-offline-trigger')) {
      const button = make('button', 'mobile-tab__btn offline-library-trigger mobile-offline-trigger');
      button.type = 'button';
      button.setAttribute('aria-label', '打开离线观看列表');
      button.setAttribute('aria-controls', 'offline-library-dialog');
      button.setAttribute('aria-expanded', 'false');
      button.append(
        makeOfflineIcon(),
        make('span', 'mobile-tab__label offline-library-trigger__label', '离线'),
      );
      button.addEventListener('click', openLibrary);
      mobileList.append(button);
    }
    if (mobileNav && mobileNav.dataset.offlineNavigationBound !== 'true') {
      mobileNav.dataset.offlineNavigationBound = 'true';
      mobileNav.addEventListener('click', (event) => {
        const target = event.target.closest('.mobile-tab__btn');
        if (libraryLayer && target && !target.classList.contains('mobile-offline-trigger')) {
          closeLibrary({ restoreFocus: false });
        }
      }, true);
    }
  };

  const decorate = () => {
    const header = getHeader();
    if (header && window.OfflineHls) {
      if (!header.querySelector('.episode-download-multi')) {
        const multi = make('button', 'episode-download-multi', '下载剧集');
        multi.type = 'button';
        multi.setAttribute('aria-label', '选择要下载的剧集');
        multi.setAttribute('aria-expanded', 'false');
        multi.addEventListener('click', () => enterSelection(header));
        header.append(multi);
      }
    }
    ensureTrigger();
  };

  document.addEventListener('click', (event) => {
    const episode = event.target.closest?.('.dmodal__ep-btn[data-download-url]');
    if (episode && !document.documentElement.dataset.downloadLock) {
      const header = getHeader();
      window.__offlineCurrentEpisode = detailsFor(episode, header);
    }
    const selectedHeader = getHeader();
    if (selectedHeader?.dataset.downloadState === states.selecting && episode) {
      if (event.target.closest('input[type="checkbox"]')) return;
      event.preventDefault();
      event.stopPropagation();
      const check = episode.querySelector('input[type="checkbox"]');
      if (check) {
        check.checked = !check.checked;
        check.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (activeQueue && !event.target.closest('.episode-download-lock')) {
      event.preventDefault();
      event.stopPropagation();
    }
    const action = event.target.closest?.('.episode-download-lock__cancel')?.dataset.queueAction;
    if (action) handleQueueAction(action).catch((error) => message(errorText(error), 'error'));
  }, true);

  document.addEventListener('keydown', (event) => {
    if (libraryLayer && libraryState.surface === 'desktop-dialog' && event.key === 'Escape') {
      event.preventDefault();
      closeLibrary();
      return;
    }
    const header = getHeader();
    if (header?.dataset.downloadState === states.selecting
      && [' ', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(event.key)
      && !event.target.closest('.episode-download-check')) event.preventDefault();
    if (activeQueue && ['Escape', ' ', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.preventDefault();
  });

  window.addEventListener('offline-hls-ready', decorate);
  window.addEventListener('offline-hls-updated', () => {
    decorate();
    if (libraryLayer) renderLibrary();
  });
  window.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });
    decorate();
    refreshRecoverableJobs().catch(() => {});
  });
})();
