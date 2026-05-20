import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { Preferences } from '@capacitor/preferences';
import { UdpSocket } from 'capacitor-udp-socket';

let poseLandmarker;
let currentStream;
let isRunning = false;
let socketId = null;

let lastFrameTime = 0;
let lastVideoTime = -1;

const video = document.getElementById('webcam');
const canvas = document.getElementById('output_canvas');
const canvasCtx = canvas.getContext('2d');
const videoContainer = document.getElementById('videoContainer');

const startButton = document.getElementById('startButton');
const toggleLogButton = document.getElementById('toggleLogButton');
const cameraSelect = document.getElementById('cameraSelect');
const modelSelect = document.getElementById('modelSelect');
const mirrorCheckbox = document.getElementById('mirrorCheckbox');
const fpsLimitInput = document.getElementById('fpsLimit');
const ipAddressInput = document.getElementById('ipAddress');
const userHeightInput = document.getElementById('userHeight');
const smoothingInput = document.getElementById('smoothing');

// --- 🌟 デバッグパネル ---
const logDiv = document.createElement('div');
logDiv.style.cssText =
	'display:none; position:fixed; bottom:0; left:0; width:100%; height:200px; overflow-y:auto; background:rgba(0,0,0,0.9); color:lime; font-size:12px; padding:8px; z-index:9999; box-sizing:border-box; border-top:2px solid #555; font-family:monospace;';
document.body.appendChild(logDiv);

let logCount = 0;
function logDebug(msg) {
	if (logCount > 100) {
		logDiv.innerHTML = '';
		logCount = 0;
	}
	logDiv.innerHTML += `<div>[INFO] ${msg}</div>`;
	logDiv.scrollTop = logDiv.scrollHeight;
	logCount++;
}

// ★修正: エラーを骨の髄まで詳細に表示する強化版エラーハンドラー
function logError(msg, err = null) {
	let detailedMsg = `<div style="color:#ff5555; font-weight:bold; margin-top:8px;">[ERR] ${msg}</div>`;
	if (err) {
		// Errorオブジェクトならスタックトレースを、それ以外ならJSONを展開
		let errStr = '';
		if (err instanceof Error) {
			errStr = `Name: ${err.name}\nMessage: ${err.message}\nStack: ${
				err.stack || 'No stack trace'
			}`;
		} else if (typeof err === 'object') {
			try {
				errStr = JSON.stringify(
					err,
					Object.getOwnPropertyNames(err),
					2,
				);
			} catch (e) {
				errStr = String(err);
			}
		} else {
			errStr = String(err);
		}
		detailedMsg += `<div style="color:#ffaaaa; white-space:pre-wrap; background:rgba(255,0,0,0.15); padding:6px; border-left:3px solid #ff0000; margin-bottom:8px; word-wrap:break-word;">${errStr}</div>`;
	}
	logDiv.innerHTML += detailedMsg;
	logDiv.scrollTop = logDiv.scrollHeight;
}

toggleLogButton.addEventListener('click', () => {
	logDiv.style.display = logDiv.style.display === 'none' ? 'block' : 'none';
});

// --- 🌟 1. UDP初期化（クリーンアップ強化） ---
async function initUdp() {
	try {
		logDebug('Initializing UDP Socket...');

		// 既存のソケットがあれば確実に閉じてゾンビ化を防ぐ
		if (socketId !== null) {
			try {
				await UdpSocket.close({ socketId: socketId });
			} catch (e) {}
			socketId = null;
		}

		// ★修正: 公式仕様に合わせた引数構造
		// 空でもよいので properties を明示的に渡さないとJava側でNullエラー(create error)が起きます
		const info = await UdpSocket.create({
			properties: {
				name: 'nekoFBT-osc',
				bufferSize: 4096,
			},
		});

		socketId = info.socketId;

		// ★修正: バインド時の引数も公式仕様に準拠
		await UdpSocket.bind({
			socketId: socketId,
			address: '0.0.0.0',
			port: 0,
		});

		logDebug('UDP Socket Ready: ' + socketId);
	} catch (e) {
		logError('UDP Init Failed', e);
	}
}

