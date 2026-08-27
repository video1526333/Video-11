import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HLS_ERROR_CODES,
  buildLocalMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  rewriteMediaPlaylist,
} from '../offline-hls-core.js';

test('选择最高码率视频和对应的默认音频 rendition', () => {
  const playlist = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="备用",DEFAULT=NO,URI="audio/backup.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="国语",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="zh",URI="audio/main.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="audio"
video/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1920x1080,AUDIO="audio"
video/high.m3u8`;
  const result = parseMasterPlaylist(playlist, 'https://cdn.example.test/show/master.m3u8');
  assert.equal(result.selectedVariant.url, 'https://cdn.example.test/show/video/high.m3u8');
  assert.equal(result.selectedVariant.bandwidth, 2400000);
  assert.equal(result.selectedAudio.url, 'https://cdn.example.test/show/audio/main.m3u8');
  assert.equal(result.selectedAudio.attributes.LANGUAGE, 'zh');
});

test('解析相对 URL、query string、fMP4 init、byte range 和 AES-128 key', () => {
  const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin?token=abc",IV=0x00000000000000000000000000000001
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:4.5,
segments/chunk.m4s?part=1
#EXT-X-BYTERANGE:100@720
segments/chunk.m4s?part=1
#EXT-X-ENDLIST`;
  const result = parseMediaPlaylist(playlist, 'https://cdn.example.test/show/video/index.m3u8', 'video');
  assert.equal(result.resources.length, 4);
  assert.equal(result.totalDuration, 4.5);
  assert.deepEqual(result.resources.map((resource) => resource.kind), ['key', 'init', 'segment', 'segment']);
  assert.equal(result.resources[0].url, 'https://cdn.example.test/show/keys/key.bin?token=abc');
  assert.equal(result.resources[1].range, 'bytes=0-719');
  assert.notEqual(result.resources[2].key, result.resources[3].key);
  const rewritten = rewriteMediaPlaylist(result, (resource) => `/offline/${resource.kind}/${resource.sequence}`);
  assert.match(rewritten, /URI="\/offline\/key\/0"/);
  assert.match(rewritten, /URI="\/offline\/init\/1"/);
  assert.match(rewritten, /\/offline\/segment\/2/);
  assert.match(rewritten, /\/offline\/segment\/3/);
  assert.doesNotMatch(rewritten, /EXT-X-BYTERANGE/);
  assert.doesNotMatch(rewritten, /BYTERANGE=/);
});

test('本地 master 同时声明视频和音频 playlist', () => {
  const master = buildLocalMasterPlaylist({
    variant: { bandwidth: 2000, attributes: { CODECS: 'avc1.4d401f,mp4a.40.2', RESOLUTION: '1280x720' } },
    audio: { attributes: { NAME: '国语', LANGUAGE: 'zh' } },
    videoPath: '/offline-hls/id/playlists/video.m3u8',
    audioPath: '/offline-hls/id/playlists/audio.m3u8',
  });
  assert.match(master, /TYPE=AUDIO/);
  assert.match(master, /AUDIO="offline-audio"/);
  assert.match(master, /playlists\/video\.m3u8/);
  assert.match(master, /playlists\/audio\.m3u8/);
});

test('拒绝 Live HLS 和不支持的 DRM/加密格式', () => {
  assert.throws(
    () => parseMediaPlaylist('#EXTM3U\n#EXTINF:5,\nsegment.ts', 'https://cdn.example.test/live.m3u8'),
    (error) => error.code === HLS_ERROR_CODES.LIVE_UNSUPPORTED,
  );
  assert.throws(
    () => parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST', 'https://cdn.example.test/vod.m3u8'),
    (error) => error.code === HLS_ERROR_CODES.DRM_UNSUPPORTED,
  );
});
