import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const UdpPlugin = registerPlugin('UdpPlugin');

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
const cameraSelect = document.getElementById('cameraSelect');
const modelSelect = document.getElementById('modelSelect');
const mirrorCheckbox = document.getElementById('mirrorCheckbox');
const fpsLimitInput = document.getElementById('fpsLimit');
const ipAddressInput = document.getElementById('ipAddress');
const smoothingInput = document.getElementById('smoothing');

// --- 🌟 1. 設定の自動保存＆読み込み機能 ---

async function loadSettings() {
	const keys = ['ipAddress', 'fpsLimit', 'smoothing', 'modelSelect'];
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
}

async function saveSetting(key, value) {
	await Preferences.set({ key, value: String(value) });
}

['ipAddress', 'fpsLimit', 'smoothing', 'modelSelect'].forEach((id) => {
	document
		.getElementById(id)
		.addEventListener('change', (e) => saveSetting(id, e.target.value));
});
mirrorCheckbox.addEventListener('change', (e) => {
	saveSetting('mirrorCheckbox', e.target.checked);
	videoContainer.style.transform = e.target.checked ? 'scaleX(-1)' : 'none';
});

// --- 🌟 2. OSC変換＆送信ツール ---

// ★ PositionとRotationの両方を送れるように改良
function createOscPacket(trackerId, dataType, x, y, z) {
	const address = `/tracking/trackers/${trackerId}/${dataType}`;
	const types = ',fff';
	const align = (len) => Math.ceil((len + 1) / 4) * 4;

	const addressLen = align(address.length);
	const typesLen = align(types.length);
	const totalLen = addressLen + typesLen + 12;

	const buffer = new ArrayBuffer(totalLen);
	const view = new DataView(buffer);
	const uint8 = new Uint8Array(buffer);

	for (let i = 0; i < address.length; i++) uint8[i] = address.charCodeAt(i);
	for (let i = 0; i < types.length; i++)
		uint8[addressLen + i] = types.charCodeAt(i);

	// エンディアンネスを明示(ビッグエンディアン)
	view.setFloat32(addressLen + typesLen, x, false);
	view.setFloat32(addressLen + typesLen + 4, y, false);
	view.setFloat32(addressLen + typesLen + 8, z, false);

	let binaryStr = '';
	for (let i = 0; i < uint8.length; i++)
		binaryStr += String.fromCharCode(uint8[i]);
	return btoa(binaryStr);
}

let smoothedData = {};
function smoothCoordinate(id, x, y, z, strength) {
	const factor = strength / 100;
	if (!smoothedData[id]) {
		smoothedData[id] = { x, y, z };
		return { x, y, z };
	}
	smoothedData[id].x = smoothedData[id].x * factor + x * (1 - factor);
	smoothedData[id].y = smoothedData[id].y * factor + y * (1 - factor);
	smoothedData[id].z = smoothedData[id].z * factor + z * (1 - factor);
	return smoothedData[id];
}

async function sendToVRChat(trackerId, dataType, x, y, z) {
	if (!socketId) return;

	let sendX = x,
		sendY = y,
		sendZ = z;

	// スムージングはPositionにのみかける（Rotationは今回0固定のため）
	if (dataType === 'position') {
		const strength = parseInt(smoothingInput.value, 10);
		const smoothed = smoothCoordinate(trackerId, x, y, z, strength);
		sendX = smoothed.x;
		sendY = smoothed.y;
		sendZ = smoothed.z;
	}

	const base64Data = createOscPacket(
		trackerId,
		dataType,
		sendX,
		sendY,
		sendZ,
	);

	try {
		await UdpPlugin.send({
			socketId: socketId,
			address: ipAddressInput.value,
			port: 9000,
			buffer: base64Data,
		});
	} catch (e) {}
}

// --- 🌟 3. カメラとAIのメイン処理 ---

async function populateCameras() {
	try {
		const tempStream = await navigator.mediaDevices.getUserMedia({
			video: true,
		});
		tempStream.getTracks().forEach((track) => track.stop());
	} catch (e) {}

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
}

async function startCamera() {
	if (!poseLandmarker) {
		alert('Loading AI...');
		return;
	}

	if (!socketId) {
		try {
			const result = await UdpPlugin.create();
			socketId = result.socketId;
			await UdpPlugin.bind({
				socketId: socketId,
				address: '0.0.0.0',
				port: 0,
			});
		} catch (e) {}
	}

	if (currentStream)
		currentStream.getTracks().forEach((track) => track.stop());
	const deviceId = cameraSelect.value;

	try {
		currentStream = await navigator.mediaDevices.getUserMedia({
			video: deviceId
				? { deviceId: { exact: deviceId } }
				: { facingMode: 'environment' },
		});
		video.srcObject = currentStream;

		startButton.innerText = 'Stop Tracking';
		startButton.style.backgroundColor = '#f44336';

		if (!isRunning) {
			isRunning = true;
			predictWebcam();
		}
	} catch (error) {}
}

async function initOrUpdateModel() {
	const wasRunning = isRunning;
	if (wasRunning) {
		stopCamera();
		startButton.innerText = 'Reloading Model...';
	}

	const level = modelSelect.value;
	const modelUrl = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${level}/float16/1/pose_landmarker_${level}.task`;

	if (!poseLandmarker) {
		const vision = await FilesetResolver.forVisionTasks(
			'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
		);
		poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
			baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
			runningMode: 'VIDEO',
			numPoses: 1,
		});
	} else {
		await poseLandmarker.setOptions({
			baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
		});
	}

	if (wasRunning) await startCamera();
}

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

		if (results.landmarks && results.worldLandmarks) {
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

			// ★ トラッカーを地面に立たせるための高さ補正 ★
			// 足首（27か28）のうち、画面下側（Yが最大）のものを「地面(Y=0)」と定義する
			const lowestY = Math.max(world[27].y, world[28].y);

			// MediaPipe空間をVRChat(Unity)空間に変換
			const toUnity = (point) => {
				return {
					x: point.x, // Xはそのまま（右が正）
					y: lowestY - point.y, // 地面を0として、上向きに高さを出す（床めり込み防止）
					z: -point.z, // 手前/奥の反転
				};
			};

			// 1: 腰 (Hip)
			const hipCenter = {
				x: (world[23].x + world[24].x) / 2,
				y: (world[23].y + world[24].y) / 2,
				z: (world[23].z + world[24].z) / 2,
			};
			const hipU = toUnity(hipCenter);
			sendToVRChat(1, 'position', hipU.x, hipU.y, hipU.z);
			sendToVRChat(1, 'rotation', 0, 0, 0); // VRChat必須データ

			// 2: 左足首
			const leftFootU = toUnity(world[27]);
			sendToVRChat(2, 'position', leftFootU.x, leftFootU.y, leftFootU.z);
			sendToVRChat(2, 'rotation', 0, 0, 0);

			// 3: 右足首
			const rightFootU = toUnity(world[28]);
			sendToVRChat(
				3,
				'position',
				rightFootU.x,
				rightFootU.y,
				rightFootU.z,
			);
			sendToVRChat(3, 'rotation', 0, 0, 0);
		}
	} catch (error) {}
}

// --- イベントリスナー ---

startButton.addEventListener('click', () => {
	if (isRunning) stopCamera();
	else startCamera();
});

modelSelect.addEventListener('change', initOrUpdateModel);
cameraSelect.addEventListener('change', () => {
	if (isRunning) startCamera();
});

loadSettings().then(() => {
	populateCameras();
	initOrUpdateModel();
});