// --- 🌟 2. 設定の自動保存＆読み込み機能 ---
async function loadSettings() {
	try {
		const keys = [
			'ipAddress',
			'fpsLimit',
			'smoothing',
			'modelSelect',
			'userHeight',
		];
		for (const key of keys) {
			const { value } = await Preferences.get({ key });
			if (value !== null) document.getElementById(key).value = value;
		}
		const mirror = await Preferences.get({ key: 'mirrorCheckbox' });
		if (mirror.value !== null) {
			mirrorCheckbox.checked = mirror.value === 'true';
			videoContainer.style.transform = mirrorCheckbox.checked
				? 'scaleX(-1)'
				: 'none';
		}
	} catch (e) {
		logError('Settings Load Failed', e);
	}
}

async function saveSetting(key, value) {
	try {
		await Preferences.set({ key, value: String(value) });
	} catch (e) {
		logError(`Failed to save setting [${key}]`, e);
	}
}

['ipAddress', 'fpsLimit', 'smoothing', 'modelSelect', 'userHeight'].forEach(
	(id) => {
		document
			.getElementById(id)
			.addEventListener('change', (e) => saveSetting(id, e.target.value));
	},
);
mirrorCheckbox.addEventListener('change', (e) => {
	saveSetting('mirrorCheckbox', e.target.checked);
	videoContainer.style.transform = e.target.checked ? 'scaleX(-1)' : 'none';
});

// --- 🌟 3. 超高速OSC変換＆UDP送信ツール ---
const oscCache = {};

function getOscBase64Fast(trackerId, dataType, x, y, z) {
	const key = `${trackerId}_${dataType}`;
	if (!oscCache[key]) {
		const address = `/tracking/trackers/${trackerId}/${dataType}`;
		const types = ',fff';
		const align = (len) => Math.ceil((len + 1) / 4) * 4;

		const addressLen = align(address.length);
		const typesLen = align(types.length);
		const totalLen = addressLen + typesLen + 12;

		const buffer = new ArrayBuffer(totalLen);
		const view = new DataView(buffer);
		const uint8 = new Uint8Array(buffer);

		for (let i = 0; i < address.length; i++)
			uint8[i] = address.charCodeAt(i);
		for (let i = 0; i < types.length; i++)
			uint8[addressLen + i] = types.charCodeAt(i);

		oscCache[key] = { view, uint8, offset: addressLen + typesLen };
	}

	const cache = oscCache[key];
	cache.view.setFloat32(cache.offset, x, false);
	cache.view.setFloat32(cache.offset + 4, y, false);
	cache.view.setFloat32(cache.offset + 8, z, false);
	return btoa(String.fromCharCode.apply(null, cache.uint8));
}

let smoothedData = {};
function smoothCoordinate(id, x, y, z, strength, isRotation = false) {
	const factor = strength / 100;
	if (!smoothedData[id]) {
		smoothedData[id] = { x, y, z };
		return smoothedData[id];
	}

	if (isRotation) {
		const lerpAngle = (a, b, t) => {
			let diff = b - a;
			while (diff < -180) diff += 360;
			while (diff > 180) diff -= 360;
			return a + diff * t;
		};
		smoothedData[id].x = lerpAngle(smoothedData[id].x, x, 1 - factor);
		smoothedData[id].y = lerpAngle(smoothedData[id].y, y, 1 - factor);
		smoothedData[id].z = lerpAngle(smoothedData[id].z, z, 1 - factor);
	} else {
		smoothedData[id].x = smoothedData[id].x * factor + x * (1 - factor);
		smoothedData[id].y = smoothedData[id].y * factor + y * (1 - factor);
		smoothedData[id].z = smoothedData[id].z * factor + z * (1 - factor);
	}
	return smoothedData[id];
}

let udpErrorCount = 0;

async function sendToVRChat(trackerId, dataType, x, y, z) {
	if (!socketId) return;

	const strength = parseInt(smoothingInput.value, 10);
	const smoothed = smoothCoordinate(
		`${trackerId}_${dataType}`,
		x,
		y,
		z,
		strength,
		dataType === 'rotation',
	);
	const base64Data = getOscBase64Fast(
		trackerId,
		dataType,
		smoothed.x,
		smoothed.y,
		smoothed.z,
	);

	try {
		await UdpSocket.send({
			socketId: socketId,
			address: ipAddressInput.value,
			port: 9000,
			buffer: base64Data,
		});
		udpErrorCount = 0;
	} catch (e) {
		if (udpErrorCount < 5) {
			logError(`UDP Error (Tracker ${trackerId} ${dataType})`, e); // ★ 詳細表示
			udpErrorCount++;
			if (udpErrorCount === 5)
				logError(
					'Too many UDP errors. Suppressing further network logs.',
					null,
				);
		}
	}
}

