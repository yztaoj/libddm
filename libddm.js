var adb_port = 5037;
var maxSyncLength = (64*1024);
var net = require('net');
var fs = require('fs');
var assert = require('assert');

function formCommand(cmd){
	var len = cmd.length;
	assert (len <= 0xffff);

	var zeros = ((len&0xf000)?'':'0')+
				((len&0xff00)?'':'0')+
				((len&0xfff0)?'':'0');
	return zeros + cmd.length.toString(16) + cmd;
}

function Device(sid){
	this.sid = sid;
}

function execCmdSeq(dev){
	if(!dev.socket) {
		dev.socket = net.connect(adb_port, function(){
			execCmdSeq(dev);
		})
		.on('error', function(err){
			console.log(err);
			dev.notify('connection error');
		})
		.on('timeout',function(){
			dev.socket.end();
			dev.notify('connection timeout');
		});
	}else{
		var cmd = dev.cmdseq.shift();
		dev.socket.write(formCommand(cmd));
		dev.socket.once('data', function(data){
			if(data.toString().match(/OKAY/)){
				if(dev.cmdseq.length == 0){
					dev.notify('success');
				}else{
					execCmdSeq(dev);
				}
			}
			else
				dev.notify('failed at '+cmd);			
		});
	}
}

Device.prototype.reboot = function(phase, callback){
	this.cmdseq = [
		'host:transport:' + this.sid,
		'reboot:' + (phase? phase: '')
	];

	if(this.socket) this.socket = null;
	this.notify = callback;
	execCmdSeq(this);
}

Device.prototype.shell = function(command, callback){
	this.cmdseq = [
		'host:transport:' + this.sid,
		'shell:' + command
	];

	if(this.socket) this.socket = null;
	var self = this;
	this.notify = function(result){
		if(result != 'success') return callback(result);

		this.socket.on('data', function(data){
			callback('outstream', data.toString());
		})
		.on('close', function(){callback('success')});
	};
	execCmdSeq(this);
}

Device.prototype.instream = function(data){
	if(this.socket) this.socket.write(data);
}

Device.prototype.forward = function(source, dest, callback){
	this.cmdseq = [
		'host-serial:'+this.sid+':forward:'+source+';'+dest
	];

	if(this.socket) this.socket = null;
	this.notify = callback;
	execCmdSeq(this);

	if(!this.forward) this.forward = {};
	this.forward[source] = dest;
}

Device.prototype.forwardTCP = function(sport, dport, callback){
	this.forward('tcp:'+sport, 'tcp:'+dport, callback);
}

Device.prototype.forwardJDWP = function(sport, pid, callback){
	this.forward('tcp:'+sport, 'jdwp:'+pid, callback);
}

Device.prototype.remForward = function(callback){
	var list = [];
	for(var key in this.forward){
		list.push('host-serial:'+this.sid+':killforward:'+key+';'+this.forward[key]);
	}

	if(this.socket) this.socket = null;
	this.notify = callback;
	this.cmdseq = list;
	execCmdSeq(this);
}

Device.prototype.trackJDWP = function(callback){
	this.cmdseq = [
		'host:transport:' + this.sid,
		'track-jdwp'
	];

	if(this.socket) this.socket = null;
	this.notify = callback;
	execCmdSeq(this);
}

Device.prototype.log = function(name, callback){
	this.cmdseq = [
		'host:transport:' + this.sid,
		'log:' + name
	];

	if(this.socket) this.socket = null;
	this.notify = callback;
	execCmdSeq(this);
}

function fileHelper(cmd, path, mode){
	var modStr = mode?(','+(mode & 0777)):'';
	var buf = new Buffer(8);
	buf.write(cmd);
	buf.writeUInt32LE(modStr.length+path.length, 4);
	return Buffer.concat([buf, Buffer(path), Buffer(modStr)]);
}

function doneHelper(){
	var buf = new Buffer(8);
	var date = new Date();
	buf.write('DONE');
	buf.writeUInt32LE(parseInt(date.getTime()/1000), 4);
	return buf;
}

function sendBuf(socket, bufList){
	var cache = new Buffer(8+maxSyncLength);
	cache.write('DATA');

	while(bufList.length > 0){
		var buf = bufList.shift();
		if(buf){
			cache.writeUInt32LE(buf.length, 4);
			buf.copy(cache, 8);
			socket.write(cache.slice(0,8+buf.length)); 
		}else{
			socket.write(doneHelper());
			socket.once('data', function(data){
				if(!data.toString().match(/OKAY/)) console.log('push file failed');
				socket.end();
			});
			cache = null;
			break;
		}
	}
}

