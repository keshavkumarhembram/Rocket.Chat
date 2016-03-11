RocketChat.OTR.Room = class {
	constructor(userId, roomId) {
		this.userId = userId;
		this.roomId = roomId;
		this.peerId = roomId.replace(userId, '');
		this.established = new ReactiveVar(false);
		this.establishing = new ReactiveVar(false);

		this.keyPair = null;
		this.exportedPublicKey = null;
		this.sessionKey = null;

		this.serial = "3";
		this.firstPeer = null;
	}

	handshake() {
		this.establishing.set(true);
		this.firstPeer = true;
		this.generateKeyPair(false).then(() => {
			RocketChat.Notifications.notifyUser(this.peerId, 'otr', 'handshake', { roomId: this.roomId, userId: this.userId, publicKey: this.bytesToHexString(this.exportedPublicKey) });
		});
	}

	acknowledge() {
		RocketChat.Notifications.notifyUser(this.peerId, 'otr', 'acknowledge', { roomId: this.roomId, userId: this.userId, publicKey: this.bytesToHexString(this.exportedPublicKey) });
	}

	deny() {
		this.establishing.set(false);
		RocketChat.Notifications.notifyUser(this.peerId, 'otr', 'deny', { roomId: this.roomId, userId: this.userId });
	}

	end() {
		this.establishing.set(false);
		RocketChat.Notifications.notifyUser(this.peerId, 'otr', 'end', { roomId: this.roomId, userId: this.userId });
	}

	bytesToHexString(bytes) {
		if (!bytes)
			return null;
		bytes = new Uint8Array(bytes);
		var hexBytes = [];
		for (var i = 0; i < bytes.length; ++i) {
			var byteString = bytes[i].toString(16);
			if (byteString.length < 2)
				byteString = "0" + byteString;
			hexBytes.push(byteString);
		}
		return hexBytes.join("");
	}

	hexStringToUint8Array(hexString) {
		if (hexString.length % 2 != 0)
			throw "Invalid hexString";
		var arrayBuffer = new Uint8Array(hexString.length / 2);
		for (var i = 0; i < hexString.length; i += 2) {
			var byteValue = parseInt(hexString.substr(i, 2), 16);
			if (byteValue == NaN)
				throw "Invalid hexString";
			arrayBuffer[i/2] = byteValue;
		}
		return arrayBuffer;
	}

	generateKeyPair(refreshKeys) {
		// Generate an ephemeral key pair.
		return window.crypto.subtle.generateKey({
			name: 'ECDH',
			namedCurve: 'P-256'
		}, false, ['deriveKey', 'deriveBits']).then((keyPair) => {
			this.keyPair = keyPair;
			return crypto.subtle.exportKey('spki', keyPair.publicKey);
		})
		.then((exportedPublicKey) => {
			this.exportedPublicKey = exportedPublicKey;
		})
		.catch((err) => {
			console.error(err);
		});
	}

	importPublicKey(publicKey) {
		return window.crypto.subtle.importKey('spki', this.hexStringToUint8Array(publicKey), {
			name: 'ECDH',
			namedCurve: 'P-256'
		}, false, []).then((peerPublicKey) => {
			return crypto.subtle.deriveBits({
				name: 'ECDH',
				namedCurve: 'P-256',
				public: peerPublicKey
			}, this.keyPair.privateKey, 256);
		}).then((bits) => {
			return crypto.subtle.digest({
				name: 'SHA-256'
			}, bits);
		}).then((hashedBits) => {
			// We truncate the hash to 128 bits.
			var sessionKeyData = new Uint8Array(hashedBits).slice(0, 16);
			return crypto.subtle.importKey('raw', sessionKeyData, {
				name: 'AES-GCM'
			}, false, ['encrypt', 'decrypt']);
		}).then((sessionKey) => {
			// Session key available.
			this.sessionKey = sessionKey;
		});
	}

	encrypt(message) {
		// var clearText = new Uint8Array(message);
		var clearText = new TextEncoder("UTF-8").encode(message);
		this.serial = (parseInt(this.serial) + 1).toString();
		serial = new TextEncoder("UTF-8").encode(this.serial)
		var data = new Uint8Array(1 + 1 + serial.length + clearText.length);
		if (this.firstPeer) {
			data[0] = 1;
		}
		data[1] = serial.length;
		data.set(serial, 2);
		data.set(clearText, 2 + serial.length);

		var iv = crypto.getRandomValues(new Uint8Array(12));

		return crypto.subtle.encrypt({
			name: 'AES-GCM',
			iv: iv
		}, this.sessionKey, data).then((cipherText) => {
			cipherText = new Uint8Array(cipherText);
			var output = new Uint8Array(iv.length + cipherText.length);
			output.set(iv, 0);
			output.set(cipherText, iv.length);
			return this.bytesToHexString(output);
		});
	}

	decrypt(message) {
		var cipherText = new this.hexStringToUint8Array(message);
		var iv = cipherText.slice(0, 12);
		cipherText = cipherText.slice(12);

		return crypto.subtle.decrypt({
			name: 'AES-GCM',
			iv: iv
		}, this.sessionKey, cipherText).then((data) => {
			data = new Uint8Array(data);

			// if (this.firstPeer) {
			// 	if (data[0] !== 0) {
			// 		throw new Error("Can decrypt only encrypted data from the second peer.");
			// 	}
			// }
			// else {
			// 	if (data[0] !== 1) {
			// 		throw new Error("Can decrypt only encrypted data from the first peer.");
			// 	}
			// }

			var serial = data.slice(2, 2 + data[1]);
			var clearText = data.slice(2 + data[1]);
			// var clearText = new TextDecoder("UTF-8").decode(new Uint8Array(data.slice(2 + data[1])));

			// To copy over and make sure we do not have a shallow slice with simply non-zero byteOffset.
			serial = new TextDecoder("UTF-8").decode(new Uint8Array(serial));
			clearText = new TextDecoder("UTF-8").decode(new Uint8Array(clearText));

			console.log(serial);
			console.log(clearText);

			// // This prevents any replay attacks. Or attacks where messages are changed in order.
			// if (parseInt(serial) - parseInt(this.serial) !== 1) {
			// 	throw new Error("Invalid serial.");
			// }
			// this.serial = serial;

			return clearText;
		})
		.catch((e) => {
			console.log(e);
			console.log(JSON.stringify(e));
		});
	}

	onUserStream(type, data) {
		const user = Meteor.users.findOne(data.userId);
		switch(type) {
			case 'handshake':
				let timeout = null;
				this.establishing.set(true);
				swal({
					title: "<i class='icon-key alert-icon'></i>" + TAPi18n.__("OTR"),
					text: TAPi18n.__("Username_wants_to_start_otr_Do_you_want_to_accept", { username: user.username }),
					html: true,
					showCancelButton: true,
					confirmButtonText: TAPi18n.__("Yes"),
					cancelButtonText: TAPi18n.__("No")
				}, (isConfirm) => {
					if (isConfirm) {
						Meteor.clearTimeout(timeout);
						this.generateKeyPair(false).then(() => {
							this.importPublicKey(data.publicKey).then(() => {
								this.firstPeer = false;
								FlowRouter.goToRoomById(data.roomId);
								Meteor.defer(() => {
									this.established.set(true);
									this.acknowledge();
								});
							});
						});
					} else {
						Meteor.clearTimeout(timeout);
						this.deny();
					}
				});
				timeout = Meteor.setTimeout(() => {
					this.establishing.set(false);
					swal.close();
				}, 10000);
				break;

			case 'acknowledge':
				this.importPublicKey(data.publicKey).then(() => {
					this.established.set(true);
				});
				break;

			case 'deny':
				this.establishing.set(false);
				swal(TAPi18n.__("Denied"), null, "error");
				break;

			case 'end':
				this.establishing.set(false);
				swal(TAPi18n.__("Ended"), null, "error");
				break;
		}
	}
}
