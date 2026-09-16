function PCMPlayer(option) {
    this.init(option);
}

PCMPlayer.prototype.init = function(option) {
    var defaults = {
        encoding: '16bitInt',
        channels: 1,
        sampleRate: 48000,
        flushingTime: 500 // unused now, kept for API compatibility
    };
    this.option = Object.assign({}, defaults, option);
    this.maxValue = this.getMaxValue();
    this.typedArray = this.getTypedArray();
    // Queue of resampled samples (interleaved per channel, at the AudioContext's
    // native rate) waiting to be played.
    this.queue = new Float32Array(0);
    this.createContext();
};

PCMPlayer.prototype.getMaxValue = function () {
    var encodings = {
        '8bitInt': 128,
        '16bitInt': 32768,
        '32bitInt': 2147483648,
        '32bitFloat': 1
    }

    return encodings[this.option.encoding] ? encodings[this.option.encoding] : encodings['16bitInt'];
};

PCMPlayer.prototype.getTypedArray = function () {
    var typedArrays = {
        '8bitInt': Int8Array,
        '16bitInt': Int16Array,
        '32bitInt': Int32Array,
        '32bitFloat': Float32Array
    }

    return typedArrays[this.option.encoding] ? typedArrays[this.option.encoding] : typedArrays['16bitInt'];
};

PCMPlayer.prototype.createContext = function() {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // context needs to be resumed on iOS and Safari (or it will stay in "suspended" state)
    this.audioCtx.resume();

    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = 1;
    this.gainNode.connect(this.audioCtx.destination);

    // Continuous, callback-driven playback instead of scheduling separate
    // AudioBufferSourceNode chunks back-to-back. Chaining discrete buffers
    // that way is prone to audible micro-clicks/buzz at each chunk boundary
    // in some browsers (observed: Chrome, not Firefox/Edge). A
    // ScriptProcessorNode instead pulls exactly the samples the audio engine
    // asks for on every callback, which is gapless by construction.
    var self = this;
    var channels = this.option.channels;
    this.scriptNode = this.audioCtx.createScriptProcessor(4096, 0, channels);
    this.scriptNode.onaudioprocess = function(e) {
        self._processAudio(e);
    };
    this.scriptNode.connect(this.gainNode);
};

PCMPlayer.prototype._processAudio = function(e) {
    var channels = this.option.channels;
    var outLen = e.outputBuffer.length;
    var available = Math.floor(this.queue.length / channels);
    var take = Math.min(outLen, available);
    var c, j;
    for (c = 0; c < channels; c++) {
        var out = e.outputBuffer.getChannelData(c);
        for (j = 0; j < take; j++) {
            out[j] = this.queue[j * channels + c];
        }
        for (; j < outLen; j++) {
            out[j] = 0; // underrun (no data yet): silence, not a glitch
        }
    }
    if (take > 0) {
        this.queue = this.queue.slice(take * channels);
    }
};

PCMPlayer.prototype.resume = function() {
    this.audioCtx.resume();
}

PCMPlayer.prototype.isTypedArray = function(data) {
    return (data.byteLength && data.buffer && data.buffer.constructor == ArrayBuffer);
};

PCMPlayer.prototype.feed = function(data) {
    if (!this.isTypedArray(data)) {
        console.log("feed: not typed array");
        return;
    }
    var fdata = this.getFormatedValue(data);
    var resampled = this._resample(fdata);
    var tmp = new Float32Array(this.queue.length + resampled.length);
    tmp.set(this.queue, 0);
    tmp.set(resampled, this.queue.length);
    this.queue = tmp;
    this.audioCtx.resume();
};

// Linear-interpolation resample from this.option.sampleRate (the nominal rate
// of the incoming PCM, e.g. 12000 Hz) to the AudioContext's actual native
// rate, so no implicit resampling happens anywhere else in the pipeline.
PCMPlayer.prototype._resample = function(fdata) {
    var channels = this.option.channels;
    var srcRate = this.option.sampleRate;
    var dstRate = this.audioCtx.sampleRate;
    if (srcRate === dstRate) {
        return fdata;
    }
    var srcFrames = fdata.length / channels;
    var ratio = dstRate / srcRate;
    var dstFrames = Math.round(srcFrames * ratio);
    var out = new Float32Array(dstFrames * channels);
    var c, i;
    for (c = 0; c < channels; c++) {
        for (i = 0; i < dstFrames; i++) {
            var srcPos = i / ratio;
            var idx0 = Math.floor(srcPos);
            var frac = srcPos - idx0;
            var idx1 = idx0 + 1;
            if (idx0 >= srcFrames) idx0 = srcFrames - 1;
            if (idx1 >= srcFrames) idx1 = srcFrames - 1;
            var s0 = fdata[idx0 * channels + c];
            var s1 = fdata[idx1 * channels + c];
            out[i * channels + c] = s0 + (s1 - s0) * frac;
        }
    }
    return out;
};

PCMPlayer.prototype.getFormatedValue = function(data) {
    var ndata = new this.typedArray(data.buffer),
        float32 = new Float32Array(ndata.length),
        i;
    for (i = 0; i < ndata.length; i++) {
        float32[i] = ndata[i] / this.maxValue;
    }
    return float32;
};

PCMPlayer.prototype.volume = function(volume) {
    this.gainNode.gain.value = volume;
};

PCMPlayer.prototype.destroy = function() {
    if (this.scriptNode) {
        this.scriptNode.disconnect();
        this.scriptNode.onaudioprocess = null;
    }
    this.queue = null;
    this.audioCtx.close();
    this.audioCtx = null;
};