// --- 🌟 4. カメラとAIのメイン処理 ---

async function populateCameras() {
	try {
		const tempStream = await navigator.mediaDevices.getUserMedia({
			video: true,
		});
		tempStream.getTracks().forEach((track) => track.stop());
	} catch (e) {
		logError('Camera permission check failed', e);
	}

	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const videoDevices = devices.filter(
			(device) => device.kind === 'videoinput',
		);

		cameraSelect.innerHTML = '';
		videoDevices.forEach((device, index) => {
			const option = document.createElement('option');
			option.value = device.deviceId;
			option.text = device.label || `Camera ${index + 1}`;
			cameraSelect.appendChild(option);
		});
	} catch (e) {
		logError('Failed to list cameras', e);
	}
}

function stopCamera() {
	isRunning = false;
	if (currentStream) {
		currentStream.getTracks().forEach((track) => track.stop());
		currentStream = null;
	}
	video.srcObject = null;
	canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
	startButton.innerText = 'Camera Start';
	startButton.style.backgroundColor = '#4CAF50';
	logDebug('Tracking Stopped.');
}

async function startCamera() {
	if (!poseLandmarker) {
		alert('Loading AI... Please wait.');
		return;
	}

	if (currentStream)
		currentStream.getTracks().forEach((track) => track.stop());
	const deviceId = cameraSelect.value;

	try {
		currentStream = await navigator.mediaDevices.getUserMedia({
			video: deviceId
				? { deviceId: { exact: deviceId }, width: 640, height: 480 }
				: { facingMode: 'environment', width: 640, height: 480 },
		});
		video.srcObject = currentStream;

		startButton.innerText = 'Stop Tracking';
		startButton.style.backgroundColor = '#f44336';

		if (!isRunning) {
			isRunning = true;
			predictWebcam();
		}
	} catch (error) {
		logError('Camera Start Error', error);
	}
}