Device.prototype.push = function(file){
	var remotePath = '/data/local/tmp/'+file;
	this.cmdseq = [
		'host:transport:' + this.sid,
		'sync:'
	];

	if(this.socket) this.socket = null;
	var self = this;
	this.notify = function(result){
		if(result == 'success'){
			self.socket.write(fileHelper('SEND', remotePath, 0777));
			self.ready = true;
			// console.log(self.bufList);
			if(self.bufList){
				sendBuf(self.socket, self.bufList);
			}
		}else{
			self.ready = false;
		}
	};
	execCmdSeq(this);

	return function(data){
		if(self.ready == false){ // push fill failed already
			return false;
		}
		else if(!self.bufList){ //no buffer added before
			self.bufList = [];
		}

		if(data){
			while(data.length > maxSyncLength){
				self.bufList.push(data.slice(0, maxSyncLength));
				data = data.slice(maxSyncLength);
			}
			self.bufList.push(data);
		}else{
			self.bufList.push(null);
		}

		if(self.ready){
			sendBuf(self.socket, self.bufList);
		}
		return true;
	};
}

Device.prototype.pull = function(path, callback){
	this.cmdseq = [
		'host:transport:' + this.sid,
		'sync:'
	];

	if(this.socket) this.socket = null;
	var self = this;
	this.notify = function(result){
		if(result == 'success'){
			var dataLen;
			self.socket.on('data', function(data){
				if(dataLen) {
					if(dataLen < data.length){
						callback('data', data.slice(0, dataLen));
						data = data.slice(dataLen);
						dataLen = 0;
					}else{
						dataLen -= data.length;
						return callback('data', data);
					}
				}
	
				if(data.length < 4) callback('error', data.toString());
				var type = data.slice(0,4).toString();
				switch(type){
				case 'DONE':
					self.socket.end();
					return callback('end');
				case 'DATA':
					dataLen = data.readUInt32LE(4);
					if(data.length > 8){
						callback('data', data.slice(8));
						dataLen -= (data.length - 8);
					}
					break;
				default:
					callback('error', data.toString());
				}

			})
			.write(fileHelper('RECV', path));
		}else{
			callback('fail');
		}
	};
	execCmdSeq(this);
}

Device.prototype.install = function(file, callback){}

Device.prototype.snapshot = function(callback){}

function pixelReader2(buf, off){
	return buf.readUInt16LE(off);
}
function pixelReader3(buf, off){
	var value12 = buf.readUInt16LE(off);
	var value3 = buf.readUInt16LE(off+2);
	return value12 + (value3 << 16);
}
function pixelReader4(buf, off){
	return buf.readUInt32LE(off);
}
function imgHeader(buf){
	if(buf.length < 4) return;
	var version = buf.readUInt32LE(0);

	if(version == 16){
		this.version = version;
		if(buf.length < 16) return;
		this.headlen = 16;
		this.size = buf.readUInt32LE(4);
		this.width = buf.readUInt32LE(8);
		this.height = buf.readUInt32LE(12);
		this.bpp = 16;
		this.red_offset = 11;
		this.red_length = 5;
		this.blue_offset = 0;
		this.blue_length = 5;
		this.green_offset = 5;
		this.green_length = 6;
		this.alpha_offset = 0;
		this.alpha_length = 0;
	}else if (version == 1){
		this.version = version;
		if(buf.length < 52) return;
		this.headlen = 52;
		this.bpp = buf.readUInt32LE(4);
		assert(!(this.bpp % 8) && (this.bpp<=32));
		this.size = buf.readUInt32LE(8);
		this.width = buf.readUInt32LE(12);
		this.height = buf.readUInt32LE(16);
		this.red_offset = buf.readUInt32LE(20);
		this.red_length = buf.readUInt32LE(24);
		this.blue_offset = buf.readUInt32LE(28);
		this.blue_length = buf.readUInt32LE(32);
		this.green_offset = buf.readUInt32LE(36);
		this.green_length = buf.readUInt32LE(40);
		this.alpha_offset = buf.readUInt32LE(44);
		this.alpha_length = buf.readUInt32LE(48);
	}else {
		return;
	}

	this.data = new Buffer(this.width*this.height*4);
	this.data_offset = 0;

	this.redm = ((1 << this.red_length)-1)<<this.red_offset;
	this.reds = this.red_offset-(8-this.red_length);
	this.grem = ((1 << this.green_length)-1)<<this.green_offset;
	this.gres = this.green_offset-(16-this.green_length);
	this.blum = ((1 << this.blue_length)-1)<<this.blue_offset;
	this.blus = this.blue_offset-(24-this.blue_length);

	switch(this.bpp>>3){
	case 2:
		this.pixreader = pixelReader2;
		break;
	case 3:
		this.pixreader = pixelReader3;
		break;
	case 4:
		this.pixreader = pixelReader4;
		break;
	default:
		assert(0);
	}
}

