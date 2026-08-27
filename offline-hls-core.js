const REDIRECT_PROTOCOLS = new Set(['http:', 'https:']);

export const HLS_ERROR_CODES = {
  CONTENT_INVALID: 'HLS_CONTENT_INVALID',
  LIVE_UNSUPPORTED: 'HLS_LIVE_UNSUPPORTED',
  PARSE_ERROR: 'HLS_PARSE_ERROR',
  DRM_UNSUPPORTED: 'HLS_DRM_UNSUPPORTED',
};

export const parseAttributes = (line) => {
  const attributes = {};
  const separator = line.indexOf(':');
  const source = separator >= 0 ? line.slice(separator + 1) : line;
  source.replace(/([A-Z0-9-]+)=((?:"[^"]*")|(?:[^,]*))(?:,|$)/g, (_, key, value) => {
    attributes[key] = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    return _;
  });
  return attributes;
};

export const resolveHlsUrl = (value, baseUrl) => {
  let resolved;
  try {
    resolved = new URL(value, baseUrl);
  } catch {
    const error = new Error('HLS 地址无效');
    error.code = HLS_ERROR_CODES.PARSE_ERROR;
    throw error;
  }
  if (!REDIRECT_PROTOCOLS.has(resolved.protocol)) {
    const error = new Error('HLS 地址协议不受支持');
    error.code = HLS_ERROR_CODES.CONTENT_INVALID;
    throw error;
  }
  return resolved.toString();
};

const linesOf = (text) => String(text || '').split(/\r?\n/);
const uriLineAt = (lines, index) => {
  const value = lines[index + 1]?.trim();
  return value && !value.startsWith('#') ? value : null;
};

const unsupportedEncryption = (message) => {
  const error = new Error(message);
  error.code = HLS_ERROR_CODES.DRM_UNSUPPORTED;
  throw error;
};

export const parseMasterPlaylist = (text, baseUrl) => {
  const lines = linesOf(text);
  if (!lines.some((line) => line.trim() === '#EXTM3U')) {
    const error = new Error('播放列表缺少 EXTM3U 标记');
    error.code = HLS_ERROR_CODES.CONTENT_INVALID;
    throw error;
  }
  const variants = [];
  const audioRenditions = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = uriLineAt(lines, index);
      if (!uri) return;
      const attributes = parseAttributes(trimmed);
      variants.push({
        url: resolveHlsUrl(uri, baseUrl),
        bandwidth: Number(attributes.BANDWIDTH || 0),
        averageBandwidth: Number(attributes['AVERAGE-BANDWIDTH'] || 0),
        attributes,
      });
    }
    if (trimmed.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributes(trimmed);
      if (attributes.TYPE === 'AUDIO' && attributes.URI) {
        audioRenditions.push({
          url: resolveHlsUrl(attributes.URI, baseUrl),
          attributes,
        });
      }
    }
    if (trimmed.startsWith('#EXT-X-SESSION-KEY:')) {
      const attributes = parseAttributes(trimmed);
      const method = attributes.METHOD || 'NONE';
      const keyFormat = attributes.KEYFORMAT || 'identity';
      if (method !== 'NONE' && (method !== 'AES-128' || keyFormat !== 'identity')) unsupportedEncryption('仅支持 AES-128 和 identity 密钥');
    }
  });
  const selectedVariant = [...variants].sort((left, right) => (right.bandwidth || right.averageBandwidth) - (left.bandwidth || left.averageBandwidth))[0] || null;
  const audioGroup = selectedVariant?.attributes?.AUDIO;
  const matchingAudio = audioGroup
    ? audioRenditions
      .filter((audio) => audio.attributes['GROUP-ID'] === audioGroup)
      .sort((left, right) => Number(right.attributes.DEFAULT === 'YES') - Number(left.attributes.DEFAULT === 'YES'))[0] || null
    : null;
  return {
    lines,
    variants,
    audioRenditions,
    selectedVariant,
    selectedAudio: matchingAudio,
    isMaster: variants.length > 0,
  };
};

const parseByteRange = (value, previousEnd = 0) => {
  if (!value) return null;
  const [lengthText, offsetText] = value.split('@');
  const length = Number(lengthText);
  if (!Number.isFinite(length) || length <= 0) return null;
  const offset = Number.isFinite(Number(offsetText)) ? Number(offsetText) : previousEnd;
  return { length, offset, header: `bytes=${offset}-${offset + length - 1}`, end: offset + length };
};

const resourceIdentity = (kind, url, range) => `${kind}|${url}|${range || ''}`;