async function initOrUpdateModel() {
	const wasRunning = isRunning;
	if (wasRunning) {
		stopCamera();
		startButton.innerText = 'Reloading Model...';
	}

	const level = modelSelect.value;
	const modelUrl = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${level}/float16/1/pose_landmarker_${level}.task`;

	try {
		// ★修正: メモリリーク防止（既存モデルの確実な破棄）
		if (poseLandmarker) {
			logDebug('Disposing previous AI model to free memory...');
			poseLandmarker.close();
			poseLandmarker = null;
		}

		logDebug(`Downloading AI Model (${level})...`);
		const vision = await FilesetResolver.forVisionTasks(
			'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
		);
		poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
			baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
			runningMode: 'VIDEO',
			numPoses: 1,
		});
		logDebug(`AI Model [${level}] Ready.`);
	} catch (error) {
		logError('AI Initialization Failed', error);
	}

	if (wasRunning) await startCamera();
}

let aiErrorCount = 0;

async function predictWebcam() {
	if (!isRunning) return;
	window.requestAnimationFrame(predictWebcam);

	let now = performance.now();
	let fpsInput = fpsLimitInput.value;
	if (fpsInput !== '') {
		let targetFps = parseInt(fpsInput, 10);
		if (targetFps > 0 && now - lastFrameTime < 1000 / targetFps) return;
	}
	lastFrameTime = now;

	if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
	lastVideoTime = video.currentTime;

	try {
		const results = poseLandmarker.detectForVideo(video, performance.now());
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
		aiErrorCount = 0; // 成功時はエラーカウンタリセット

		if (
			results.landmarks &&
			results.worldLandmarks &&
			results.worldLandmarks.length > 0
		) {
			for (const landmark of results.landmarks) {
				for (const point of landmark) {
					canvasCtx.beginPath();
					canvasCtx.arc(
						point.x * canvas.width,
						point.y * canvas.height,
						5,
						0,
						2 * Math.PI,
					);
					canvasCtx.fillStyle = 'red';
					canvasCtx.fill();
				}
			}

			const world = results.worldLandmarks[0];
			const userHeightM =
				(parseFloat(userHeightInput.value) || 160) / 100;
			const lowestY = Math.max(
				world[27].y,
				world[28].y,
				world[29].y,
				world[30].y,
				world[31].y,
				world[32].y,
			);
			const highestY = Math.min(
				world[0].y,
				world[1].y,
				world[2].y,
				world[7].y,
				world[8].y,
			);
			const detectedHeight = lowestY - highestY;

			let scale = 1.0;
			if (detectedHeight > 0.5) scale = userHeightM / detectedHeight;

			const toUnity = (point) => {
				return {
					x: point.x * scale,
					y: (lowestY - point.y) * scale,
					z: -point.z * scale,
				};
			};

			const uHipL = toUnity(world[23]),
				uHipR = toUnity(world[24]);
			const uShoulderL = toUnity(world[11]),
				uShoulderR = toUnity(world[12]);
			const uMidHip = {
				x: (uHipL.x + uHipR.x) / 2,
				y: (uHipL.y + uHipR.y) / 2,
				z: (uHipL.z + uHipR.z) / 2,
			};
			const uMidShoulder = {
				x: (uShoulderL.x + uShoulderR.x) / 2,
				y: (uShoulderL.y + uShoulderR.y) / 2,
				z: (uShoulderL.z + uShoulderR.z) / 2,
			};

			const hipYaw =
				Math.atan2(uHipR.x - uHipL.x, uHipR.z - uHipL.z) *
					(180 / Math.PI) -
				90;
			const hipPitch =
				Math.atan2(
					uMidShoulder.z - uMidHip.z,
					uMidShoulder.y - uMidHip.y,
				) *
				(180 / Math.PI);
			const hipRoll =
				Math.atan2(
					uMidShoulder.x - uMidHip.x,
					uMidShoulder.y - uMidHip.y,
				) * -(180 / Math.PI);

			sendToVRChat(1, 'position', uMidHip.x, uMidHip.y, uMidHip.z);
			sendToVRChat(1, 'rotation', hipPitch, hipYaw, hipRoll);

			const calcFootRot = (heel, toe) => {
				const dx = toe.x - heel.x,
					dy = toe.y - heel.y,
					dz = toe.z - heel.z;
				const yaw = Math.atan2(dx, dz) * (180 / Math.PI);
				const pitch =
					Math.atan2(-dy, Math.sqrt(dx * dx + dz * dz)) *
					(180 / Math.PI);
				return { pitch, yaw, roll: 0 };
			};

			const uLeftAnkle = toUnity(world[27]);
			const uLeftHeel = toUnity(world[29]),
				uLeftToe = toUnity(world[31]);
			const leftRot = calcFootRot(uLeftHeel, uLeftToe);
			sendToVRChat(
				2,
				'position',
				uLeftAnkle.x,
				uLeftAnkle.y,
				uLeftAnkle.z,
			);
			sendToVRChat(
				2,
				'rotation',
				leftRot.pitch,
				leftRot.yaw,
				leftRot.roll,
			);

			const uRightAnkle = toUnity(world[28]);
			const uRightHeel = toUnity(world[30]),
				uRightToe = toUnity(world[32]);
			const rightRot = calcFootRot(uRightHeel, uRightToe);
			sendToVRChat(
				3,
				'position',
				uRightAnkle.x,
				uRightAnkle.y,
				uRightAnkle.z,
			);
			sendToVRChat(
				3,
				'rotation',
				rightRot.pitch,
				rightRot.yaw,
				rightRot.roll,
			);
		}
	} catch (error) {
		// ★修正: 今まで握りつぶされていたAIエラーをキャッチして表示
		if (aiErrorCount < 5) {
			logError('AI Prediction Process Error', error);
			aiErrorCount++;
			if (aiErrorCount === 5)
				logError(
					'Too many AI errors. Suppressing further prediction logs.',
					null,
				);
		}
	}
}

// --- イベントリスナー初期化 ---
startButton.addEventListener('click', () => {
	if (isRunning) stopCamera();
	else startCamera();
});
modelSelect.addEventListener('change', initOrUpdateModel);
cameraSelect.addEventListener('change', () => {
	if (isRunning) startCamera();
});

// アプリ起動シーケンス
initUdp().then(() => {
	loadSettings().then(() => {
		populateCameras();
		initOrUpdateModel();
	});
});