function enCoder(img, buf){
	var bytes = img.bpp >> 3;
	assert(!(buf.length % bytes));

	var pixels = buf.length / bytes;
	var pixReader = img.pixreader;
	var rmask = img.redm;
	var rshift = img.reds;
	var gmask = img.grem;
	var gshift = img.gres;
	var bmask = img.blum;
	var bshift = img.blus;
	var data = img.data;
	var offset = img.data_offset;
	//console.log(pixels);
	for(var i = 0; i < pixels; i++){
		var value = pixReader(buf, i*bytes);
		var wvalue = ((rshift>0)?((value&rmask)>>rshift):((value&rmask)<<(-rshift))) +
				((gshift>0)?((value&gmask)>>gshift):((value&gmask)<<(-gshift))) +
				((bshift>0)?((value&bmask)>>bshift):((value&bmask)<<(-bshift)));
		data.writeUInt32LE(wvalue, offset);
		offset += 4;
		//console.log(wbuf);
		//console.log(value);
	}
	img.data_offset = offset;
}
function fbData(img, buf){
	assert(img.size);
	enCoder(img, buf);
	img.fill = img.fill ? (img.fill+buf.length) : buf.length;
}
Device.prototype.getFrameBuffer = function(callback){
	function _appendBuf(img, buf){
		var count = fbData(img, buf);
		if (img.fill >= img.size){
			self.socket.end();
			callback(img);
		}
	}

	function _handleData(data){
		if(!rawImage){
			rawImage = new imgHeader(data);
			if(rawImage.headlen){
				self.socket.write(Buffer([0]));
				if(data.length > rawImage.headlen) 
					_appendBuf(rawImage, data.slice(rawImage.headlen));
			}else{
				console.log('get framebuffer header failed!!');
				self.socket.end();
				callback(null);
			}
		}else{
			_appendBuf(rawImage, data);
		}
	}

	this.cmdseq = [
		'host:transport:' + this.sid,
		'framebuffer:'
	];

	if(this.socket) this.socket = null;
	var self = this;
	var rawImage;
	this.notify = function(result){
		if(result == 'success'){
			self.socket.once('data', function(data){
				self.socket.on('data', _handleData);
				if(data.length>4) _handleData(data.slice(4));
			});
		}else{
			callback(result);
		}
	}
	execCmdSeq(this);
}

function Moniter(callback){
	var client = net.connect(adb_port, function(){
		console.log('adb-server connected');
		client.write(formCommand('host:track-devices'));
	})
	.once('data', function(data){
		if(data.length >= 4 &&
		data.slice(0,4).toString() == 'OKAY'){
			console.log('host:track-devices comfirmed');
			client.on('data', callback);
			if(data.length > 8) callback(data.slice(4));
		}else{
			console.log('host:track-devices failed!!!!!');
			console.log(data);
			client.end();
	  		callback(null);
		}
	});
	return client;
}

exports.device = Device;
exports.monitor = Moniter;

// var dev = new Device('0163C00D0C01C00E');
/*
 * remote shell
 */
// dev.shell('top', console.log);

/*
 * push file
 */
// var fun = dev.push('testfile.apk');
// require('fs').createReadStream('../../YuNiFangQiJianDian_2_6_1_Android_build201301091114.apk')
// .on('data', function(data){fun(data)});
// setTimeout(function(){
// 	fun();
// }, 1000);
/*
 * pull file
 */
// var fun = dev.pull('data/local/tmp/testfile.txt', console.log);
