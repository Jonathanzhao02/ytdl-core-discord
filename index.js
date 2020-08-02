const ytdl = require('ytdl-core');
const prism = require('prism-media');
const { PassThrough } = require('stream');

function filter(format) {
	return format.codecs === 'opus' &&
		format.container === 'webm' &&
		format.audioSampleRate == 48000;
}

function createStream (options) {
	const stream = new PassThrough({
		highWaterMark: (options && options.highWaterMark) || 1024 * 512,
	});
	stream.destroy = () => { stream._isDestroyed = true; };
	return stream;
};

/**
 * Tries to find the highest bitrate audio-only format. Failing that, will use any available audio format.
 * @private
 * @param {Object[]} formats The formats to select from
 * @param {boolean} isLive Whether the content is live or not
 */
function nextBestFormat(formats, isLive) {
	let filter = format => format.audioBitrate;
	if (isLive) filter = format => format.audioBitrate && format.isHLS;
	formats = formats
		.filter(filter)
		.sort((a, b) => b.audioBitrate - a.audioBitrate);
	return formats.find(format => !format.bitrate) || formats[0];
}

function download(url, options = {}) {
	const stream = createStream(options);
	ytdl.getInfo(url)
	.then(info => {
		getInfoCallback(stream, info, options);
	}, stream.emit.bind(stream, 'error'));
	return stream;
}

function getInfoCallback(stream, info, options) {
	// Prefer opus
	const format = info.formats.find(filter);
	const canDemux = format && info.videoDetails.lengthSeconds != 0;
	if (canDemux) options = { ...options, filter };
	else if (info.videoDetails.lengthSeconds != 0) options = { ...options, filter: 'audioonly' };
	if (canDemux) {
		stream.emit('info', info, format);
		if (stream._isDestroyed) return;
		const demuxer = new prism.opus.WebmDemuxer();
		const ytdlDownload = ytdl.downloadFromInfo(info, options)
		stream.destroy = () => {
			stream._isDestroyed = true;
			demuxer.destroy();
		}
		ytdlDownload.pipe(demuxer).on('data', data => {
			if (stream._isDestroyed) return;
			stream.write(data);
		}).on('end', () => {
			ytdlDownload.destroy();
			demuxer.destroy();
		});
	} else {
		const bestFormat = nextBestFormat(info.formats, info.player_response.videoDetails.isLiveContent);
		if (!bestFormat) throw new Error('No suitable format found');
		stream.emit('info', info, bestFormat);
		if (stream._isDestroyed) return;
		const transcoder = new prism.FFmpeg({
			args: [
				'-reconnect', '1',
				'-reconnect_streamed', '1',
				'-reconnect_delay_max', '5',
				'-i', bestFormat.url,
				'-analyzeduration', '0',
				'-loglevel', '0',
				'-f', 's16le',
				'-ar', '48000',
				'-ac', '2',
			],
		});
		const opus = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
		transcoder.pipe(opus).on('data', data => {
			if (stream._isDestroyed) {
				opus.end();
				return;
			}
			stream.write(data);
		}).on('close', () => {
			transcoder.destroy();
			opus.destroy();
		});
	}
}

module.exports = Object.assign(download, ytdl);