export const parseMediaPlaylist = (text, baseUrl, trackId = 'video') => {
  const lines = linesOf(text);
  if (!lines.some((line) => line.trim() === '#EXTM3U')) {
    const error = new Error('播放列表缺少 EXTM3U 标记');
    error.code = HLS_ERROR_CODES.CONTENT_INVALID;
    throw error;
  }
  if (!lines.some((line) => line.trim() === '#EXT-X-ENDLIST')) {
    const error = new Error('直播流不能保存，只支持完整剧集');
    error.code = HLS_ERROR_CODES.LIVE_UNSUPPORTED;
    throw error;
  }

  const resources = [];
  const resourceMap = new Map();
  const entries = [];
  let pendingDuration = 0;
  let pendingRange = null;
  const rangeEnds = new Map();
  let sequence = 0;

  const addResource = (kind, rawUrl, range, duration = 0) => {
    const url = resolveHlsUrl(rawUrl, baseUrl);
    const identity = resourceIdentity(kind, url, range?.header);
    let resource = resourceMap.get(identity);
    if (!resource) {
      resource = {
        key: identity,
        kind,
        trackId,
        url,
        range: range?.header || null,
        rangeLength: range?.length || null,
        duration: Number(duration) || 0,
        sequence: sequence++,
      };
      resources.push(resource);
      resourceMap.set(identity, resource);
    } else if (duration && !resource.duration) {
      resource.duration = Number(duration) || 0;
    }
    return resource;
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      pendingDuration = Number(trimmed.slice(8).split(',')[0]) || 0;
      entries.push({ type: 'text', line });
      return;
    }
    if (trimmed.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(trimmed.slice(trimmed.indexOf(':') + 1), rangeEnds.get('segment') || 0);
      if (pendingRange) rangeEnds.set('segment', pendingRange.end);
      entries.push({ type: 'byterange', line, range: pendingRange });
      return;
    }
    if (trimmed.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributes(trimmed);
      const method = attributes.METHOD || 'NONE';
      const keyFormat = attributes.KEYFORMAT || 'identity';
      if (method !== 'NONE' && (method !== 'AES-128' || keyFormat !== 'identity')) unsupportedEncryption('仅支持 AES-128 和 identity 密钥');
      const resource = attributes.URI ? addResource('key', attributes.URI, null) : null;
      entries.push({ type: 'key', line, resource });
      return;
    }
    if (trimmed.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributes(trimmed);
      const range = parseByteRange(attributes.BYTERANGE, rangeEnds.get('map') || 0);
      if (range) rangeEnds.set('map', range.end);
      const resource = attributes.URI ? addResource('init', attributes.URI, range) : null;
      entries.push({ type: 'map', line, resource });
      return;
    }
    if (trimmed && !trimmed.startsWith('#')) {
      const range = pendingRange;
      pendingRange = null;
      const resource = addResource('segment', trimmed, range, pendingDuration);
      pendingDuration = 0;
      entries.push({ type: 'uri', line, resource });
      return;
    }
    entries.push({ type: 'text', line });
  });

  return {
    trackId,
    lines,
    entries,
    resources,
    totalDuration: resources.filter((resource) => resource.kind === 'segment').reduce((sum, resource) => sum + resource.duration, 0) || null,
  };
};

export const rewriteMediaPlaylist = (playlist, localPathFor) => playlist.entries.map((entry) => {
  if (entry.type === 'byterange' && entry.range) return '';
  if (entry.type === 'uri' && entry.resource) return localPathFor(entry.resource, entry.line);
  if ((entry.type === 'key' || entry.type === 'map') && entry.resource) {
    const localLine = entry.line.replace(/URI="([^"]+)"/, `URI="${localPathFor(entry.resource)}"`);
    return entry.type === 'map' && entry.resource.range ? localLine.replace(/,?BYTERANGE="[^"]*"/, '') : localLine;
  }
  return entry.line;
}).join('\n');

export const buildLocalMasterPlaylist = ({ variant, audio, videoPath, audioPath }) => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  let audioGroup = null;
  if (audio && audioPath) {
    const source = audio.attributes;
    audioGroup = 'offline-audio';
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroup}",NAME="${source.NAME || source.LANGUAGE || '音频'}",DEFAULT=YES,AUTOSELECT=YES${source.LANGUAGE ? `,LANGUAGE="${source.LANGUAGE}"` : ''},URI="${audioPath}"`);
  }
  const attributes = variant?.attributes || {};
  const streamAttributes = [`BANDWIDTH=${variant?.bandwidth || 0}`];
  ['AVERAGE-BANDWIDTH', 'CODECS', 'RESOLUTION', 'FRAME-RATE'].forEach((key) => {
    if (attributes[key]) streamAttributes.push(`${key}=${key === 'CODECS' ? `"${attributes[key]}"` : attributes[key]}`);
  });
  if (audioGroup) streamAttributes.push(`AUDIO="${audioGroup}"`);
  lines.push(`#EXT-X-STREAM-INF:${streamAttributes.join(',')}`);
  lines.push(videoPath);
  return lines.join('\n');
};
